import type { Page } from "@playwright/test";
import type { DeliveredNotification } from "../src/platform/native-bridge/generated/DeliveredNotification";
import type { PageEvent } from "../src/platform/native-bridge/generated/PageEvent";
import type { PushedMessage } from "../src/platform/native-bridge/generated/PushedMessage";
import type { PushPermission } from "../src/platform/native-bridge/generated/PushPermission";
import type { PushTarget } from "../src/platform/native-bridge/generated/PushTarget";

export interface NativeCall {
  readonly command: string;
  readonly request: unknown;
}

interface StubOptions {
  readonly permission?: PushPermission;
  readonly requestResult?: PushPermission;
}

export const stubRouteKeys = {
  p256dh:
    "BNQLdH2QGCW7H9BfhAzGJN4FLu6PGsgHF-w4Tln0_KAFtjeW0hXCKQo2POEZzkRCUL9HFFCJTYAgh1hn2bx377w",
  auth: "X1uz2Os19r4uPs82m9FE6Q",
} as const;

/**
 * Stands in for the iPhone app's WKWebView: the shell identity, Tauri's `invoke` answering the
 * native-bridge commands, and no service worker, PushManager or Notification.
 */
export async function installIosShellStub(
  page: Page,
  { permission = "default", requestResult = "granted" }: StubOptions = {},
): Promise<void> {
  await page.addInitScript(
    ({ initialPermission, granted, keys }) => {
      Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
      Reflect.deleteProperty(globalThis, "PushManager");
      Reflect.deleteProperty(globalThis, "Notification");
      const calls: { command: string; request: unknown }[] = [];
      let delivered: { identifier: string }[] = [];
      let pushed: unknown[] = [];
      let currentPermission = initialPermission;
      let pushTarget: unknown = null;
      const answers: Record<string, () => unknown> = {
        push_permission: () => currentPermission,
        request_push_permission: () => {
          currentPermission = granted;
          return currentPermission;
        },
        push_target: () => pushTarget,
        create_route_keys: () => keys,
        take_pushed_messages: () => {
          const taken = pushed;
          pushed = [];
          return taken;
        },
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
        queue: (message: unknown) => {
          pushed = [...pushed, message];
        },
        issueToken: (target: unknown) => {
          pushTarget = target;
          window.dispatchEvent(
            new CustomEvent("weblounge:push-target", { detail: target }),
          );
        },
      });
    },
    {
      initialPermission: permission,
      granted: requestResult,
      keys: stubRouteKeys,
    },
  );
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

/** Queues a message the notification extension showed, for the page to drain. */
export async function queuePushedMessage(
  page: Page,
  message: PushedMessage,
): Promise<void> {
  await page.evaluate(
    (value) => Reflect.get(globalThis, "__iosShell").queue(value),
    message,
  );
}

/** Answers `push_target` with `target` from now on and announces it, as APNs issuing a token. */
export async function issueApnsToken(
  page: Page,
  target: PushTarget,
): Promise<void> {
  await page.evaluate(
    (value) => Reflect.get(globalThis, "__iosShell").issueToken(value),
    target,
  );
}

/** Fires `event` right after the page's load event, when the shell delivers a warm tap. */
export async function dispatchShellEventOnLoad(
  page: Page,
  event: PageEvent,
): Promise<void> {
  await page.addInitScript(({ name, detail }) => {
    window.addEventListener("load", () =>
      window.dispatchEvent(new CustomEvent(name, { detail })),
    );
  }, event);
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
