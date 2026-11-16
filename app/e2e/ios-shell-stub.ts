import type { Page } from "@playwright/test";
import type { DeliveredNotification } from "../src/platform/native-bridge/generated/DeliveredNotification";
import type { PageEvent } from "../src/platform/native-bridge/generated/PageEvent";

export interface NativeCall {
  readonly command: string;
  readonly request: unknown;
}

/**
 * Stands in for the iPhone app's WKWebView: the shell identity, Tauri's `invoke` answering the
 * native-bridge commands, and no service worker, PushManager or Notification.
 */
export async function installIosShellStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    Reflect.deleteProperty(globalThis, "PushManager");
    Reflect.deleteProperty(globalThis, "Notification");
    const calls: { command: string; request: unknown }[] = [];
    let delivered: { identifier: string }[] = [];
    const answers: Record<string, () => unknown> = {
      request_push_permission: () => "default",
      push_target: () => null,
      take_pushed_messages: () => [],
      delivered_notifications: () => delivered,
    };
    Object.defineProperty(window, "__WEBLOUNGE_SHELL__", {
      value: Object.freeze({ kind: "ios-app", version: "0.0.0-e2e" }),
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: Object.freeze({
        invoke: (command: string, args?: { request?: unknown }) => {
          const request = args?.request;
          calls.push({ command, request });
          if (command === "remove_delivered_notifications") {
            const { identifiers } = request as { identifiers: string[] };
            delivered = delivered.filter(
              ({ identifier }) => !identifiers.includes(identifier),
            );
          }
          return Promise.resolve(answers[command]?.() ?? null);
        },
      }),
    });
    Reflect.set(globalThis, "__iosShell", {
      calls: () => [...calls],
      deliver: (notification: { identifier: string }) => {
        delivered = [...delivered, notification];
      },
    });
  });
}

export function nativeCalls(page: Page): Promise<NativeCall[]> {
  return page.evaluate(() => Reflect.get(globalThis, "__iosShell").calls());
}

export async function deliverNativeNotification(
  page: Page,
  notification: DeliveredNotification,
): Promise<void> {
  await page.evaluate(
    (value) => Reflect.get(globalThis, "__iosShell").deliver(value),
    notification,
  );
}

export async function dispatchShellEvent(
  page: Page,
  event: PageEvent,
): Promise<void> {
  await page.evaluate(
    ({ name, detail }) =>
      window.dispatchEvent(new CustomEvent(name, { detail })),
    event,
  );
}
