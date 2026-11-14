import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { expectSettled } from "./settled";

test.describe("mobile read state against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("clears a quiet chat while another channel stays busy", async ({
    page,
    irc,
  }) => {
    await observeMarkReadRequests(page);
    await page.goto(irc.url());
    const channel = irc.channelNamed("read");
    await page.getByRole("button", { name: irc.channel }).click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expectSettled(page);
    await page.getByRole("button", { name: "Back to chats" }).click();
    await expectSettled(page);

    const quiet = await irc.peer("quiet", [channel]);
    const busy = await Promise.all(
      [0, 1, 2].map((index) => irc.peer(`busy${index}`)),
    );
    let chatting = true;
    const chatter = busy.map(async (bot, botIndex) => {
      for (let message = 0; chatting; message += 1)
        await bot.privmsgConfirmed(
          irc.channel,
          `read dwell noise ${botIndex} ${message}`,
        );
    });

    try {
      const row = page
        .locator("[data-mobile-chats] [data-buffer-id]")
        .filter({ hasText: channel });

      await quiet.privmsgConfirmed(channel, "yeah");
      await expect(row).toHaveAccessibleName(`${channel}, 1 unread`);
      const firstMarkerCount = await markReadRequestCount(page);
      await row.click();
      await expect(page.getByText("yeah", { exact: true })).toBeVisible();
      await expect
        .poll(() => markReadRequestCount(page))
        .toBeGreaterThan(firstMarkerCount);
      await expect(row).toHaveAttribute("aria-label", channel);
      await expectSettled(page);
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expectSettled(page);
      await expect(row).toHaveAccessibleName(channel);

      await quiet.privmsgConfirmed(channel, "yeah again");
      await expect(row).toHaveAccessibleName(`${channel}, 1 unread`);
      const secondMarkerCount = await markReadRequestCount(page);
      await row.click();
      await expect(page.getByText("yeah again", { exact: true })).toBeVisible();
      await expect
        .poll(() => markReadRequestCount(page))
        .toBeGreaterThan(secondMarkerCount);
      await expect(row).toHaveAttribute("aria-label", channel);
      await expectSettled(page);
      await completeBackSwipe(page);
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();
      await expectSettled(page);
      await expect(row).toHaveAccessibleName(channel);
    } finally {
      chatting = false;
      await Promise.allSettled(chatter);
    }
  });
});

async function observeMarkReadRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, { markReadRequests: 0 });
    const observe = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request" &&
        "payload" in message &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        "request" in message.payload &&
        typeof message.payload.request === "object" &&
        message.payload.request !== null &&
        "type" in message.payload.request &&
        message.payload.request.type === "mark_read"
      ) {
        const state = window as Window & { markReadRequests: number };
        state.markReadRequests += 1;
      }
    };
    const wrap = (prototype: {
      postMessage: (...arguments_: unknown[]) => unknown;
    }) => {
      const postMessage = prototype.postMessage;
      prototype.postMessage = function (...arguments_: unknown[]) {
        observe(arguments_[0]);
        return Reflect.apply(postMessage, this, arguments_);
      };
    };
    wrap(MessagePort.prototype as unknown as Parameters<typeof wrap>[0]);
    wrap(Worker.prototype as unknown as Parameters<typeof wrap>[0]);
  });
}

function markReadRequestCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as Window & { markReadRequests: number }).markReadRequests,
  );
}

async function completeBackSwipe(page: Page): Promise<void> {
  const shell = page.locator("[data-mobile-shell]");
  for (const [type, clientX] of [
    ["pointerdown", 5],
    ["pointermove", 20],
    ["pointermove", 260],
    ["pointerup", 260],
  ] as const)
    await shell.dispatchEvent(type, {
      clientX,
      clientY: 300,
      isPrimary: true,
      pointerId: 88,
      pointerType: "touch",
    });
}
