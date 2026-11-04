import { randomUUID } from "node:crypto";
import { rename, rm, symlink } from "node:fs/promises";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { IrcClient } from "./irc-client";

const enabled = process.env.WEBLOUNGE_PUSH_FULL_E2E === "1";
const relayControl = process.env.WEBLOUNGE_PUSH_RELAY_CONTROL ?? "";
const receiverRecords = process.env.WEBLOUNGE_PUSH_RECEIVER_RECORDS ?? "";
const currentApp = process.env.WEBLOUNGE_APP_DIR ?? "";
const appLink = process.env.WEBLOUNGE_PUSH_APP_LINK ?? "";
const oauthToken = "push-e2e-token";
let receiverCursor = 0;

interface RelayDeviceState {
  readonly id: string;
  readonly probing: number;
  readonly active: number;
  readonly dead: number;
  readonly leases: number;
}

interface ReceiverRecord {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

test.describe("full unmocked push lifecycle", () => {
  test.skip(!enabled, "requires the local push E2E VM");
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;
  let audit: IrcClient;
  let bot: IrcClient;

  test.beforeAll(async ({ browser }) => {
    context = await pushContext(browser, "a");
    page = await context.newPage();
    audit = await IrcClient.connectOAuth("push-audit", oauthToken);
  });

  test.afterAll(async () => {
    bot?.close();
    audit?.close();
    await context?.close();
  });

  test("enables once in the deployed build and upgrades in place", async () => {
    await page.goto("/");
    await expect(connectionHeading(page)).toBeVisible();
    await page.getByRole("button", { name: "Turn on" }).click();

    await expectOneRoutePerDevice(1);
    await expect.poll(() => audit.pushSubscriptionEndpoints()).toHaveLength(1);

    await switchToCurrentBuild();
    await page.reload();
    await expect(connectionHeading(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.weblounge.version))
      .toContain("weblounge ci");
    await expectOneRoutePerDevice(1);
    await expect.poll(() => audit.pushSubscriptionEndpoints()).toHaveLength(1);
    const expired = await fetch(`${relayControl}/test/expire-leases`, {
      method: "POST",
    });
    expect(expired.status).toBe(204);
  });

  test("keeps one route through reconnect and two tabs", async () => {
    await context.setOffline(true);
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(0);
    await context.setOffline(false);
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);

    const second = await context.newPage();
    await second.goto("/");
    await expect(second.locator('[data-network-state="online"]')).toHaveCount(
      1,
    );
    await expectOneRoutePerDevice(1);
    await expect.poll(() => audit.pushSubscriptionEndpoints()).toHaveLength(1);
    await second.close();
  });

  test("delivers one real DM and mention and recovers missing route keys", async () => {
    bot = await IrcClient.connectIsolated(
      `push-bot-${randomUUID().slice(0, 8)}`,
      "#push-e2e",
    );
    await releaseForegroundLeases([page]);

    const direct = `full-chain direct ${randomUUID()}`;
    await bot.privmsgConfirmed("weblounge", direct);
    const directRecord = await nextRecord("/device/a");
    expect(directRecord.headers["content-encoding"]).toBe("aes128gcm");
    expect(directRecord.headers.authorization).toMatch(/^vapid /);
    expect(Number(directRecord.headers.ttl)).toBeGreaterThan(0);
    await deliverRecordedEnvelope(context, page, directRecord);
    await expectNotification(page, direct);
    await closeNotifications(page);

    const mention = `weblounge: full-chain mention ${randomUUID()}`;
    await bot.privmsgConfirmed("#push-e2e", mention);
    const mentionRecord = await nextRecord("/device/a");
    await deliverRecordedEnvelope(context, page, mentionRecord);
    await expectNotification(page, mention);
    await closeNotifications(page);

    const missingKeys = `missing route keys ${randomUUID()}`;
    await bot.privmsgConfirmed("weblounge", missingKeys);
    const missingRecord = await nextRecord("/device/a");
    await breakStoredRouteKeys(page);
    await deliverRecordedEnvelope(context, page, missingRecord);
    await expect
      .poll(() => notifications(page))
      .toEqual([{ title: "New message", body: "", tag: "" }]);
    await restoreStoredRouteKeys(page);

    await page.goto("/");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    await expectOneRoutePerDevice(1);
    await expect.poll(() => audit.pushSubscriptionEndpoints()).toHaveLength(1);
  });

  test("does not tidy the notification shown by the current push", async () => {
    await closeNotifications(page);
    await seedReadConversationState(page, `1/${bot.nickname.toLowerCase()}`);
    await releaseForegroundLeases([page]);

    const direct = `tidy keeps current push ${randomUUID()}`;
    await bot.privmsgConfirmed("weblounge", direct);
    const record = await nextRecord("/device/a");
    await deliverRecordedEnvelope(context, page, record);

    await expectNotification(page, direct);
    await expect.poll(() => storedAppBadge(page)).toBe(1);
  });

  test("keeps Apple-style MARKREAD silent when another device reads", async ({
    browser,
  }) => {
    const otherContext = await pushContext(browser, "b");
    const other = await otherContext.newPage();
    try {
      await other.goto("/");
      await expect(connectionHeading(other)).toBeVisible();
      await other.getByRole("button", { name: "Turn on" }).click();
      await expectOneRoutePerDevice(2);
      await expect
        .poll(() => audit.pushSubscriptionEndpoints())
        .toHaveLength(2);

      await closeNotifications(page);
      await releaseForegroundLeases([page, other]);
      const direct = `read elsewhere ${randomUUID()}`;
      await bot.privmsgConfirmed("weblounge", direct);
      const [first, second] = await nextRecords(["/device/a", "/device/b"]);
      await deliverRecordedEnvelope(context, page, first);
      await deliverRecordedEnvelope(otherContext, other, second);
      await expectNotification(page, direct);
      await expectNotification(other, direct);

      const droppedBefore = await normalPushesDropped();
      await other.goto("/");
      await expect(connectionHeading(other)).toBeVisible();
      await other
        .getByRole("complementary", { name: "Channel list" })
        .getByRole("button", {
          name: new RegExp(`^${bot.nickname},`, "u"),
        })
        .click();
      await expect.poll(() => normalPushesDropped()).toBe(droppedBefore + 1);
      expect((await records()).length).toBe(receiverCursor);
      await expect.poll(() => notifications(other)).toEqual([]);
      await expect(notifications(page)).resolves.toHaveLength(1);
    } finally {
      await otherContext.close();
    }
  });

  test("re-grants permission, rotates keys, and recovers a refused REGISTER", async () => {
    await page.bringToFront();
    await closeNotifications(page);
    await releaseForegroundLeases([page]);
    const previousEndpoints = await audit.pushSubscriptionEndpoints();
    expect(previousEndpoints).toHaveLength(2);
    const direct = `registration refusal ${randomUUID()}`;
    await bot.privmsgConfirmed("weblounge", direct);
    const record = await nextRecord("/device/a");
    const envelope = JSON.parse(
      await decryptRecordedEnvelope(page, record),
    ) as { notification: { data: { c: string } } };
    const ciphertext = envelope.notification.data.c;
    envelope.notification.data.c = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
    await deliverPush(context, page, JSON.stringify(envelope));
    await expect.poll(() => routeNeedsReregistration(page)).toBe(true);

    const refusal = await fetch(`${relayControl}/test/refuse-next-push`, {
      method: "POST",
    });
    expect(refusal.status).toBe(204);
    await page.evaluate(() => localStorage.removeItem("push-e2e-permission"));
    await page.goto("/");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Turn on" }).click();
    let currentEndpoints: readonly string[] = [];
    await expect
      .poll(async () => {
        currentEndpoints = await audit.pushSubscriptionEndpoints();
        return {
          count: currentEndpoints.length,
          retained: currentEndpoints.filter((endpoint) =>
            previousEndpoints.includes(endpoint),
          ).length,
        };
      })
      .toEqual({ count: 2, retained: 1 });
    await expectOneRoutePerDevice(2);
  });
});

