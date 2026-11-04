import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  closeEngineDatabase,
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_STORES,
  ENGINE_DATABASE_VERSION,
  openEngineDatabase,
} from "./engine-database";
import { IrcClient } from "./irc-client";

const routeId = "route-push-e2e";

test("leaves a fresh engine database for the engine to create", async ({
  context,
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_DEV === "1",
    "the service worker is intentionally disabled in development",
  );
  await page.route("**/push-fresh", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/push-fresh");
  await context.grantPermissions(["notifications"], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
    });
    await navigator.serviceWorker.ready;
  });
  const envelope = await seedRouteAndEncrypt(
    page,
    "@time=2026-11-03T12:34:56.789Z;msgid=fresh-push :mel!m@example.test PRIVMSG #lounge :hello before engine storage",
  );

  await deliverPush(context, page, envelope);
  await expect.poll(() => notifications(page)).toHaveLength(1);
  await trackDedicatedEngine(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();

  await expect(loadNotificationPromptDismissal(page)).resolves.toBeUndefined();
  const database = await openEngineDatabase(page);
  try {
    await expect(
      database.evaluate((value) => ({
        name: value.name,
        stores: Array.from(value.objectStoreNames),
        version: value.version,
      })),
    ).resolves.toEqual({
      name: ENGINE_DATABASE_NAME,
      stores: [...ENGINE_DATABASE_STORES],
      version: ENGINE_DATABASE_VERSION,
    });
  } finally {
    await closeEngineDatabase(database);
  }
});

async function prepareServiceWorker(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  test.skip(
    process.env.WEBLOUNGE_E2E_DEV === "1",
    "the service worker is intentionally disabled in development",
  );
  await page.goto("/");
  await context.grantPermissions(["notifications"], {
    origin: new URL(page.url()).origin,
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return {
          active: registration.active?.state ?? null,
          controller: navigator.serviceWorker.controller?.state ?? null,
        };
      }),
    )
    .toEqual({ active: "activated", controller: "activated" });
}

test("decrypts a real envelope into one routed notification", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const line =
    "@time=2026-11-03T12:34:56.789Z;msgid=push-one :mel!m@example.test PRIVMSG #lounge :hello from push";
  const envelope = await seedRouteAndEncrypt(page, line);

  await deliverPush(context, page, envelope);

  await expect
    .poll(() => notifications(page))
    .toEqual([
      {
        title: "mel in #lounge",
        body: "hello from push",
        tag: "1/#lounge",
        route: "/Lounge/lounge",
      },
    ]);
});

test("re-shows a duplicate msgid without incrementing its badge", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const prefix =
    "@time=2026-11-03T12:34:56.789Z;msgid=push-duplicate :mel!m@example.test PRIVMSG #lounge :";
  await deliverPush(
    context,
    page,
    await seedRouteAndEncrypt(page, `${prefix}first delivery`),
  );
  await expect.poll(() => notifications(page)).toHaveLength(1);

  await deliverPush(
    context,
    page,
    await seedRouteAndEncrypt(page, `${prefix}second delivery`),
  );

  await expect
    .poll(() => notifications(page))
    .toEqual([
      {
        title: "mel in #lounge",
        body: "second delivery",
        tag: "1/#lounge",
        route: "/Lounge/lounge",
      },
    ]);
  await expect.poll(() => storedAppBadge(page)).toBe(1);
});

test("migrates and decrypts an active route from the previous schema", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const envelope = await seedRouteAndEncrypt(
    page,
    "@time=2026-11-03T12:34:56.789Z;msgid=push-upgrade :mel!m@example.test PRIVMSG #lounge :hello after upgrade",
    { networkLabel: "Lounge", nickname: "weblounge" },
    2,
  );

  await deliverPush(context, page, envelope);

  await expect
    .poll(() => notifications(page))
    .toContainEqual({
      title: "mel in #lounge",
      body: "hello after upgrade",
      tag: "1/#lounge",
      route: "/Lounge/lounge",
    });
});

