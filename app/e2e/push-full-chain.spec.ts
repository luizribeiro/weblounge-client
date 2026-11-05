import { randomUUID } from "node:crypto";
import { rename, rm, symlink } from "node:fs/promises";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  expect,
  type JSHandle,
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
  let deployedDatabasePage: Page;
  let deployedPushDatabase: JSHandle<IDBDatabase>;
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

    deployedDatabasePage = await context.newPage();
    await deployedDatabasePage.goto("/push-driver.html");
    deployedPushDatabase = await deployedDatabasePage.evaluateHandle(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("weblounge-push");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
    );

    await switchToCurrentBuild();
    await activateCurrentServiceWorker(page);
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
    await deployedPushDatabase.evaluate((database) => database.close());
    await deployedPushDatabase.dispose();
    await deployedDatabasePage.close();
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
    const badgeBefore = (await storedAppBadge(page)) ?? 0;

    const direct = `tidy keeps current push ${randomUUID()}`;
    await bot.privmsgConfirmed("weblounge", direct);
    const record = await nextRecord("/device/a");
    await deliverRecordedEnvelope(context, page, record);

    await expectNotification(page, direct);
    await expect.poll(() => storedAppBadge(page)).toBe(badgeBefore + 1);
  });

  test("shows a notification before a blocked IndexedDB deadline", async () => {
    await closeNotifications(page);
    await releaseForegroundLeases([page]);
    await page.goto("/push-driver.html");
    const blocker = await blockPushRouteReads(page);
    const direct = `blocked database ${randomUUID()}`;
    await bot.privmsgConfirmed("weblounge", direct);
    const record = await nextRecord("/device/a");
    await deliverRecordedEnvelope(context, page, record);

    try {
      await expect
        .poll(() => notifications(page), {
          intervals: [50],
          timeout: 2_500,
        })
        .toEqual([{ title: "New message", body: "", tag: "" }]);
    } finally {
      await blocker.evaluate((transaction) => {
        transaction.abort();
        transaction.db.close();
      });
      await blocker.dispose();
    }
    await drainPushRouteReads(page);
    await expect(notifications(page)).resolves.toEqual([
      { title: "New message", body: "", tag: "" },
    ]);
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
      const badgeBefore = (await storedAppBadge(page)) ?? 0;
      const direct = `read elsewhere ${randomUUID()}`;
      await bot.privmsgConfirmed("weblounge", direct);
      const [first, second] = await nextRecords(["/device/a", "/device/b"]);
      await deliverRecordedEnvelope(context, page, first);
      await deliverRecordedEnvelope(otherContext, other, second);
      await expectNotification(page, direct);
      await expectNotification(other, direct);
      const originalNotification = [
        {
          title: bot.nickname,
          body: direct,
          tag: `weblounge/${bot.nickname.toLowerCase()}`,
        },
      ];
      await expect(notifications(page)).resolves.toEqual(originalNotification);
      await expect.poll(() => storedAppBadge(page)).toBe(badgeBefore + 1);

      const droppedBefore = await normalPushesDropped();
      await other.goto("/");
      await expect(connectionHeading(other)).toBeVisible();
      await other
        .getByRole("complementary", { name: "Channel list" })
        .getByRole("button", {
          name: new RegExp(`^${bot.nickname},`, "u"),
        })
        .click();
      await expect.poll(() => normalPushesDropped()).toBe(droppedBefore + 2);
      expect((await records()).length).toBe(receiverCursor);
      await expect.poll(() => notifications(other)).toEqual([]);
      await expect
        .poll(() => notifications(page))
        .toEqual(originalNotification);
      await expect.poll(() => storedAppBadge(page)).toBe(badgeBefore + 1);

      await context.addInitScript(installAppBadgeSpy);
      await page.goto("/");
      await expect(connectionHeading(page)).toBeVisible();
      await expect.poll(() => notifications(page)).toEqual([]);
      await expect
        .poll(async () => {
          const corrected = await latestAppBadgeCall(page);
          const stored = await storedAppBadge(page);
          return (
            corrected !== undefined &&
            corrected < badgeBefore + 1 &&
            corrected === stored
          );
        })
        .toBe(true);
    } finally {
      await otherContext.close();
    }
  });
});

