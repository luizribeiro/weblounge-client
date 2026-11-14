import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import type { IrcClient } from "./irc-client";
import { expect, test } from "./irc-fixture";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const [layout, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(layout, () => {
    test.use({
      viewport,
      ...(layout === "phone" ? { hasTouch: true, isMobile: true } : {}),
    });

    test(`renders runs, expands them, and rejoins after an own kick`, async ({
      page,
      irc,
    }) => {
      const suffix = irc.id;
      const account = irc.account;
      const channel = irc.channelNamed("sl");
      const operator = await irc.peer("sl-op", [channel]);
      const operatorNick = operator.nickname;
      const joiners: IrcClient[] = [];
      const joinerLabels = ["kiwi", "zed", "ana", "tomo", "bob", "eve"];
      const joinerNicks = joinerLabels.map((label) => irc.nickNamed(label));
      const [opTarget, voiceTarget] = joinerNicks;
      if (opTarget === undefined || voiceTarget === undefined)
        throw new Error("mode targets are missing");
      await page.goto(irc.url());
      await joinChannel(page, irc.channel, channel);
      const directSeed = `direct before rename ${suffix}`;
      await operator.privmsgConfirmed(account, directSeed);

      const joinBreaker = `join breaker ${suffix}`;
      await operator.privmsgConfirmed(channel, joinBreaker);
      await expect(page.getByText(joinBreaker, { exact: true })).toBeVisible();

      for (const label of joinerLabels)
        joiners.push(await irc.peer(label, [channel]));
      const renamedNick = irc.nickNamed("sl-new");
      await operator.nick(renamedNick);

      const collapsed = systemLine(page, "joined", joinerNicks.slice(0, 3));
      await expect(collapsed).toContainText("3 others");
      await expect(collapsed).toContainText(
        `${operatorNick} is now ${renamedNick}`,
      );
      await expectSystemGeometry(collapsed, layout);
      if (layout === "desktop")
        await expectDesktopColumnAlignment(page, collapsed, joinBreaker);
      await captureNick(page, layout);
      await capture(page, layout, "collapsed");

      if (layout === "phone")
        await page.getByRole("button", { name: "Back to chats" }).click();
      await page
        .getByRole("button", {
          name: new RegExp(`^${operatorNick}(?:,|$)`, "u"),
        })
        .click();
      await expect(
        page.getByRole("heading", { name: operatorNick }),
      ).toBeVisible();
      await expect(
        systemLine(page, "is now", [operatorNick, renamedNick]),
      ).toBeVisible();
      if (layout === "phone")
        await page.getByRole("button", { name: "Back to chats" }).click();
      await page.getByRole("button", { name: channel }).click();
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();

      await collapsed.getByRole("button", { name: "Show 3 others" }).click();
      const expanded = page.locator('[data-system-line][data-expanded="true"]');
      await expect(expanded).toContainText("6 people joined");
      await expect(expanded.locator("[data-system-detail]")).toHaveCount(7);
      for (const nick of joinerNicks)
        await expect(
          expanded.locator("[data-system-detail]").filter({ hasText: nick }),
        ).toBeVisible();
      await capture(page, layout, "expanded");
      await expanded.getByRole("button", { name: "Show less" }).click();

      const modeBreaker = `mode breaker ${suffix}`;
      await operator.privmsgConfirmed(channel, modeBreaker);
      const banMask = `blocked-${suffix}!*@*`;
      await operator.mode(channel, "+ovb", opTarget, voiceTarget, banMask);
      const modes = systemLine(page, "gave op", [
        renamedNick,
        opTarget,
        voiceTarget,
        banMask,
      ]);
      await expect(modes).toContainText("voice to");
      await expect(modes).toContainText("banned");
      if (layout === "desktop") {
        await expect(modes).toContainText(
          `+ovb ${opTarget} ${voiceTarget} ${banMask}`,
        );
      } else {
        await expect(modes).not.toContainText("+ovb");
      }
      await capture(page, layout, "modes-alone");

      await operator.privmsgConfirmed(channel, `mixed mode breaker ${suffix}`);
      const mixedJoiner = await irc.peer("mix", [channel]);
      const mixedNick = mixedJoiner.nickname;
      joiners.push(mixedJoiner);
      await operator.mode(channel, "+v", mixedNick);
      const mixedModes = systemLine(page, "joined", [
        mixedNick,
        renamedNick,
      ]).filter({ hasText: "gave voice" });
      await expect(mixedModes).toBeVisible();
      await capture(page, layout, "modes-mixed");
      mixedJoiner.close();
      await mixedJoiner.waitForDisconnect();
      joiners.pop();

      const breaker = `run breaker ${suffix}`;
      await operator.privmsgConfirmed(channel, breaker);
      await expect(page.getByText(breaker, { exact: true })).toBeVisible();
      for (const joiner of joiners.slice(0, 2)) await joiner.part(channel);
      await expect(
        systemLine(page, "left", joinerNicks.slice(0, 2)),
      ).toBeVisible();
      await operator.privmsgConfirmed(channel, `quit breaker ${suffix}`);
      for (const joiner of joiners.slice(2)) joiner.close();
      for (const joiner of joiners.slice(2)) await joiner.waitForDisconnect();
      const quit = systemLine(page, "quit", joinerNicks.slice(2));
      await expect(quit).toBeVisible();
      await expect(quit).not.toContainText("others");

      await operator.kick(channel, account, "testing rejoin");
      const warning = page
        .locator('[data-system-line][data-warning="true"]')
        .filter({ hasText: "testing rejoin" });
      await expect(warning).toContainText(`${renamedNick} kicked you`);
      await expect(warning.getByRole("img", { name: "Warning" })).toBeVisible();
      await expect(
        warning.getByRole("button", { name: "Rejoin channel" }),
      ).toBeVisible();
      await capture(page, layout, "own-kick");

      const rejoined = operator.waitForNextJoin(channel, account);
      await warning.getByRole("button", { name: "Rejoin channel" }).click();
      await rejoined;
      await expect(
        page.getByRole("textbox", { name: "Message" }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Rejoin channel" }),
      ).toHaveCount(0);
    });
  });
}

async function joinChannel(
  page: Page,
  home: string,
  channel: string,
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  if (!(await composer.isVisible()))
    await page.getByRole("button", { name: home }).click();
  await expect(composer).toBeEnabled();
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

function systemLine(page: Page, verb: string, nicks: readonly string[]) {
  let row = page.locator("[data-system-line]").filter({ hasText: verb });
  for (const nick of nicks) row = row.filter({ hasText: nick });
  return row;
}

async function expectSystemGeometry(
  row: ReturnType<typeof systemLine>,
  layout: "desktop" | "phone",
): Promise<void> {
  const icon = row.locator("svg").first();
  if (layout === "phone") {
    await expect(row.locator("time")).toBeHidden();
    await expect(row).toHaveCSS("font-size", "14px");
    await expect(row).toHaveCSS("line-height", "20px");
    await expect(icon).toHaveCSS("width", "16px");
    await expect(row).toHaveCSS("column-gap", "10px");
  } else {
    await expect(row.locator("time")).toBeVisible();
    await expect(row.locator("[data-system-summary]")).toHaveCSS(
      "font-size",
      "13px",
    );
    await expect(row).toHaveCSS("line-height", "21px");
    await expect(icon).toHaveCSS("width", "15px");
    await expect(row).toHaveCSS("grid-template-columns", /.+ 112px .+/u);
    await expect(row).toHaveCSS("column-gap", "10px");
  }
  await expect(row.locator("[data-own]").first()).toHaveCSS(
    "font-weight",
    "600",
  );
}

async function expectDesktopColumnAlignment(
  page: Page,
  system: ReturnType<typeof systemLine>,
  message: string,
): Promise<void> {
  const messageRow = page.locator("[data-message-row]").filter({
    has: page.getByText(message, { exact: true }),
  });
  const messageText = messageRow.locator("[data-selectable]");
  const systemText = system.locator("[data-system-summary]");

  await expect
    .poll(async () => {
      const [messageBox, systemBox] = await Promise.all([
        messageText.boundingBox(),
        systemText.boundingBox(),
      ]);
      if (messageBox === null || systemBox === null) return null;
      return Math.abs(messageBox.x - systemBox.x);
    })
    .toBeLessThanOrEqual(0.5);

  const [messageTime, systemTime] = await Promise.all([
    messageRow.locator("time").boundingBox(),
    system.locator("time").boundingBox(),
  ]);
  if (messageTime === null || systemTime === null)
    throw new Error("desktop time geometry is missing");
  expect(systemTime.width).toBeCloseTo(messageTime.width, 1);
  expect(systemTime.height).toBeLessThanOrEqual(21);
}

async function capture(
  page: Page,
  layout: "desktop" | "phone",
  phase: "collapsed" | "expanded" | "modes-alone" | "modes-mixed" | "own-kick",
): Promise<void> {
  const directory = process.env.WEBLOUNGE_SYSTEM_LINE_SCREENSHOT_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "dark" ? "lounge-night" : "lounge",
    );
    await screenshotWithInter(page.locator("[data-app-root]"), {
      path: path.join(
        directory,
        `system-lines-${layout}-${theme}-${phase}.png`,
      ),
    });
  }
}

async function captureNick(
  page: Page,
  layout: "desktop" | "phone",
): Promise<void> {
  const directory = process.env.WEBLOUNGE_SYSTEM_LINE_SCREENSHOT_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lounge");
  await screenshotWithInter(page.locator("[data-app-root]"), {
    path: path.join(directory, `system-lines-${layout}-light-nick.png`),
  });
}
