import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test.describe.configure({ mode: "serial" });

test("routes live channel and direct notices as styled chat", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("phone"),
    "the phone project covers the signed notice row through raw server events",
  );
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

test("routes server notices, services, and WALLOPS into the server buffer", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
    "requires the controllable socket forwarder",
  );
  const suffix = Date.now().toString(36).slice(-6);
  const account = `ntserver${suffix}`;
  const channel = `#notice-server-${suffix}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(await isolatedStartUrl(account, channel, true));
  await expect(page.getByRole("heading", { name: "Local Ergo" })).toBeVisible();

  const serverNotice = `Global notice: services restart ${suffix}`;
  const serviceNotice = `You are now identified ${suffix}`;
  const wallops = `WALLOPS: rotating the TLS certificate ${suffix}`;
  await inject(`:offline.test NOTICE ${account} :${serverNotice}`);
  await inject(`:NickServ!service@services.test NOTICE $* :${serviceNotice}`);
  await inject(`:offline.test WALLOPS :${wallops}`);

  const service = noticeRow(page, serviceNotice);
  const server = noticeRow(page, serverNotice);
  const wallopsRow = noticeRow(page, wallops);
  await expect(service).toHaveAttribute("data-notice-source", "service");
  await expect(service.getByRole("img", { name: "Notice" })).toBeVisible();
  for (const row of [server, wallopsRow]) {
    await expect(row).toHaveAttribute("data-notice-source", "server");
    await expect(row.getByRole("img", { name: "Server notice" })).toBeVisible();
  }
  await expect(bufferRow(page, "NickServ")).toHaveCount(0);
  await captureScreenshots(page, testInfo.project.name.includes("phone"));
});

async function isolatedStartUrl(
  account: string,
  channel: string,
  serverBuffer = false,
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
  const path = serverBuffer ? `/${encodeURIComponent("Local Ergo")}` : "/";
  return `${path}?${params.toString()}`;
}

function bufferRow(page: Page, title: string): Locator {
  return page.locator("[data-buffer-id]").filter({ hasText: title });
}

function noticeRow(page: Page, text: string): Locator {
  return page
    .locator('[data-message-row][data-irc-notice="true"]')
    .filter({ hasText: text });
}

async function expectNoticeStyle(row: Locator): Promise<void> {
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-irc-notice", "true");
  await expect(row).toHaveAttribute("data-notice-source", "user");
  await expect(row.getByRole("img", { name: "Notice" })).toBeVisible();
  const text = row.locator("[data-selectable]").last();
  await expect(text).toHaveCSS("font-style", "normal");
  const expectedColor = await row
    .page()
    .locator("html")
    .evaluate(() => {
      const sample = document.createElement("span");
      sample.style.color = "var(--wl-color-fg)";
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

async function captureScreenshots(page: Page, phone: boolean): Promise<void> {
  const directory = process.env.WEBLOUNGE_NOTICE_SCREENSHOT_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      scheme === "dark" ? "lounge-night" : "lounge",
    );
    const name = phone ? "phone" : "desktop";
    await page.setViewportSize(
      phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    );
    await expect(page.getByText(/rotating the TLS certificate/u)).toBeVisible();
    await screenshotWithInter(page.locator("[data-app-root]"), {
      path: path.join(directory, `notice-${name}-${scheme}.png`),
    });
  }
}

async function inject(line: string): Promise<void> {
  const base = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
  if (base === undefined) throw new Error("socket forwarder is unavailable");
  const response = await fetch(`${base}/inject`, {
    method: "POST",
    body: line,
  });
  if (!response.ok)
    throw new Error(`socket forwarder inject failed: ${response.status}`);
  const result = await response.text();
  if (!result.includes("into 1 connection"))
    throw new Error(
      `socket forwarder inject reached the wrong scope: ${result}`,
    );
}
