import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import type { TabIcon } from "../src/features/unread/tab-indicator";
import { tabIconHref } from "../src/platform/tab-indicator-writer";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import {
  dispatchPersistedPageShow,
  installFocusControl,
  setPageFocused,
  setPageHidden,
} from "./page-lifecycle";
import {
  openNotificationSettings,
  settingsScreenshot,
} from "./settings-fixture";
import { expectSettled } from "./settled";
import { directRow } from "./sidebar-rows";

const screenshots = path.join(
  process.cwd(),
  "e2e",
  "screenshots",
  "tab-indicator",
);

test.describe("browser tab indicator against local Ergo", () => {
  test("turns red with a count for a DM, which counts as a mention, and grey while disconnected", async ({
    context,
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await openHome(page, irc);
    await expectTab(page, "connected", "weblounge");
    await captureTab(context, page, "connected");

    const peer = await irc.peer("tab-peer");
    await peer.privmsgConfirmed(irc.account, "are you there?");
    await expectTab(page, "mention", "(1) weblounge");
    await captureTab(context, page, "mention");

    await directRow(page, peer).click();
    await expectSettled(page, { conversation: peer.nickname });
    await expectTab(page, "connected", "weblounge");

    await whileOffline(page, async () => {
      await expectTab(page, "disconnected", "weblounge");
      await captureTab(context, page, "disconnected");
    });
    await expectTab(page, "connected", "weblounge");
    await expectSettled(page, { conversation: peer.nickname });
    await nativeFeelAudit(page);
  });

  test("turns yellow for unread channels, red for a mention, and plain once both are read", async ({
    context,
    irc,
    page,
  }) => {
    const [chatter, mentions] = ["tab-chat", "tab-ping"].map((label) =>
      irc.channelNamed(label),
    );
    await installNativeFeelInstrumentation(page);
    await openHome(page, irc, [chatter, mentions]);
    const peer = await irc.peer("tab-mentioner", [chatter, mentions]);
    await expectTab(page, "connected", "weblounge");

    await peer.privmsgConfirmed(chatter, "anyone around?");
    await expectTab(page, "unread", "weblounge");
    await captureTab(context, page, "unread");

    await peer.privmsgConfirmed(mentions, `${irc.account}: you there?`);
    await expectTab(page, "mention", "(1) weblounge");

    await channelRow(page, mentions).click();
    await expectSettled(page, { conversation: mentions });
    await expectTab(page, "unread", "weblounge");

    await channelRow(page, chatter).click();
    await expectSettled(page, { conversation: chatter });
    await expectTab(page, "connected", "weblounge");
    await nativeFeelAudit(page);
  });

  test("counts a DM in the open conversation while the tab is hidden", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await openHome(page, irc);
    const peer = await irc.peer("hidden-tab");
    await peer.privmsgConfirmed(irc.account, "got a minute?");
    await directRow(page, peer).click();
    await expectSettled(page, { conversation: peer.nickname });
    await expectTab(page, "connected", "weblounge");

    await setPageHidden(page, true);
    await peer.privmsgConfirmed(irc.account, "ping while you are away");
    await expectTab(page, "mention", "(1) weblounge");

    await setPageHidden(page, false);
    await expect(
      page
        .locator("[data-message-row]")
        .filter({ hasText: "ping while you are away" }),
    ).toBeVisible();
    await expectTab(page, "connected", "weblounge");
    await expectSettled(page, { conversation: peer.nickname });
    await nativeFeelAudit(page);
  });

  test("counts a mention in the open channel while the window is unfocused", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await installFocusControl(page);
    const peer = await irc.peer("blur-tab", [irc.channel]);
    await openHome(page, irc);

    await setPageFocused(page, false);
    await peer.privmsgConfirmed(irc.channel, `${irc.account}: look here`);
    await expectTab(page, "mention", "(1) weblounge");

    await setPageFocused(page, true);
    await expectTab(page, "connected", "weblounge");
    await expectSettled(page, { conversation: irc.channel });
    await nativeFeelAudit(page);
  });

  test("the Settings switch hides unread from the tab but keeps grey", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await openHome(page, irc);
    await openNotificationSettings(page);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    const tabSwitch = dialog.getByRole("switch", {
      name: "Show unread in the tab",
    });
    await expect(tabSwitch).toHaveAttribute("aria-checked", "true");
    await tabSwitch.click();
    await expect(tabSwitch).toHaveAttribute("aria-checked", "false");
    await nativeFeelAudit(page);
    await settingsScreenshot(dialog, "desktop-tab-indicator-off");
    // The audit focuses text fields to measure zoom, so put focus back where the click left it.
    await tabSwitch.focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    const peer = await irc.peer("quiet-peer");
    await peer.privmsgConfirmed(irc.account, "quietly");
    await expect(directRow(page, peer)).toHaveAccessibleName(/, 1 unread/u);
    await expectTab(page, "connected", "weblounge");

    await whileOffline(page, () =>
      expectTab(page, "disconnected", "weblounge"),
    );
    await expectTab(page, "connected", "weblounge");

    await page.goto(irc.url());
    await expect(directRow(page, peer)).toHaveAccessibleName(/, 1 unread/u);
    await openNotificationSettings(page);
    await expect(tabSwitch).toHaveAttribute("aria-checked", "false");
    await expectTab(page, "connected", "weblounge");
    await tabSwitch.click();
    await expectTab(page, "mention", "(1) weblounge");
    await expectSettled(page);
    await settingsScreenshot(dialog, "desktop-tab-indicator-on");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await nativeFeelAudit(page);
  });
  test("the Mac app leaves the tab alone and has no tab setting", async ({
    irc,
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__WEBLOUNGE_SHELL__", {
        value: Object.freeze({ kind: "macos-app", version: "0.1.3" }),
      });
    });
    await installNativeFeelInstrumentation(page);
    await openHome(page, irc);
    const untouched = await tabState(page);
    expect(untouched.title).toBe("weblounge");

    const peer = await irc.peer("app-peer");
    await peer.privmsgConfirmed(irc.account, "no tab here");
    await expect(directRow(page, peer)).toHaveAccessibleName(/, 1 unread/u);
    expect(await tabState(page)).toEqual(untouched);

    await page
      .getByRole("complementary", { name: "Channel list" })
      .getByRole("button", { name: "Settings" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: "Appearance" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Notifications" }).click();
    await expect(
      dialog.getByRole("switch", { name: "Notifications", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("switch", { name: "Show unread in the tab" }),
    ).toHaveCount(0);
    await nativeFeelAudit(page);
  });
});

