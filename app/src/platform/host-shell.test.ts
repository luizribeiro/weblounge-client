import { describe, expect, it } from "vitest";
import { hostShell, hostShellIdentity } from "./host-shell";

function injected(value: unknown): { readonly __WEBLOUNGE_SHELL__: unknown } {
  const scope = {};
  Object.defineProperty(scope, "__WEBLOUNGE_SHELL__", {
    value,
    writable: false,
    configurable: false,
  });
  return scope as { readonly __WEBLOUNGE_SHELL__: unknown };
}

describe("host shell", () => {
  it("recognises the Mac app's injected identity", () => {
    const scope = injected(
      Object.freeze({ kind: "macos-app", version: "0.1.0" }),
    );

    expect(hostShellIdentity(scope)).toEqual({
      kind: "macos-app",
      version: "0.1.0",
    });
    expect(hostShell(scope)).toBe("macos-app");
  });

  it("treats a missing, unknown or malformed identity as a plain browser", () => {
    for (const value of [
      undefined,
      null,
      "macos-app",
      { kind: "ios-app", version: "0.1.0" },
      { kind: "macos-app" },
      { kind: "macos-app", version: 1 },
    ]) {
      expect(hostShellIdentity(injected(value))).toBeUndefined();
      expect(hostShell(injected(value))).toBe("web");
    }
    expect(hostShell({})).toBe("web");
  });

  it("reads the window controls the wrapper reserves", () => {
    const scope = injected(
      Object.freeze({
        kind: "macos-app",
        version: "0.2.0",
        windowControls: Object.freeze({ inlineStart: 84, blockSize: 48 }),
      }),
    );

    expect(hostShellIdentity(scope)).toEqual({
      kind: "macos-app",
      version: "0.2.0",
      windowControls: { inlineStart: 84, blockSize: 48 },
    });
  });

  it("keeps a zero inset and drops unknown window-control keys", () => {
    const scope = injected({
      kind: "macos-app",
      version: "0.2.0",
      windowControls: { inlineStart: 0, blockSize: 0, style: "overlay" },
    });

    expect(hostShellIdentity(scope)?.windowControls).toEqual({
      inlineStart: 0,
      blockSize: 0,
    });
  });

  it("reads an identity without window controls as having none", () => {
    expect(
      hostShellIdentity(injected({ kind: "macos-app", version: "0.1.0" })),
    ).not.toHaveProperty("windowControls");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 84],
    ["a string", "84,48"],
    ["an array", [84, 48]],
    ["no block size", { inlineStart: 84 }],
    ["no inline start", { blockSize: 48 }],
    ["a string inline start", { inlineStart: "84px", blockSize: 48 }],
    ["a NaN inline start", { inlineStart: Number.NaN, blockSize: 48 }],
    ["a NaN block size", { inlineStart: 84, blockSize: Number.NaN }],
    ["a negative inline start", { inlineStart: -1, blockSize: 48 }],
    ["a negative block size", { inlineStart: 84, blockSize: -1 }],
    [
      "an infinite block size",
      { inlineStart: 84, blockSize: Number.POSITIVE_INFINITY },
    ],
  ])("treats window controls with %s as none", (_case, windowControls) => {
    expect(
      hostShellIdentity(
        injected({ kind: "macos-app", version: "0.2.0", windowControls }),
      ),
    ).toEqual({ kind: "macos-app", version: "0.2.0" });
  });

  it("reads the real global by default", () => {
    expect(hostShell()).toBe("web");
  });
});
