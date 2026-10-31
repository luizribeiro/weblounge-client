import { type Accessor, createSignal } from "solid-js";
import { observeTouchMoveLock } from "./touch-move-lock";
import { observeViewportGeometry } from "./viewport-geometry";

export const desktopPanelBoundary = 760;

export type PrimaryInput = "touch" | "mouse";
export type DisplayMode = "standalone" | "browser" | "tauri";
export type Shell = "mobile" | "desktop";
export type DesktopPanels = "inline" | "overlay";
export type PlatformTarget = "web" | "tauri-desktop" | "tauri-mobile";
export type ShortcutPlatform = "macos" | "other";

export interface PlatformEnvironment {
  readonly input: PrimaryInput;
  readonly display: DisplayMode;
  readonly shell: Shell;
  readonly desktopPanels: DesktopPanels;
}

export interface PlatformController {
  readonly environment: Accessor<PlatformEnvironment>;
  readonly prefersDark: Accessor<boolean>;
  readonly prefersReducedMotion: Accessor<boolean>;
  readonly shortcutPlatform: ShortcutPlatform;
  dispose(): void;
}

export interface InstallOptions {
  readonly target?: PlatformTarget;
  readonly observeWidth?: WidthObserver;
}

type WidthObserver = (
  element: Element,
  onWidth: (width: number) => void,
) => () => void;

const touchQuery = "(hover: none) and (pointer: coarse)";
const standaloneQuery = "(display-mode: standalone)";
const darkQuery = "(prefers-color-scheme: dark)";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

let installed: PlatformController | undefined;

export function installPlatformEnvironment(
  root: HTMLElement,
  browserWindow: Window,
  options: InstallOptions = {},
): PlatformController {
  const target = options.target ?? "web";
  const touch = mediaQuery(browserWindow, touchQuery);
  const standalone = mediaQuery(browserWindow, standaloneQuery);
  const dark = mediaQuery(browserWindow, darkQuery);
  const reducedMotion = mediaQuery(browserWindow, reducedMotionQuery);
  let panels = panelsForWidth(initialWidth(root, browserWindow));
  const [environment, setEnvironment] = createSignal(
    resolveEnvironment(target, touch.matches, standalone.matches, panels),
  );
  const [prefersDark, setPrefersDark] = createSignal(dark.matches);
  const [prefersReducedMotion, setPrefersReducedMotion] = createSignal(
    reducedMotion.matches,
  );

  const publish = () => {
    const next = resolveEnvironment(
      target,
      touch.matches,
      standalone.matches,
      panels,
    );
    setEnvironment(next);
    setPrefersDark(dark.matches);
    setPrefersReducedMotion(reducedMotion.matches);
    root.dataset.input = next.input;
    root.dataset.display = next.display;
    root.dataset.shell = next.shell;
    root.dataset.desktopPanels = next.desktopPanels;
  };
  const mediaChanged = () => publish();
  const media = [touch, standalone, dark, reducedMotion];
  for (const query of media) query.addEventListener("change", mediaChanged);

  const stopWidthObserver = (options.observeWidth ?? observeWidth)(
    root,
    (width) => {
      const next = panelsForWidth(width);
      if (next === panels) return;
      panels = next;
      publish();
    },
  );
  const stopViewportObserver = observeViewportGeometry(root, browserWindow, {
    onScreenKeyboard: () => environment().input === "touch",
    prefersReducedMotion,
  });
  const stopTouchMoveLock = observeTouchMoveLock(root, browserWindow);
  publish();

  const controller: PlatformController = {
    environment,
    prefersDark,
    prefersReducedMotion,
    shortcutPlatform: resolveShortcutPlatform(browserWindow.navigator),
    dispose() {
      for (const query of media)
        query.removeEventListener("change", mediaChanged);
      stopViewportObserver();
      stopTouchMoveLock();
      stopWidthObserver();
      delete root.dataset.input;
      delete root.dataset.display;
      delete root.dataset.shell;
      delete root.dataset.desktopPanels;
      if (installed === controller) installed = undefined;
    },
  };
  installed?.dispose();
  installed = controller;
  return controller;
}

export function platformEnvironment(): PlatformController {
  if (installed === undefined) {
    throw new Error("platform environment is not installed");
  }
  return installed;
}

export function resolveEnvironment(
  target: PlatformTarget,
  touchPrimary: boolean,
  standalone: boolean,
  desktopPanels: DesktopPanels,
): PlatformEnvironment {
  if (target === "tauri-desktop") {
    return {
      input: "mouse",
      display: "tauri",
      shell: "desktop",
      desktopPanels,
    };
  }
  if (target === "tauri-mobile") {
    return {
      input: "touch",
      display: "tauri",
      shell: "mobile",
      desktopPanels,
    };
  }
  return {
    input: touchPrimary ? "touch" : "mouse",
    display: standalone ? "standalone" : "browser",
    shell: touchPrimary ? "mobile" : "desktop",
    desktopPanels,
  };
}

export function resolveShortcutPlatform(
  browserNavigator: Pick<Navigator, "platform">,
): ShortcutPlatform {
  return /Mac|iPhone|iPad/u.test(browserNavigator.platform) ? "macos" : "other";
}

function panelsForWidth(width: number): DesktopPanels {
  return width < desktopPanelBoundary ? "overlay" : "inline";
}

function initialWidth(root: HTMLElement, browserWindow: Window): number {
  const width = root.getBoundingClientRect().width;
  return width > 0 ? width : browserWindow.innerWidth;
}

function observeWidth(
  element: Element,
  onWidth: (width: number) => void,
): () => void {
  const observer = new ResizeObserver(([entry]) => {
    if (entry !== undefined) onWidth(entry.contentRect.width);
  });
  observer.observe(element);
  return () => observer.disconnect();
}

function mediaQuery(browserWindow: Window, query: string): MediaQueryList {
  if (typeof browserWindow.matchMedia === "function") {
    return browserWindow.matchMedia(query);
  }
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
}
