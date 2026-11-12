import type { Page } from "@playwright/test";

export interface PostedPageNotification {
  readonly title: string;
  readonly body: string | undefined;
  readonly tag: string | undefined;
  readonly closed: boolean;
}

interface StubOptions {
  readonly permission: NotificationPermission;
  readonly requestResult: NotificationPermission;
}

/**
 * Stands in for a WKWebView-style host: no service worker or PushManager, and a
 * `window.Notification` with only the members the page relies on. It doubles
 * as the contract the macOS wrapper's shim must implement.
 */
export async function installPageNotificationStub(
  page: Page,
  options: StubOptions,
): Promise<void> {
  await page.addInitScript(({ permission, requestResult }) => {
    Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    Reflect.deleteProperty(globalThis, "PushManager");
    let current = permission;
    const posted: {
      title: string;
      body: string | undefined;
      tag: string | undefined;
      closed: boolean;
      instance: { onclick: (() => void) | null };
    }[] = [];
    let permissionRequests = 0;
    const records = new WeakMap<object, (typeof posted)[number]>();
    // Playwright transpiles init scripts without class-field helpers, so the
    // stub sets its fields in the constructor.
    class StubNotification {
      declare onclick: (() => void) | null;

      constructor(title: string, init?: { body?: string; tag?: string }) {
        if (current !== "granted") throw new TypeError("permission denied");
        this.onclick = null;
        const record = {
          title,
          body: init?.body,
          tag: init?.tag,
          closed: false,
          instance: this,
        };
        records.set(this, record);
        posted.push(record);
      }

      static get permission(): NotificationPermission {
        return current;
      }

      static requestPermission(): Promise<NotificationPermission> {
        permissionRequests += 1;
        current = requestResult;
        return Promise.resolve(current);
      }

      close(): void {
        const record = records.get(this);
        if (record !== undefined) record.closed = true;
      }
    }
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: StubNotification,
    });
    Reflect.set(globalThis, "__pageNotifications", {
      list: () =>
        posted.map(({ title, body, tag, closed }) => ({
          title,
          body,
          tag,
          closed,
        })),
      click: (title: string) =>
        posted
          .findLast((notification) => notification.title === title)
          ?.instance.onclick?.(),
      permissionRequests: () => permissionRequests,
    });
  }, options);
}

export function postedPageNotifications(
  page: Page,
): Promise<PostedPageNotification[]> {
  return page.evaluate(() =>
    Reflect.get(globalThis, "__pageNotifications").list(),
  );
}

export async function clickPageNotification(
  page: Page,
  index: number,
): Promise<void> {
  await page.evaluate(
    (position) =>
      Reflect.get(globalThis, "__pageNotifications").click(position),
    index,
  );
}

export function pageNotificationPermissionRequests(
  page: Page,
): Promise<number> {
  return page.evaluate(() =>
    Reflect.get(globalThis, "__pageNotifications").permissionRequests(),
  );
}

export async function installPageNotificationCounter(
  page: Page,
): Promise<void> {
  await page.addInitScript(() => {
    let constructed = 0;
    const counting = new Proxy(globalThis.Notification, {
      construct: () => {
        constructed += 1;
        return { onclick: null, close: () => undefined };
      },
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: counting,
    });
    Reflect.set(
      globalThis,
      "__pageNotificationConstructions",
      () => constructed,
    );
  });
}

export function pageNotificationConstructions(page: Page): Promise<number> {
  return page.evaluate(() =>
    Reflect.get(globalThis, "__pageNotificationConstructions")(),
  );
}
