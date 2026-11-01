import { expect, test } from "@playwright/test";

const development = process.env.WEBLOUNGE_E2E_DEV === "1";

test("registers the app-shell worker only in production", async ({ page }) => {
  await page.goto("/");
  if (development) {
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
      )
      .toBe(0);
    return;
  }
  await expect.poll(() => activeWorkerState(page)).toBe("activated");
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
});

test("launches the shell and engine from cache with the origin offline", async ({
  context,
  page,
}) => {
  test.skip(
    development,
    "the service worker is intentionally disabled in development",
  );
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  await expect.poll(() => activeWorkerState(page)).toBe("activated");
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
  await page.evaluate(() => fetch("/config.json"));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open("weblounge-runtime-config");
        return (await cache.match("/config.json")) !== undefined;
      }),
    )
    .toBe(true);
  await page.addInitScript(() => {
    Reflect.set(globalThis, "offlineSawSplash", false);
    Reflect.set(globalThis, "offlineWorkers", []);
    const NativeWorker = Worker;
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(target, argumentsList) {
          const workers = Reflect.get(globalThis, "offlineWorkers");
          if (Array.isArray(workers)) workers.push(String(argumentsList[0]));
          return Reflect.construct(target, argumentsList);
        },
      }),
    });
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-initial-splash]") !== null) {
        Reflect.set(globalThis, "offlineSawSplash", true);
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "offlineSawSplash")),
  ).toBe(true);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "offlineWorkers")),
  ).toEqual([
    expect.stringMatching(/\/assets\/engine\.dedicated-worker-[^/]+\.js$/u),
  ]);
  expect(
    await page.evaluate(async () => {
      const names = await caches.keys();
      const requests = await Promise.all(
        names
          .filter((name) => name.startsWith("weblounge-shell-"))
          .map(async (name) => (await caches.open(name)).keys()),
      );
      return requests.flat().some((request) => request.url.endsWith(".wasm"));
    }),
  ).toBe(true);
});

test("activation removes obsolete app-shell caches", async ({ page }) => {
  test.skip(
    development,
    "the service worker is intentionally disabled in development",
  );
  await page.addInitScript(() => caches.open("weblounge-shell-obsolete"));

  await page.goto("/");

  await expect.poll(() => activeWorkerState(page)).toBe("activated");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await caches.keys()).includes("weblounge-shell-obsolete"),
      ),
    )
    .toBe(false);
});

test("does not intercept or cache API, OAuth, session, or WebSocket traffic", async ({
  page,
}) => {
  test.skip(
    development,
    "the service worker is intentionally disabled in development",
  );
  await page.goto("/");
  await expect.poll(() => activeWorkerState(page)).toBe("activated");
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
  const seen: string[] = [];
  for (const path of ["api/probe", "oauth/probe", "session-token"]) {
    await page.route(`**/${path}`, async (route) => {
      seen.push(`${route.request().method()} /${path}`);
      await route.fulfill({ body: "ok", status: 200 });
    });
  }

  expect(
    await page.evaluate(async () =>
      Promise.all([
        fetch("/api/probe").then((response) => response.text()),
        fetch("/oauth/probe").then((response) => response.text()),
        fetch("/session-token", { method: "POST" }).then((response) =>
          response.text(),
        ),
      ]),
    ),
  ).toEqual(["ok", "ok", "ok"]);
  expect(seen).toEqual([
    "GET /api/probe",
    "GET /oauth/probe",
    "POST /session-token",
  ]);

  const opened = page.waitForEvent(
    "websocket",
    (socket) => new URL(socket.url()).pathname === "/socket",
  );
  await page.evaluate(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/socket`);
    socket.addEventListener("open", () => socket.close(), { once: true });
  });
  expect(new URL((await opened).url()).pathname).toBe("/socket");

  const cachedPaths = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = await Promise.all(
      names.map(async (name) => (await caches.open(name)).keys()),
    );
    return requests.flat().map((request) => new URL(request.url).pathname);
  });
  expect(cachedPaths).not.toEqual(
    expect.arrayContaining([
      "/api/probe",
      "/oauth/probe",
      "/session-token",
      "/socket",
    ]),
  );
});

async function activeWorkerState(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.active?.state ?? null;
  });
}