test.describe("independent push route reopen", () => {
  test.skip(!enabled, "requires the local push E2E VM");

  test("keeps the active route and delivers after the app reopens", async ({
    browser,
  }) => {
    await switchToCurrentBuild();
    const context = await pushContext(browser, "route-reopen");
    let page = await context.newPage();
    const audit = await IrcClient.connectOAuth("push-audit", oauthToken);
    const bot = await IrcClient.connectIsolated(
      `push-reopen-${randomUUID().slice(0, 8)}`,
      "#push-e2e",
    );
    try {
      const devicesBefore = new Set((await relayStates()).map(({ id }) => id));
      const endpointsBefore = await audit.pushSubscriptionEndpoints();
      await page.goto("/");
      await expect(connectionHeading(page)).toBeVisible();
      await page.getByRole("button", { name: "Turn on" }).click();

      let deviceId: string | undefined;
      await expect
        .poll(async () => {
          const created = (await relayStates()).find(
            ({ id }) => !devicesBefore.has(id),
          );
          deviceId = created?.id;
          return created === undefined
            ? undefined
            : { active: created.active, probing: created.probing };
        })
        .toEqual({ active: 1, probing: 0 });
      await expect
        .poll(() => audit.pushSubscriptionEndpoints())
        .toHaveLength(endpointsBefore.length + 1);
      const registeredEndpoints = await audit.pushSubscriptionEndpoints();
      const routeEndpoints = registeredEndpoints.filter(
        (endpoint) => !endpointsBefore.includes(endpoint),
      );
      expect(routeEndpoints).toHaveLength(1);
      const [routeEndpoint] = routeEndpoints;
      if (deviceId === undefined)
        throw new Error("relay device was not created");

      await page.close();
      page = await context.newPage();
      await page.goto("/");
      await expect(connectionHeading(page)).toBeVisible();
      await expect
        .poll(async () => {
          const reopened = (await relayStates()).find(
            ({ id }) => id === deviceId,
          );
          return reopened === undefined
            ? undefined
            : { active: reopened.active, probing: reopened.probing };
        })
        .toEqual({ active: 1, probing: 0 });
      expect(await audit.pushSubscriptionEndpoints()).toContain(routeEndpoint);

      await closeNotifications(page);
      await releaseForegroundLeases([page]);
      const direct = `push survives reopen ${randomUUID()}`;
      await bot.privmsgConfirmed("weblounge", direct);
      const record = await nextRecord("/device/route-reopen");
      await deliverRecordedEnvelope(context, page, record);
      await expectNotification(page, direct);
    } finally {
      bot.close();
      audit.close();
      await context.close();
    }
  });
});

test.describe("independent push recovery", () => {
  test.skip(!enabled, "requires the local push E2E VM");

  test("re-grants permission, rotates keys, and recovers a refused REGISTER", async ({
    browser,
  }) => {
    await switchToCurrentBuild();
    const context = await pushContext(browser, "registration-refusal");
    const page = await context.newPage();
    const audit = await IrcClient.connectOAuth("push-audit", oauthToken);
    const bot = await IrcClient.connectIsolated(
      `push-bot-${randomUUID().slice(0, 8)}`,
      "#push-e2e",
    );
    try {
      const devicesBefore = new Set((await relayStates()).map(({ id }) => id));
      const endpointsBefore = await audit.pushSubscriptionEndpoints();
      await page.goto("/");
      await expect(connectionHeading(page)).toBeVisible();
      await page.getByRole("button", { name: "Turn on" }).click();
      await expect
        .poll(async () => {
          const created = (await relayStates()).find(
            ({ id }) => !devicesBefore.has(id),
          );
          return created === undefined
            ? undefined
            : { active: created.active, probing: created.probing };
        })
        .toEqual({ active: 1, probing: 0 });
      const deviceCount = (await relayStates()).length;
      await expectOneRoutePerDevice(deviceCount);
      await closeNotifications(page);
      await releaseForegroundLeases([page]);
      await expect
        .poll(() => audit.pushSubscriptionEndpoints())
        .toHaveLength(endpointsBefore.length + 1);
      const previousEndpoints = await audit.pushSubscriptionEndpoints();
      const direct = `registration refusal ${randomUUID()}`;
      await bot.privmsgConfirmed("weblounge", direct);
      const record = await nextRecord("/device/registration-refusal");
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
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
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
        .toEqual({
          count: previousEndpoints.length,
          retained: previousEndpoints.length - 1,
        });
      await expectOneRoutePerDevice(deviceCount);
    } finally {
      bot.close();
      audit.close();
      await context.close();
    }
  });
});

