import type { Page } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { expect, test } from "./irc-fixture";
import { useDedicatedWorker } from "./production-ergo";

const fixtureChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

test.describe("buffer routing against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("updates the address and restores the selected channel", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("route");
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel, exact: true }).click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await expect(composer).toBeVisible();
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");

    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );
    await expect.poll(() => cachedChatList(page)).toContain(channel);

    await restoreDebugConnection(page, irc.url());
    await page.reload();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );
  });

  test("restores the URL from live always-on membership before caching", async ({
    page,
  }) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
      "requires the production-shaped always-on Ergo profile",
    );
    await useDedicatedWorker(page);
    const channel = `#route-live-${Date.now().toString(36)}`;
    await page.goto("/?irc-password=weblounge-test");
    await page
      .getByRole("button", { name: fixtureChannel, exact: true })
      .click();
    const composer = page.getByRole("textbox", {
      name: `Message ${fixtureChannel}`,
    });
    await expect(composer).toBeVisible();
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );

    await restoreDebugConnection(page, "/?irc-password=weblounge-test");
    await deleteCachedChatList(page);
    await page.reload();

    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );
  });
});

async function restoreDebugConnection(
  page: Page,
  startUrl: string,
): Promise<void> {
  await page.evaluate((start) => {
    const url = new URL(location.href);
    for (const [name, value] of new URL(start, location.href).searchParams)
      url.searchParams.append(name, value);
    history.replaceState(history.state, "", url);
  }, startUrl);
}

async function cachedChatList(page: Page): Promise<string> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(async (value) => {
      const snapshot = await new Promise<unknown>((resolve, reject) => {
        const request = value
          .transaction("cache")
          .objectStore("cache")
          .get(new TextEncoder().encode("chat-list-snapshot"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      return snapshot instanceof Uint8Array
        ? new TextDecoder().decode(snapshot)
        : "";
    });
  } finally {
    await closeEngineDatabase(database);
  }
}

async function deleteCachedChatList(page: Page): Promise<void> {
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(async (value) => {
      await new Promise<void>((resolve, reject) => {
        const transaction = value.transaction("cache", "readwrite");
        transaction
          .objectStore("cache")
          .delete(new TextEncoder().encode("chat-list-snapshot"));
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => resolve();
      });
    });
  } finally {
    await closeEngineDatabase(database);
  }
}
