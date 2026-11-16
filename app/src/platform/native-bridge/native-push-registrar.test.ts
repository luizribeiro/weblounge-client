import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeBridge } from "./native-bridge";
import {
  hostPushRegistrar,
  nativePushRegistrar,
} from "./native-push-registrar";

const token = "ab".repeat(32);

function shell(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const bridge = {
    call: async (command: string) => {
      calls.push(command);
      return answers[command] ?? null;
    },
  } as NativeBridge;
  return { bridge, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native push registrar", () => {
  it("reads the permission without asking and asks only when told to", async () => {
    const { bridge, calls } = shell({
      push_permission: "default",
      request_push_permission: "granted",
    });
    const registrar = nativePushRegistrar(bridge);

    await expect(registrar.permission()).resolves.toBe("default");
    expect(calls).toEqual(["push_permission"]);
    await expect(registrar.requestPermission()).resolves.toBe("granted");
    expect(calls).toEqual(["push_permission", "request_push_permission"]);
    expect(registrar.native).toBe(true);
    expect(registrar.supported()).toBe(true);
  });

  it("offers the APNs token once permission is granted", async () => {
    const target = { platform: "apns", token, environment: "sandbox" };

    await expect(
      nativePushRegistrar(
        shell({ push_permission: "granted", push_target: target }).bridge,
      ).target("relay-vapid"),
    ).resolves.toEqual({ status: "ready", target });
    await expect(
      nativePushRegistrar(shell({ push_permission: "granted" }).bridge).target(
        "relay-vapid",
      ),
    ).resolves.toEqual({ status: "unavailable" });
    const denied = shell({ push_permission: "denied", push_target: target });
    await expect(
      nativePushRegistrar(denied.bridge).target("relay-vapid"),
    ).resolves.toEqual({ status: "permission_not_granted" });
    expect(denied.calls).toEqual(["push_permission"]);
  });

  it("reports each token the shell announces until stopped", () => {
    const changed = vi.fn();
    const announce = (detail: unknown) =>
      window.dispatchEvent(
        new CustomEvent("weblounge:push-target", { detail }),
      );
    const stop = nativePushRegistrar(shell({}).bridge).onTargetChange(changed);

    announce({ platform: "apns", token, environment: "production" });
    announce({ platform: "apns", token: "not-hex", environment: "production" });
    stop();
    announce({ platform: "apns", token, environment: "production" });

    expect(changed).toHaveBeenCalledOnce();
  });

  it("keeps route keys in the keychain and drops them with their route", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const { bridge, calls } = shell({
      create_route_keys: { p256dh: "public", auth: "auth" },
    });
    const registrar = nativePushRegistrar(bridge);
    const keys = await registrar.generateRouteKeys({
      routeId: "route-1",
      networkId: 1,
      networkLabel: "Lounge",
      nickname: "me",
    });
    const routes = registrar.routes();

    await routes.put({
      networkId: 1,
      networkLabel: "Lounge",
      nickname: "me",
      vapid: "home-vapid",
      routeId: "route-1",
      endpoint: "https://push.example.test/v1/r/route-1",
      ...keys,
    });
    await routes.delete("home-vapid");

    expect(keys).toEqual({
      p256dh: "public",
      auth: "auth",
      keyStorage: "native",
    });
    expect(calls).toEqual(["create_route_keys", "drop_route_keys"]);
  });

  it("is the web registrar outside the iPhone app", () => {
    expect(hostPushRegistrar(undefined).native).toBe(false);
    expect(hostPushRegistrar(shell({}).bridge).native).toBe(true);
  });
});
