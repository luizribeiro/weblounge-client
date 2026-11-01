import { expect, type Page, test } from "@playwright/test";
import { BETA_CONTENT_SECURITY_POLICY } from "../csp";
import { IrcClient } from "./irc-client";

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
      progressAtSwap: true,
      stoppedAtIteration: expect.any(Number),
      swapIterations: expect.any(Number),
    });
  const shimmer = await cachedListShimmerObservation(page);
  expect(shimmer.stoppedAtIteration).toBeGreaterThan(
    shimmer.swapIterations ?? -1,
  );
  await expect(
    page.locator("[data-mobile-chats] [data-connection-progress]"),
  ).toHaveCount(0);
});

test("turns a stalled startup into a human error", async ({ page }) => {
  await page.clock.install();
  await page.route("**/config.json", () => new Promise(() => {}));
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
  await page.clock.fastForward(10_000);

  await expect(page.getByRole("alert")).toContainText(
    "Invalid /config.json: could not be loaded in time",
  );
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await expect.poll(() => startupErrors).toHaveLength(1);
  expect(startupErrors[0]).toContain("/config.json");
});

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
      page.getByRole("button", { exact: true, name: nick }),
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
          title: "#weblounge-test",
          text: expect.stringContaining(channelPreview),
        }),
        expect.objectContaining({
          title: nick,
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
  page,
}) => {
  const snapshot = {
    schema: 2,
    fingerprint: fingerprint("Local Ergo", "ws://127.0.0.1:4173/socket"),
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
  expect(firstFrame?.map((row) => row.title)).toEqual(["zeta", "alpha"]);
});

test("reveals an interactive IndexedDB chat list before reconnecting", async ({
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
    fingerprint: fingerprint("Local Ergo", "ws://127.0.0.1:4173/socket"),
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
        title: "#cached",
        text: expect.stringContaining("cached before the socket"),
      }),
    ]);
    await expect(
      page.locator("[data-mobile-chats] [data-connection-progress]"),
    ).toBeVisible();
    await observeCachedListShimmer(page);
    await page.getByRole("button", { name: "#cached" }).click();
    await expect(page.locator("[data-mobile-chat]")).toBeVisible();
    await page.getByRole("button", { name: "Mark as read" }).click();
    await expect(
      page.getByRole("button", { name: "Mark as read" }),
    ).toHaveCount(0);
    await expect(page.getByText("Will send when connected")).toBeVisible();
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
    await expect(page.getByText("Will send when connected")).toHaveCount(0);
    await expect(
      page.getByText("This conversation is not available."),
    ).toBeVisible();
    await expect
      .poll(() => cachedListShimmerObservation(page))
      .toMatchObject({
        progressAtSwap: true,
        stoppedAtIteration: expect.any(Number),
        swapIterations: expect.any(Number),
      });
    const shimmer = await cachedListShimmerObservation(page);
    expect(shimmer.stoppedAtIteration).toBeGreaterThan(
      shimmer.swapIterations ?? -1,
    );
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
      last_message: {
        id: index + 1,
        author: buffer.title,
        text,
        kind: "text",
        bot: false,
        mode_symbol: null,
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
  await page.evaluate(async (record) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("cache"))
          request.result.createObjectStore("cache");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("cache", "readwrite");
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
    database.close();
  }, snapshot);
}

interface ShimmerObservation {
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

async function installDelayedLiveListEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
            buffers: [buffer(2, "#cached", true)],
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
          buffers: [buffer(3, "#live", false)],
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
  });
}