function connectionHeading(page: Page) {
  return page
    .getByRole("complementary", { name: "Channel list" })
    .getByRole("heading", { name: "weblounge" });
}

async function pushContext(
  browser: Browser,
  deviceId: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const origin = process.env.WEBLOUNGE_E2E_BASE_URL;
  if (origin === undefined) throw new Error("push E2E base URL is missing");
  await context.grantPermissions(["notifications"], { origin });
  await context.addInitScript(installPushSubscription, deviceId);
  return context;
}

async function installPushSubscription(deviceId: string): Promise<void> {
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: () => false,
  });
  const databaseName = "weblounge-push-e2e-subscription";
  const storeName = "target";
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const load = async () => {
    const database = await open();
    const transaction = database.transaction(storeName, "readonly");
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = transaction.objectStore(storeName).get("subscription");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value as
      | {
          applicationServerKey: ArrayBuffer;
          auth: Uint8Array;
          privateKey: CryptoKey;
          publicKey: Uint8Array;
        }
      | undefined;
  };
  const save = async (value: unknown) => {
    const database = await open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value, "subscription");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  };
  const remove = async () => {
    const database = await open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete("subscription");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  };
  const subscription = async (): Promise<PushSubscription | null> => {
    const value = await load();
    if (value === undefined) return null;
    return {
      endpoint: `https://web.push.apple.com/device/${deviceId}`,
      expirationTime: null,
      options: {
        applicationServerKey: value.applicationServerKey,
        userVisibleOnly: true,
      },
      getKey: (name: PushEncryptionKeyName) =>
        (name === "p256dh" ? value.publicKey : value.auth).buffer.slice(0),
      toJSON: () => ({}),
      unsubscribe: async () => {
        await remove();
        return true;
      },
    } as PushSubscription;
  };
  PushManager.prototype.getSubscription = subscription;
  PushManager.prototype.subscribe = async (
    options?: PushSubscriptionOptions,
  ) => {
    if (options?.applicationServerKey === undefined) {
      throw new Error("application server key is required");
    }
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    )) as CryptoKeyPair;
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const applicationServerKey = new Uint8Array(options.applicationServerKey)
      .buffer;
    await save({
      applicationServerKey,
      auth,
      privateKey: pair.privateKey,
      publicKey,
    });
    const created = await subscription();
    if (created === null) throw new Error("subscription was not stored");
    return created;
  };

  let permission: NotificationPermission =
    localStorage.getItem("push-e2e-permission") === "granted"
      ? "granted"
      : "default";
  Object.defineProperty(Notification, "permission", {
    configurable: true,
    get: () => permission,
  });
  Object.defineProperty(Notification, "requestPermission", {
    configurable: true,
    value: () => {
      permission = "granted";
      localStorage.setItem("push-e2e-permission", "granted");
      return Promise.resolve(permission);
    },
  });
}

