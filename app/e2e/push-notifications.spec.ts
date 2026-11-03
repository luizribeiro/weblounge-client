import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const routeId = "route-push-e2e";

test.beforeEach(async ({ context, page }) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_DEV === "1",
    "the service worker is intentionally disabled in development",
  );
  await page.goto("/");
  await context.grantPermissions(["notifications"], {
    origin: new URL(page.url()).origin,
  });
  await expect.poll(() => activeWorkerState(page)).toBe("activated");
});

test("decrypts a real envelope into one routed notification", async ({
  context,
  page,
}) => {
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
  const envelope = await seedRouteAndEncrypt(
    page,
    "@time=2026-11-03T12:34:56.789Z;msgid=push-bad :mel!m@example.test PRIVMSG weblounge :secret",
  );
  const parsed = JSON.parse(envelope) as {
    notification: { data: { c: string } };
  };
  parsed.notification.data.c = `${parsed.notification.data.c.slice(0, -1)}A`;

  await deliverPush(context, page, JSON.stringify(parsed));

  await expect
    .poll(() => notifications(page))
    .toEqual([{ title: "New message", body: "Lounge", tag: "", route: "/" }]);
});

async function activeWorkerState(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.active?.state ?? null;
  });
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

async function seedRouteAndEncrypt(page: Page, line: string): Promise<string> {
  return page.evaluate(
    async ({ plaintext, seededRouteId }) => {
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
        const request = indexedDB.open("weblounge-push", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("routes", { keyPath: "networkId" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("routes", "readwrite");
        transaction.objectStore("routes").put({
          networkId: 1,
          networkLabel: "Lounge",
          nickname: "weblounge",
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
    { plaintext: line, seededRouteId: routeId },
  );
}
