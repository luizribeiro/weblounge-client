import { afterEach, describe, expect, it, vi } from "vitest";
import { themes } from "../theme/theme-registry";
import {
  observeWindowControls,
  type WindowControlsController,
  type WindowControlsScope,
  type WindowTheme,
  windowColor,
  windowDragRegion,
} from "./window-controls";

interface InvokeCall {
  readonly command: string;
  readonly args: unknown;
}

type FakeInvoke = (command: string, args?: unknown) => unknown;

class FakeWindow extends EventTarget {
  readonly calls: InvokeCall[] = [];
  fullScreen: unknown = false;
  readonly __WEBLOUNGE_SHELL__: unknown;
  readonly __TAURI_INTERNALS__: unknown;

  constructor(shell: unknown, bridge: FakeInvoke | "tauri" | "absent") {
    super();
    this.__WEBLOUNGE_SHELL__ = shell;
    this.__TAURI_INTERNALS__ =
      bridge === "absent"
        ? undefined
        : {
            invoke: (command: string, args?: unknown) => {
              this.calls.push({ command, args });
              return bridge === "tauri"
                ? Promise.resolve(this.answer(command))
                : bridge(command, args);
            },
          };
  }

  resize(): void {
    this.dispatchEvent(new Event("resize"));
  }

  private answer(command: string): unknown {
    return command === "plugin:window|is_fullscreen" ? this.fullScreen : null;
  }
}

const macApp = {
  kind: "macos-app",
  version: "0.2.0",
  windowControls: { inlineStart: 84, blockSize: 48 },
};
const root = document.documentElement;
let controller: WindowControlsController | undefined;

function start(scope: FakeWindow): FakeWindow {
  controller = observeWindowControls(
    root,
    scope as unknown as WindowControlsScope,
  );
  return scope;
}

function observe(
  shell: unknown = macApp,
  bridge: FakeInvoke | "tauri" | "absent" = "tauri",
): FakeWindow {
  return start(new FakeWindow(shell, bridge));
}

function theme(id: string): WindowTheme {
  const definition = themes.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`missing theme ${id}`);
  return definition;
}

function inlineInset(): string {
  return root.style.getPropertyValue("--wl-window-controls-inline");
}

async function flushInvokes(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0)); // wait-ok: drains the invoke chains' microtasks so a stale answer would have landed
}

