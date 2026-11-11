import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";

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
      baseURL,
      page,
    }) => {
      const suffix = `${layout[0]}${Date.now().toString(36).slice(-5)}`;
      const account = `sl-own-${suffix}`;
      const operatorNick = `sl-op-${suffix}`;
      const channel = `#sl-${suffix}`;
      const registration = await IrcClient.connectIsolated(
        account,
        `#reg-${suffix}`,
      );
      registration.close();
      await registration.waitForDisconnect();
      const operator = await IrcClient.connectIsolated(operatorNick, channel);
      const joiners: IrcClient[] = [];
      const joinerNicks = ["kiwi", "zed", "ana", "tomo", "bob", "eve"].map(
        (name) => `${name}-${suffix}`,
      );
      try {
        await page.goto(accountUrl(baseURL, account));
        await joinChannel(page, channel);
        const directSeed = `direct before rename ${suffix}`;
        await operator.privmsgConfirmed(account, directSeed);

        const joinBreaker = `join breaker ${suffix}`;
        await operator.privmsgConfirmed(channel, joinBreaker);
        await expect(
          page.getByText(joinBreaker, { exact: true }),
        ).toBeVisible();

        for (const nick of joinerNicks)
          joiners.push(await IrcClient.connectIsolated(nick, channel));
        const renamedNick = `sl-new-${suffix}`;
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
        await expect(
          page.getByRole("heading", { name: channel }),
        ).toBeVisible();

        await collapsed.getByRole("button", { name: "Show 3 others" }).click();
        const expanded = page.locator(
          '[data-system-line][data-expanded="true"]',
        );
        await expect(expanded).toContainText("6 people joined");
        await expect(expanded.locator("[data-system-detail]")).toHaveCount(7);
        for (const nick of joinerNicks)
          await expect(
            expanded.locator("[data-system-detail]").filter({ hasText: nick }),
          ).toBeVisible();
        await capture(page, layout, "expanded");
        await expanded.getByRole("button", { name: "Show less" }).click();

        const breaker = `run breaker ${suffix}`;
        await operator.privmsgConfirmed(channel, breaker);
        await expect(page.getByText(breaker, { exact: true })).toBeVisible();
        for (const joiner of joiners.slice(0, 2)) await joiner.part(channel);
        await expect(
          systemLine(page, "left", joinerNicks.slice(0, 2)),
        ).toBeVisible();
        await operator.privmsgConfirmed(channel, `quit breaker ${suffix}`);
        for (const joiner of joiners.slice(2)) joiner.close();
        const quit = systemLine(page, "quit", joinerNicks.slice(2));
        await expect(quit).toBeVisible();
        await expect(quit).not.toContainText("others");

        await operator.kick(channel, account, "testing rejoin");
        const warning = page
          .locator('[data-system-line][data-warning="true"]')
          .filter({ hasText: "testing rejoin" });
        await expect(warning).toContainText(`${renamedNick} kicked you`);
        await expect(
          warning.getByRole("img", { name: "Warning" }),
        ).toBeVisible();
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
      } finally {
        operator.close();
        for (const joiner of joiners) joiner.close();
      }
    });
  });
}

function accountUrl(baseURL: string | undefined, account: string): string {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const url = new URL("/", baseURL);
  url.searchParams.set("irc-password", `test-${account}`);
  url.searchParams.set("irc-account", account);
  url.searchParams.set("irc-nickname", account);
  return url.href;
}

async function joinChannel(page: Page, channel: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  if (!(await composer.isVisible()))
    await page.getByRole("button", { name: "#weblounge-test" }).click();
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
  phase: "collapsed" | "expanded" | "own-kick",
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