test("shows MARKREAD and maintenance PING after applying cleanup", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  for (const [msgid, text] of [
    ["push-read-one", "first unread push"],
    ["push-read-two", "second unread push"],
  ]) {
    const envelope = await seedRouteAndEncrypt(
      page,
      `@time=2026-11-03T12:34:56.789Z;msgid=${msgid} :mel!m@example.test PRIVMSG #lounge :${text}`,
    );
    await deliverPush(context, page, envelope);
  }
  await expect.poll(() => notifications(page)).toHaveLength(1);
  await expect.poll(() => storedAppBadge(page)).toBe(2);

  const markread = await seedRouteAndEncrypt(
    page,
    ":irc.example.test MARKREAD #lounge timestamp=2026-11-03T12:34:56.789Z",
  );
  await deliverPush(context, page, markread);

  await expect
    .poll(() => notifications(page))
    .toEqual([{ title: "New message", body: "Lounge", tag: "", route: "/" }]);
  await expect.poll(() => storedAppBadge(page)).toBe(0);

  await closeNotifications(page);
  await seedReadNotification(page);
  await expect.poll(() => notifications(page)).toHaveLength(1);
  const ping = await seedRouteAndEncrypt(page, "PING :maintenance");
  await deliverPush(context, page, ping);
  await expect
    .poll(() => notifications(page))
    .toEqual([{ title: "New message", body: "Lounge", tag: "", route: "/" }]);
  await expect.poll(() => storedAppBadge(page)).toBe(0);

  await closeNotifications(page);
  const visible = await seedRouteAndEncrypt(
    page,
    "@time=2026-11-03T12:34:56.789Z;msgid=push-after-controls :mel!m@example.test PRIVMSG #lounge :visible after controls",
  );
  await deliverPush(context, page, visible);
  await expect
    .poll(() => notifications(page))
    .toEqual([
      {
        title: "mel in #lounge",
        body: "visible after controls",
        tag: "1/#lounge",
        route: "/Lounge/lounge",
      },
    ]);
  await expect.poll(() => storedAppBadge(page)).toBe(1);
});

test("shows one generic notification when decryption fails", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const envelope = await seedRouteAndEncrypt(
    page,
    "@time=2026-11-03T12:34:56.789Z;msgid=push-bad :mel!m@example.test PRIVMSG weblounge :secret",
  );
  const parsed = JSON.parse(envelope) as {
    notification: { data: { c: string } };
  };
  const ciphertext = parsed.notification.data.c;
  parsed.notification.data.c = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;

  await deliverPush(context, page, JSON.stringify(parsed));

  await expect
    .poll(() => notifications(page))
    .toEqual([{ title: "New message", body: "Lounge", tag: "", route: "/" }]);
  await expect.poll(() => routeNeedsReregistration(page)).toBe(true);
});

test("shows one generic notification when route keys are missing", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const envelope = JSON.parse(
    await seedRouteAndEncrypt(
      page,
      "@time=2026-11-03T12:34:56.789Z;msgid=push-missing-route :mel!m@example.test PRIVMSG #lounge :still visible",
    ),
  ) as { notification: { data: { r: string } } };
  envelope.notification.data.r = "missing-route";

  await deliverPush(context, page, JSON.stringify(envelope));

  await expect
    .poll(() => notifications(page))
    .toEqual([{ title: "New message", body: "", tag: "", route: "/" }]);
});

test("shows one generic notification without replacing keys when parsing fails", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const envelope = await seedRouteAndEncrypt(page, "this is not an IRC line");

  await deliverPush(context, page, envelope);

  await expect
    .poll(() => notifications(page))
    .toEqual([{ title: "New message", body: "Lounge", tag: "", route: "/" }]);
  expect(await routeNeedsReregistration(page)).toBe(false);
});