async function openHome(
  page: Page,
  irc: IrcTestAccount,
  autojoin: readonly string[] = [],
): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(irc.url({ autojoin }));
  for (const channel of autojoin)
    await expect(channelRow(page, channel)).toBeAttached();
  await channelRow(page, irc.channel).click();
  await expectSettled(page, { conversation: irc.channel });
}

async function whileOffline(
  page: Page,
  check: () => Promise<void>,
): Promise<void> {
  const context = page.context();
  await context.setOffline(true);
  try {
    await check();
  } finally {
    await context.setOffline(false);
    await dispatchPersistedPageShow(page);
  }
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
}

async function expectTab(
  page: Page,
  icon: TabIcon,
  title: string,
): Promise<void> {
  await expect
    .poll(() => tabState(page), { message: `the tab shows ${icon}` })
    .toEqual({
      icons: [
        tabIconHref("image/svg+xml", icon),
        tabIconHref("image/png", icon),
      ],
      states: [icon, icon],
      title,
    });
}

function channelRow(page: Page, channel: string) {
  return page.getByRole("button", { name: channel });
}

function tabState(page: Page) {
  return page.evaluate(() => ({
    icons: [...document.querySelectorAll('link[rel="icon"]')].map((link) =>
      link.getAttribute("href"),
    ),
    states: [...document.querySelectorAll('link[rel="icon"]')].map((link) =>
      link.getAttribute("data-tab-icon"),
    ),
    title: document.title,
  }));
}

/** Draws the page's current favicon and title like a tab, since headless tabs have no strip. */
async function captureTab(
  context: BrowserContext,
  page: Page,
  name: TabIcon,
): Promise<void> {
  const { icons, title } = await tabState(page);
  const icon = await context.request.get(
    new URL(icons[0] ?? "", page.url()).href,
  );
  expect(icon.ok()).toBe(true);
  const source = `data:image/svg+xml;base64,${(await icon.body()).toString("base64")}`;
  const preview = await context.newPage();
  try {
    await mkdir(screenshots, { recursive: true });
    await preview.setContent(`
      <div id="tab" style="display:inline-flex;align-items:center;gap:8px;padding:8px 14px;background:#dee1e6;font:13px system-ui;color:#1f1f1f">
        <img alt="" height="16" src="${source}" width="16" />
        <span>${title}</span>
        <img alt="" height="64" src="${source}" style="margin-left:12px" width="64" />
      </div>`);
    await expect
      .poll(() =>
        preview
          .locator("img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    await preview
      .locator("#tab")
      .screenshot({ path: path.join(screenshots, `${name}.png`) });
  } finally {
    await preview.close();
  }
}
