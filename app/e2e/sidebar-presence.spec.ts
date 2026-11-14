import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";
import {
  expectSidebarColumnsCentredAtEachDensity,
  tokenColour,
} from "./sidebar-geometry";

test.describe("sidebar presence against local Ergo", () => {
  test("marks the connected network with the online colour", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });

    const network = page.getByRole("button", { name: "Local Ergo, online" });
    const dot = network.locator("[data-network-dot]");
    await expect(dot).toBeVisible();
    await expect(dot).toHaveCSS(
      "background-color",
      await tokenColour(page, "--wl-color-online"),
    );
    await nativeFeelAudit(page);
  });

  test("centres every leading and trailing mark on its column's centre line", async ({
    page,
    irc,
  }) => {
    const bot = await irc.peer("concierge", []);
    const human = await irc.peer("ana", []);
    try {
      await bot.mode(bot.nickname, "+B");
      await installNativeFeelInstrumentation(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(irc.url());
      await expectSettled(page, { conversation: irc.channel });
      await bot.privmsgConfirmed(irc.account, `beep ${irc.id}`);
      await human.privmsgConfirmed(irc.account, `hello ${irc.id}`);
      await directRow(
        page,
        `${bot.nickname}, bot, 1 unread, including mentions, online`,
      );
      await directRow(
        page,
        `${human.nickname}, 1 unread, including mentions, online`,
      );
      const network = page.getByRole("button", { name: "Local Ergo, online" });
      await expectSidebarColumnsCentredAtEachDensity(page, network);
      await widenFirstBadge(page);
      await expectSidebarColumnsCentredAtEachDensity(page, network);

      await page.setViewportSize({ width: 700, height: 800 });
      await page.getByRole("button", { name: "Toggle channel list" }).click();
      await expect(page.locator("[data-overlay-drawer]")).toBeVisible();
      await expect(network).toBeVisible();
      await expectSidebarColumnsCentredAtEachDensity(page, network);
      await nativeFeelAudit(page);
    } finally {
      bot.close();
      human.close();
    }
  });

  test("colours the network dot for each connection state", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    const network = page.locator("[data-network-state]");
    const dot = network.locator("[data-network-dot]");

    for (const [state, background, border] of [
      ["reconnecting", "transparent", "--wl-color-panel-muted"],
      ["offline", "--wl-color-panel-border", "--wl-color-panel-border"],
      ["failed", "--wl-color-error", "--wl-color-error"],
    ] as const) {
      await network.evaluate((element, value) => {
        element.setAttribute("data-network-state", value);
      }, state);
      await expect(dot).toHaveCSS(
        "background-color",
        background === "transparent"
          ? "rgba(0, 0, 0, 0)"
          : await tokenColour(page, background),
      );
      await expect(dot).toHaveCSS(
        "border-top-color",
        await tokenColour(page, border),
      );
    }
  });

  test("shows a DM peer's MONITOR presence on the row's leading column", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("ana", []);
    try {
      await installNativeFeelInstrumentation(page);
      await page.goto(irc.url());
      await expectSettled(page, { conversation: irc.channel });
      await peer.privmsgConfirmed(irc.account, `hello ${irc.id}`);

      const row = await directRow(
        page,
        `${peer.nickname}, 1 unread, including mentions, online`,
      );
      const dot = row.locator("[data-sidebar-prefix] [data-presence]");
      await expect(dot).toHaveAttribute("data-presence", "online");
      await expect(dot).toHaveCSS(
        "background-color",
        await tokenColour(page, "--wl-color-online"),
      );
      const channel = page.getByRole("button", { name: irc.channel });
      expect(await nameLeft(row)).toBeCloseTo(await nameLeft(channel), 1);

      await peer.setAway("lunch");
      await expect(row).toHaveAccessibleName(
        `${peer.nickname}, 1 unread, including mentions, away`,
      );
      await expect(dot).toHaveAttribute("data-presence", "away");
      await expect(dot).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(dot).toHaveCSS(
        "border-top-color",
        await tokenColour(page, "--wl-color-panel-muted"),
      );
      peer.close();
      await peer.waitForDisconnect();
      await expect(row).toHaveAccessibleName(
        `${peer.nickname}, 1 unread, including mentions`,
      );
      await expect(dot).toHaveCount(0);
      await nativeFeelAudit(page);
    } finally {
      peer.close();
    }
  });

  test("shows a bot DM peer's presence as a tinted robot in the leading column", async ({
    page,
    irc,
  }) => {
    const bot = await irc.peer("concierge", []);
    const human = await irc.peer("ana", []);
    try {
      await bot.mode(bot.nickname, "+B");
      await installNativeFeelInstrumentation(page);
      await page.goto(irc.url());
      await expectSettled(page, { conversation: irc.channel });
      await bot.privmsgConfirmed(irc.account, `beep ${irc.id}`);
      await human.privmsgConfirmed(irc.account, `hello ${irc.id}`);

      const botRow = await directRow(
        page,
        `${bot.nickname}, bot, 1 unread, including mentions, online`,
      );
      const humanRow = await directRow(
        page,
        `${human.nickname}, 1 unread, including mentions, online`,
      );
      const robot = botRow.locator("[data-sidebar-prefix] [data-peer-bot]");
      await expect(robot).toHaveAttribute("data-presence", "online");
      await expect(robot).toHaveCSS(
        "color",
        await tokenColour(page, "--wl-color-online"),
      );
      await expect(robot).toHaveCSS("opacity", "1");
      await expect(botRow.locator("[data-presence]")).toHaveCount(1);
      await expect(
        humanRow.locator("[data-sidebar-prefix] [data-peer-bot]"),
      ).toHaveCount(0);
      await expect(humanRow.locator("[data-presence]")).toHaveAttribute(
        "data-presence",
        "online",
      );
      await expectFillsPrefix(robot, botRow);
      const channel = page.getByRole("button", { name: irc.channel });
      expect(await nameLeft(botRow)).toBeCloseTo(await nameLeft(channel), 1);

      await bot.setAway("recharging");
      await expect(botRow).toHaveAccessibleName(
        `${bot.nickname}, bot, 1 unread, including mentions, away`,
      );
      await expect(robot).toHaveAttribute("data-presence", "away");
      await expect(robot).toHaveCSS(
        "color",
        await tokenColour(page, "--wl-color-panel-muted"),
      );
      await expect(robot).toHaveCSS("opacity", "0.5");

      bot.close();
      await bot.waitForDisconnect();
      await expect(botRow).toHaveAccessibleName(
        `${bot.nickname}, bot, 1 unread, including mentions`,
      );
      await expect(robot).not.toHaveAttribute("data-presence");
      await expect(robot).toHaveCSS("opacity", "1");
      await nativeFeelAudit(page);
    } finally {
      bot.close();
      human.close();
    }
  });
});

