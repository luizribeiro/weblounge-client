import {
  type BrowserContext,
  type ConsoleMessage,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { IrcClient } from "./irc-client";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";

const fixtureChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

test("keeps normal desktop and mobile flows console-clean", async ({
  baseURL,
  browser,
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");

  const suffix = Date.now().toString().slice(-6);
  const channel = `#console-${suffix}`;
  const bot = await IrcClient.connect(
    `console-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  let phase = "load";
  const issues = observeConsole(page, baseURL, () => phase);
  let mobileContext: BrowserContext | undefined;
  try {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto("/?irc-password=weblounge-test");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    phase = "open channel";
    const joinComposer = page.getByRole("textbox", { name: "Message" });
    await joinComposer.fill(`/join ${channel}`);
    await joinComposer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const list = page.locator("[data-message-list]");
    const finalSeed = `console seed final ${suffix}`;
    for (let index = 0; index < 12; index += 1) {
      await bot.privmsgConfirmed(
        channel,
        `console seed ${suffix} ${index} ${"wrapped message ".repeat(20)}`,
      );
    }
    await bot.privmsgConfirmed(channel, finalSeed);
    await expect(page.getByText(finalSeed, { exact: true })).toBeVisible();
    phase = "scroll messages";
    await scrollAwayFromLiveEdge(page, list);

    phase = "send message";
    const sent = `console send ${suffix}`;
    const composer = page.getByRole("textbox", { name: `Message ${channel}` });
    await composer.fill(sent);
    await page.getByRole("button", { name: "Send" }).click();
    await list.press("End");
    await expect(page.getByText(sent, { exact: true })).toBeVisible();
    phase = "open members";
    await page.getByRole("button", { name: "Toggle member list" }).click();
    await expect(
      page.getByRole("complementary", { name: "Members" }),
    ).toBeVisible();

    mobileContext = await browser.newContext({
      baseURL,
      hasTouch: true,
      ignoreHTTPSErrors: process.env.WEBLOUNGE_E2E_SECURE_ERGO === "1",
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });
    const mobile = await mobileContext.newPage();
    let mobilePhase = "mobile load";
    const mobileIssues = observeConsole(mobile, baseURL, () => mobilePhase);
    await mobile.goto("/?irc-password=weblounge-test");
    await expect(mobile.locator("[data-mobile-chats]")).toBeVisible();
    mobilePhase = "open mobile chat";
    await mobile
      .getByRole("button", { name: new RegExp(`^${fixtureChannel}`) })
      .click();
    await expect(
      mobile.getByRole("heading", { name: fixtureChannel }),
    ).toBeVisible();
    await expect(mobile.locator("[data-message-list]")).toBeVisible();

    expect({ desktop: issues, mobile: mobileIssues }).toEqual({
      desktop: [],
      mobile: [],
    });
  } finally {
    await mobileContext?.close();
    bot.close();
  }
});

interface ConsoleIssue {
  readonly location: string;
  readonly phase: string;
  readonly text: string;
  readonly type: string;
}

function observeConsole(
  page: Page,
  baseURL: string,
  phase: () => string,
): ConsoleIssue[] {
  const origin = new URL(baseURL).origin;
  const issues: ConsoleIssue[] = [];
  page.on("console", (message) => {
    if (message.type() !== "warning" && message.type() !== "error") return;
    const location = message.location().url;
    if (location !== "" && new URL(location).origin !== origin) return;
    issues.push(consoleIssue(message, phase()));
  });
  page.on("pageerror", (error) => {
    issues.push({
      location: page.url(),
      phase: phase(),
      text: error.message,
      type: "pageerror",
    });
  });
  return issues;
}

function consoleIssue(message: ConsoleMessage, phase: string): ConsoleIssue {
  return {
    location: message.location().url,
    phase,
    text: message.text(),
    type: message.type(),
  };
}
