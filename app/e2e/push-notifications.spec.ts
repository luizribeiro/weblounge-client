import {
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  closeEngineDatabase,
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_STORES,
  ENGINE_DATABASE_VERSION,
  openEngineDatabase,
} from "./engine-database";
import { IrcClient } from "./irc-client";
import { deliverStablePushBatch } from "./stable-push-batch";

const routeId = "route-push-e2e";
const pushHarnessScope = "/e2e/push-events/";

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
  await context.grantPermissions(["notifications"]);
  await page.goto("/");
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

function capturePushErrors(context: BrowserContext): string[] {
  const errors: string[] = [];
  context.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && text.startsWith("push delivery failed")) {
      errors.push(text);
    }
  });
  return errors;
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
        tag: "Lounge/#lounge",
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
        tag: "Lounge/#lounge",
        route: "/Lounge/lounge",
      },
    ]);
  await expect.poll(() => storedAppBadge(page)).toBe(1);
});

test("collapses a busy DM without native tag replacement", async ({
  browserName,
  context,
  page,
}) => {
  const scope = await preparePushEventHarness(context, page);
  const envelopes = await seedRouteAndEncryptMany(page, [
    "@time=2026-11-05T12:34:56.787Z;msgid=iris-one :iris!i@example.test PRIVMSG weblounge :first from iris",
    "@time=2026-11-05T12:34:56.788Z;msgid=iris-two :iris!i@example.test PRIVMSG weblounge :second from iris",
    "@time=2026-11-05T12:34:56.789Z;msgid=iris-three :iris!i@example.test PRIVMSG weblounge :latest from iris",
  ]);

  for (const envelope of envelopes) {
    await deliverBrowserPush(
      browserName,
      context,
      page,
      scope,
      envelope,
      0,
      false,
    );
  }

  await expect
    .poll(() => notifications(page, scope))
    .toEqual([
      {
        title: "iris",
        body: "latest from iris\n· 3 new messages",
        tag: "Lounge/iris",
        route: "/Lounge/@iris",
      },
    ]);
  await expect.poll(() => storedAppBadge(page)).toBe(3);
  await expect(
    clickHarnessNotification(page, scope, "closed"),
  ).resolves.toEqual({ openedRoute: "/Lounge/@iris" });
});

test("serializes concurrent pushes without closing either notification", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const envelopes = await seedRouteAndEncryptMany(page, [
    "@time=2026-11-03T12:34:56.789Z;msgid=push-concurrent-one :mel!m@example.test PRIVMSG #one :first concurrent push",
    "@time=2026-11-03T12:34:56.790Z;msgid=push-concurrent-two :sam!s@example.test PRIVMSG #two :second concurrent push",
  ]);

  await deliverPushes(context, page, envelopes);

  await expect
    .poll(async () =>
      (await notifications(page))?.toSorted((left, right) =>
        left.tag.localeCompare(right.tag),
      ),
    )
    .toEqual([
      {
        title: "mel in #one",
        body: "first concurrent push",
        tag: "Lounge/#one",
        route: "/Lounge/one",
      },
      {
        title: "sam in #two",
        body: "second concurrent push",
        tag: "Lounge/#two",
        route: "/Lounge/two",
      },
    ]);
  await expect.poll(() => storedAppBadge(page)).toBe(2);
});

test("migrates and decrypts an active route from the previous schema", async ({
  context,
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_DEV === "1",
    "the service worker is intentionally disabled in development",
  );
  await page.route("**/push-upgrade", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/push-upgrade");
  const envelope = await seedRouteAndEncrypt(
    page,
    "@time=2026-11-03T12:34:56.789Z;msgid=push-upgrade :mel!m@example.test PRIVMSG #lounge :hello after upgrade",
    { networkLabel: "Lounge", nickname: "weblounge" },
    3,
    true,
  );
  await context.grantPermissions(["notifications"], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
    });
    await navigator.serviceWorker.ready;
  });

  await deliverPush(context, page, envelope);

  await expect
    .poll(() => notifications(page))
    .toContainEqual({
      title: "mel in #lounge",
      body: "hello after upgrade",
      tag: "Lounge/#lounge",
      route: "/Lounge/lounge",
    });
});

