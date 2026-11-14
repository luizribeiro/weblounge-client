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

  it("reads the real global by default", () => {
    expect(hostShell()).toBe("web");
  });
});
