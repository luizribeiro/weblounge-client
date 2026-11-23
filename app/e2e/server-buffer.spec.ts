import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expectInterFont } from "./inter-font";
import { expect, type IrcTestAccount, test } from "./irc-fixture";

const connectedLine = "Connected to 127.0.0.1 without TLS";

test("shows the connection in the server buffer on a first load", async ({
  page,
  irc,
}) => {
  await openServerBuffer(page, irc);
  await expect(connectionLines(page)).toHaveCount(1);
});

test("shows the message of the day folded below the connection", async ({
  page,
  irc,
}, testInfo) => {
  await openServerBuffer(page, irc);
  const card = motdCards(page);
  await expect(card).toHaveCount(1);
  const lines = card.locator("[data-motd-line]");
  await expect(lines).toHaveCount(4);
  await expect(lines.first()).toContainText(
    "Welcome to the WebLounge local test network.",
  );
  expect(await verticalOrder(connectionLines(page), card)).toBe("above");

  await card.getByRole("button", { name: "Show all 6 lines" }).click();
  await expect(lines).toHaveCount(6);
  await expect(lines.last()).toContainText("Have a good test run.");
  await captureServerBuffer(page, testInfo.project.name.includes("phone"));
});

test("shows the connection to a second tab opened later", async ({
  context,
  page,
  irc,
}) => {
  await openServerBuffer(page, irc);
  await expect(connectionLines(page)).toHaveCount(1);

  const second = await context.newPage();
  await openServerBuffer(second, irc);
  await expect(connectionLines(second)).toHaveCount(1);
});

test("adds a connection line for each reconnect", async ({ page, irc }) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
    "requires the controllable socket forwarder",
  );
  await openServerBuffer(page, irc);
  await expect(connectionLines(page)).toHaveCount(1);

  await irc.forwarder.disconnect();
  await irc.forwarder.restore();
  await expect(connectionLines(page)).toHaveCount(2);
});

async function openServerBuffer(
  page: Page,
  irc: IrcTestAccount,
): Promise<void> {
  await page.goto(irc.url({ path: `/${encodeURIComponent("Local Ergo")}` }));
  await expect(page.getByRole("heading", { name: "Local Ergo" })).toBeVisible();
}

function motdCards(page: Page): Locator {
  return page
    .getByRole("list", { name: "Messages" })
    .locator('[data-system-card="motd"]');
}

async function verticalOrder(
  first: Locator,
  second: Locator,
): Promise<"above" | "below"> {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  if (a === null || b === null) throw new Error("both rows must be visible");
  return a.y < b.y ? "above" : "below";
}

async function captureServerBuffer(page: Page, phone: boolean): Promise<void> {
  const directory = process.env.WEBLOUNGE_SERVER_BUFFER_SCREENSHOT_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      scheme === "dark" ? "lounge-night" : "lounge",
    );
    await expectInterFont(page.locator("[data-app-root]"));
    await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
    await expect(motdCards(page).locator("[data-motd-line]")).toHaveCount(6);
    await page.screenshot({
      path: path.join(
        directory,
        `server-buffer-${phone ? "phone" : "desktop"}-${scheme}.png`,
      ),
    });
  }
}

function connectionLines(page: Page): Locator {
  return page
    .getByRole("list", { name: "Messages" })
    .locator('[data-system-line="true"]')
    .filter({ hasText: connectedLine });
}