test.describe("independent portable push controls", () => {
  test.skip(!enabled, "requires the local push E2E VM");

  test("keeps portable control messages silent", async ({
    browser,
    browserName,
  }) => {
    await switchToCurrentBuild();
    const deviceId = `controls-${browserName}`;
    const controlContext = await pushContext(
      browser,
      deviceId,
      "updates.push.services.mozilla.com",
    );
    const control = await controlContext.newPage();
    const controlBot = await IrcClient.connectIsolated(
      `control-bot-${randomUUID().slice(0, 8)}`,
      "#push-e2e",
    );
    const audit = await IrcClient.connectOAuth("push-audit", oauthToken);
    try {
      const devicesBefore = new Set((await relayStates()).map(({ id }) => id));
      await control.goto("/");
      await expect(connectionHeading(control)).toBeVisible();
      await control.getByRole("button", { name: "Turn on" }).click();
      await expect
        .poll(async () => {
          const created = (await relayStates()).find(
            ({ id }) => !devicesBefore.has(id),
          );
          return created === undefined
            ? undefined
            : { active: created.active, probing: created.probing };
        })
        .toEqual({ active: 1, probing: 0 });
      await preparePortablePushDriver(control);
      await releaseForegroundLeases([control]);
      const badgeBefore = (await storedAppBadge(control)) ?? 0;

      const direct = `portable control ${browserName} ${randomUUID()}`;
      const echoed = await controlBot.privmsgConfirmed("weblounge", direct);
      const message = await nextRecord(`/device/${deviceId}`);
      await deliverPortableEnvelope(control, message);
      await expectNotification(control, direct);
      await expect.poll(() => storedAppBadge(control)).toBe(badgeBefore + 1);

      await audit.markRead(controlBot.nickname, serverTime(echoed));
      const markread = await nextRecord(`/device/${deviceId}`);
      await deliverPortableEnvelope(control, markread);
      await expect.poll(() => storedAppBadge(control)).toBe(badgeBefore);

      await expect.poll(() => notifications(control)).toEqual([]);
    } finally {
      audit.close();
      controlBot.close();
      await controlContext.close();
    }
  });
});

test.describe("independent Apple badge recovery", () => {
  test.skip(!enabled, "requires the local push E2E VM");

  test("corrects a stale Apple badge when the app opens", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "webkit", "models iOS WebKit badge recovery");
    await switchToCurrentBuild();
    const deviceId = "ios-badge-stale";
    const iosContext = await pushContext(browser, deviceId);
    await iosContext.addInitScript(installAppBadgeSpy);
    let ios = await iosContext.newPage();
    const iosBot = await IrcClient.connectIsolated(
      `ios-badge-bot-${randomUUID().slice(0, 8)}`,
      "#push-e2e",
    );
    const audit = await IrcClient.connectOAuth("push-audit", oauthToken);
    try {
      const devicesBefore = new Set((await relayStates()).map(({ id }) => id));
      await ios.goto("/");
      await expect(connectionHeading(ios)).toBeVisible();
      await ios.getByRole("button", { name: "Turn on" }).click();
      await expect
        .poll(async () => {
          const created = (await relayStates()).find(
            ({ id }) => !devicesBefore.has(id),
          );
          return created === undefined
            ? undefined
            : { active: created.active, probing: created.probing };
        })
        .toEqual({ active: 1, probing: 0 });
      await releaseForegroundLeases([ios]);

      const direct = `stale Apple badge ${randomUUID()}`;
      const echoed = await iosBot.privmsgConfirmed("weblounge", direct);
      await nextRecord(`/device/${deviceId}`);
      const droppedBefore = await normalPushesDropped();
      await audit.markRead(iosBot.nickname, serverTime(echoed));
      await expect
        .poll(() => normalPushesDropped())
        .toBeGreaterThan(droppedBefore);

      await seedAppBadge(ios, 999);
      await ios.close();
      ios = await iosContext.newPage();
      await ios.goto("/");
      await expect(connectionHeading(ios)).toBeVisible();
      await expect
        .poll(async () => {
          const corrected = await latestAppBadgeCall(ios);
          const stored = await storedAppBadge(ios);
          return (
            corrected !== undefined && corrected !== 999 && corrected === stored
          );
        })
        .toBe(true);
    } finally {
      audit.close();
      iosBot.close();
      await iosContext.close();
    }
  });
});

