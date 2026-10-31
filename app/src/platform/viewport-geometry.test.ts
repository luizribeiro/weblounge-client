import { afterEach, describe, expect, it, vi } from "vitest";
import {
  documentPanned,
  observeViewportGeometry,
  resolveViewportGeometry,
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
      top: 0,
    });
  });

  it("pins the app to the visual viewport above an open keyboard", () => {
    expect(resolveViewportGeometry(withViewport(476))).toEqual({
      keyboard: "open",
      height: 476,
      top: 0,
    });
    expect(resolveViewportGeometry(withViewport(476, 336))).toEqual({
      keyboard: "open",
      height: 476,
      top: 336,
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

describe("viewport geometry observer", () => {
  afterEach(() => {
    for (const stop of running.splice(0)) stop();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("publishes the open keyboard and clears it when the keyboard closes", () => {
    const { root, viewport, stop } = observe();

    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");

    viewport.set(window.innerHeight - 300, 0, "resize");
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 300}px`,
    );
    expect(root.style.getPropertyValue("--wl-app-top")).toBe("0px");

    viewport.set(window.innerHeight, 0, "resize");
    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
    expect(root.style.getPropertyValue("--wl-app-top")).toBe("");

    stop();
    expect(root.dataset.keyboard).toBeUndefined();
    viewport.set(window.innerHeight - 300, 0, "resize");
    expect(root.dataset.keyboard).toBeUndefined();
  });

  it("undoes an iOS pan and lands at the top of the visual viewport", () => {
    const { root, viewport } = observe();
    const scrollTo = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => viewport.set(viewport.height, 0, "scroll"));

    viewport.set(window.innerHeight - 300, 336, "resize");

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-top")).toBe("0px");
  });

  it("follows a pan that cannot be undone", () => {
    const { root, viewport } = observe();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    viewport.set(window.innerHeight - 300, 336, "resize");

    expect(root.style.getPropertyValue("--wl-app-top")).toBe("336px");
  });

  it("re-measures on later frames when an event reported stale values", async () => {
    const { root, viewport } = observe();
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
    viewport.height = window.innerHeight - 300;

    window.dispatchEvent(new FocusEvent("focusin"));

    expect(root.dataset.keyboard).toBe("open");
  });

  it("keeps measuring after a focus change until the keyboard has settled", async () => {
    const { root, viewport } = observe();

    window.dispatchEvent(new FocusEvent("focusin"));
    for (let frame = 0; frame < 6; frame += 1)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(root.dataset.keyboard).toBe("closed");
    viewport.height = window.innerHeight - 403;

    await vi.waitFor(() => expect(root.dataset.keyboard).toBe("open"));
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 403}px`,
    );
  });

  it("settles in a couple of frames after focus changes without an on-screen keyboard", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame");
    observe({ onScreenKeyboard: () => false });

    window.dispatchEvent(new FocusEvent("focusin"));
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
  const stop = observeViewportGeometry(root, fakeWindow(viewport), options);
  running.push(stop);
  return { root, viewport, stop };
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

function fakeWindow(viewport: FakeVisualViewport | null): Window {
  return new Proxy(window, {
    get(target, property) {
      if (property === "visualViewport") return viewport;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