async function nameLeft(row: Locator): Promise<number> {
  const box = await row.locator("[data-sidebar-name]").boundingBox();
  if (box === null) throw new Error("row name has no box");
  return box.x;
}

/** Seeding 100 unread lines is slow; the layout only needs the widest text a badge can show. */
async function widenFirstBadge(page: Page): Promise<void> {
  const badge = page.locator("[data-badge-kind]").first();
  await badge.evaluate((element) => {
    element.textContent = "99+";
  });
  await expect(badge).toHaveText("99+");
}

async function directRow(page: Page, name: string): Promise<Locator> {
  const direct = page.getByRole("button", { name, exact: true });
  await expect(direct).toBeVisible();
  return page.locator(
    `[data-buffer-id="${await direct.getAttribute("data-buffer-id")}"]`,
  );
}

async function expectFillsPrefix(icon: Locator, row: Locator): Promise<void> {
  const [iconBox, prefixBox] = await Promise.all([
    icon.boundingBox(),
    row.locator("[data-sidebar-prefix]").boundingBox(),
  ]);
  if (iconBox === null || prefixBox === null)
    throw new Error("bot icon or prefix has no box");
  expect(iconBox.width).toBeCloseTo(prefixBox.width, 1);
  expect(iconBox.x).toBeCloseTo(prefixBox.x, 1);
}
