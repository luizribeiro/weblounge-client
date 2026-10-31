import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 402, height: 874 },
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

async function installHistoryStallEngine(
  page: import("@playwright/test").Page,
) {
  await page.addInitScript(() => {
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
  });
}