async function switchToCurrentBuild(): Promise<void> {
  if (currentApp === "" || appLink === "") {
    throw new Error("push E2E app paths are missing");
  }
  const next = `${appLink}.next`;
  await rm(next, { force: true });
  await symlink(currentApp, next);
  await rename(next, appLink);
}

async function relayStates(): Promise<readonly RelayDeviceState[]> {
  const response = await fetch(`${relayControl}/test/device-states`);
  if (!response.ok) throw new Error(`relay state returned ${response.status}`);
  return (await response.json()) as RelayDeviceState[];
}

async function expectOneRoutePerDevice(deviceCount: number): Promise<void> {
  await expect
    .poll(async () => {
      const states = await relayStates();
      return {
        devices: states.length,
        active: states.map((state) => state.active),
        probing: states.map((state) => state.probing),
      };
    })
    .toEqual({
      devices: deviceCount,
      active: Array.from({ length: deviceCount }, () => 1),
      probing: Array.from({ length: deviceCount }, () => 0),
    });
  const health = await (await fetch(`${relayControl}/healthz`)).text();
  expect(health).toContain(
    "weblounge_push_relay_duplicate_active_route_devices 0",
  );
}

async function releaseForegroundLeases(pages: readonly Page[]): Promise<void> {
  for (const target of pages) await target.goto("/push-driver.html");
  const expired = await fetch(`${relayControl}/test/expire-leases`, {
    method: "POST",
  });
  expect(expired.status).toBe(204);
  await expect
    .poll(async () => {
      const states = await relayStates();
      return pages.length > 0 && states.every((state) => state.leases === 0);
    })
    .toBe(true);
}

