import { expect, type Page, test } from "@playwright/test";

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
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    await expect(composer).toBeVisible();
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");

    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );
    await expect.poll(() => cachedChatList(page)).toContain(channel);

    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set("irc-password", "weblounge-test");
      history.replaceState(history.state, "", url);
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );
  });
});

async function cachedChatList(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const snapshot = await new Promise<unknown>((resolve, reject) => {
        const request = database
          .transaction("cache")
          .objectStore("cache")
          .get(new TextEncoder().encode("chat-list-snapshot"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      return snapshot instanceof Uint8Array
        ? new TextDecoder().decode(snapshot)
        : "";
    } finally {
      database.close();
    }
  });
}
