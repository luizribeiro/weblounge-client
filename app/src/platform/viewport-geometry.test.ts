import { afterEach, describe, expect, it, vi } from "vitest";
import { TouchTapGesture } from "./focus-without-pan";
import {
  type AppGeometryChange,
  cacheKeyboardHeight,
  documentPanned,
  type KeyboardLayoutCommit,
  keyboardLayoutCommitEvent,
  keyboardSurfaceOwner,
  observeViewportGeometry,
  requestCachedKeyboardOpen,
  resolveViewportGeometry,
  shouldBeginKeyboardClose,
  type ViewportMeasurements,
  type ViewportObserverOptions,
} from "./viewport-geometry";

const iphone: ViewportMeasurements = {
  layoutHeight: 874,
  scrollY: 0,
  viewport: { height: 874, offsetTop: 0, scale: 1 },
};

function withViewport(
  height: number,
  offsetTop = 0,
  scale = 1,
): ViewportMeasurements {
  return { ...iphone, viewport: { height, offsetTop, scale } };
}

describe("viewport geometry", () => {
  it("leaves the app to CSS while the keyboard is closed", () => {
    expect(resolveViewportGeometry(iphone)).toEqual({ keyboard: "closed" });
    expect(resolveViewportGeometry({ ...iphone, layoutHeight: 812 })).toEqual({
      keyboard: "closed",
    });
  });

  it("treats a visual viewport up to 120px short as no keyboard", () => {
    expect(resolveViewportGeometry(withViewport(754))).toEqual({
      keyboard: "closed",
    });
    expect(resolveViewportGeometry(withViewport(753))).toEqual({
      keyboard: "open",
      height: 753,
    });
  });

  it("pins the app height without following a visual viewport pan", () => {
    expect(resolveViewportGeometry(withViewport(476))).toEqual({
      keyboard: "open",
      height: 476,
    });
    expect(resolveViewportGeometry(withViewport(476, 336))).toEqual({
      keyboard: "open",
      height: 476,
    });
  });

  it("does not mistake pinch zoom for a keyboard", () => {
    expect(resolveViewportGeometry(withViewport(406, 200, 2))).toEqual({
      keyboard: "closed",
    });
  });
});

describe("document pan", () => {
  it("is detected through either the visual viewport or the document scroll", () => {
    expect(documentPanned(iphone)).toBe(false);
    expect(documentPanned(withViewport(476, 336))).toBe(true);
    expect(documentPanned({ ...withViewport(476), scrollY: 336 })).toBe(true);
    expect(documentPanned({ ...iphone, scrollY: 62 })).toBe(true);
  });

  it("ignores sub-pixel noise, rubber-band overscroll and pinch zoom", () => {
    expect(documentPanned(withViewport(476, 0.4))).toBe(false);
    expect(documentPanned({ ...iphone, scrollY: -40 })).toBe(false);
    expect(documentPanned(withViewport(406, 200, 2))).toBe(false);
  });
});

describe("keyboard close decision", () => {
  it("waits for focus to remain outside keyboard fields", () => {
    const field = document.createElement("textarea");
    const nextField = document.createElement("input");
    const button = document.createElement("button");

    expect(shouldBeginKeyboardClose(field, button, button, true)).toBe(true);
    expect(shouldBeginKeyboardClose(field, nextField, button, true)).toBe(
      false,
    );
    expect(shouldBeginKeyboardClose(field, button, nextField, true)).toBe(
      false,
    );
    expect(shouldBeginKeyboardClose(field, button, button, false)).toBe(false);
  });
});

describe("keyboard surface ownership", () => {
  it("uses the nearest keyboard surface and falls back to the root", () => {
    const root = document.createElement("div");
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    const field = document.createElement("input");
    outer.dataset.keyboardSurface = "true";
    inner.dataset.keyboardSurface = "true";
    inner.append(field);
    outer.append(inner);
    root.append(outer);

    expect(keyboardSurfaceOwner(field, root)).toBe(inner);
    expect(keyboardSurfaceOwner(root, root)).toBe(root);
    expect(keyboardSurfaceOwner(null, root)).toBe(root);
  });
});

