import { afterEach, describe, expect, it } from "vitest";
import {
  observeViewportGeometry,
  resolveViewportGeometry,
  type ViewportMeasurements,
} from "./viewport-geometry";

const iphone: ViewportMeasurements = {
  layoutHeight: 874,
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

describe("viewport geometry observer", () => {
  afterEach(() => {
    document.body.replaceChildren();
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

  it("does nothing without a visual viewport", () => {
    const root = document.createElement("div");
    const stop = observeViewportGeometry(root, fakeWindow(null));
    expect(root.dataset.keyboard).toBeUndefined();
    stop();
  });
});

function observe() {
  const root = document.createElement("div");
  document.body.append(root);
  const viewport = new FakeVisualViewport(window.innerHeight);
  const stop = observeViewportGeometry(root, fakeWindow(viewport));
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
