import { afterEach, describe, expect, it } from "vitest";
import {
  observeViewportGeometry,
  resolveViewportGeometry,
  type ViewportMeasurements,
} from "./viewport-geometry";

const iphoneStandalone: ViewportMeasurements = {
  layoutHeight: 812,
  screenHeight: 874,
  safeTop: 62,
  standalone: true,
  viewport: { height: 812, scale: 1 },
};

const iphoneTab: ViewportMeasurements = {
  layoutHeight: 760,
  screenHeight: 874,
  safeTop: 62,
  standalone: false,
  viewport: { height: 760, scale: 1 },
};

describe("viewport geometry", () => {
  it("fills the screen when iOS standalone shortens the layout viewport by the status bar", () => {
    expect(resolveViewportGeometry(iphoneStandalone)).toEqual({
      appHeight: 874,
      keyboard: "closed",
    });
    expect(
      resolveViewportGeometry({ ...iphoneStandalone, layoutHeight: 811 }),
    ).toMatchObject({ appHeight: 874 });
  });

  it("keeps the layout viewport in a browser tab even when the screen is taller", () => {
    expect(resolveViewportGeometry(iphoneTab)).toEqual({
      appHeight: 760,
      keyboard: "closed",
    });
  });

  it("ignores standalone shortfalls that are not the status bar", () => {
    expect(
      resolveViewportGeometry({ ...iphoneStandalone, layoutHeight: 810 }),
    ).toMatchObject({ appHeight: 810 });
    expect(
      resolveViewportGeometry({
        ...iphoneStandalone,
        layoutHeight: 600,
        viewport: { height: 600, scale: 1 },
      }),
    ).toEqual({ appHeight: 600, keyboard: "closed" });
    expect(
      resolveViewportGeometry({ ...iphoneStandalone, safeTop: 0 }),
    ).toMatchObject({ appHeight: 812 });
  });

  it("treats a visual viewport up to 120px short as no keyboard", () => {
    const full = { ...iphoneStandalone, layoutHeight: 874 };
    expect(
      resolveViewportGeometry({
        ...full,
        viewport: { height: 754, scale: 1 },
      }),
    ).toEqual({ appHeight: 874, keyboard: "closed" });
    expect(
      resolveViewportGeometry({
        ...full,
        viewport: { height: 753, scale: 1 },
      }),
    ).toEqual({ appHeight: 753, keyboard: "open" });
    expect(
      resolveViewportGeometry({
        ...full,
        viewport: { height: 900, scale: 1 },
      }),
    ).toMatchObject({ keyboard: "closed" });
  });

  it("pins the app to the visual viewport above an open keyboard", () => {
    expect(
      resolveViewportGeometry({
        ...iphoneStandalone,
        viewport: { height: 476, scale: 1 },
      }),
    ).toEqual({ appHeight: 476, keyboard: "open" });
    expect(
      resolveViewportGeometry({
        ...iphoneTab,
        viewport: { height: 420, scale: 1 },
      }),
    ).toEqual({ appHeight: 420, keyboard: "open" });
  });

  it("does not mistake pinch zoom for a keyboard", () => {
    expect(
      resolveViewportGeometry({
        ...iphoneStandalone,
        viewport: { height: 406, scale: 2 },
      }),
    ).toEqual({ appHeight: 874, keyboard: "closed" });
  });
});

describe("viewport geometry observer", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("publishes geometry on viewport resize and clears it on dispose", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const viewport = new FakeVisualViewport(window.innerHeight);
    const browserWindow = fakeWindow(viewport);
    const stop = observeViewportGeometry(root, browserWindow, () => false);

    expect(root.dataset.keyboard).toBe("closed");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight}px`,
    );

    viewport.set(window.innerHeight - 300);
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--wl-app-height")).toBe(
      `${window.innerHeight - 300}px`,
    );

    stop();
    expect(root.dataset.keyboard).toBeUndefined();
    expect(root.style.getPropertyValue("--wl-app-height")).toBe("");
    viewport.set(window.innerHeight - 300);
    expect(root.dataset.keyboard).toBeUndefined();
  });

  it("does nothing without a visual viewport", () => {
    const root = document.createElement("div");
    const stop = observeViewportGeometry(root, fakeWindow(null), () => false);
    expect(root.dataset.keyboard).toBeUndefined();
    stop();
  });
});

class FakeVisualViewport extends EventTarget {
  height: number;
  readonly scale = 1;

  constructor(height: number) {
    super();
    this.height = height;
  }

  set(height: number): void {
    this.height = height;
    this.dispatchEvent(new Event("resize"));
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
