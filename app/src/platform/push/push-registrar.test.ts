import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsWebPush, webPushRegistrar } from "./push-registrar";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web push registrar", () => {
  it("needs page notifications, PushManager and a service worker", () => {
    const browser = {
      Notification: class {},
      PushManager: class {},
    } as unknown as Window;
    const worker = { serviceWorker: {} } as unknown as Navigator;

    expect(supportsWebPush(browser, worker)).toBe(true);
    expect(supportsWebPush({} as Window, worker)).toBe(false);
    expect(supportsWebPush(browser, {} as Navigator)).toBe(false);
  });

  it("reads the browser's permission without asking", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });

    await expect(webPushRegistrar().permission()).resolves.toBe("granted");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("reports the worker's subscription changes until stopped", () => {
    const worker = new EventTarget();
    vi.stubGlobal("navigator", { serviceWorker: worker });
    const changed = vi.fn();
    const send = (data: unknown) =>
      worker.dispatchEvent(new MessageEvent("message", { data }));

    const stop = webPushRegistrar().onTargetChange(changed);
    send({ type: "push_subscription_change" });
    send({ kind: "open-route", route: "/Lounge/@mel" });
    stop();
    send({ type: "push_subscription_change" });

    expect(changed).toHaveBeenCalledOnce();
  });
});
