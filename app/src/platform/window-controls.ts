import { type Accessor, createSignal } from "solid-js";
import type { ThemeDefinition } from "../theme/theme-registry";
import { hostShellIdentity, type WindowControls } from "./host-shell";

export type WindowControlsState = "overlay" | "hidden";
export type WindowTheme = Pick<ThemeDefinition, "appearance" | "colors">;

export interface WindowControlsController {
  readonly state: Accessor<WindowControlsState | undefined>;
  applyTheme(theme: WindowTheme): void;
  dispose(): void;
}

export type WindowControlsScope = Pick<
  Window,
  | "__WEBLOUNGE_SHELL__"
  | "__TAURI_INTERNALS__"
  | "addEventListener"
  | "removeEventListener"
>;

type Invoke = (
  command: string,
  args?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;
type WindowColor = string | readonly [number, number, number, number];

const inlineProperty = "--wl-window-controls-inline";
const blockProperty = "--wl-window-controls-block";

// A wrapper that never answers is_fullscreen must not leave the page invisible.
const unansweredRevealDelayMs = 1000;

const absentControls: WindowControlsController = {
  state: () => undefined,
  applyTheme() {},
  dispose() {},
};

export function observeWindowControls(
  root: HTMLElement,
  scope: WindowControlsScope,
): WindowControlsController {
  const controls = hostShellIdentity(scope)?.windowControls;
  if (controls === undefined) return absentControls;
  const invoke = tauriInvoke(scope);
  const [state, setState] = createSignal<WindowControlsState>("overlay");
  let disposed = false;
  let revealUnanswered: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: WindowControlsState) => {
    if (disposed) return;
    clearTimeout(revealUnanswered);
    setState(next);
    root.dataset.windowControls = next;
  };
  const checkFullScreen = coalescedFullScreenCheck(invoke, (answer) =>
    publish(answeredState(answer, state())),
  );
  const applyTheme = deduplicatedThemeCalls(invoke);

  reserveInsets(root, controls);
  root.dataset.windowControls = "pending";
  revealUnanswered = setTimeout(
    () => publish("overlay"),
    unansweredRevealDelayMs,
  );
  checkFullScreen();
  scope.addEventListener("resize", checkFullScreen);

  return {
    state,
    applyTheme(theme) {
      if (!disposed) applyTheme(theme);
    },
    dispose() {
      disposed = true;
      clearTimeout(revealUnanswered);
      scope.removeEventListener("resize", checkFullScreen);
      delete root.dataset.windowControls;
      root.style.removeProperty(inlineProperty);
      root.style.removeProperty(blockProperty);
    },
  };
}

export function windowDragRegion(
  state: WindowControlsState | undefined,
): "deep" | undefined {
  return state === "overlay" ? "deep" : undefined;
}

function reserveInsets(root: HTMLElement, controls: WindowControls): void {
  root.style.setProperty(inlineProperty, `${controls.inlineStart}px`);
  root.style.setProperty(blockProperty, `${controls.blockSize}px`);
}

function coalescedFullScreenCheck(
  invoke: Invoke,
  onAnswer: (answer: unknown) => void,
): () => void {
  let inFlight = false;
  let outdated = false;
  const check = () => {
    if (inFlight) {
      outdated = true;
      return;
    }
    inFlight = true;
    void invoke("plugin:window|is_fullscreen").then((answer) => {
      inFlight = false;
      onAnswer(answer);
      if (!outdated) return;
      outdated = false;
      check();
    });
  };
  return check;
}

function answeredState(
  answer: unknown,
  fallback: WindowControlsState,
): WindowControlsState {
  if (typeof answer !== "boolean") return fallback;
  return answer ? "hidden" : "overlay";
}

function deduplicatedThemeCalls(invoke: Invoke): (theme: WindowTheme) => void {
  let applied: string | undefined;
  return (theme) => {
    const key = `${theme.appearance} ${theme.colors.bg}`;
    if (key === applied) return;
    applied = key;
    const background = windowColor(theme.colors.bg);
    void invoke("plugin:window|set_theme", { value: theme.appearance });
    void invoke("plugin:window|set_background_color", { value: background });
    void invoke("plugin:webview|set_webview_background_color", {
      value: background,
    });
  };
}

// Tauri's Color parses hex strings or channel tuples, not CSS rgb()/rgba() notation.
export function windowColor(css: string): WindowColor {
  const channels = /^rgba?\(([0-9., ]+)\)$/i.exec(css)?.[1]?.split(",");
  if (channels === undefined) return css;
  const [red = 0, green = 0, blue = 0, alpha = 1] = channels.map(Number);
  return [red, green, blue, Math.round(alpha * 255)];
}

// The wrapper may lack a permission (an older build), so a failed call must stay silent.
function tauriInvoke(scope: Pick<Window, "__TAURI_INTERNALS__">): Invoke {
  const internals = scope.__TAURI_INTERNALS__;
  if (
    typeof internals !== "object" ||
    internals === null ||
    !("invoke" in internals) ||
    typeof internals.invoke !== "function"
  )
    return () => Promise.resolve(undefined);
  const call = internals.invoke;
  return (command, args) => {
    try {
      return Promise.resolve(
        Reflect.apply(call, internals, [command, args]),
      ).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  };
}
