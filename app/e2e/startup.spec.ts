import { expect, type Locator, type Page, test } from "@playwright/test";
import { BETA_CONTENT_SECURITY_POLICY } from "../csp";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { IrcClient } from "./irc-client";

const development = process.env.WEBLOUNGE_E2E_DEV === "1";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 402, height: 874 },
});

test("starts under the beta CSP without a policy violation", async ({
  page,
}) => {
  await installHistoryStallEngine(page);
  await page.addInitScript(() => {
    Reflect.set(globalThis, "startupCspViolations", []);
    document.addEventListener("securitypolicyviolation", (event) => {
      const violations = Reflect.get(globalThis, "startupCspViolations");
      if (Array.isArray(violations)) {
        violations.push({
          blocked: event.blockedURI,
          directive: event.violatedDirective,
          source: event.sourceFile,
        });
      }
    });
  });
  const consoleViolations: string[] = [];
  page.on("console", (message) => {
    if (
      (message.type() === "error" || message.type() === "warning") &&
      /content security policy/iu.test(message.text())
    ) {
      consoleViolations.push(message.text());
    }
  });

  const response = await page.goto("/");

  expect(response?.headers()["content-security-policy"]).toBe(
    BETA_CONTENT_SECURITY_POLICY,
  );
  await expect(page.locator("[data-app-root]")).toBeVisible();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "startupCspViolations")),
  ).toEqual([]);
  expect(consoleViolations).toEqual([]);
});

test("shimmers through cached-list hydration and finishes its sweep", async ({
  page,
}) => {
  await installDelayedLiveListEngine(page);

  await page.goto("/?irc-password=weblounge-test");

  await expect(page.getByRole("button", { name: "#cached" })).toBeVisible();
  await expect(
    page.locator("[data-mobile-chats] [data-connection-progress]"),
  ).toBeVisible();
  await observeCachedListShimmer(page);
  await page.evaluate(() => {
    const release = Reflect.get(globalThis, "releaseLiveChatList");
    if (typeof release !== "function") throw new Error("live list unavailable");
    release();
  });

  await expect(page.getByRole("button", { name: "#live" })).toBeVisible();
  await expect(page.getByRole("button", { name: "#cached" })).toHaveCount(0);
  await expect
    .poll(() => cachedListShimmerObservation(page))
    .toMatchObject({
      filled: true,
      progressAtSwap: true,
      stoppedAtIteration: expect.any(Number),
      swapIterations: expect.any(Number),
    });
  await expect(
    page.locator("[data-mobile-chats] [data-connection-progress]"),
  ).toHaveCount(0);
});

test.describe("desktop cached chat list", () => {
  test.use({
    hasTouch: false,
    isMobile: false,
    viewport: { width: 1280, height: 800 },
  });

  test("opens a cached row when the live list arrives during its tap", async ({
    page,
  }) => {
    await installDelayedLiveListEngine(page, true);
    await page.goto("/?irc-password=weblounge-test");

    const row = page.getByRole("button", { name: "#tapped" });
    await expect(row).toBeVisible();
    await expect(page.locator("[data-conversation-title]")).toContainText(
      "#first",
    );
    const bounds = await row.boundingBox();
    if (bounds === null) throw new Error("cached row is not laid out");
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.evaluate(() => {
      const release = Reflect.get(globalThis, "releaseLiveChatList");
      if (typeof release !== "function")
        throw new Error("live list unavailable");
      release();
    });
    await expect(page.locator("[data-app-root]")).not.toHaveAttribute(
      "data-chat-list-hydrating",
    );
    await page.mouse.up();

    await expect(page.locator("[data-conversation-title]")).toContainText(
      "#tapped",
    );
  });
});

