import { describe, expect, it } from "vitest";
import { nativeBridge } from "./native-bridge";

function iosScope(answer: (command: string) => unknown) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    scope: {
      __WEBLOUNGE_SHELL__: { kind: "ios-app", version: "0.1.3" },
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: unknown) => {
          calls.push([command, args]);
          return Promise.resolve(answer(command));
        },
      },
    },
  };
}

describe("native bridge", () => {
  it("sends a command's input as its one request argument", async () => {
    const { calls, scope } = iosScope(() => ({ p256dh: "key", auth: "auth" }));
    const bridge = nativeBridge(scope);

    await expect(
      bridge?.call("create_route_keys", {
        routeId: "route-1234567890123456",
        route: { networkId: 1, networkLabel: "Libera", nickname: "mel" },
      }),
    ).resolves.toEqual({ p256dh: "key", auth: "auth" });
    expect(calls).toEqual([
      [
        "create_route_keys",
        {
          request: {
            routeId: "route-1234567890123456",
            route: { networkId: 1, networkLabel: "Libera", nickname: "mel" },
          },
        },
      ],
    ]);
  });

  it("sends no arguments to a command without input", async () => {
    const { calls, scope } = iosScope(() => null);

    await expect(nativeBridge(scope)?.call("push_target")).resolves.toBeNull();
    expect(calls).toEqual([["push_target", undefined]]);
  });

  it("is absent outside the iPhone app", () => {
    const { scope } = iosScope(() => null);

    expect(
      nativeBridge({ ...scope, __WEBLOUNGE_SHELL__: undefined }),
    ).toBeUndefined();
    expect(
      nativeBridge({
        ...scope,
        __WEBLOUNGE_SHELL__: { kind: "macos-app", version: "0.1.3" },
      }),
    ).toBeUndefined();
    expect(
      nativeBridge({ ...scope, __TAURI_INTERNALS__: undefined }),
    ).toBeUndefined();
  });
});
