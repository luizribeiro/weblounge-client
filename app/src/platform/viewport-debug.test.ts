import { afterEach, describe, expect, it } from "vitest";
import {
  installViewportDebug,
  readViewportDiagnostics,
  viewportDebugRequested,
} from "./viewport-debug";

const flagKey = "weblounge.debug.viewport";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const throwingStorage = {
  getItem(): string | null {
    throw new Error("storage blocked");
  },
  setItem(): void {
    throw new Error("storage blocked");
  },
  removeItem(): void {
    throw new Error("storage blocked");
  },
};

describe("viewport debug flag", () => {
  it("turns on from the URL and remembers it after the query is gone", () => {
    const storage = new MemoryStorage();
    expect(
      viewportDebugRequested(
        new URL("https://beta.weblounge.org/?debug=viewport"),
        storage,
      ),
    ).toBe(true);
    expect(
      viewportDebugRequested(new URL("https://beta.weblounge.org/"), storage),
    ).toBe(true);
  });

  it("turns off with debug=off and is off by default", () => {
    const storage = new MemoryStorage();
    storage.setItem(flagKey, "on");
    expect(
      viewportDebugRequested(
        new URL("https://beta.weblounge.org/?debug=off"),
        storage,
      ),
    ).toBe(false);
    expect(
      viewportDebugRequested(new URL("https://beta.weblounge.org/"), storage),
    ).toBe(false);
    expect(
      viewportDebugRequested(
        new URL("https://beta.weblounge.org/?debug=other"),
        null,
      ),
    ).toBe(false);
  });

  it("still honours the URL when storage throws", () => {
    expect(
      viewportDebugRequested(
        new URL("https://beta.weblounge.org/?debug=viewport"),
        throwingStorage,
      ),
    ).toBe(true);
    expect(
      viewportDebugRequested(
        new URL("https://beta.weblounge.org/"),
        throwingStorage,
      ),
    ).toBe(false);
  });
});

describe("viewport diagnostics", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("reports window, visual viewport, insets, app geometry and element rects", () => {
    const root = document.createElement("div");
    root.id = "root";
    root.dataset.keyboard = "open";
    root.style.setProperty("--wl-app-height", "476px");
    const composer = document.createElement("div");
    composer.dataset.composer = "true";
    root.append(composer);
    const probe = document.createElement("div");
    probe.style.setProperty("padding", "62px 0px 34px 0px");
    document.body.append(root, probe);

    const readings = new Map(readViewportDiagnostics(window, root, probe));

    expect(readings.get("inner")).toBe(
      `${window.innerWidth}×${window.innerHeight}`,
    );
    expect(readings.get("safe t r b l")).toBe("62 0 34 0");
    expect(readings.get("data-keyboard")).toBe("open");
    expect(readings.get("--wl-app-height")).toBe("476px");
    expect(readings.get("--wl-app-top")).toBe("unset");
    expect(readings.get("composer")).toBe("0–0 (h 0)");
    expect(readings.get("shell")).toBe("absent");
  });

  it("renders an inert overlay that refreshes on focus and removes itself", async () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    document.body.append(root, input);
    const stop = installViewportDebug(root, window);
    const overlay = document.querySelector<HTMLElement>(
      "[data-viewport-debug]",
    );

    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay?.textContent).toContain("event: install");
    input.focus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(overlay?.textContent).toContain("event: focusin");

    stop();
    expect(document.querySelector("[data-viewport-debug]")).toBeNull();
    expect(document.querySelector("[data-viewport-debug-probe]")).toBeNull();
  });
});