describe("viewport geometry observer", () => {
  afterEach(() => {
    for (const stop of running.splice(0)) stop();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("publishes the open keyboard and clears it when the keyboard closes", () => {
    const { root, viewport, stop } = observe();
    const field = textField();

    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");

    field.focus();
    viewport.set(window.innerHeight - 300, 0, "resize");
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 300}px`,
    );
    expect(root.style.getPropertyValue("--wl-app-top")).toBe("0px");
    expect(root.style.getPropertyValue("--wl-keyboard-inset")).toBe("300px");
    expect(root.dataset.keyboardOwner).toBe("true");

    viewport.set(window.innerHeight, 0, "resize");
    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
    expect(root.style.getPropertyValue("--wl-app-top")).toBe("");
    expect(root.style.getPropertyValue("--wl-keyboard-inset")).toBe("");
    expect(root.dataset.keyboardOwner).toBeUndefined();

    stop();
    expect(root.dataset.keyboard).toBeUndefined();
    viewport.set(window.innerHeight - 300, 0, "resize");
    expect(root.dataset.keyboard).toBeUndefined();
  });

  it("undoes an iOS pan and lands at the top of the visual viewport", () => {
    const { root, viewport } = observe();
    const field = textField();
    const scrollTo = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => viewport.set(viewport.height, 0, "scroll"));

    field.focus();
    viewport.set(window.innerHeight - 300, 336, "resize");

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-top")).toBe("0px");
  });

  it("never publishes a pan that cannot be undone immediately", () => {
    const { root, viewport } = observe();
    const field = textField();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    field.focus();
    viewport.set(window.innerHeight - 300, 336, "resize");

    expect(root.style.getPropertyValue("--wl-app-top")).toBe("0px");
  });

  it("announces geometry changes after publishing them", () => {
    const changes: AppGeometryChange[] = [];
    const changed = (event: Event) =>
      changes.push((event as CustomEvent<AppGeometryChange>).detail);
    window.addEventListener("weblounge:app-geometry-change", changed);
    const { root, viewport } = observe();
    const field = textField();
    changes.length = 0;

    field.focus();
    viewport.set(window.innerHeight - 300, 0, "resize");

    expect(changes).toEqual([
      {
        geometry: { keyboard: "open", height: window.innerHeight - 300 },
        owner: root,
      },
    ]);
    window.removeEventListener("weblounge:app-geometry-change", changed);
  });

  it("re-measures on later frames when an event reported stale values", async () => {
    const { root, viewport } = observe();
    const field = textField();
    field.focus();
    viewport.dispatchEvent(new Event("resize"));
    viewport.height = window.innerHeight - 300;

    await vi.waitFor(() => expect(root.dataset.keyboard).toBe("open"));
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 300}px`,
    );
  });

  it("leaves an unpanned document alone and stops measuring once stable", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const scrollTo = vi.spyOn(window, "scrollTo");
    const { viewport } = observe();
    const field = textField();

    field.focus();
    viewport.set(window.innerHeight - 300, 0, "resize");
    await vi.waitFor(() => expect(frames).toHaveBeenCalledTimes(2));
    const settled = frames.mock.calls.length;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(frames).toHaveBeenCalledTimes(settled + 2);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("re-measures on focus changes", () => {
    const { root, viewport } = observe();
    const field = textField();
    viewport.height = window.innerHeight - 300;

    field.focus();

    expect(root.dataset.keyboard).toBe("open");
  });

  it("detects an iOS keyboard shrink several frames after focus", async () => {
    const { root, viewport } = observe();
    const field = textField();

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.focus();
    for (let frame = 0; frame < 6; frame += 1)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(root.dataset.keyboard).toBe("closed");
    viewport.height = window.innerHeight - 403;

    await vi.waitFor(() => expect(root.dataset.keyboard).toBe("open"));
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 403}px`,
    );
  });

  it("watches pointerless focus through a silent late viewport shrink", () => {
    const frames = new ManualAnimationFrames();
    const viewport = new FakeVisualViewport(window.innerHeight);
    const browserWindow = fakeWindow(viewport, undefined, frames);
    const root = document.createElement("div");
    const field = textField();
    document.body.append(root);
    const stop = observeViewportGeometry(root, browserWindow);
    running.push(stop);
    const startedAt = performance.now();

    field.focus();
    frames.flush(startedAt + 16);
    frames.flush(startedAt + 32);
    viewport.height = 471;
    frames.flush(startedAt + 48);

    expect(root.dataset.keyboard).toBe("open");
    expect(root.dataset.keyboardOwner).toBe("true");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("471px");
  });

  it("keeps watching pointerless focus after a pending close rollback", () => {
    const frames = new ManualAnimationFrames(true);
    const viewport = new FakeVisualViewport(window.innerHeight);
    const browserWindow = fakeWindow(viewport, undefined, frames);
    const root = document.createElement("div");
    const field = textField();
    const button = document.createElement("button");
    document.body.append(root, button);
    const stop = observeViewportGeometry(root, browserWindow);
    running.push(stop);
    const startedAt = performance.now();

    field.focus();
    viewport.set(471, 0, "resize");
    frames.flush(startedAt + 16);
    frames.flush(startedAt + 32);
    button.focus();
    viewport.height = window.innerHeight;
    field.focus();
    frames.flush(startedAt + 48);
    frames.flush(startedAt + 64);
    viewport.height = 471;
    frames.flush(startedAt + 80);

    expect(document.activeElement).toBe(field);
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("471px");
  });

  it.each(["visibilitychange", "pageshow"] as const)(
    "re-arms focused keyboard measurement on %s",
    (resumeEvent) => {
      const frames = new ManualAnimationFrames();
      const viewport = new FakeVisualViewport(window.innerHeight);
      const browserWindow = fakeWindow(viewport, undefined, frames);
      const root = document.createElement("div");
      const field = textField();
      document.body.append(root);
      const stop = observeViewportGeometry(root, browserWindow);
      running.push(stop);
      const startedAt = performance.now();

      field.focus();
      frames.flush(startedAt + 1_100);
      frames.flush(startedAt + 1_116);
      expect(frames.pending).toBe(0);

      if (resumeEvent === "visibilitychange")
        document.dispatchEvent(new Event(resumeEvent));
      else browserWindow.dispatchEvent(new Event(resumeEvent));
      const resumedAt = performance.now();
      frames.flush(resumedAt + 16);
      frames.flush(resumedAt + 32);
      viewport.height = 471;
      frames.flush(resumedAt + 48);

      expect(root.dataset.keyboard).toBe("open");
      expect(root.style.getPropertyValue("--wl-app-height")).toBe("471px");
    },
  );

  it("re-arms the watch when keyboard accessory focus moves fields", () => {
    const frames = new ManualAnimationFrames();
    const viewport = new FakeVisualViewport(window.innerHeight);
    const browserWindow = fakeWindow(viewport, undefined, frames);
    const root = document.createElement("div");
    const first = textField();
    const second = textField();
    document.body.append(root);
    const stop = observeViewportGeometry(root, browserWindow);
    running.push(stop);
    const startedAt = performance.now();

    first.focus();
    frames.flush(startedAt + 1_100);
    frames.flush(startedAt + 1_116);
    expect(frames.pending).toBe(0);

    second.focus();
    const movedAt = performance.now();
    frames.flush(movedAt + 16);
    frames.flush(movedAt + 32);
    viewport.height = 471;
    frames.flush(movedAt + 48);

    expect(document.activeElement).toBe(second);
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("471px");
  });

  it("commits focused cache then reconciles and caches stable measured geometry", async () => {
    const viewport = new FakeVisualViewport(window.innerHeight);
    const browserWindow = fakeWindow(viewport);
    const root = document.createElement("div");
    const field = textField();
    document.body.append(root);
    const stop = observeViewportGeometry(root, browserWindow);
    running.push(stop);

    expect(requestCachedKeyboardOpen(browserWindow)).toBe(false);
    expect(root.dataset.keyboard).toBe("closed");

    cacheKeyboardHeight(browserWindow, window.innerHeight - 320);
    viewport.height = window.innerHeight - 60;
    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(root.dataset.keyboard).toBe("closed");

    field.focus();
    expect(root.dataset.keyboard).toBe("open");
    expect(root.dataset.keyboardOwner).toBe("true");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 320}px`,
    );

    viewport.set(window.innerHeight - 280, 0, "resize");
    viewport.set(window.innerHeight - 300, 0, "resize");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 320}px`,
    );
    await vi.waitFor(() =>
      expect(root.style.getPropertyValue("--wl-app-height")).toBe(
        `${window.innerHeight - 300}px`,
      ),
    );
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 300}px`,
    );

    const commits: KeyboardLayoutCommit[] = [];
    browserWindow.addEventListener(
      keyboardLayoutCommitEvent,
      (event) =>
        commits.push((event as CustomEvent<KeyboardLayoutCommit>).detail),
      { once: true },
    );
    requestCachedKeyboardOpen(browserWindow);
    expect(commits.at(-1)).toEqual({
      geometry: { keyboard: "open", height: window.innerHeight - 300 },
      source: "cached",
    });
  });

  it("applies measured keyboard geometry only to an overlay owner", async () => {
    const { browserWindow, root, viewport } = observe();
    const surface = document.createElement("div");
    surface.dataset.keyboardSurface = "true";
    const field = document.createElement("input");
    field.type = "search";
    surface.append(field);
    document.body.append(surface);
    cacheKeyboardHeight(browserWindow, window.innerHeight - 320);

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.focus();

    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
    expect(surface.dataset.keyboardOwner).toBe("true");

    viewport.set(window.innerHeight - 300, 0, "resize");

    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
    expect(root.style.getPropertyValue("--wl-keyboard-inset")).toBe("300px");
    expect(surface.dataset.keyboardOwner).toBe("true");

    field.blur();
    expect(surface.dataset.keyboardOwner).toBe("true");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-keyboard-inset")).toBe("");
    expect(surface.dataset.keyboardOwner).toBeUndefined();
  });

  it("reopens after a retained-focus send, Done blur, and rejected tap", async () => {
    const { browserWindow, root, viewport } = observe();
    const field = textField();

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.focus();
    viewport.set(471, 0, "resize");
    field.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(root.dataset.keyboard).toBe("open");
    expect(document.activeElement).toBe(field);
    expect(requestCachedKeyboardOpen(browserWindow)).toBe(true);

    field.value = "/debug keyboard";
    field.value = "";
    expect(document.activeElement).toBe(field);
    field.blur();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    viewport.set(window.innerHeight, 0, "resize");
    expect(root.dataset.keyboard).toBe("closed");
    expect(root.dataset.keyboardOwner).toBeUndefined();

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.dispatchEvent(new Event("pointerup", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(root.dataset.keyboard).toBe("closed");

    field.focus();
    viewport.set(471, 0, "resize");

    expect(root.dataset.keyboard).toBe("open");
    expect(root.dataset.keyboardOwner).toBe("true");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("471px");
  });

  it("keeps measured open reality when rejected-tap rollbacks fire late", () => {
    const frames = new ManualAnimationFrames(true);
    const viewport = new FakeVisualViewport(window.innerHeight);
    const browserWindow = fakeWindow(viewport, undefined, frames);
    const root = document.createElement("div");
    const field = textField();
    document.body.append(root);
    const stop = observeViewportGeometry(root, browserWindow);
    running.push(stop);
    const tap = new TouchTapGesture();

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    tap.begin(touch(81), 0);
    expect(tap.end(touch(87), 81)).toEqual({
      accepted: false,
      reason: "touch changed from 81 to 87",
    });
    field.dispatchEvent(new Event("pointerup", { bubbles: true }));
    field.focus();
    viewport.set(471, 0, "resize");
    frames.flush();

    expect(document.activeElement).toBe(field);
    expect(root.dataset.keyboard).toBe("open");
    expect(root.dataset.keyboardOwner).toBe("true");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("471px");
    expect(root.style.getPropertyValue("--wl-keyboard-inset")).toBe(
      `${window.innerHeight - 471}px`,
    );
  });

  it("matches focused open reality across tap and event-order permutations", () => {
    const orders = [
      ["focus", "viewport"],
      ["viewport", "focus"],
    ] as const;
    for (const accepted of [true, false]) {
      for (const order of orders) {
        for (const rollbackAfter of [0, 1, 2]) {
          document.body.replaceChildren();
          const frames = new ManualAnimationFrames(true);
          const viewport = new FakeVisualViewport(window.innerHeight);
          const browserWindow = fakeWindow(viewport, undefined, frames);
          const root = document.createElement("div");
          const field = textField();
          document.body.append(root);
          const stop = observeViewportGeometry(root, browserWindow);
          const tap = new TouchTapGesture();
          const endIdentifier = accepted ? 81 : 87;

          field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
          tap.begin(touch(81), 0);
          expect(tap.end(touch(endIdentifier), 81).accepted).toBe(accepted);
          field.dispatchEvent(new Event("pointerup", { bubbles: true }));
          for (const [index, action] of order.entries()) {
            if (rollbackAfter === index) frames.flush();
            if (action === "focus") field.focus();
            else viewport.set(471, 0, "resize");
          }
          if (rollbackAfter === order.length) frames.flush();
          frames.flush();

          const focusedAndOpen =
            document.activeElement === field && viewport.height === 471;
          expect(
            root.dataset.keyboard,
            scenario(accepted, order, rollbackAfter),
          ).toBe(focusedAndOpen ? "open" : "closed");
          expect(
            root.style.getPropertyValue("--wl-app-height"),
            scenario(accepted, order, rollbackAfter),
          ).toBe(focusedAndOpen ? "471px" : "");
          stop();
          frames.clear();
        }
      }
    }
  });

  it("ignores open viewport geometry without a focused keyboard field", () => {
    const { root, viewport } = observe();

    viewport.set(window.innerHeight - 300, 0, "resize");

    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
  });

  it("rolls back a pointer tap that ends without focus", async () => {
    const { browserWindow, root } = observe();
    const field = textField();
    cacheKeyboardHeight(browserWindow, window.innerHeight - 320);
    const commits: KeyboardLayoutCommit[] = [];
    window.addEventListener(
      keyboardLayoutCommitEvent,
      (event) =>
        commits.push((event as CustomEvent<KeyboardLayoutCommit>).detail),
      { once: true },
    );

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.dispatchEvent(new Event("pointerup", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).not.toBe(field);
    expect(root.dataset.keyboard).toBe("closed");
    expect(commits.at(-1)).toEqual({
      geometry: { keyboard: "closed" },
      rollbackReason: "pointer-ended-without-focus",
      source: "rollback",
    });
  });

  it("rolls back when a composer pointer gesture becomes a drag", async () => {
    const { browserWindow, root } = observe();
    const field = textField();
    cacheKeyboardHeight(browserWindow, window.innerHeight - 320);

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    await Promise.resolve();

    expect(document.activeElement).not.toBe(field);
    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
  });

  it("commits the closed layout one frame after focusout before geometry arrives", async () => {
    const { root, viewport } = observe();
    const field = textField();
    field.focus();
    viewport.set(window.innerHeight - 300, 0, "resize");

    field.blur();

    expect(root.dataset.keyboard).toBe("open");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
  });

  it("does not let late open geometry undo a committed close", async () => {
    const { root, viewport } = observe();
    const field = textField();
    field.focus();
    viewport.set(window.innerHeight - 300, 0, "resize");

    field.blur();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    viewport.dispatchEvent(new Event("resize"));

    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
  });

  it("keeps the keyboard still when focus returns before the close frame", async () => {
    const { root, viewport } = observe();
    const field = textField();
    const button = document.createElement("button");
    document.body.append(button);
    field.focus();
    viewport.set(window.innerHeight - 300, 0, "resize");

    button.focus();
    field.focus();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).toBe(field);
    expect(root.dataset.keyboard).toBe("open");
  });

  it("restores the open layout when a keyboard field refocuses after the close frame", async () => {
    const { root, viewport } = observe();
    const field = textField();
    field.focus();
    viewport.set(window.innerHeight - 300, 0, "resize");

    field.blur();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(root.dataset.keyboard).toBe("closed");
    field.focus();

    expect(root.dataset.keyboard).toBe("open");
  });

  it("uses VirtualKeyboard overlay geometry on Android", () => {
    const viewport = new FakeVisualViewport(window.innerHeight);
    const keyboard = new FakeVirtualKeyboard();
    const browserWindow = fakeWindow(viewport, keyboard);
    const root = document.createElement("div");
    document.body.append(root);
    const stop = observeViewportGeometry(root, browserWindow);
    running.push(stop);

    expect(keyboard.overlaysContent).toBe(true);
    const field = textField();
    field.focus();
    keyboard.height = 280;
    keyboard.dispatchEvent(new Event("geometrychange"));

    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 280}px`,
    );
    stop();
    expect(keyboard.overlaysContent).toBe(false);
  });

  it("settles desktop focus in a couple of frames", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const field = textField();
    observe({ onScreenKeyboard: () => false });

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.focus();
    await vi.waitFor(() => expect(frames).toHaveBeenCalledTimes(2));
    for (let frame = 0; frame < 3; frame += 1)
      await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(frames).toHaveBeenCalledTimes(5);
  });

  it("stops measuring once a touch keyboard is open and stable", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const { viewport } = observe();
    const field = textField();
    viewport.height = window.innerHeight - 300;

    field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    field.focus();
    await vi.waitFor(() => expect(frames).toHaveBeenCalledTimes(2));
    for (let frame = 0; frame < 3; frame += 1)
      await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(frames).toHaveBeenCalledTimes(5);
  });

  it("never treats a nested scroller as a document pan", () => {
    const { viewport } = observe();
    const scrollTo = vi.spyOn(window, "scrollTo");
    const scroller = document.createElement("div");
    document.body.append(scroller);
    viewport.offsetTop = 336;

    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing without a visual viewport", () => {
    const root = document.createElement("div");
    const stop = observeViewportGeometry(root, fakeWindow(null));
    expect(root.dataset.keyboard).toBeUndefined();
    stop();
  });
});

const running: (() => void)[] = [];

function observe(options?: ViewportObserverOptions) {
  const root = document.createElement("div");
  document.body.append(root);
  const viewport = new FakeVisualViewport(window.innerHeight);
  const browserWindow = fakeWindow(viewport);
  const stop = observeViewportGeometry(root, browserWindow, options);
  running.push(stop);
  return { browserWindow, root, viewport, stop };
}

function textField(): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  document.body.append(field);
  return field;
}

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  readonly scale = 1;

  constructor(height: number) {
    super();
    this.height = height;
  }

  set(height: number, offsetTop: number, event: "resize" | "scroll"): void {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event(event));
  }
}

class FakeVirtualKeyboard extends EventTarget {
  height = 0;
  overlaysContent = false;
  get boundingRect(): DOMRectReadOnly {
    return rect(0, this.height);
  }
}

function fakeWindow(
  viewport: FakeVisualViewport | null,
  keyboard?: FakeVirtualKeyboard,
  frames?: ManualAnimationFrames,
): Window {
  return new Proxy(window, {
    get(target, property) {
      if (property === "visualViewport") return viewport;
      if (property === "requestAnimationFrame" && frames !== undefined)
        return frames.request;
      if (property === "cancelAnimationFrame" && frames !== undefined)
        return frames.cancel;
      if (property === "navigator" && keyboard !== undefined)
        return new Proxy(target.navigator, {
          get(navigator, navigatorProperty) {
            if (navigatorProperty === "virtualKeyboard") return keyboard;
            return Reflect.get(navigator, navigatorProperty, navigator);
          },
        });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

class ManualAnimationFrames {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  readonly #keepCanceled: boolean;
  #next = 1;

  constructor(keepCanceled = false) {
    this.#keepCanceled = keepCanceled;
  }

  readonly request = (callback: FrameRequestCallback): number => {
    const id = this.#next;
    this.#next += 1;
    this.#callbacks.set(id, callback);
    return id;
  };

  readonly cancel = (id: number): void => {
    if (!this.#keepCanceled) this.#callbacks.delete(id);
  };

  get pending(): number {
    return this.#callbacks.size;
  }

  flush(now = performance.now()): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(now);
  }

  clear(): void {
    this.#callbacks.clear();
  }
}

function touch(identifier: number) {
  return { clientX: 20, clientY: 40, identifier };
}

function scenario(
  accepted: boolean,
  order: readonly ["focus" | "viewport", "focus" | "viewport"],
  rollbackAfter: number,
): string {
  return JSON.stringify({ accepted, order, rollbackAfter });
}

function rect(top: number, height: number): DOMRectReadOnly {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