test("turns a stalled startup into a human error", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.clock.install();
  let recover = false;
  await page.route("**/config.json", async (route) => {
    if (!recover) return new Promise(() => {});
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ mode: "app" }),
    });
  });
  const startupErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().startsWith("[weblounge startup]")
    ) {
      startupErrors.push(message.text());
    }
  });

  await page.goto("/");
  const initialChair = await page.locator("[data-splash-mark]").boundingBox();
  await page.clock.fastForward(10_000);

  await expect(page.getByRole("alert")).toContainText(
    "Can't reach weblounge. Check your connection.",
  );
  await expect(page.locator("[data-initial-splash]")).toBeVisible();
  await expect(page.locator("[data-splash-mark]")).toHaveCount(1);
  const retry = page.getByRole("button", { name: "Retry" });
  await expectAccentButtonContrast(retry);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "lounge-night",
  );
  await expectAccentButtonContrast(retry);
  expect(await page.locator("[data-splash-mark]").boundingBox()).toEqual(
    initialChair,
  );
  await expect.poll(() => startupErrors).toHaveLength(1);
  expect(startupErrors[0]).toContain("Can't reach weblounge");

  recover = true;
  await page.emulateMedia({ colorScheme: "light" });
  await page.clock.resume();
  await retry.click();
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
});

test("offers Reset app after two failed retries and recovers cleanly", async ({
  page,
}) => {
  test.skip(
    development,
    "the service worker is intentionally disabled in development",
  );
  const startupErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().startsWith("[weblounge startup]")
    ) {
      startupErrors.push(message.text());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  await expect.poll(() => activeWorkerState(page)).toBe("activated");
  await page.context().addCookies([
    {
      name: "weblounge-e2e-config",
      value: "invalid",
      url: new URL(page.url()).origin,
      sameSite: "Strict",
    },
  ]);
  await page.evaluate(async () => {
    localStorage.setItem("reset-survival-setting", "preserved");
    const cache = await caches.open("weblounge-reset-sentinel");
    await cache.put("/reset-sentinel", new Response("cached"));
    await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/reset-sentinel/",
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("reset-survival", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction("state", "readwrite");
        transaction.objectStore("state").put("preserved", "marker");
        transaction.oncomplete = () => {
          request.result.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    localStorage.removeItem("weblounge.deployment-config.v1");
  });
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).some(
          (registration) => registration.scope.endsWith("/reset-sentinel/"),
        ),
      ),
    )
    .toBe(true);

  await page.reload();
  const retry = page.getByRole("button", { name: "Retry" });
  const reset = page.getByRole("button", { name: "Reset app" });
  await expect(page.getByRole("alert")).toContainText("misconfigured");
  await expect.poll(() => startupErrors).toHaveLength(1);
  await expect(reset).toHaveCount(0);

  await retry.click();
  await expect.poll(() => startupErrors).toHaveLength(2);
  await expect(reset).toHaveCount(0);

  await retry.click();
  await expect.poll(() => startupErrors).toHaveLength(3);
  await expect(reset).toBeVisible();

  await page.context().clearCookies({ name: "weblounge-e2e-config" });
  await reset.click();
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const databaseValue = await new Promise<string | undefined>(
        (resolve, reject) => {
          const request = indexedDB.open("reset-survival");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction("state");
            const value = transaction.objectStore("state").get("marker");
            value.onerror = () => reject(value.error);
            value.onsuccess = () => {
              request.result.close();
              resolve(
                typeof value.result === "string" ? value.result : undefined,
              );
            };
          };
        },
      );
      return {
        appCacheExists: (await caches.keys()).includes(
          "weblounge-reset-sentinel",
        ),
        databaseValue,
        preservedSetting: localStorage.getItem("reset-survival-setting"),
        sentinelWorkerExists: (
          await navigator.serviceWorker.getRegistrations()
        ).some((registration) =>
          registration.scope.endsWith("/reset-sentinel/"),
        ),
      };
    }),
  ).toEqual({
    appCacheExists: false,
    databaseValue: "preserved",
    preservedSetting: "preserved",
    sentinelWorkerExists: false,
  });
});

