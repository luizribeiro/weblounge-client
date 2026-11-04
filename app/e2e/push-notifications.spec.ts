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

    await page.close();
    await context.setOffline(true);
    const coldPage = await context.newPage();
    await coldPage.goto(
      "/Local%20Ergo/weblounge-test?irc-password=weblounge-test",
    );

    await expect(coldPage.getByText(text, { exact: true })).toBeVisible();
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
): Promise<string> {
  return page.evaluate(
    async ({ plaintext, route, seededRouteId }) => {
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
        const request = indexedDB.open("weblounge-push", 3);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("routes")) {
            request.result.createObjectStore("routes", {
              keyPath: "routeId",
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
    { plaintext: line, route: routeContext, seededRouteId: routeId },
  );
}
