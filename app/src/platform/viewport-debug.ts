import { type DebugReading, installDebugSection } from "./debug-overlay";

const refreshInterval = 250;
const insets = ["top", "right", "bottom", "left"] as const;
const appProperties = ["--wl-app-height", "--wl-app-top"] as const;
const trackedElements = [
  ["#root", "#root"],
  ["shell", "[data-mobile-shell]"],
  ["composer", "[data-composer]"],
] as const;
const refreshEvents = ["resize", "scroll", "focusin", "focusout"] as const;
export function readViewportDiagnostics(
  browserWindow: Window,
  root: HTMLElement,
  insetProbe: HTMLElement,
): readonly DebugReading[] {
  const { document: doc, screen, visualViewport: viewport } = browserWindow;
  const { documentElement } = doc;
  const probe = getComputedStyle(insetProbe);
  const rootStyle = getComputedStyle(root);
  return [
    ["inner", `${browserWindow.innerWidth}×${browserWindow.innerHeight}`],
    ["outerH", px(browserWindow.outerHeight)],
    ["screen", `${screen.width}×${screen.height}`],
    [
      "docEl client/scroll H",
      `${documentElement.clientHeight} / ${documentElement.scrollHeight}`,
    ],
    ["scrollY", px(browserWindow.scrollY)],
    ...visualViewportReadings(viewport),
    [
      "safe t r b l",
      insets.map((edge) => px(probeInset(probe, edge))).join(" "),
    ],
    ["standalone", String(matchesStandalone(browserWindow))],
    ["data-keyboard", root.dataset.keyboard ?? "unset"],
    ...appProperties.map(
      (name): DebugReading => [
        name,
        rootStyle.getPropertyValue(name).trim() || "unset",
      ],
    ),
    ...trackedElements.map(
      ([label, selector]): DebugReading => [
        label,
        describeRect(doc.querySelector(selector)),
      ],
    ),
  ];
}

export function installViewportDebug(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  const doc = browserWindow.document;
  const insetProbe = doc.createElement("div");
  insetProbe.dataset.viewportDebugProbe = "true";
  doc.body.append(insetProbe);
  let lastEvent = "install";
  const stopSection = installDebugSection(browserWindow, {
    id: "viewport",
    title: "viewport",
    read: () => [
      ["event", lastEvent],
      ...readViewportDiagnostics(browserWindow, root, insetProbe),
    ],
    subscribe: (render) => {
      const onEvent = (event: Event) => {
        lastEvent = event.type;
        render();
      };
      const targets = [browserWindow.visualViewport, browserWindow].filter(
        (target): target is VisualViewport | Window => target != null,
      );
      for (const target of targets)
        for (const type of refreshEvents)
          target.addEventListener(type, onEvent);
      const timer = browserWindow.setInterval(render, refreshInterval);
      return () => {
        browserWindow.clearInterval(timer);
        for (const target of targets)
          for (const type of refreshEvents)
            target.removeEventListener(type, onEvent);
      };
    },
  });
  return () => {
    stopSection();
    insetProbe.remove();
  };
}

function visualViewportReadings(
  viewport: VisualViewport | null | undefined,
): readonly DebugReading[] {
  if (viewport == null) return [["vv", "none"]];
  return [
    ["vv w×h", `${px(viewport.width)}×${px(viewport.height)}`],
    [
      "vv offsetTop/pageTop",
      `${px(viewport.offsetTop)} / ${px(viewport.pageTop)}`,
    ],
    ["vv scale", viewport.scale.toFixed(3)],
  ];
}

function matchesStandalone(browserWindow: Window): boolean {
  if (typeof browserWindow.matchMedia !== "function") return false;
  return browserWindow.matchMedia("(display-mode: standalone)").matches;
}

function probeInset(
  style: CSSStyleDeclaration,
  edge: (typeof insets)[number],
): number {
  return Number.parseFloat(style.getPropertyValue(`padding-${edge}`)) || 0;
}

function describeRect(element: Element | null): string {
  if (element === null) return "absent";
  const { top, bottom, height } = element.getBoundingClientRect();
  return `${px(top)}–${px(bottom)} (h ${px(height)})`;
}

function px(value: number): string {
  return String(Math.round(value * 10) / 10);
}