async function records(): Promise<readonly ReceiverRecord[]> {
  const response = await fetch(receiverRecords);
  if (response.status === 404) return [];
  if (!response.ok)
    throw new Error(`receiver records returned ${response.status}`);
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ReceiverRecord);
}

async function nextRecord(path: string): Promise<ReceiverRecord> {
  let found: ReceiverRecord | undefined;
  await expect
    .poll(async () => {
      const current = await records();
      for (let index = receiverCursor; index < current.length; index += 1) {
        const candidate = current[index];
        receiverCursor = index + 1;
        if (candidate?.path === path) {
          found = candidate;
          break;
        }
      }
      return found?.path;
    })
    .toBe(path);
  if (found === undefined) throw new Error(`receiver did not record ${path}`);
  return found;
}

async function nextRecords(
  paths: readonly string[],
): Promise<ReceiverRecord[]> {
  let found: ReceiverRecord[] = [];
  await expect
    .poll(async () => {
      const current = await records();
      const pending = current.slice(receiverCursor);
      const candidates = paths.map((path) =>
        pending.find((record) => record.path === path),
      );
      if (candidates.every((record) => record !== undefined)) {
        found = candidates as ReceiverRecord[];
        receiverCursor = current.length;
      }
      return found.map((record) => record.path);
    })
    .toEqual(paths);
  return found;
}

async function decryptRecordedEnvelope(
  page: Page,
  record: ReceiverRecord,
): Promise<string> {
  return page.evaluate(async (encodedBody) => {
    const decode = (encoded: string) =>
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const concatenate = (...parts: Uint8Array[]) => {
      const result = new Uint8Array(
        parts.reduce((length, part) => length + part.byteLength, 0),
      );
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
      }
      return result;
    };
    const hkdf = async (
      input: BufferSource,
      salt: BufferSource,
      info: BufferSource,
      length: number,
    ) => {
      const key = await crypto.subtle.importKey("raw", input, "HKDF", false, [
        "deriveBits",
      ]);
      return crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info },
        key,
        length,
      );
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-e2e-subscription", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("target", "readonly");
    const target = await new Promise<{
      auth: Uint8Array;
      privateKey: CryptoKey;
      publicKey: Uint8Array;
    }>((resolve, reject) => {
      const request = transaction.objectStore("target").get("subscription");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const body = decode(encodedBody);
    const salt = body.slice(0, 16);
    const publicLength = body[20];
    if (publicLength === undefined)
      throw new Error("outer key length is missing");
    const senderPublic = body.slice(21, 21 + publicLength);
    const ciphertext = body.slice(21 + publicLength);
    const importedSender = await crypto.subtle.importKey(
      "raw",
      senderPublic,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const shared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: importedSender },
      target.privateKey,
      256,
    );
    const encoder = new TextEncoder();
    const inputKeyMaterial = await hkdf(
      shared,
      target.auth,
      concatenate(
        encoder.encode("WebPush: info\0"),
        target.publicKey,
        senderPublic,
      ),
      256,
    );
    const contentKey = await hkdf(
      inputKeyMaterial,
      salt,
      encoder.encode("Content-Encoding: aes128gcm\0"),
      128,
    );
    const nonce = await hkdf(
      inputKeyMaterial,
      salt,
      encoder.encode("Content-Encoding: nonce\0"),
      96,
    );
    const key = await crypto.subtle.importKey(
      "raw",
      contentKey,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, tagLength: 128 },
        key,
        ciphertext,
      ),
    );
    if (plaintext.at(-1) !== 2) throw new Error("outer delimiter is invalid");
    return new TextDecoder().decode(plaintext.slice(0, -1));
  }, record.body);
}

