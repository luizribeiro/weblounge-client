import type { Locator, Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";
import { tokenColor } from "./token-color";

const membersButton = (page: Page) =>
  page.getByRole("button", { name: "Toggle member list" });
const membersOf = (page: Page, channel: string) =>
  page.getByRole("complementary", { name: `Members of ${channel}` });
const composerOf = (page: Page, title: string) =>
  page.getByRole("textbox", { name: `Message ${title}` });

async function openBuffer(page: Page, title: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Networks and buffers" })
    .getByRole("button", { name: title, exact: true })
    .click();
  await expectSettled(page, { conversation: title });
}

async function launch(
  page: Page,
  irc: IrcTestAccount,
  channels: readonly string[],
): Promise<void> {
  await page.goto(irc.url({ autojoin: channels }));
  for (const channel of channels)
    await expect(
      page.getByRole("button", { name: channel, exact: true }),
    ).toBeVisible();
}

async function paneBox(page: Page, selector: string) {
  return page.evaluate((target) => {
    const box = document.querySelector(target)?.getBoundingClientRect();
    if (box === undefined) throw new Error(`${target} is missing`);
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
    };
  }, selector);
}

function memberColumnWidth(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--wl-size-members",
      ),
    ),
  );
}

async function expectPaneOwnsMembers(page: Page, panel: Locator) {
  const pane = await paneBox(page, "[data-desktop-pane]");
  const header = await paneBox(page, "[data-main-header]");
  const transcript = await paneBox(page, "[data-message-list]");
  const members = await panel.boundingBox();
  if (members === null) throw new Error("the member list has no box");
  expect(Math.abs(header.left - pane.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(header.right - pane.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(members.y - header.bottom)).toBeLessThanOrEqual(1);
  expect(members.width).toBeCloseTo(await memberColumnWidth(page), 0);
  expect(Math.abs(members.x + members.width - pane.right)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(transcript.left - pane.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(transcript.right - members.x)).toBeLessThanOrEqual(1);
}

test.describe("per-pane desktop members against local Ergo", () => {
  test("remembers each channel's list across a relaunch", async ({
    page,
    irc,
  }) => {
    const first = irc.channel;
    const second = irc.channelNamed("second");
    const third = irc.channelNamed("third");
    const fourth = irc.channelNamed("fourth");
    const pal = await irc.peer("pal", [first]);
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await launch(page, irc, [second, third, fourth]);
    await openBuffer(page, first);

    await membersButton(page).click();
    const firstMembers = membersOf(page, first);
    await expect(firstMembers).toBeVisible();
    await expect(membersButton(page)).toHaveAttribute("aria-pressed", "true");
    await expectPaneOwnsMembers(page, firstMembers);

    const member = firstMembers.getByRole("button", {
      name: `Open direct message with ${pal.nickname}`,
    });
    await member.focus();
    await page.keyboard.press("Escape");
    await expect(composerOf(page, first)).toBeFocused();
    await expect(firstMembers).toBeVisible();

    await openBuffer(page, second);
    await expect(membersOf(page, second)).toBeVisible();
    await page.keyboard.press("Control+Period");
    await expect(membersOf(page, second)).toHaveCount(0);
    await expect(membersButton(page)).toHaveAttribute("aria-pressed", "false");

    await openBuffer(page, third);
    await expect(membersOf(page, third)).toHaveCount(0);
    await membersButton(page).click();
    await expect(membersOf(page, third)).toBeVisible();
    await openBuffer(page, first);
    await expect(firstMembers).toBeVisible();
    await nativeFeelAudit(page);

    await launch(page, irc, [second, third, fourth]);
    await openBuffer(page, first);
    await expect(firstMembers).toBeVisible();
    await openBuffer(page, second);
    await expect(membersOf(page, second)).toHaveCount(0);
    await openBuffer(page, fourth);
    await expect(membersOf(page, fourth)).toBeVisible();
  });

  test("opens a member's DM in the pane, without a members column", async ({
    page,
    irc,
  }) => {
    const pal = await irc.peer("pal");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await membersButton(page).click();
    await membersOf(page, irc.channel)
      .getByRole("button", { name: `Open direct message with ${pal.nickname}` })
      .click();

    await expectSettled(page, { conversation: pal.nickname });
    await expect(composerOf(page, pal.nickname)).toBeFocused();
    await expectFullWidthWithoutMembers(page);

    await page.getByRole("button", { name: "Local Ergo, online" }).click();
    await expectSettled(page, { conversation: "Local Ergo" });
    await expectFullWidthWithoutMembers(page);

    await openBuffer(page, irc.channel);
    await expect(membersOf(page, irc.channel)).toBeVisible();
  });

  test("docks a narrow pane's list below its header like the inline list", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    const composer = composerOf(page, irc.channel);
    await composer.fill("draft across the threshold");
    await composer.evaluate((element) => {
      (element as HTMLElement & { paneProbe?: true }).paneProbe = true;
    });

    const drawer = page.getByRole("dialog", { name: "Members" });
    const scrim = page.locator("[data-overlay-scrim]");
    await membersButton(page).click();
    await expect(page.locator("[data-overlay-drawer]")).toHaveAttribute(
      "data-phase",
      "open",
    );
    await expect(membersButton(page)).toHaveAttribute("aria-pressed", "true");
    await expectDrawerLooksInline(page, drawer, membersOf(page, irc.channel));

    await membersButton(page).click();
    await expect(drawer).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(membersButton(page)).toHaveAttribute("aria-pressed", "false");

    await membersButton(page).click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(composer).toBeFocused();

    await page.keyboard.press("Control+Period");
    await expect(drawer).toBeVisible();
    await scrim.click({ position: { x: 40, y: 400 } });
    await expect(drawer).toHaveCount(0);
    await expect(composer).toBeFocused();

    await membersButton(page).click();
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(drawer).toHaveCount(0);
    await expect(membersOf(page, irc.channel)).toHaveCount(0);
    await membersButton(page).click();
    await expect(membersOf(page, irc.channel)).toBeVisible();
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(membersOf(page, irc.channel)).toHaveCount(0);
    await expect(drawer).toHaveCount(0);
    await expect(composer).toHaveValue("draft across the threshold");
    expect(
      await composer.evaluate(
        (element) =>
          (element as HTMLElement & { paneProbe?: true }).paneProbe === true,
      ),
    ).toBe(true);
    await nativeFeelAudit(page);
  });

  test("a confirmation over the docked list still swallows typing", async ({
    page,
    irc,
  }) => {
    const second = irc.channelNamed("second");
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await launch(page, irc, [irc.channel, second]);
    await openBuffer(page, irc.channel);

    await openDockedDrawer(page);
    await page
      .getByRole("navigation", { name: "Networks and buffers" })
      .getByRole("button", { name: second, exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menu", { name: `Actions for ${second}` })
      .getByRole("menuitem", { name: "Leave channel" })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: `Leave ${second}?`,
    });
    await expect(
      confirmation.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await page.keyboard.type("x");
    await expect(
      confirmation.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await expect(composerOf(page, irc.channel)).toHaveValue("");
    await nativeFeelAudit(page);
  });
});

async function openDockedDrawer(page: Page): Promise<void> {
  await membersButton(page).click();
  await expect(page.locator("[data-overlay-drawer]")).toHaveAttribute(
    "data-phase",
    "open",
  );
}

async function expectDrawerLooksInline(
  page: Page,
  drawer: Locator,
  panel: Locator,
): Promise<void> {
  await expect(panel).toBeVisible();
  await expect(drawer).toHaveAttribute("aria-modal", "false");
  await expect(drawer.locator("header")).toHaveCount(0);
  await expect(
    drawer.getByRole("button", { name: "Hide members" }),
  ).toHaveCount(0);
  await expect(drawer).toHaveCSS("box-shadow", "none");
  await expect(page.locator("[data-overlay-scrim]")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(panel).toHaveCSS("border-left-width", "1px");
  await expect(panel).toHaveCSS(
    "background-color",
    await tokenColor(page, "--wl-color-panel-alt"),
  );
  const pane = await paneBox(page, "[data-desktop-pane]");
  const header = await paneBox(page, "[data-main-header]");
  const overlay = await paneBox(page, "[data-overlay-drawer]");
  expect(Math.abs(overlay.top - header.bottom)).toBeLessThanOrEqual(1);
  for (const edge of ["left", "right", "bottom"] as const)
    expect(Math.abs(overlay[edge] - pane[edge])).toBeLessThanOrEqual(1);
  expect(pane.left).toBeGreaterThan(0);
  const drawerBox = await drawer.boundingBox();
  if (drawerBox === null) throw new Error("the members drawer has no box");
  expect(
    Math.abs(drawerBox.x + drawerBox.width - pane.right),
  ).toBeLessThanOrEqual(1);
}

async function expectFullWidthWithoutMembers(page: Page): Promise<void> {
  await expect(membersButton(page)).toHaveCount(0);
  await expect(page.locator("[data-member-buffer]")).toHaveCount(0);
  const pane = await paneBox(page, "[data-desktop-pane]");
  const transcript = await paneBox(page, "[data-message-list]");
  expect(Math.abs(transcript.right - pane.right)).toBeLessThanOrEqual(1);
}