function connectionHeading(page: Page) {
  return page
    .getByRole("complementary", { name: "Channel list" })
    .getByRole("heading", { name: "weblounge" });
}

function serverTime(line: string): string {
  const timestamp = /(?:^@|;)time=([^; ]+)/u.exec(line)?.[1];
  if (timestamp === undefined)
    throw new Error(`IRC line has no server time: ${line}`);
  return timestamp;
}

async function pushContext(
  browser: Browser,
  deviceId: string,
  endpointHost = "web.push.apple.com",
): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const origin = process.env.WEBLOUNGE_E2E_BASE_URL;
  if (origin === undefined) throw new Error("push E2E base URL is missing");
  await context.grantPermissions(["notifications"], { origin });
  await context.addInitScript(installPushSubscription, {
    deviceId,
    endpointHost,
  });
  return context;
}

async function installPushSubscription({
  deviceId,
  endpointHost,
}: {
  deviceId: string;
  endpointHost: string;
}): Promise<void> {
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
      endpoint: `https://${endpointHost}/device/${deviceId}`,
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

async function activateCurrentServiceWorker(page: Page): Promise<void> {
  const previous = await page.evaluateHandle(
    () => navigator.serviceWorker.controller,
  );
  try {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (registration === undefined)
        throw new Error("root service worker is not registered");
      await registration.update();
    });
    await expect
      .poll(() =>
        page.evaluate(
          (oldController) =>
            navigator.serviceWorker.controller !== oldController &&
            navigator.serviceWorker.controller?.state === "activated",
          previous,
        ),
      )
      .toBe(true);
  } finally {
    await previous.dispose();
  }
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

async function preparePortablePushDriver(page: Page): Promise<void> {
  await page.goto("/push-driver.html");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      "/push-driver-sw.js",
      { scope: "/push-driver/" },
    );
    const worker =
      registration.active ?? registration.waiting ?? registration.installing;
    if (worker === null) throw new Error("push driver worker is missing");
    if (worker.state === "activated") return;
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant")
          reject(new Error("push driver worker became redundant"));
      });
    });
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration =
          await navigator.serviceWorker.getRegistration("/push-driver/");
        return registration?.active?.state;
      }),
    )
    .toBe("activated");
}

async function deliverPortableEnvelope(
  page: Page,
  record: ReceiverRecord,
): Promise<void> {
  const envelope = await decryptRecordedEnvelope(page, record);
  const deliveryId = randomUUID();
  await page.evaluate(
    async ({ deliveryId, payload }) => {
      const registration =
        await navigator.serviceWorker.getRegistration("/push-driver/");
      if (registration?.active === undefined)
        throw new Error("push driver worker is not active");
      registration.active.postMessage({
        type: "deliver-push",
        deliveryId,
        payload,
      });
    },
    { deliveryId, payload: envelope },
  );
  let result: { ok: boolean; error?: string } | undefined;
  await expect
    .poll(async () => {
      result = await page.evaluate(async (id) => {
        const response = await caches.match(`/push-driver-result/${id}`);
        return response === undefined ? undefined : response.json();
      }, deliveryId);
      return result === undefined ? "pending" : "complete";
    })
    .toBe("complete");
  if (result?.ok !== true)
    throw new Error(result?.error ?? "push delivery failed");
}