async function deliverRecordedEnvelope(
  context: BrowserContext,
  page: Page,
  record: ReceiverRecord,
): Promise<void> {
  await deliverPush(context, page, await decryptRecordedEnvelope(page, record));
}

async function deliverPush(
  context: BrowserContext,
  page: Page,
  data: string,
): Promise<void> {
  const session = await context.newCDPSession(page);
  const registration = new Promise<string>((resolve) => {
    session.on(
      "ServiceWorker.workerRegistrationUpdated",
      ({ registrations }) => {
        const current = registrations.find(
          (candidate) =>
            !candidate.isDeleted &&
            candidate.scopeURL === new URL("/", page.url()).href,
        );
        if (current !== undefined) resolve(current.registrationId);
      },
    );
  });
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.deliverPushMessage", {
    origin: new URL(page.url()).origin,
    registrationId: await registration,
    data,
  });
  await session.detach();
}

async function notifications(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return (await registration?.getNotifications())?.map((notification) => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
    }));
  });
}

async function expectNotification(page: Page, body: string): Promise<void> {
  await expect
    .poll(() => notifications(page))
    .toEqual([expect.objectContaining({ body })]);
}

async function closeNotifications(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    for (const notification of (await registration?.getNotifications()) ?? []) {
      notification.close();
    }
  });
  await expect.poll(() => notifications(page)).toEqual([]);
}

async function seedReadConversationState(
  page: Page,
  tag: string,
): Promise<void> {
  await page.evaluate(async (conversationTag) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readwrite");
    const store = transaction.objectStore("state");
    store.put(
      { schema: 1, conversations: [[conversationTag, 0]], untagged: 0 },
      "notification-counts",
    );
    store.put(0, "app-badge");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, tag);
}

async function storedAppBadge(page: Page): Promise<number | undefined> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readonly");
    const request = transaction.objectStore("state").get("app-badge");
    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return typeof value === "number" ? value : undefined;
  });
}

async function breakStoredRouteKeys(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("routes", "readwrite");
    const store = transaction.objectStore("routes");
    const routes = await new Promise<readonly Record<string, unknown>[]>(
      (resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () =>
          resolve(request.result as readonly Record<string, unknown>[]);
        request.onerror = () => reject(request.error);
      },
    );
    Reflect.set(window, "pushE2eSavedRoutes", routes);
    for (const route of routes) store.put({ ...route, privateKey: "missing" });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
}

async function restoreStoredRouteKeys(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const routes = Reflect.get(window, "pushE2eSavedRoutes") as
      | readonly Record<string, unknown>[]
      | undefined;
    if (routes === undefined) throw new Error("push route keys were not saved");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("routes", "readwrite");
    const store = transaction.objectStore("routes");
    for (const route of routes) store.put(route);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    Reflect.deleteProperty(window, "pushE2eSavedRoutes");
  });
}

async function routeNeedsReregistration(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("routes", "readonly");
    const routes = await new Promise<readonly unknown[]>((resolve, reject) => {
      const request = transaction.objectStore("routes").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return routes.some(
      (route) =>
        typeof route === "object" &&
        route !== null &&
        "needsReregistration" in route &&
        route.needsReregistration === true,
    );
  });
}

async function normalPushesDropped(): Promise<number> {
  const response = await fetch(`${relayControl}/test/counters`);
  if (!response.ok)
    throw new Error(`relay counters returned ${response.status}`);
  const counters = (await response.json()) as {
    readonly normal_pushes_dropped: number;
  };
  return counters.normal_pushes_dropped;
}
