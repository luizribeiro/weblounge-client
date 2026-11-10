import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("routes live channel and direct notices as styled chat", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).slice(-6);
  const account = `ntuser${suffix}`;
  const channel = `#notice-${suffix}`;
  const startUrl = await isolatedStartUrl(account, channel);
  const bot = await IrcClient.connect(
    `notice-bot-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const channelNotice = `channel notice ${suffix}`;
  const highlightedNotice = `notice for ${account} ${suffix}`;
  const directNotice = `direct notice ${suffix}`;
  const screenshotNotice = `maintenance window ${suffix}`;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(startUrl);
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "lounge-night",
    );

    const channelBuffer = bufferRow(page, channel);
    await expect(channelBuffer).toBeVisible();
    await page.getByRole("button", { name: "Local Ergo, online" }).click();
    await bot.noticeConfirmed(channel, channelNotice);
    await expect(channelBuffer).toHaveAttribute("data-unread", "1");
    await expect(channelBuffer).toHaveAttribute("data-mentions", "0");
    await bot.noticeConfirmed(channel, highlightedNotice);
    await expect(channelBuffer).toHaveAttribute("data-unread", "2");
    await expect(channelBuffer).toHaveAttribute("data-mentions", "1");

    await channelBuffer.click();
    const liveChannelNotice = noticeRow(page, channelNotice);
    const liveHighlight = noticeRow(page, highlightedNotice);
    await expectNoticeStyle(liveChannelNotice);
    await expectNoticeStyle(liveHighlight);
    await expectHighlighted(liveHighlight);
    await expect(channelBuffer).toHaveAttribute("data-unread", "0");
    await expect(channelBuffer).toHaveAttribute("data-mentions", "0");

    await bot.privmsgConfirmed(channel, `before notice ${suffix}`);
    await bot.noticeConfirmed(channel, screenshotNotice);
    await bot.privmsgConfirmed(channel, `after notice ${suffix}`);
    await expectNoticeStyle(noticeRow(page, screenshotNotice));
    await captureScreenshots(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await bot.noticeConfirmed(account, directNotice);
    const directBuffer = bufferRow(page, bot.nickname);
    await expect(directBuffer).toHaveAttribute("data-unread", "1");
    await expect(directBuffer).toHaveAttribute("data-mentions", "1");
    await directBuffer.click();
    const liveDirectNotice = noticeRow(page, directNotice);
    await expectNoticeStyle(liveDirectNotice);
    await expect(liveDirectNotice).toHaveAttribute(
      "data-unverified-sender",
      "true",
    );
    await expect(directBuffer).toHaveAttribute("data-unread", "0");
  } finally {
    bot.close();
  }
});

async function isolatedStartUrl(
  account: string,
  channel: string,
): Promise<string> {
  const seed = await IrcClient.connectIsolated(account, channel);
  seed.close();
  await seed.waitForDisconnect();
  const params = new URLSearchParams({
    "irc-account": account,
    "irc-autojoin": channel,
    "irc-nickname": account,
    "irc-password": `test-${account}`,
  });
  return `/?${params.toString()}`;
}

function bufferRow(page: Page, title: string): Locator {
  return page.locator("[data-buffer-id]").filter({ hasText: title });
}

function noticeRow(page: Page, text: string): Locator {
  return page.locator('[data-message-row][data-irc-notice="true"]').filter({
    has: page.getByText(text, { exact: true }),
  });
}

async function expectNoticeStyle(row: Locator): Promise<void> {
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-irc-notice", "true");
  const text = row.locator("[data-selectable]").last();
  await expect(text).toHaveCSS("font-style", "italic");
  const expectedColor = await row
    .page()
    .locator("html")
    .evaluate(() => {
      const sample = document.createElement("span");
      sample.style.color = "var(--wl-color-muted)";
      document.body.append(sample);
      const expected = getComputedStyle(sample).color;
      sample.remove();
      return expected;
    });
  await expect(text).toHaveCSS("color", expectedColor);
}

async function expectHighlighted(row: Locator): Promise<void> {
  await expect
    .poll(() =>
      row.evaluate(
        (element) =>
          getComputedStyle(element, "::before").backgroundColor !==
          "rgba(0, 0, 0, 0)",
      ),
    )
    .toBe(true);
}

async function captureScreenshots(page: Page): Promise<void> {
  const directory = process.env.WEBLOUNGE_NOTICE_SCREENSHOT_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole("heading", { name: /^#notice-/u }),
    ).toBeVisible();
    await screenshotWithInter(page.locator("[data-app-root]"), {
      path: path.join(directory, `notice-${name}-lounge-night.png`),
    });
  }
}