test("survives focus while the engine handshake is pending", async ({
  page,
}) => {
  await page.clock.install();
  let releaseEngine: (() => void) | undefined;
  let markEngineRequested: (() => void) | undefined;
  const engineRequested = new Promise<void>((resolve) => {
    markEngineRequested = resolve;
  });
  await page.route("**/*.wasm", async (route) => {
    if (!route.request().url().includes("engine")) {
      await route.continue();
      return;
    }
    await new Promise<void>((release) => {
      releaseEngine = release;
      markEngineRequested?.();
    });
    await route.continue();
  });
  await page.addInitScript(() => {
    let focused = false;
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => focused,
    });
    Reflect.set(globalThis, "focusStartupPage", () => {
      focused = true;
      window.dispatchEvent(new Event("focus"));
    });
  });

  await page.goto("/");
  await engineRequested;
  await page.evaluate(() => {
    const focus = Reflect.get(globalThis, "focusStartupPage");
    if (typeof focus !== "function")
      throw new Error("focus control is missing");
    focus();
  });
  // wait-ok: crosses the worker heartbeat timeout while the handshake is held.
  await page.clock.runFor(6_000);
  if (releaseEngine === undefined)
    throw new Error("engine request was not held");
  releaseEngine();
  await page.clock.resume();

  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
});

async function expectAccentButtonContrast(button: Locator): Promise<void> {
  const colors = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    return {
      background: style.backgroundColor,
      foreground: style.color,
      accent: root.getPropertyValue("--wl-color-accent").trim(),
      accentForeground: root.getPropertyValue("--wl-color-accent-fg").trim(),
    };
  });
  expect(colors.background).toBe(rgb(colors.accent));
  expect(colors.foreground).toBe(rgb(colors.accentForeground));
  expect(
    contrastRatio(colors.background, colors.foreground),
  ).toBeGreaterThanOrEqual(4.5);
}

async function activeWorkerState(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.active?.state ?? null;
  });
}

function rgb(hex: string): string {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16));
  if (channels === undefined || channels.length !== 3)
    throw new Error(`couldn't parse ${hex}`);
  return `rgb(${channels.join(", ")})`;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function luminance(color: string): number {
  const channels = color.match(/\d+/gu)?.slice(0, 3).map(Number);
  if (channels === undefined || channels.length !== 3)
    throw new Error(`couldn't parse ${color}`);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

test("uses cached config and chats while config revalidation is blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "weblounge.deployment-config.v1",
      JSON.stringify({ config: { mode: "app" }, schema: 1 }),
    );
  });
  await installDelayedLiveListEngine(page);
  await page.route("**/config.json", () => new Promise(() => {}));

  await page.goto("/?irc-password=weblounge-test");

  await expect(page.getByRole("button", { name: "#cached" })).toBeVisible();
  await expect(page.getByText(/misconfigured/iu)).toHaveCount(0);
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
});

for (const recovery of [
  { event: "online", name: "browser comes online" },
  { event: "visibilitychange", name: "page becomes visible" },
] as const) {
  test(`retries an unreachable cold start when the ${recovery.name}`, async ({
    page,
  }) => {
    await page.clock.install();
    let reachable = false;
    await page.route("**/config.json", async (route) => {
      if (!reachable) return new Promise(() => {});
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ mode: "app" }),
      });
    });

    await page.goto("/");
    await page.clock.fastForward(10_000);
    await expect(page.getByRole("alert")).toContainText(
      "Can't reach weblounge",
    );

    reachable = true;
    await page.clock.resume();
    await page.evaluate((event) => {
      const target = event === "online" ? window : document;
      target.dispatchEvent(new Event(event));
    }, recovery.event);

    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
  });
}

