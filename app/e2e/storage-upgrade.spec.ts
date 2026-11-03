import { expect, type Page, test } from "@playwright/test";
import {
  closeEngineDatabase,
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_STORES,
  ENGINE_DATABASE_VERSION,
  openEngineDatabase,
} from "./engine-database";

test("opens the engine's current database schema for fixtures", async ({
  page,
}) => {
  await page.route("**/idb-helper", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/idb-helper");

  const database = await openEngineDatabase(page);
  try {
    const schema = await database.evaluate((value) => ({
      name: value.name,
      stores: Array.from(value.objectStoreNames),
      version: value.version,
    }));
    expect(schema).toEqual({
      name: ENGINE_DATABASE_NAME,
      stores: [...ENGINE_DATABASE_STORES],
      version: ENGINE_DATABASE_VERSION,
    });
  } finally {
    await closeEngineDatabase(database);
  }
});

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
    ({ databaseName, nextVersion }) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(databaseName, nextVersion);
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
    {
      databaseName: ENGINE_DATABASE_NAME,
      nextVersion: ENGINE_DATABASE_VERSION + 1,
    },
  );

  expect(previousVersion).toBe(ENGINE_DATABASE_VERSION);
});

async function holdVersionOneConnection(page: Page): Promise<void> {
  await page.evaluate(
    async ({ cacheStore, databaseName }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore(cacheStore);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      Reflect.set(globalThis, "blockingDatabase", database);
    },
    {
      cacheStore: ENGINE_DATABASE_STORES[0],
      databaseName: ENGINE_DATABASE_NAME,
    },
  );
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