async function deliverPush(
  context: BrowserContext,
  page: Page,
  data: string,
): Promise<void> {
  const { registrationId, session } = await pushDeliveryTarget(context, page);
  await session.send("ServiceWorker.deliverPushMessage", {
    origin: new URL(page.url()).origin,
    registrationId,
    data,
  });
}

const pushDeliveryTargets = new WeakMap<
  Page,
  Promise<{ readonly registrationId: string; readonly session: CDPSession }>
>();

function pushDeliveryTarget(
  context: BrowserContext,
  page: Page,
): Promise<{ readonly registrationId: string; readonly session: CDPSession }> {
  const existing = pushDeliveryTargets.get(page);
  if (existing !== undefined) return existing;
  const created = createPushDeliveryTarget(context, page);
  pushDeliveryTargets.set(page, created);
  return created;
}

async function createPushDeliveryTarget(
  context: BrowserContext,
  page: Page,
): Promise<{ readonly registrationId: string; readonly session: CDPSession }> {
  const session = await context.newCDPSession(page);
  const registrationId = new Promise<string>((resolve) => {
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
  return { registrationId: await registrationId, session };
}

async function notifications(page: Page) {
  return page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const visible = await Promise.all(
      registrations.map((registration) => registration.getNotifications()),
    );
    const actual = visible.flat().map((notification) => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
    }));
    const recorded = await caches.match("/push-driver-notifications");
    const portable =
      recorded === undefined ? [] : ((await recorded.json()) as typeof actual);
    return [...actual, ...portable];
  });
}

async function expectNotification(page: Page, body: string): Promise<void> {
  await expect
    .poll(() => notifications(page))
    .toEqual([expect.objectContaining({ body })]);
}

async function closeNotifications(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      for (const notification of await registration.getNotifications()) {
        notification.close();
      }
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
      const request = indexedDB.open("weblounge-push-v2");
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

async function seedAppBadge(page: Page, count: number): Promise<void> {
  await page.evaluate(async (value) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(value, "app-badge");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, count);
}

function installAppBadgeSpy(): void {
  Reflect.set(globalThis, "pushE2eAppBadgeCalls", []);
  Object.defineProperties(Navigator.prototype, {
    setAppBadge: {
      configurable: true,
      value: async (count: number) => {
        const calls = Reflect.get(globalThis, "pushE2eAppBadgeCalls");
        if (Array.isArray(calls)) calls.push(count);
      },
    },
    clearAppBadge: {
      configurable: true,
      value: async () => {
        const calls = Reflect.get(globalThis, "pushE2eAppBadgeCalls");
        if (Array.isArray(calls)) calls.push(0);
      },
    },
  });
}

async function latestAppBadgeCall(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const calls = Reflect.get(globalThis, "pushE2eAppBadgeCalls");
    if (!Array.isArray(calls)) return undefined;
    const latest: unknown = calls.at(-1);
    return typeof latest === "number" ? latest : undefined;
  });
}

async function storedAppBadge(page: Page): Promise<number | undefined> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
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

async function blockPushRouteReads(
  page: Page,
): Promise<JSHandle<IDBTransaction>> {
  return page.evaluateHandle(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("routes", "readwrite");
    const store = transaction.objectStore("routes");
    await new Promise<void>((resolve, reject) => {
      let acquired = false;
      const holdLock = () => {
        const request = store.get("__push-e2e-lock__");
        request.onsuccess = () => {
          holdLock();
          if (!acquired) {
            acquired = true;
            resolve();
          }
        };
        request.onerror = (event) => {
          event.preventDefault();
          if (!acquired) reject(request.error);
        };
      };
      holdLock();
    });
    return transaction;
  });
}

async function drainPushRouteReads(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("routes", "readonly");
    transaction.objectStore("routes").getAll();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
}

async function breakStoredRouteKeys(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
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
      const request = indexedDB.open("weblounge-push-v2");
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
      const request = indexedDB.open("weblounge-push-v2");
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