test("reveals local Ergo rows with channel and direct previews", async ({
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  const suffix = Date.now().toString().slice(-6);
  const nick = `start${suffix}`;
  const channelPreview = `channel startup ${suffix}`;
  const directPreview = `direct startup ${suffix}`;
  const bot = await IrcClient.connect(
    nick,
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  let keeper: Page | undefined;
  try {
    await page.goto("/?irc-password=weblounge-test");
    await page.getByRole("button", { name: "#weblounge-test" }).click();
    await expect(
      page.locator('[data-mobile-chat][data-network-state="online"]'),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Back to chats" }).click();
    await bot.privmsgConfirmed("#weblounge-test", channelPreview);
    await bot.privmsgConfirmed("weblounge", directPreview);
    await expect(
      page.getByRole("button", { name: new RegExp(`^${nick}(?:,|$)`) }),
    ).toContainText(directPreview);
    keeper = await page.context().newPage();
    await keeper.goto("/");
    await expect(keeper.locator("[data-initial-splash]")).toHaveCount(0);
    await recordFirstReveal(page);
    await page.evaluate(() =>
      history.replaceState(null, "", "/?irc-password=weblounge-test"),
    );

    await page.reload();

    const rows = await firstRevealRows(page);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "#weblounge-test, 1 unread",
          text: expect.stringContaining(channelPreview),
        }),
        expect.objectContaining({
          title: `${nick}, 1 unread, including mentions`,
          text: expect.stringContaining(directPreview),
        }),
      ]),
    );
    await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  } finally {
    await keeper?.close();
    bot.close();
  }
});

test("keeps seeded rows unchanged through the cached-to-live frame", async ({
  baseURL,
  page,
}) => {
  const snapshot = {
    schema: 2,
    fingerprint: fingerprint("Local Ergo", websocketEndpoint(baseURL)),
    rows: [
      {
        conversation: { kind: "direct", key: "zeta" },
        title: "zeta",
        last_activity_ms: 1_700_000_300_000,
        badge: { kind: "mentions", count: 2 },
        preview: "newest",
      },
      {
        conversation: { kind: "direct", key: "alpha" },
        title: "alpha",
        last_activity_ms: 1_700_000_200_000,
        badge: { kind: "none" },
        preview: "older",
      },
    ],
  };
  await page.goto("/config.json");
  await seedChatListSnapshot(page, snapshot);
  await installSnapshotSwapEngine(page, snapshot);
  await recordChatListSwap(page);

  await page.goto("/?irc-password=weblounge-test");

  const filmstrip = await chatListSwapFilmstrip(page);
  expect(filmstrip[0]?.cached).toBe(true);
  expect(filmstrip.at(-1)?.cached).toBe(false);
  const firstFrame = filmstrip[0]?.rows;
  expect(firstFrame).toBeDefined();
  for (const frame of filmstrip) expect(frame.rows).toEqual(firstFrame);
  expect(firstFrame?.map((row) => row.title)).toEqual([
    "zeta, 2 unread, including mentions",
    "alpha",
  ]);
});

test("reveals an interactive IndexedDB chat list before reconnecting", async ({
  baseURL,
  context,
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's startup connection configuration",
  );
  test.skip(
    process.env.WEBLOUNGE_ERGO_CONTROL_PID === undefined,
    "requires the restartable Ergo fixture",
  );
  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis, "SharedWorker");
  });
  await page.goto("/");
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
  await seedChatListSnapshot(page, {
    schema: 2,
    fingerprint: fingerprint("Local Ergo", websocketEndpoint(baseURL)),
    rows: [
      {
        conversation: { kind: "channel", key: "#cached" },
        title: "#cached",
        last_activity_ms: 1_700_000_000_000,
        badge: { kind: "unread" },
        preview: "alice: cached before the socket",
      },
    ],
  });
  await recordFirstReveal(page);
  let ergoStopped = false;
  try {
    process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR1");
    ergoStopped = true;
    await expectErgoRunning(false);
    await context.setOffline(true);

    await page.goto("/?irc-password=weblounge-test");

    const rows = await firstRevealRows(page);
    expect(rows).toEqual([
      expect.objectContaining({
        title: "#cached, 1 unread",
        text: expect.stringContaining("cached before the socket"),
      }),
    ]);
    await expect(
      page.locator("[data-mobile-chats] [data-connection-progress]"),
    ).toBeVisible();
    await observeCachedListShimmer(page);
    await page.getByRole("button", { name: "#cached" }).click();
    await expect(page.locator("[data-mobile-chat]")).toBeVisible();
    await page.getByRole("textbox").fill("queued from cache");
    await page.getByRole("textbox").press("Enter");
    await expect(page.getByText("queued from cache")).toBeVisible();

    process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR2");
    await expectErgoRunning(true);
    ergoStopped = false;
    await context.setOffline(false);
    await expect(
      page.locator('[data-mobile-chat][data-network-state="online"]'),
    ).toBeVisible();
    await expect(
      page.getByText("This conversation is not available."),
    ).toBeVisible();
    await expect
      .poll(() => cachedListShimmerObservation(page))
      .toMatchObject({
        filled: true,
        progressAtSwap: true,
        stoppedAtIteration: expect.any(Number),
        swapIterations: expect.any(Number),
      });
    await expect(
      page
        .getByRole("main")
        .getByText(
          "That conversation is no longer available, so the message was not sent.",
        ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to Chats", exact: true })
      .click();
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  } finally {
    await context.setOffline(false);
    if (ergoStopped) {
      process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR2");
      await expectErgoRunning(true);
    }
  }
});