test("shows a cold pushed row before IRC and deduplicates its history copy", async ({
  context,
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
  await prepareServiceWorker(context, page);
  const bot = await IrcClient.connect(
    "weblounge-bot",
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  const text = `pushed before history ${Date.now()}`;
  try {
    const line = await bot.privmsgConfirmed("#weblounge-test", text);
    const envelope = await seedRouteAndEncrypt(page, line, {
      networkLabel: "Local Ergo",
      nickname: "weblounge",
    });
    await deliverPush(context, page, envelope);
    await expect.poll(() => notifications(page)).toHaveLength(1);
    await replaceWithConversationNotification(page, "1/#weblounge-test");

    await page.close();
    await context.setOffline(true);
    const coldPage = await context.newPage();
    await coldPage.goto(
      "/Local%20Ergo/weblounge-test?irc-password=weblounge-test",
    );

    await expect(coldPage.getByText(text, { exact: true })).toBeVisible();
    await expect.poll(() => notifications(coldPage)).toEqual([]);
    await expect(coldPage.locator('[data-network-state="online"]')).toHaveCount(
      0,
    );

    await context.setOffline(false);
    await expect(coldPage.locator('[data-network-state="online"]')).toHaveCount(
      1,
    );
    const marker = `history settled ${Date.now()}`;
    bot.privmsg("#weblounge-test", marker);
    await expect(coldPage.getByText(marker, { exact: true })).toBeVisible();
    await expect(coldPage.getByText(text, { exact: true })).toHaveCount(1);
  } finally {
    await context.setOffline(false);
    bot.close();
  }
});

test("keeps a restored pushed direct message verified through history", async ({
  context,
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
  await prepareServiceWorker(context, page);
  await page.goto("/?irc-password=weblounge-test");
  const bot = await IrcClient.connect(
    "weblounge-bot",
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  const text = `pushed direct before history ${Date.now()}`;
  try {
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const echoed = await bot.privmsgConfirmed("weblounge", text);
    const line = echoed.replace(/^@/u, "@account=weblounge-bot;");
    const envelope = await seedRouteAndEncrypt(page, line, {
      networkLabel: "Local Ergo",
      nickname: "weblounge",
    });
    await deliverPush(context, page, envelope);
    await expect
      .poll(() => notifications(page))
      .toEqual([
        {
          title: "weblounge-bot",
          body: text,
          tag: "1/weblounge-bot",
          route: "/Local%20Ergo/@weblounge-bot",
        },
      ]);

    await page.close();
    await context.setOffline(true);
    const coldPage = await context.newPage();
    let documentRequests = 0;
    coldPage.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === coldPage.mainFrame()
      ) {
        documentRequests += 1;
      }
    });
    await coldPage.goto("/?irc-password=weblounge-test");

    const directBuffer = coldPage
      .locator("[data-buffer-id]")
      .filter({ hasText: "weblounge-bot" });
    await expect(directBuffer).toHaveAttribute("data-unread", "1");
    await directBuffer.click();
    const row = coldPage.locator("[data-message-row]", { hasText: text });
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute("data-unverified-sender", "true");
    await expect(directBuffer).toHaveAttribute("data-unread", "0");
    await expect(coldPage.getByRole("note")).toHaveCount(0);
    await expect(coldPage.locator('[data-network-state="online"]')).toHaveCount(
      0,
    );

    await context.setOffline(false);
    await expect(coldPage.locator('[data-network-state="online"]')).toHaveCount(
      1,
    );
    const marker = `direct history settled ${Date.now()}`;
    await bot.privmsgConfirmed("weblounge", marker);
    await expect(coldPage.getByText(marker, { exact: true })).toBeVisible();
    expect(documentRequests).toBe(1);
    await expect(coldPage.getByText(text, { exact: true })).toHaveCount(1);
    await expect(row).not.toHaveAttribute("data-unverified-sender", "true");
  } finally {
    await context.setOffline(false);
    bot.close();
  }
});

async function trackDedicatedEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
    const NativeWorker = Worker;
    class TrackedWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        Reflect.set(globalThis, "pushTestEngineWorker", this);
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: TrackedWorker,
    });
  });
}

async function loadNotificationPromptDismissal(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const worker = Reflect.get(globalThis, "pushTestEngineWorker");
        if (!(worker instanceof Worker)) {
          reject(new Error("dedicated engine worker is unavailable"));
          return;
        }
        const id = crypto.randomUUID();
        const onMessage = (event: MessageEvent<unknown>) => {
          const message = event.data;
          if (
            typeof message !== "object" ||
            message === null ||
            !("id" in message) ||
            message.id !== id
          ) {
            return;
          }
          worker.removeEventListener("message", onMessage);
          if ("type" in message && message.type === "command_result") resolve();
          else reject(new Error("notification prompt dismissal read failed"));
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({
          type: "request",
          payload: {
            id,
            request: { type: "load_notification_prompt_dismissal" },
          },
        });
      }),
  );
}

async function notifications(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return (await registration?.getNotifications())?.map((notification) => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
      route:
        typeof notification.data === "object" &&
        notification.data !== null &&
        "route" in notification.data
          ? String(notification.data.route)
          : "",
    }));
  });
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

