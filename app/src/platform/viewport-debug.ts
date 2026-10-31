import "./viewport-debug.css";

export type ViewportReading = readonly [label: string, value: string];
type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const flagParameter = "debug";
const flagValue = "viewport";
const storageKey = "weblounge.debug.viewport";
const refreshInterval = 250;
const insets = ["top", "right", "bottom", "left"] as const;
const appProperties = ["--wl-app-height", "--wl-app-top"] as const;
const trackedElements = [
  ["#root", "#root"],
  ["shell", "[data-mobile-shell]"],
  ["composer", "[data-composer]"],
] as const;
const refreshEvents = ["resize", "scroll", "focusin", "focusout"] as const;

// Home Screen apps launch at the manifest start_url and hosted sign-in
// redirects drop the query, so the flag must outlive the URL that set it.
export function viewportDebugRequested(
  url: URL,
  storage: FlagStorage | null,
): boolean {
  const requested = url.searchParams.get(flagParameter);
  return (
    attempt(() => {
      if (requested === flagValue) storage?.setItem(storageKey, "on");
      if (requested === "off") storage?.removeItem(storageKey);
      return storage?.getItem(storageKey) === "on";
    }) === true || requested === flagValue
  );
}

export function installRequestedViewportDebug(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  const url = new URL(browserWindow.location.href);
  const storage = attempt(() => browserWindow.localStorage) ?? null;
  if (!viewportDebugRequested(url, storage)) return () => {};
  return installViewportDebug(root, browserWindow);
}

export function readViewportDiagnostics(
  browserWindow: Window,
  root: HTMLElement,
  insetProbe: HTMLElement,
): readonly ViewportReading[] {
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
      (name): ViewportReading => [
        name,
        rootStyle.getPropertyValue(name).trim() || "unset",
      ],
    ),
    ...trackedElements.map(
      ([label, selector]): ViewportReading => [
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
  const overlay = doc.createElement("pre");
  overlay.dataset.viewportDebug = "true";
  overlay.setAttribute("aria-hidden", "true");
  const insetProbe = doc.createElement("div");
  insetProbe.dataset.viewportDebugProbe = "true";
  doc.body.append(overlay, insetProbe);
  let lastEvent = "install";
  const render = () => {
    const rows = readViewportDiagnostics(browserWindow, root, insetProbe);
    overlay.textContent = [["event", lastEvent] as const, ...rows]
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n");
  };
  const onEvent = (event: Event) => {
    lastEvent = event.type;
    render();
  };
  const targets = [browserWindow.visualViewport, browserWindow].filter(
    (target): target is VisualViewport | Window => target != null,
  );
  for (const target of targets)
    for (const type of refreshEvents) target.addEventListener(type, onEvent);
  const timer = browserWindow.setInterval(render, refreshInterval);
  render();
  return () => {
    browserWindow.clearInterval(timer);
    for (const target of targets)
      for (const type of refreshEvents)
        target.removeEventListener(type, onEvent);
    overlay.remove();
    insetProbe.remove();
  };
}

function visualViewportReadings(
  viewport: VisualViewport | null | undefined,
): readonly ViewportReading[] {
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

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
