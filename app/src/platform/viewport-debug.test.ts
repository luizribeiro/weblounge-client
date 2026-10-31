import { describe, expect, it } from "vitest";
import { viewportDebugRequested } from "./viewport-debug";

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