afterEach(() => {
  controller?.dispose();
  controller = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("window controls", () => {
  it("reserves the wrapper's inset and paints once full screen is known", async () => {
    const scope = observe();

    expect(controller?.state()).toBe("overlay");
    expect(root.dataset.windowControls).toBe("pending");
    expect(inlineInset()).toBe("84px");
    expect(root.style.getPropertyValue("--wl-window-controls-block")).toBe(
      "48px",
    );
    await vi.waitFor(() =>
      expect(scope.calls).toEqual([
        { command: "plugin:window|is_fullscreen", args: undefined },
      ]),
    );
    await vi.waitFor(() => expect(root.dataset.windowControls).toBe("overlay"));
    expect(controller?.state()).toBe("overlay");
  });

  it("reveals the windowed layout when full screen goes unanswered", async () => {
    vi.useFakeTimers();
    const answers: ((fullScreen: boolean) => void)[] = [];
    observe(
      macApp,
      () => new Promise<boolean>((resolve) => answers.push(resolve)),
    );

    vi.advanceTimersByTime(999);
    expect(root.dataset.windowControls).toBe("pending");
    vi.advanceTimersByTime(1);
    expect(root.dataset.windowControls).toBe("overlay");
    expect(vi.getTimerCount()).toBe(0);

    answers[0]?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller?.state()).toBe("hidden");
    expect(root.dataset.windowControls).toBe("hidden");
  });

  it("drops the reveal deadline once full screen answers", async () => {
    vi.useFakeTimers();
    observe();

    await vi.advanceTimersByTimeAsync(0);
    expect(root.dataset.windowControls).toBe("overlay");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["answers nonsense", () => Promise.resolve("yes")],
    ["rejects", () => Promise.reject(new Error("not allowed"))],
  ])(
    "reveals at once and drops the deadline when full screen %s",
    async (_case, invoke: FakeInvoke) => {
      vi.useFakeTimers();
      observe(macApp, invoke);

      await vi.advanceTimersByTimeAsync(0);
      expect(root.dataset.windowControls).toBe("overlay");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("drops the reveal deadline when disposed while pending", () => {
    vi.useFakeTimers();
    observe(macApp, () => new Promise(() => {}));

    controller?.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(root.dataset.windowControls).toBeUndefined();
  });

  it("sets no reveal deadline outside a wrapper with window controls", () => {
    vi.useFakeTimers();
    observe({ kind: "macos-app", version: "0.1.0" });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("hides the controls when the window launches in full screen", async () => {
    const scope = new FakeWindow(macApp, "tauri");
    scope.fullScreen = true;
    start(scope);

    await vi.waitFor(() => expect(controller?.state()).toBe("hidden"));
    expect(root.dataset.windowControls).toBe("hidden");
  });

  it("re-checks full screen after every resize", async () => {
    const scope = observe();
    await vi.waitFor(() => expect(scope.calls).toHaveLength(1));

    scope.fullScreen = true;
    scope.resize();
    await vi.waitFor(() => expect(controller?.state()).toBe("hidden"));

    scope.fullScreen = false;
    scope.resize();
    await vi.waitFor(() => expect(controller?.state()).toBe("overlay"));
    expect(root.dataset.windowControls).toBe("overlay");
  });

  it("folds a live resize's burst of events into one trailing check", async () => {
    const answers: ((fullScreen: boolean) => void)[] = [];
    const scope = observe(
      macApp,
      () => new Promise<boolean>((resolve) => answers.push(resolve)),
    );
    for (let frame = 0; frame < 60; frame += 1) scope.resize();
    expect(scope.calls).toHaveLength(1);

    answers[0]?.(false);
    await vi.waitFor(() => expect(scope.calls).toHaveLength(2));
    answers[1]?.(true);
    await vi.waitFor(() => expect(controller?.state()).toBe("hidden"));
    await flushInvokes();
    expect(scope.calls).toHaveLength(2);
  });

  it("keeps the last state when a check fails or answers nonsense", async () => {
    const scope = new FakeWindow(macApp, "tauri");
    scope.fullScreen = true;
    start(scope);
    await vi.waitFor(() => expect(controller?.state()).toBe("hidden"));

    scope.fullScreen = "yes";
    scope.resize();
    await flushInvokes();
    expect(controller?.state()).toBe("hidden");
    expect(scope.calls).toHaveLength(2);
  });

  it("matches the window's appearance and background to the theme", async () => {
    const scope = observe();
    await vi.waitFor(() => expect(scope.calls).toHaveLength(1));

    controller?.applyTheme(theme("lounge-night"));
    controller?.applyTheme(theme("lounge-night"));
    controller?.applyTheme(theme("lounge"));

    expect(scope.calls.slice(1)).toEqual([
      { command: "plugin:window|set_theme", args: { value: "dark" } },
      {
        command: "plugin:window|set_background_color",
        args: { value: "#18221e" },
      },
      {
        command: "plugin:webview|set_webview_background_color",
        args: { value: "#18221e" },
      },
      { command: "plugin:window|set_theme", args: { value: "light" } },
      {
        command: "plugin:window|set_background_color",
        args: { value: "#f3f1e9" },
      },
      {
        command: "plugin:webview|set_webview_background_color",
        args: { value: "#f3f1e9" },
      },
    ]);
  });

  it("converts CSS channel notation to a colour Tauri parses", () => {
    expect(windowColor("#101112")).toBe("#101112");
    expect(windowColor("rgb(16, 17, 18)")).toEqual([16, 17, 18, 255]);
    expect(windowColor("rgba(16,17,18,0.5)")).toEqual([16, 17, 18, 128]);
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("not allowed"))],
    [
      "throws",
      () => {
        throw new Error("bridge gone");
      },
    ],
  ])("stays silent when the bridge %s", async (_case, invoke: FakeInvoke) => {
    const error = vi.spyOn(console, "error");
    const scope = observe(macApp, invoke);

    controller?.applyTheme(theme("lounge"));
    scope.resize();

    await vi.waitFor(() => expect(scope.calls).toHaveLength(5));
    await flushInvokes();
    expect(controller?.state()).toBe("overlay");
    expect(root.dataset.windowControls).toBe("overlay");
    expect(error).not.toHaveBeenCalled();
  });

  it("does nothing outside a wrapper that reserves window controls", () => {
    for (const shell of [
      null,
      { kind: "macos-app", version: "0.1.0" },
      { ...macApp, windowControls: { inlineStart: "84px", blockSize: 48 } },
    ]) {
      const scope = observe(shell);
      controller?.applyTheme(theme("lounge"));
      scope.resize();

      expect(controller?.state()).toBeUndefined();
      expect(root.dataset.windowControls).toBeUndefined();
      expect(inlineInset()).toBe("");
      expect(scope.calls).toEqual([]);
    }
  });

  it.each([
    ["no bridge", undefined],
    ["a bridge without invoke", {}],
  ])("works with %s", async (_case, internals) => {
    const scope = new FakeWindow(macApp, "absent");
    Object.defineProperty(scope, "__TAURI_INTERNALS__", { value: internals });
    start(scope);

    expect(() => {
      controller?.applyTheme(theme("lounge"));
      scope.resize();
    }).not.toThrow();
    expect(controller?.state()).toBe("overlay");
    await vi.waitFor(() => expect(root.dataset.windowControls).toBe("overlay"));
  });

  it("clears the root and goes quiet when disposed", async () => {
    const answers: ((fullScreen: boolean) => void)[] = [];
    const scope = observe(macApp, (command) =>
      command === "plugin:window|is_fullscreen"
        ? new Promise<boolean>((resolve) => answers.push(resolve))
        : Promise.resolve(null),
    );

    controller?.dispose();
    answers[0]?.(true);
    scope.resize();
    controller?.applyTheme(theme("lounge"));
    await flushInvokes();

    expect(root.dataset.windowControls).toBeUndefined();
    expect(root.style.getPropertyValue("--wl-window-controls-block")).toBe("");
    expect(scope.calls).toHaveLength(1);
  });

  it("marks drag regions only while the controls overlay the page", () => {
    expect(windowDragRegion("overlay")).toBe("deep");
    expect(windowDragRegion("hidden")).toBeUndefined();
    expect(windowDragRegion(undefined)).toBeUndefined();
  });
});