async function routeNeedsReregistration(page: Page): Promise<boolean> {
  return page.evaluate(async (seededRouteId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("routes", "readonly");
    const route = await new Promise<unknown>((resolve, reject) => {
      const request = transaction.objectStore("routes").get(seededRouteId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return (
      typeof route === "object" &&
      route !== null &&
      "needsReregistration" in route &&
      route.needsReregistration === true
    );
  }, routeId);
}

async function storedAppBadge(page: Page): Promise<number | undefined> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readonly");
    const count = await new Promise<unknown>((resolve, reject) => {
      const request = transaction.objectStore("state").get("app-badge");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return typeof count === "number" ? count : undefined;
  });
}

async function seedReadNotification(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("already read", {
      tag: "1/#stale",
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(
      {
        schema: 1,
        conversations: [["1/#stale", 0]],
        untagged: 0,
      },
      "notification-counts",
    );
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
}

async function replaceWithConversationNotification(
  page: Page,
  tag: string,
): Promise<void> {
  await page.evaluate(async (conversationTag) => {
    const registration = await navigator.serviceWorker.ready;
    for (const notification of await registration.getNotifications()) {
      notification.close();
    }
    await registration.showNotification("conversation notification", {
      tag: conversationTag,
    });
  }, tag);
  await expect
    .poll(() => notifications(page))
    .toEqual([
      {
        title: "conversation notification",
        body: "",
        tag,
        route: "",
      },
    ]);
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

async function seedRouteAndEncrypt(
  page: Page,
  line: string,
  routeContext: {
    readonly networkLabel: string;
    readonly nickname: string;
  } = { networkLabel: "Lounge", nickname: "weblounge" },
  databaseVersion: 2 | 3 = 3,
): Promise<string> {
  return page.evaluate(
    async ({ plaintext, route, seededRouteId, seededDatabaseVersion }) => {
      const encode = (bytes: ArrayBuffer | ArrayBufferView): string => {
        const view = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
        let binary = "";
        for (const byte of view) binary += String.fromCharCode(byte);
        return btoa(binary)
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/u, "");
      };
      const concatenate = (...parts: Uint8Array[]): Uint8Array => {
        const output = new Uint8Array(
          parts.reduce((length, part) => length + part.byteLength, 0),
        );
        let offset = 0;
        for (const part of parts) {
          output.set(part, offset);
          offset += part.byteLength;
        }
        return output;
      };
      const hkdf = async (
        input: BufferSource,
        salt: BufferSource,
        info: BufferSource,
        length: number,
      ): Promise<ArrayBuffer> => {
        const key = await crypto.subtle.importKey("raw", input, "HKDF", false, [
          "deriveBits",
        ]);
        return crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt, info },
          key,
          length,
        );
      };
      const routePair = (await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      )) as CryptoKeyPair;
      const routePublic = new Uint8Array(
        await crypto.subtle.exportKey("raw", routePair.publicKey),
      );
      const authentication = crypto.getRandomValues(new Uint8Array(16));
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("weblounge-push", seededDatabaseVersion);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("routes")) {
            request.result.createObjectStore("routes", {
              keyPath: seededDatabaseVersion === 2 ? "networkId" : "routeId",
            });
          }
          if (!request.result.objectStoreNames.contains("state")) {
            request.result.createObjectStore("state");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("routes", "readwrite");
        transaction.objectStore("routes").put({
          networkId: 1,
          networkLabel: route.networkLabel,
          nickname: route.nickname,
          vapid: "test-home",
          routeId: seededRouteId,
          endpoint: `https://push.example.test/v1/r/${seededRouteId}`,
          p256dh: encode(routePublic),
          auth: encode(authentication),
          privateKey: routePair.privateKey,
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();

      const senderPair = (await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      )) as CryptoKeyPair;
      const senderPublic = new Uint8Array(
        await crypto.subtle.exportKey("raw", senderPair.publicKey),
      );
      const importedRoutePublic = await crypto.subtle.importKey(
        "raw",
        routePublic,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      const shared = await crypto.subtle.deriveBits(
        { name: "ECDH", public: importedRoutePublic },
        senderPair.privateKey,
        256,
      );
      const encoder = new TextEncoder();
      const inputKeyMaterial = await hkdf(
        shared,
        authentication,
        concatenate(
          encoder.encode("WebPush: info\0"),
          routePublic,
          senderPublic,
        ),
        256,
      );
      const salt = crypto.getRandomValues(new Uint8Array(16));
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
        ["encrypt"],
      );
      const record = concatenate(encoder.encode(plaintext), Uint8Array.of(2));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, tagLength: 128 },
          key,
          record,
        ),
      );
      const recordSize = new Uint8Array(4);
      new DataView(recordSize.buffer).setUint32(0, 4_096);
      const encrypted = concatenate(
        salt,
        recordSize,
        Uint8Array.of(senderPublic.byteLength),
        senderPublic,
        ciphertext,
      );
      return JSON.stringify({
        web_push: 8030,
        mutable: true,
        notification: {
          title: "New message",
          navigate: "/",
          data: { r: seededRouteId, c: encode(encrypted) },
        },
      });
    },
    {
      plaintext: line,
      route: routeContext,
      seededRouteId: routeId,
      seededDatabaseVersion: databaseVersion,
    },
  );
}
