import { installGestureDebug } from "./gesture-debug";
import { installKeyboardDebug } from "./keyboard-debug";
import { installViewportDebug } from "./viewport-debug";

export type DebugOverlay = "gestures" | "keyboard" | "viewport";
type DebugMode = DebugOverlay | "off";
type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const overlays = ["viewport", "gestures", "keyboard"] as const;
const activeStops = new Map<DebugOverlay, () => void>();

// Home Screen apps launch at the manifest start_url and hosted sign-in
// redirects drop the query, so each section flag must outlive its URL.
export function debugOverlayRequested(
  overlay: DebugOverlay,
  url: URL,
  storage: FlagStorage | null,
): boolean {
  const requested = url.searchParams.get("debug");
  const key = storageKey(overlay);
  return (
    attempt(() => {
      if (requested === overlay) storage?.setItem(key, "on");
      if (requested === "off") storage?.removeItem(key);
      return storage?.getItem(key) === "on";
    }) === true || requested === overlay
  );
}

export function installRequestedDebugOverlays(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  const url = new URL(browserWindow.location.href);
  const storage = attempt(() => browserWindow.localStorage) ?? null;
  for (const overlay of overlays) {
    if (debugOverlayRequested(overlay, url, storage))
      enable(root, browserWindow, overlay);
  }
  return () => {
    for (const overlay of overlays) disable(overlay);
  };
}

export function setDebugOverlayEnabled(
  root: HTMLElement,
  browserWindow: Window,
  mode: DebugMode,
): void {
  const storage = attempt(() => browserWindow.localStorage) ?? null;
  if (mode === "off") {
    for (const overlay of overlays) {
      attempt(() => storage?.removeItem(storageKey(overlay)));
      disable(overlay);
    }
    return;
  }
  attempt(() => storage?.setItem(storageKey(mode), "on"));
  enable(root, browserWindow, mode);
}

function enable(
  root: HTMLElement,
  browserWindow: Window,
  overlay: DebugOverlay,
): void {
  disable(overlay);
  activeStops.set(overlay, installerFor(overlay)(root, browserWindow));
}

function installerFor(
  overlay: DebugOverlay,
): (root: HTMLElement, browserWindow: Window) => () => void {
  switch (overlay) {
    case "gestures":
      return installGestureDebug;
    case "keyboard":
      return installKeyboardDebug;
    case "viewport":
      return installViewportDebug;
  }
}

function disable(overlay: DebugOverlay): void {
  activeStops.get(overlay)?.();
  activeStops.delete(overlay);
}

function storageKey(overlay: DebugOverlay): string {
  return `weblounge.debug.${overlay}`;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
