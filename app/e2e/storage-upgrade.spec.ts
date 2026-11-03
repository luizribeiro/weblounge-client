import { expect, type Page, test } from "@playwright/test";

test("starts with an empty cache when a version-one connection blocks the upgrade", async ({
  context,
}) => {
  const blocker = await context.newPage();
  await blocker.route("**/idb-blocker", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await blocker.goto("/idb-blocker");
  await holdVersionOneConnection(blocker);

  try {
    const page = await context.newPage();
    await page.goto("/");

    await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
    await expect(page.locator("[data-app-root]")).toBeVisible();
  } finally {
    await closeBlockingConnection(blocker);
  }
});

test("closes the engine database connection on versionchange", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);

  const previousVersion = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("weblounge", 3);
        let oldVersion = -1;
        request.onupgradeneeded = (event) => {
          oldVersion = event.oldVersion;
        };
        request.onblocked = () =>
          reject(new Error("the engine kept its version-two connection open"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          resolve(oldVersion);
        };
      }),
  );

  expect(previousVersion).toBe(2);
});

async function holdVersionOneConnection(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("cache");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    Reflect.set(globalThis, "blockingDatabase", database);
  });
}

async function closeBlockingConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const database = Reflect.get(globalThis, "blockingDatabase");
    if (!(database instanceof IDBDatabase)) {
      throw new Error("blocking database connection is missing");
    }
    database.close();
  });
}