test("reveals after the hydration cap when latest history stalls", async ({
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's startup connection configuration",
  );
  await installHistoryStallEngine(page);
  await recordFirstReveal(page);

  await page.goto("/?irc-password=weblounge-test");

  await expect
    .poll(() =>
      page.evaluate(() => ({
        online: Reflect.get(globalThis, "startupOnlineAt"),
        reveal: Reflect.get(globalThis, "startupRevealAt"),
      })),
    )
    .toMatchObject({ online: expect.any(Number), reveal: expect.any(Number) });
  const measured = await page.evaluate(() => ({
    online: Reflect.get(globalThis, "startupOnlineAt") as number,
    reveal: Reflect.get(globalThis, "startupRevealAt") as number,
  }));
  // wait-ok: verifies the fixed 400ms product cap rather than waiting for state.
  expect(measured.reveal - measured.online).toBeGreaterThanOrEqual(380);
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "#weblounge-test" }),
  ).toBeVisible();
});

async function recordFirstReveal(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    Reflect.set(globalThis, "startupRevealRows", undefined);
    Reflect.set(globalThis, "startupRevealAt", undefined);
    const observer = new MutationObserver(() => {
      const splash = document.querySelector("[data-initial-splash]");
      if (
        splash?.getAttribute("data-state") !== "leaving" ||
        Reflect.get(globalThis, "startupRevealRows") !== undefined
      ) {
        return;
      }
      Reflect.set(globalThis, "startupRevealAt", performance.now());
      Reflect.set(
        globalThis,
        "startupRevealRows",
        [
          ...document.querySelectorAll<HTMLElement>(
            "[data-mobile-chat-list] [data-buffer-id]",
          ),
        ].map((row) => ({
          text: row.textContent ?? "",
          title: row.getAttribute("aria-label"),
        })),
      );
      observer.disconnect();
    });
    observer.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
}

async function firstRevealRows(
  page: import("@playwright/test").Page,
): Promise<Array<{ title: string | null; text: string }>> {
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "startupRevealRows")),
    )
    .not.toBeUndefined();
  return page.evaluate(
    () =>
      Reflect.get(globalThis, "startupRevealRows") as Array<{
        title: string | null;
        text: string;
      }>,
  );
}

interface ChatListFrame {
  readonly cached: boolean;
  readonly rows: Array<{
    readonly text: string;
    readonly time: string | null;
    readonly title: string | null;
  }>;
}

async function recordChatListSwap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.set(globalThis, "chatListSwapFilmstrip", undefined);
    const frames: ChatListFrame[] = [];
    let sawCached = false;
    const sample = () => {
      const elements = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-mobile-chat-list] [data-buffer-id]",
        ),
      ];
      const cached = elements.some((row) => row.dataset.cached === "true");
      if (elements.length > 0 && (cached || sawCached)) {
        sawCached ||= cached;
        frames.push({
          cached,
          rows: elements.map((row) => ({
            text: row.textContent ?? "",
            time: row.querySelector("time")?.textContent ?? null,
            title: row.getAttribute("aria-label"),
          })),
        });
      }
      if (sawCached && !cached) {
        Reflect.set(globalThis, "chatListSwapFilmstrip", frames);
      } else {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  });
}

