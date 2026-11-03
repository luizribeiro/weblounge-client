import { expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { useDedicatedWorker } from "./production-ergo";

const fixtureChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

test.describe("buffer routing against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("updates the address and restores the selected channel", async ({
    page,
  }) => {
    const channel = `#route-${Date.now().toString(36)}`;
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
    await expect.poll(() => cachedChatList(page)).toContain(channel);

    await restoreDebugPassword(page);
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

    await restoreDebugPassword(page);
    await deleteCachedChatList(page);
    await page.reload();

    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );
  });
});

async function restoreDebugPassword(page: Page): Promise<void> {
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.set("irc-password", "weblounge-test");
    history.replaceState(history.state, "", url);
  });
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
