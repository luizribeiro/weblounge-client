import type { Locator, Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";

const connectedLine = "Connected to 127.0.0.1 without TLS";

test("shows the connection in the server buffer on a first load", async ({
  page,
  irc,
}) => {
  await openServerBuffer(page, irc);
  await expect(connectionLines(page)).toHaveCount(1);
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

function connectionLines(page: Page): Locator {
  return page
    .getByRole("list", { name: "Messages" })
    .locator('[data-system-line="true"]')
    .filter({ hasText: connectedLine });
}
