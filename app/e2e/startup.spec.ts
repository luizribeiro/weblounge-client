import type { Locator, Page, Route } from "@playwright/test";
import { E2E_CONTENT_SECURITY_POLICY } from "../csp";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { IrcClient, isolatedPassword, registerAccount } from "./irc-client";
import { expect, test } from "./irc-fixture";

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
    E2E_CONTENT_SECURITY_POLICY,
  );
  await expect(page.locator("[data-app-root]")).toBeVisible();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "startupCspViolations")),
  ).toEqual([]);
  expect(consoleViolations).toEqual([]);
});

test("shimmers through restored projection updates and finishes its sweep", async ({
  page,
}) => {
  await installDelayedProjectionEngine(page);

  await page.goto("/?irc-password=weblounge-test");

  const row = page.getByRole("button", { name: "#restored" });
  await expect(row).toBeVisible();
  await row.evaluate((element) =>
    Reflect.set(globalThis, "initialRestoredRow", element),
  );
  await expect(
    page.locator("[data-mobile-chats] [data-connection-progress]"),
  ).toBeVisible();
  await observeProjectionShimmer(page);
  await page.evaluate(() => {
    const release = Reflect.get(globalThis, "releaseSnapshotProjection");
    if (typeof release !== "function")
      throw new Error("snapshot projection unavailable");
    release();
  });

  await expect(row).toContainText("live projection");
  expect(
    await row.evaluate(
      (element) => element === Reflect.get(globalThis, "initialRestoredRow"),
    ),
  ).toBe(true);
  await expect
    .poll(() => projectionShimmerObservation(page))
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

test.describe("desktop restored chat list", () => {
  test.use({
    hasTouch: false,
    isMobile: false,
    viewport: { width: 1280, height: 800 },
  });

  test("opens a restored row when its projection updates during a tap", async ({
    page,
  }) => {
    await installDelayedProjectionEngine(page, true);
    await page.goto("/?irc-password=weblounge-test");

    const row = page.getByRole("button", { name: "#tapped" });
    await expect(row).toBeVisible();
    await expect(page.locator("[data-conversation-title]")).toContainText(
      "#first",
    );
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
    const bounds = await row.boundingBox();
    if (bounds === null) throw new Error("cached row is not laid out");
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await row.evaluate((element) =>
      Reflect.set(globalThis, "pressedRestoredRow", element),
    );
    await page.mouse.down();
    await page.evaluate(() => {
      const release = Reflect.get(globalThis, "releaseSnapshotProjection");
      if (typeof release !== "function")
        throw new Error("snapshot projection unavailable");
      release();
    });
    expect(
      await row.evaluate(
        (element) => element === Reflect.get(globalThis, "pressedRestoredRow"),
      ),
    ).toBe(true);
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
  await installDelayedProjectionEngine(page);
  await page.route("**/config.json", () => new Promise(() => {}));

  await page.goto("/?irc-password=weblounge-test");

  await expect(page.getByRole("button", { name: "#restored" })).toBeVisible();
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
    let blockedRoute: Route | undefined;
    await page.route("**/config.json", async (route) => {
      if (!reachable) {
        blockedRoute = route;
        return;
      }
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

    if (blockedRoute === undefined)
      throw new Error("unreachable config request was not intercepted");
    await blockedRoute.abort("timedout");
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
  irc,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  const suffix = irc.id;
  const channelPreview = `channel startup ${suffix}`;
  const directPreview = `direct startup ${suffix}`;
  let keeper: Page | undefined;
  try {
    const seedBots = [
      await connectSeed(irc.nickNamed("seed-a"), irc.channel),
      await connectSeed(irc.nickNamed("seed-b"), irc.channel),
    ];
    for (let index = 0; index < 50; index += 1) {
      const mentioned =
        index % 10 === 0
          ? irc.account
          : seedBots[(index + 1) % seedBots.length]?.nickname;
      await seedBots[index % seedBots.length]?.privmsgConfirmed(
        irc.channel,
        `earlier startup ${suffix} ${index} mentions ${mentioned}`,
      );
    }
    for (const seedBot of seedBots) seedBot.close();
    const bot = await irc.peer("start");
    const nick = bot.nickname;
    await page.goto(irc.url());
    const channelRow = page
      .locator(`[data-buffer-id][aria-label^="${irc.channel}"]`)
      .first();
    await channelRow.click();
    await expect(
      page.locator('[data-mobile-chat][data-network-state="online"]'),
    ).toHaveCount(1);
    await expect(channelRow).toHaveAttribute("aria-label", irc.channel);
    await page.getByRole("button", { name: "Back to chats" }).click();
    await bot.privmsgConfirmed(irc.channel, channelPreview);
    await bot.privmsgConfirmed(irc.account, directPreview);
    await expect(
      page.getByRole("button", { name: new RegExp(`^${nick}(?:,|$)`) }),
    ).toContainText(directPreview);
    keeper = await page.context().newPage();
    await keeper.goto("/");
    await expect(keeper.locator("[data-initial-splash]")).toHaveCount(0);
    await recordFirstReveal(page);
    await page.evaluate(
      (url) => history.replaceState(null, "", url),
      irc.url(),
    );

    await page.reload();

    const rows = await firstRevealRows(page);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: `${irc.channel}, 1 unread`,
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
  }
});

test("updates each restored row in place without a duplicate or remount", async ({
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

  await page.goto("/?irc-password=weblounge-test");

  await expect(
    page.locator("[data-mobile-chat-list] [data-buffer-id]"),
  ).toHaveCount(2);
  expect(
    await page
      .locator("[data-mobile-chat-list] [data-buffer-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label"))),
  ).toEqual(["zeta, 2 unread, including mentions", "alpha"]);
  await page.evaluate(() => {
    Reflect.set(globalThis, "initialProjectedRows", [
      ...document.querySelectorAll("[data-mobile-chat-list] [data-buffer-id]"),
    ]);
    const release = Reflect.get(globalThis, "releaseSnapshotProjection");
    if (typeof release !== "function")
      throw new Error("projection release missing");
    release();
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        if (Reflect.get(globalThis, "snapshotProjectionReleased") !== true)
          return false;
        const initial = Reflect.get(globalThis, "initialProjectedRows");
        const current = [
          ...document.querySelectorAll(
            "[data-mobile-chat-list] [data-buffer-id]",
          ),
        ];
        return (
          Array.isArray(initial) &&
          current.length === 2 &&
          new Set(current.map((row) => row.getAttribute("data-buffer-id")))
            .size === current.length &&
          current.every((row, index) => row === initial[index])
        );
      }),
    )
    .toBe(true);
});

test("drops legacy saved counts while keeping the restored list interactive", {
  tag: "@serial",
}, async ({ baseURL, context, page, irc }) => {
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

    await page.goto(irc.url());

    const rows = await firstRevealRows(page);
    expect(rows).toEqual([
      expect.objectContaining({
        title: "#cached",
        text: expect.stringContaining("cached before the socket"),
      }),
    ]);
    await expect(
      page.locator("[data-mobile-chats] [data-connection-progress]"),
    ).toBeVisible();
    await observeProjectionShimmer(page, "This conversation is not available.");
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
      .poll(() => projectionShimmerObservation(page))
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

test("reveals restored rows without waiting for stalled history", async ({
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
  expect(measured.reveal - measured.online).toBeLessThan(380);
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "#weblounge-test" }),
  ).toBeVisible();
});

async function connectSeed(nick: string, channel: string): Promise<IrcClient> {
  await registerAccount(nick, isolatedPassword(nick));
  return IrcClient.connect(nick, nick, isolatedPassword(nick), channel);
}

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
    title: row.title,
    draft_key: `Local Ergo:${row.title}`,
    topic: null,
    unread: row.badge.kind === "none" ? 0 : (row.badge.count ?? 1),
    mentions: row.badge.kind === "mentions" ? (row.badge.count ?? 1) : 0,
    last_activity_ms: row.last_activity_ms,
    preview: row.preview,
  }));
  const live = cached.map((buffer, index) => {
    const { preview: text, ...projection } = buffer;
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

async function observeProjectionShimmer(
  page: Page,
  settledText?: string,
): Promise<void> {
  await page.evaluate((settledText) => {
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
    Reflect.set(globalThis, "projectionShimmerObservation", observation);
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
      const projectionSettled =
        observation.swapIterations === undefined &&
        (document
          .querySelector('[data-buffer-id][aria-label="#restored"]')
          ?.textContent?.includes("live projection") === true ||
          (settledText !== undefined &&
            document.body.textContent?.includes(settledText) === true));
      if (projectionSettled) {
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
  }, settledText);
}

async function projectionShimmerObservation(
  page: Page,
): Promise<ShimmerObservation> {
  return page.evaluate(
    () =>
      Reflect.get(
        globalThis,
        "projectionShimmerObservation",
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
              type: "buffers_changed",
              network_id: 1,
              buffers: swap.cached,
            });
            Reflect.set(globalThis, "releaseSnapshotProjection", () => {
              this.emit({
                type: "network_state_changed",
                network: {
                  id: 1,
                  label: "Local Ergo",
                  nickname: "weblounge",
                  state: "online",
                },
              });
              for (const buffer of swap.live)
                this.emit({ type: "buffer_updated", buffer });
              Reflect.set(globalThis, "snapshotProjectionReleased", true);
            });
            this.emit({ type: "command_result", id: payload.id });
            return;
          }
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

async function installDelayedProjectionEngine(
  page: Page,
  stableRows = false,
): Promise<void> {
  await page.addInitScript((stableRows) => {
    class DelayedProjectionPort extends EventTarget {
      postMessage(message: unknown): void {
        if (!isRecord(message)) return;
        if (message.type === "hello") {
          this.emit({
            type: "ready",
            engine_instance: "delayed-projection-engine",
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
              state: stableRows ? "online" : "connecting",
            },
          });
          this.emit({
            type: "buffers_changed",
            network_id: 1,
            buffers: stableRows
              ? [buffer(2, "#first", true), buffer(3, "#tapped", true)]
              : [buffer(2, "#restored", true)],
          });
        }
        this.emit({ type: "command_result", id: payload.id });
      }

      start(): void {}
      close(): void {}

      releaseProjection(): void {
        if (!stableRows)
          this.emit({
            type: "network_state_changed",
            network: {
              id: 1,
              label: "Local Ergo",
              nickname: "weblounge",
              state: "online",
            },
          });
        const buffers = stableRows
          ? [buffer(2, "#first", false), buffer(3, "#tapped", false)]
          : [buffer(2, "#restored", false)];
        for (const projection of buffers)
          this.emit({ type: "buffer_updated", buffer: projection });
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
      preview: cached ? "seeded snapshot" : "live projection",
    });
    const port = new DelayedProjectionPort();
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: class {
        readonly port = port;
      },
    });
    Reflect.set(globalThis, "releaseSnapshotProjection", () =>
      port.releaseProjection(),
    );

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  }, stableRows);
}