test("silently applies every delivered MARKREAD and maintenance PING", async ({
  context,
  page,
}) => {
  const pushErrors = capturePushErrors(context);
  await prepareServiceWorker(context, page);
  await deliverStablePushBatch(
    [
      "@time=2026-11-03T12:34:56.789Z;msgid=push-read-one :mel!m@example.test PRIVMSG #lounge :first unread push",
      "@time=2026-11-03T12:34:56.789Z;msgid=push-read-two :mel!m@example.test PRIVMSG #lounge :second unread push",
    ],
    (lines) => seedRouteAndEncryptMany(page, lines),
    (envelope) => deliverPush(context, page, envelope),
  );
  await expect
    .poll(async () => ({
      notificationCount: (await notifications(page))?.length,
      pushErrors,
    }))
    .toEqual({ notificationCount: 1, pushErrors: [] });
  await expect.poll(() => storedAppBadge(page)).toBe(2);

  const markread = await seedRouteAndEncrypt(
    page,
    ":irc.example.test MARKREAD #lounge timestamp=2026-11-03T12:34:56.789Z",
  );
  await deliverPush(context, page, markread);

  await expect.poll(() => notifications(page)).toEqual([]);
  await expect.poll(() => storedAppBadge(page)).toBe(0);

  await seedReadNotification(page);
  await expect.poll(() => notifications(page)).toHaveLength(1);
  const ping = await seedRouteAndEncrypt(page, "PING :maintenance");
  await deliverPush(context, page, ping);
  await expect.poll(() => notifications(page)).toEqual([]);
  await expect.poll(() => storedAppBadge(page)).toBe(0);

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
        tag: "Lounge/#lounge",
        route: "/Lounge/lounge",
      },
    ]);
  await expect.poll(() => storedAppBadge(page)).toBe(1);
});

test("MARKREAD silently closes a direct-message notification", async ({
  browserName,
  context,
  page,
}) => {
  const notificationScope =
    browserName === "firefox"
      ? await preparePushEventHarness(context, page)
      : await prepareServiceWorker(context, page).then(() => "/");
  const [message, markread] = await seedRouteAndEncryptMany(page, [
    "@time=2026-11-04T19:24:32.000Z;msgid=push-direct-read :mel!m@example.test PRIVMSG weblounge :direct message to close",
    ":irc.example.test MARKREAD mel timestamp=2026-11-04T19:24:32.000Z",
  ]);
  if (message === undefined || markread === undefined) {
    throw new Error("push envelopes were not created");
  }

  await deliverBrowserPush(
    browserName,
    context,
    page,
    notificationScope,
    message,
  );
  await expect
    .poll(() => notifications(page, notificationScope))
    .toEqual([
      {
        title: "mel",
        body: "direct message to close",
        tag: "Lounge/mel",
        route: "/Lounge/@mel",
      },
    ]);
  await expect.poll(() => storedAppBadge(page)).toBe(1);

  await deliverBrowserPush(
    browserName,
    context,
    page,
    notificationScope,
    markread,
  );

  await expect.poll(() => notifications(page, notificationScope)).toEqual([]);
  await expect.poll(() => storedAppBadge(page)).toBe(0);
});

for (const clientState of ["open", "discarded", "closed"] as const) {
  test(`routes a tapped DM when the app client is ${clientState}`, async ({
    browserName,
    context,
    page,
  }) => {
    await installNotificationTapEngine(context);
    const scope = await preparePushEventHarness(context, page);
    const envelope = await seedRouteAndEncrypt(
      page,
      `@account=louro;time=2026-11-05T12:34:56.789Z;msgid=tap-${clientState} :louro!l@example.test PRIVMSG weblounge :tap ${clientState}`,
    );
    await deliverBrowserPush(browserName, context, page, scope, envelope);
    await expect
      .poll(() => notifications(page, scope))
      .toEqual([
        expect.objectContaining({
          title: "louro",
          route: "/Lounge/@louro",
        }),
      ]);

    if (clientState === "open") {
      await clickHarnessNotification(page, scope, clientState);
      await expect(page.getByRole("heading", { name: "louro" })).toBeVisible();
      return;
    }
    if (clientState === "discarded") {
      await clickHarnessNotification(page, scope, clientState);
      await page.reload();
      await expect(page.getByRole("heading", { name: "louro" })).toBeVisible();
      return;
    }
    const click = await clickHarnessNotification(page, scope, clientState);
    expect(click.openedRoute).toBe("/Lounge/@louro");
    await page.close();
    const opened = await context.newPage();
    await opened.goto("/");
    await expect(opened.getByRole("heading", { name: "louro" })).toBeVisible();
  });
}