async function chatListSwapFilmstrip(page: Page): Promise<ChatListFrame[]> {
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "chatListSwapFilmstrip")),
    )
    .not.toBeUndefined();
  return page.evaluate(
    () => Reflect.get(globalThis, "chatListSwapFilmstrip") as ChatListFrame[],
  );
}

async function installSnapshotSwapEngine(
  page: Page,
  snapshot: {
    readonly rows: ReadonlyArray<{
      readonly badge: { readonly kind: string; readonly count?: number };
      readonly last_activity_ms: number;
      readonly preview: string;
      readonly title: string;
    }>;
  },
): Promise<void> {
  const cached = snapshot.rows.map((row, index) => ({
    id: index + 2,
    network_id: 1,
    kind: "direct",
    sync_state: "pending",
    cached: true,
    title: row.title,
    draft_key: `Local Ergo:${row.title}`,
    topic: null,
    unread: row.badge.kind === "none" ? 0 : (row.badge.count ?? 1),
    mentions: row.badge.kind === "mentions" ? (row.badge.count ?? 1) : 0,
    read_through: null,
    last_activity_ms: row.last_activity_ms,
    cached_preview: row.preview,
  }));
  const live = cached.map((buffer, index) => {
    const { cached: _, cached_preview: text, ...projection } = buffer;
    return {
      ...projection,
      sync_state: "synced",
      last_message: {
        id: index + 1,
        author: buffer.title,
        text,
        kind: "text",
        bot: false,
        authorship: "other",
        nick_color_index: 0,
        highlighted: false,
        delivery: "received",
        local_send_id: null,
        server_ids: [`snapshot-${index}`],
        server_time_ms: buffer.last_activity_ms,
        received_at_ms: buffer.last_activity_ms,
      },
    };
  });
  await installHistoryStallEngine(page, { cached, live });
}

