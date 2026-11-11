import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";
import { armMessageTime } from "./time-rewrite";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("renders out-of-order arrivals and a moved confirmation in engine order", async ({
  baseURL,
  page,
}) => {
  const suffix = Date.now().toString(36);
  const account = `order-own-${suffix}`;
  const channel = `#order-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const bot = await IrcClient.connectIsolated(`order-w-${suffix}`, channel);
  const early = `engine early ${suffix}`;
  const middle = `engine moved own ${suffix}`;
  const late = `engine late ${suffix}`;
  const base = Date.now() - 60_000;
  try {
    await armMessageTime(early, base);
    await armMessageTime(middle, base + 1_000);
    await armMessageTime(late, base + 2_000);
    await useDedicatedWorker(page);
    await page.goto(accountUrl(baseURL, account, channel));
    await page.getByRole("button", { name: channel }).click();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    await bot.privmsgConfirmed(channel, late);
    await bot.privmsgConfirmed(channel, early);
    await expect(messageRow(page, early)).toBeVisible();
    await observeOwnMovement(page, middle);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(middle);
    await composer.press("Enter");
    await expect(messageRow(page, middle)).toHaveAttribute(
      "data-delivery",
      "confirmed",
    );

    await expect
      .poll(() => observedDeliveries(page))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));
    const rows = [early, middle, late].map((text) => messageRow(page, text));
    const indexes = await Promise.all(rows.map(rowIndex));
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    const engineOrders = await Promise.all(
      rows.map((row) =>
        row.locator("xpath=ancestor::li").getAttribute("data-engine-order"),
      ),
    );
    expect(engineOrders.every((order) => order !== null)).toBe(true);
    expect(engineOrders).toEqual(
      [...engineOrders].sort((left, right) =>
        (left ?? "").localeCompare(right ?? "", undefined, { numeric: true }),
      ),
    );
  } finally {
    keeper.close();
    bot.close();
  }
});

test("renders plain membership runs with legacy wording", async ({
  baseURL,
  page,
}) => {
  const suffix = Date.now().toString(36).slice(-6);
  const account = `jr-own-${suffix}`;
  const channel = `#jr-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const writer = await IrcClient.connectIsolated(`jr-w-${suffix}`, channel);
  const joinerNicks = [0, 1, 2, 3, 4, 5].map((index) => `jr${index}-${suffix}`);
  const joiners: IrcClient[] = [];
  try {
    await useDedicatedWorker(page);
    await page.goto(accountUrl(baseURL, account, channel));
    await page.getByRole("button", { name: channel }).click();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const breaker = `membership breaker ${suffix}`;
    await writer.privmsgConfirmed(channel, breaker);
    await expect(messageRow(page, breaker)).toBeVisible();

    for (const nick of joinerNicks)
      joiners.push(await IrcClient.connectIsolated(nick, channel));

    await expect(membershipRun(page, "joined", joinerNicks)).toHaveText(
      /^→ .* joined$/u,
    );
    await writer.privmsgConfirmed(channel, `part breaker ${suffix}`);
    for (const joiner of joiners.slice(0, 3)) await joiner.part(channel);
    await expect(
      membershipRun(page, "left", joinerNicks.slice(0, 3)),
    ).toHaveText(/^← .* left$/u);
    await writer.privmsgConfirmed(channel, `quit breaker ${suffix}`);
    for (const [index, joiner] of joiners.slice(3).entries()) {
      joiner.close();
      await expect(
        page
          .locator("[data-membership-row]")
          .filter({ hasText: joinerNicks[3 + index] })
          .filter({ hasText: "quit" }),
      ).toBeVisible();
    }
    await expect(membershipRun(page, "quit", joinerNicks.slice(3))).toHaveText(
      /^← .* quit$/u,
    );
    await captureMembershipScreenshots(page);
  } finally {
    keeper.close();
    writer.close();
    for (const joiner of joiners) joiner.close();
  }
});

function accountUrl(
  baseURL: string | undefined,
  account: string,
  channel: string,
) {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const url = new URL("/", baseURL);
  url.searchParams.set("irc-password", `test-${account}`);
  url.searchParams.set("irc-account", account);
  url.searchParams.set("irc-nickname", account);
  url.searchParams.append("irc-autojoin", channel);
  return url.href;
}

function messageRow(page: import("@playwright/test").Page, text: string) {
  return page.locator("[data-message-row]").filter({
    has: page.getByText(text, { exact: true }),
  });
}

function membershipRun(
  page: import("@playwright/test").Page,
  verb: string,
  nicks: readonly string[],
) {
  let row = page.locator("[data-membership-row]").filter({ hasText: verb });
  for (const nick of nicks) row = row.filter({ hasText: nick });
  return row;
}

async function captureMembershipScreenshots(
  page: import("@playwright/test").Page,
) {
  const directory = process.env.WEBLOUNGE_MEMBERSHIP_SCREENSHOT_DIR;
  const phase = process.env.WEBLOUNGE_MEMBERSHIP_SCREENSHOT_PHASE;
  if (directory === undefined || phase === undefined) return;
  await mkdir(directory, { recursive: true });
  for (const [shell, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await screenshotWithInter(page.locator("[data-app-root]"), {
      path: path.join(directory, `${phase}-${shell}.png`),
    });
  }
}

async function rowIndex(row: import("@playwright/test").Locator) {
  return row.evaluate((element) =>
    Number(element.closest("li")?.dataset.index),
  );
}

async function observeOwnMovement(
  page: import("@playwright/test").Page,
  text: string,
) {
  await page.evaluate((messageText) => {
    Reflect.set(globalThis, "timelineOwnDeliveries", []);
    const observer = new MutationObserver(() => {
      const row = [
        ...document.querySelectorAll<HTMLElement>("[data-message-row]"),
      ].find((candidate) => candidate.dataset.messageText === messageText);
      const delivery = row?.dataset.delivery;
      const observed = Reflect.get(
        globalThis,
        "timelineOwnDeliveries",
      ) as string[];
      if (delivery !== undefined && !observed.includes(delivery))
        observed.push(delivery);
      if (delivery === "confirmed") observer.disconnect();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, text);
}

function observedDeliveries(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => Reflect.get(globalThis, "timelineOwnDeliveries") as string[],
  );
}
