import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { dispatchPersistedPageShow } from "./page-lifecycle";
import { settingsScreenshot } from "./settings-fixture";
import { expectSettled } from "./settled";

type TabIcon = "connected" | "unread" | "disconnected";

const iconSuffixes: Record<TabIcon, string> = {
  connected: "",
  unread: "-unread",
  disconnected: "-disconnected",
};
const screenshots = path.join(
  process.cwd(),
  "e2e",
  "screenshots",
  "tab-indicator",
);

test.describe("browser tab indicator against local Ergo", () => {
  test("turns red with a count for an unread DM and grey while disconnected", async ({
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
    await expectTab(page, "unread", "(1) weblounge");
    await captureTab(context, page, "unread");

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

  test("the Settings switch hides unread from the tab but keeps grey", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await openHome(page, irc);
    await settingsButton(page).click();
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
    await settingsButton(page).click();
    await expect(tabSwitch).toHaveAttribute("aria-checked", "false");
    await expectTab(page, "connected", "weblounge");
    await tabSwitch.click();
    await expectTab(page, "unread", "(1) weblounge");
    await expectSettled(page);
    await settingsScreenshot(dialog, "desktop-tab-indicator-on");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await nativeFeelAudit(page);
  });
});

async function openHome(page: Page, irc: IrcTestAccount): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(irc.url());
  await page.getByRole("button", { name: irc.channel }).click();
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

function settingsButton(page: Page) {
  return page
    .getByRole("complementary", { name: "Channel list" })
    .getByRole("button", { name: "Settings" });
}

function directRow(page: Page, peer: IrcClient) {
  return page.getByRole("button", {
    name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
  });
}

async function expectTab(
  page: Page,
  icon: TabIcon,
  title: string,
): Promise<void> {
  const suffix = iconSuffixes[icon];
  await expect
    .poll(() => tabState(page), { message: `the tab shows ${icon}` })
    .toEqual({
      icons: [`/icons/favicon${suffix}.svg`, `/icons/favicon-32${suffix}.png`],
      title,
    });
}

function tabState(page: Page) {
  return page.evaluate(() => ({
    icons: [...document.querySelectorAll('link[rel="icon"]')].map((link) =>
      link.getAttribute("href"),
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