test("does not tidy a notification newer than its read marker", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const [message, ping] = await seedRouteAndEncryptMany(page, [
    "@time=2026-11-04T19:24:34.000Z;msgid=push-after-read-marker :mel!m@example.test PRIVMSG #lounge :newer than the read marker",
    "PING :cleanup-after-new-message",
  ]);
  if (message === undefined || ping === undefined) {
    throw new Error("push envelopes were not created");
  }
  await seedReadMarker(
    page,
    "Lounge/#lounge",
    Date.parse("2026-11-04T19:24:33.000Z"),
  );

  await deliverPush(context, page, message);
  await expect.poll(() => notifications(page)).toHaveLength(1);
  await expect.poll(() => storedAppBadge(page)).toBe(1);

  await deliverPush(context, page, ping);

  await expect
    .poll(() => notifications(page))
    .toEqual([
      {
        title: "mel in #lounge",
        body: "newer than the read marker",
        tag: "Lounge/#lounge",
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

test("counts one generic notification when its route record is absent", async ({
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
  await expect.poll(() => storedAppBadge(page)).toBe(1);
});

test("retries the fallback while the push event keeps the worker alive", async ({
  browserName,
  context,
  page,
}) => {
  const scope = await preparePushEventHarness(context, page);

  await deliverBrowserPush(browserName, context, page, scope, "{}", 1);

  await expect
    .poll(() => notifications(page, scope))
    .toEqual([{ title: "New message", body: "", tag: "", route: "/" }]);
});

test("anchors queued generic notifications to their receipt deadline", async ({
  context,
  page,
}) => {
  await prepareServiceWorker(context, page);
  const envelope = await seedRouteAndEncrypt(
    page,
    "@time=2026-11-03T12:34:56.789Z;msgid=push-blocked :mel!m@example.test PRIVMSG #lounge :still visible",
    { networkLabel: "Lounge", nickname: "weblounge" },
  );
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    Reflect.set(globalThis, "blockedPushDatabase", database);
    const transaction = database.transaction("routes", "readwrite");
    Reflect.set(globalThis, "blockedPushTransaction", transaction);
    const store = transaction.objectStore("routes");
    await new Promise<void>((resolve, reject) => {
      let acquired = false;
      const holdLock = () => {
        const request = store.get("__push-test-lock__");
        request.onsuccess = () => {
          holdLock();
          if (!acquired) {
            acquired = true;
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      };
      holdLock();
    });
  });

  const startedAt = performance.now();
  let presentationElapsedMs: number;
  const deliveries = deliverPushes(context, page, [envelope, envelope]);
  try {
    await expect
      .poll(() => notifications(page), { intervals: [50] })
      .toEqual([
        {
          title: "New message",
          body: "",
          tag: expect.stringMatching(/^weblounge-fallback\//),
          route: "/",
        },
        {
          title: "New message",
          body: "",
          tag: expect.stringMatching(/^weblounge-fallback\//),
          route: "/",
        },
      ]);
    presentationElapsedMs = performance.now() - startedAt;
    await deliveries;
  } finally {
    await page.evaluate(() => {
      const transaction = Reflect.get(globalThis, "blockedPushTransaction");
      if (transaction instanceof IDBTransaction) transaction.abort();
      const database = Reflect.get(globalThis, "blockedPushDatabase");
      if (database instanceof IDBDatabase) database.close();
    });
  }
  expect(presentationElapsedMs).toBeLessThan(2_500);
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
    await replaceWithConversationNotification(
      page,
      "Local Ergo/#weblounge-test",
    );

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
    await context.setOffline(true);
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(0);
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
          tag: "Local Ergo/weblounge-bot",
          route: "/Local%20Ergo/@weblounge-bot",
        },
      ]);

    await page.close();
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

async function notifications(page: Page, scope = "/") {
  return page.evaluate(async (registrationScope) => {
    if (registrationScope !== "/") {
      const snapshots: unknown = Reflect.get(
        globalThis,
        "pushHarnessNotifications",
      );
      if (!Array.isArray(snapshots)) return [];
      return snapshots.map((snapshot) => {
        if (typeof snapshot !== "object" || snapshot === null) {
          throw new Error("invalid push harness notification");
        }
        const data = "data" in snapshot ? snapshot.data : undefined;
        return {
          title: "title" in snapshot ? String(snapshot.title) : "",
          body: "body" in snapshot ? String(snapshot.body) : "",
          tag: "tag" in snapshot ? String(snapshot.tag) : "",
          route:
            typeof data === "object" && data !== null && "route" in data
              ? String(data.route)
              : "",
        };
      });
    }
    const registration =
      await navigator.serviceWorker.getRegistration(registrationScope);
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
  }, scope);
}

async function preparePushEventHarness(
  context: BrowserContext,
  page: Page,
): Promise<string> {
  test.skip(
    process.env.WEBLOUNGE_E2E_DEV === "1",
    "the push event harness is emitted only in production test builds",
  );
  await context.grantPermissions(["notifications"]);
  await page.goto("/");
  await page.evaluate(async (scope) => {
    await navigator.serviceWorker.register("/e2e/push-event-worker.js", {
      scope,
    });
  }, pushHarnessScope);
  await expect
    .poll(() =>
      page.evaluate(async (scope) => {
        const registration =
          await navigator.serviceWorker.getRegistration(scope);
        return registration?.active?.state ?? null;
      }, pushHarnessScope),
    )
    .toBe("activated");
  return pushHarnessScope;
}

async function clickHarnessNotification(
  page: Page,
  scope: string,
  clientState: "open" | "discarded" | "closed",
): Promise<{ readonly openedRoute?: string }> {
  return page.evaluate(
    async ({ clientState, registrationScope }) => {
      const registration =
        await navigator.serviceWorker.getRegistration(registrationScope);
      if (registration?.active === null || registration?.active === undefined) {
        throw new Error("push event harness is unavailable");
      }
      const id = crypto.randomUUID();
      return new Promise<{ readonly openedRoute?: string }>(
        (resolve, reject) => {
          const onMessage = (event: MessageEvent<unknown>) => {
            const message = event.data;
            if (
              typeof message !== "object" ||
              message === null ||
              !("id" in message) ||
              message.id !== id ||
              !("type" in message)
            ) {
              return;
            }
            navigator.serviceWorker.removeEventListener("message", onMessage);
            if (message.type === "notification_clicked") {
              resolve({
                ...("openedRoute" in message &&
                typeof message.openedRoute === "string"
                  ? { openedRoute: message.openedRoute }
                  : {}),
              });
            } else if (
              message.type === "notification_click_failed" &&
              "error" in message
            ) {
              reject(new Error(String(message.error)));
            }
          };
          navigator.serviceWorker.addEventListener("message", onMessage);
          registration.active.postMessage({
            type: "click_notification",
            id,
            clientState,
          });
        },
      );
    },
    { clientState, registrationScope: scope },
  );
}

async function installNotificationTapEngine(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    const buffers = (withDirect: boolean) => [
      {
        id: 2,
        network_id: 1,
        sync_state: "synced",
        kind: "channel",
        title: "#home",
        draft_key: "test:#home",
        topic: null,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
      ...(withDirect
        ? [
            {
              id: 3,
              network_id: 1,
              sync_state: "synced",
              kind: "direct",
              title: "louro",
              draft_key: "test:louro",
              topic: null,
              unread: 1,
              mentions: 1,
              read_through: null,
            },
          ]
        : []),
    ];
    class NotificationTapPort extends EventTarget {
      postMessage(message: unknown): void {
        if (!isRecord(message)) return;
        if (message.type === "hello") {
          this.emit({
            type: "ready",
            engine_instance: "notification-tap-engine",
            revision: 0,
          });
          return;
        }
        const payload = message.payload;
        if (!isRecord(payload) || typeof payload.id !== "string") return;
        const request = payload.request;
        if (isRecord(request) && request.type === "diagnostic") {
          this.emit({
            type: "diagnostic",
            command_id: payload.id,
            message: "wasm worker round trip complete",
          });
          this.emit({
            type: "network_state_changed",
            network: {
              id: 1,
              label: "Lounge",
              nickname: "weblounge",
              state: "online",
            },
          });
          this.emit({
            type: "chat_list_snapshot_loaded",
            network_id: 1,
            buffers: buffers(false).map((buffer) => ({
              ...buffer,
              cached: true,
              cached_preview: "cached message",
            })),
          });
        }
        if (isRecord(request) && request.type === "load_pushed_messages") {
          this.emit({
            type: "chat_list_live",
            network_id: 1,
            buffers: buffers(true),
          });
        }
        this.emit({ type: "command_result", id: payload.id });
      }

      start(): void {}
      close(): void {}

      private emit(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: class {
        readonly port = new NotificationTapPort();
      },
    });

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  });
}

async function deliverBrowserPush(
  browserName: string,
  context: BrowserContext,
  page: Page,
  scope: string,
  data: string,
  presentationFailures = 0,
  tagReplacement = true,
): Promise<void> {
  if (browserName === "chromium" && scope === "/") {
    await deliverPush(context, page, data);
    return;
  }
  await page.evaluate(
    async ({
      payload,
      presentationFailures,
      registrationScope,
      tagReplacement,
    }) => {
      const registration =
        await navigator.serviceWorker.getRegistration(registrationScope);
      if (registration?.active === null || registration?.active === undefined) {
        throw new Error("push event harness is unavailable");
      }
      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const onMessage = (event: MessageEvent<unknown>) => {
          const message = event.data;
          if (
            typeof message !== "object" ||
            message === null ||
            !("id" in message) ||
            message.id !== id ||
            !("type" in message)
          ) {
            return;
          }
          navigator.serviceWorker.removeEventListener("message", onMessage);
          if (message.type === "push_dispatched") {
            if ("notifications" in message) {
              Reflect.set(
                globalThis,
                "pushHarnessNotifications",
                message.notifications,
              );
            }
            resolve();
          } else if (
            message.type === "push_dispatch_failed" &&
            "error" in message
          ) {
            reject(new Error(String(message.error)));
          }
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        registration.active.postMessage({
          type: "deliver_push",
          id,
          payload,
          presentationFailures,
          tagReplacement,
        });
      });
    },
    {
      payload: data,
      presentationFailures,
      registrationScope: scope,
      tagReplacement,
    },
  );
}

async function routeNeedsReregistration(page: Page): Promise<boolean> {
  return page.evaluate(async (seededRouteId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("routes", "readonly");
    const route = await new Promise<unknown>((resolve, reject) => {
      const request = transaction
        .objectStore("routes")
        .index("route-id")
        .get(seededRouteId);
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
      const request = indexedDB.open("weblounge-push-v2");
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
      tag: "Lounge/#stale",
      data: {
        conversationTag: "Lounge/#stale",
        messageId: "already-read",
        messageTime: "2026-11-03T12:34:56.789Z",
      },
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(
      {
        schema: 2,
        conversations: [
          {
            tag: "Lounge/#stale",
            count: 0,
            read_at_ms: Date.parse("2026-11-03T12:34:56.789Z"),
          },
        ],
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

async function seedReadMarker(
  page: Page,
  tag: string,
  readAtMs: number,
): Promise<void> {
  await page.evaluate(
    async ({ conversationTag, marker }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("weblounge-push-v2");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("state", "readwrite");
      transaction.objectStore("state").put(
        {
          schema: 2,
          conversations: [
            { tag: conversationTag, count: 0, read_at_ms: marker },
          ],
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
    },
    { conversationTag: tag, marker: readAtMs },
  );
}

async function replaceWithConversationNotification(
  page: Page,
  tag: string,
): Promise<void> {
  await page.evaluate(async (conversationTag) => {
    const registration = await navigator.serviceWorker.ready;
    const notifications = await registration.getNotifications();
    const data = notifications.at(0)?.data;
    for (const notification of notifications) {
      notification.close();
    }
    await registration.showNotification("conversation notification", {
      data,
      tag: conversationTag,
    });
  }, tag);
  await expect
    .poll(() => notifications(page))
    .toEqual([
      expect.objectContaining({
        title: "conversation notification",
        body: "",
        tag,
      }),
    ]);
}

async function deliverPush(
  context: BrowserContext,
  page: Page,
  data: string,
): Promise<void> {
  await deliverPushes(context, page, [data]);
}

async function deliverPushes(
  context: BrowserContext,
  page: Page,
  data: readonly string[],
): Promise<void> {
  const { registrationId, session } = await pushDeliveryTarget(context, page);
  await Promise.all(
    data.map((payload) =>
      session.send("ServiceWorker.deliverPushMessage", {
        origin: new URL(page.url()).origin,
        registrationId,
        data: payload,
      }),
    ),
  );
}

// Chromium can acknowledge delivery before the worker receives it. Detaching here
// discards the queued event.
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
  const { targetInfo } = await session.send("Target.getTargetInfo");
  const registrationId = new Promise<string>((resolve) => {
    session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const current = versions.find(
        (candidate) =>
          candidate.status === "activated" &&
          candidate.controlledClients.includes(targetInfo.targetId),
      );
      if (current !== undefined) resolve(current.registrationId);
    });
  });
  await session.send("ServiceWorker.enable");
  return { registrationId: await registrationId, session };
}

async function seedRouteAndEncrypt(
  page: Page,
  line: string,
  routeContext: {
    readonly networkLabel: string;
    readonly nickname: string;
  } = { networkLabel: "Lounge", nickname: "weblounge" },
  databaseVersion: 3 | 4 = 4,
  seedRetiringDuplicate = false,
): Promise<string> {
  const [envelope] = await seedRouteAndEncryptMany(
    page,
    [line],
    routeContext,
    databaseVersion,
    seedRetiringDuplicate,
  );
  if (envelope === undefined) throw new Error("push envelope was not created");
  return envelope;
}

async function seedRouteAndEncryptMany(
  page: Page,
  lines: readonly string[],
  routeContext: {
    readonly networkLabel: string;
    readonly nickname: string;
  } = { networkLabel: "Lounge", nickname: "weblounge" },
  databaseVersion: 3 | 4 = 4,
  seedRetiringDuplicate = false,
): Promise<readonly string[]> {
  return page.evaluate(
    async ({
      plaintexts,
      route,
      seededRouteId,
      seededDatabaseVersion,
      includeRetiringDuplicate,
    }) => {
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
        const currentDatabase = seededDatabaseVersion === 4;
        const request = indexedDB.open(
          currentDatabase ? "weblounge-push-v2" : "weblounge-push",
          currentDatabase ? 1 : seededDatabaseVersion,
        );
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("routes")) {
            const store = request.result.createObjectStore("routes", {
              keyPath: currentDatabase ? "vapid" : "routeId",
            });
            if (currentDatabase) {
              store.createIndex("route-id", "routeId", { unique: true });
            }
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
        if (includeRetiringDuplicate) {
          transaction.objectStore("routes").put({
            networkId: 0,
            networkLabel: route.networkLabel,
            nickname: route.nickname,
            vapid: "test-home",
            routeId: "a-retiring-route",
            endpoint: "https://push.example.test/v1/r/a-retiring-route",
            p256dh: "AQID",
            auth: "BAUG",
            privateKey: routePair.privateKey,
            retiring: true,
          });
        }
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
      return Promise.all(
        plaintexts.map(async (plaintext) => {
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
          const record = concatenate(
            encoder.encode(plaintext),
            Uint8Array.of(2),
          );
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
        }),
      );
    },
    {
      plaintexts: lines,
      route: routeContext,
      seededRouteId: routeId,
      seededDatabaseVersion: databaseVersion,
      includeRetiringDuplicate: seedRetiringDuplicate,
    },
  );
}