async function seedChatListSnapshot(
  page: Page,
  snapshot: Record<string, unknown>,
): Promise<void> {
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(async (value, record) => {
      await new Promise<void>((resolve, reject) => {
        const transaction = value.transaction("cache", "readwrite");
        transaction
          .objectStore("cache")
          .put(
            new TextEncoder().encode(JSON.stringify(record)),
            new TextEncoder().encode("chat-list-snapshot"),
          );
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }, snapshot);
  } finally {
    await closeEngineDatabase(database);
  }
}

interface ShimmerObservation {
  readonly filled?: boolean;
  readonly iterations: number;
  readonly progressAtSwap?: boolean;
  readonly stoppedAtIteration?: number;
  readonly swapIterations?: number;
}

async function observeCachedListShimmer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const logo = document.querySelector(
      "[data-mobile-chats] [data-connection-progress]",
    );
    if (!(logo instanceof HTMLElement)) throw new Error("shimmer logo missing");
    const observation: {
      filled?: boolean;
      iterations: number;
      progressAtSwap?: boolean;
      stoppedAtIteration?: number;
      swapIterations?: number;
    } = { iterations: 0 };
    Reflect.set(globalThis, "cachedListShimmerObservation", observation);
    document.addEventListener(
      "animationiteration",
      (event) => {
        if (event.target === logo) observation.iterations += 1;
      },
      true,
    );
    const observer = new MutationObserver(() => {
      if (logo.getAttribute("data-connection-phase") === "filling") {
        observation.filled = true;
      }
      if (
        observation.swapIterations === undefined &&
        document.querySelector('[data-buffer-id][aria-label="#cached"]') ===
          null
      ) {
        observation.progressAtSwap = logo.hasAttribute(
          "data-connection-progress",
        );
        observation.swapIterations = observation.iterations;
      }
      if (!logo.hasAttribute("data-connection-progress")) {
        observation.stoppedAtIteration = observation.iterations;
        observer.disconnect();
      }
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
}

async function cachedListShimmerObservation(
  page: Page,
): Promise<ShimmerObservation> {
  return page.evaluate(
    () =>
      Reflect.get(
        globalThis,
        "cachedListShimmerObservation",
      ) as ShimmerObservation,
  );
}

function fingerprint(label: string, endpoint: string): string {
  return `${label.length}:${label}${endpoint.length}:${endpoint}`;
}

function websocketEndpoint(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const endpoint = new URL("/socket", baseURL);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint.href;
}

async function expectErgoRunning(expected: boolean): Promise<void> {
  await expect
    .poll(async () => {
      try {
        await fetch("http://127.0.0.1:8089/");
        return true;
      } catch {
        return false;
      }
    })
    .toBe(expected);
}

async function installHistoryStallEngine(
  page: import("@playwright/test").Page,
  swap?: {
    readonly cached: readonly unknown[];
    readonly live: readonly unknown[];
  },
) {
  await page.addInitScript((swap) => {
    class StartupPort extends EventTarget {
      postMessage(message: unknown): void {
        if (!isRecord(message)) return;
        if (message.type === "hello") {
          this.emit({
            type: "ready",
            engine_instance: "startup-cap-engine",
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
        }
        if (isRecord(request) && request.type === "connect") {
          Reflect.set(globalThis, "startupOnlineAt", performance.now());
          if (swap !== undefined) {
            this.emit({
              type: "network_state_changed",
              network: {
                id: 1,
                label: "Local Ergo",
                nickname: "weblounge",
                state: "connecting",
              },
            });
            this.emit({
              type: "chat_list_snapshot_loaded",
              network_id: 1,
              buffers: swap.cached,
            });
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                this.emit({
                  type: "network_state_changed",
                  network: {
                    id: 1,
                    label: "Local Ergo",
                    nickname: "weblounge",
                    state: "online",
                  },
                });
                this.emit({
                  type: "chat_list_live",
                  network_id: 1,
                  buffers: swap.live,
                });
              }),
            );
            this.emit({ type: "command_result", id: payload.id });
            return;
          }
          this.emit({
            type: "network_state_changed",
            network: {
              id: 1,
              label: "Local Ergo",
              nickname: "weblounge",
              state: "online",
            },
          });
          this.emit({
            type: "buffers_changed",
            network_id: 1,
            buffers: [
              {
                id: 2,
                network_id: 1,
                kind: "channel",
                sync_state: "synced",
                title: "#weblounge-test",
                draft_key: "test:#weblounge-test",
                topic: null,
                member_count: 0,
                unread: 0,
                mentions: 0,
                read_through: null,
              },
            ],
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
    const port = new StartupPort();
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: class {
        readonly port = port;
      },
    });

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  }, swap);
}

async function installDelayedLiveListEngine(
  page: Page,
  stableRows = false,
): Promise<void> {
  await page.addInitScript((stableRows) => {
    class DelayedLiveListPort extends EventTarget {
      postMessage(message: unknown): void {
        if (!isRecord(message)) return;
        if (message.type === "hello") {
          this.emit({
            type: "ready",
            engine_instance: "delayed-live-list-engine",
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
              label: "Local Ergo",
              nickname: "weblounge",
              state: "online",
            },
          });
          this.emit({
            type: "chat_list_snapshot_loaded",
            network_id: 1,
            buffers: stableRows
              ? [buffer(2, "#first", true), buffer(3, "#tapped", true)]
              : [buffer(2, "#cached", true)],
          });
        }
        this.emit({ type: "command_result", id: payload.id });
      }

      start(): void {}
      close(): void {}

      releaseLiveList(): void {
        this.emit({
          type: "chat_list_live",
          network_id: 1,
          buffers: stableRows
            ? [buffer(2, "#first", false), buffer(3, "#tapped", false)]
            : [buffer(3, "#live", false)],
        });
      }

      private emit(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    const buffer = (id: number, title: string, cached: boolean) => ({
      id,
      network_id: 1,
      kind: "channel",
      sync_state: cached ? "pending" : "synced",
      title,
      draft_key: `test:${title}`,
      topic: null,
      member_count: 0,
      unread: 0,
      mentions: 0,
      read_through: null,
      ...(cached ? { cached: true, cached_preview: "seeded cache" } : {}),
    });
    const port = new DelayedLiveListPort();
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: class {
        readonly port = port;
      },
    });
    Reflect.set(globalThis, "releaseLiveChatList", () =>
      port.releaseLiveList(),
    );

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  }, stableRows);
}
