import { chmod, cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const development = process.env.WEBLOUNGE_E2E_DEV === "1";

test("registers the app-shell worker only in production", async ({ page }) => {
  await page.addInitScript(() => {
    if (window.requestIdleCallback === undefined) return;
    const requestIdleCallback = window.requestIdleCallback.bind(window);
    window.requestIdleCallback = (callback, options) =>
      requestIdleCallback((deadline) => {
        Reflect.set(globalThis, "serviceWorkerIdleCallbackRan", true);
        callback(deadline);
      }, options);
  });
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
  expect(
    await page.evaluate(() =>
      Reflect.get(globalThis, "serviceWorkerIdleCallbackRan"),
    ),
  ).toBe(true);
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
  expect(
    await page.evaluate(async () => {
      const requests = await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await caches.open(name)).keys(),
        ),
      );
      return requests
        .flat()
        .some((request) => new URL(request.url).pathname === "/config.json");
    }),
  ).toBe(false);
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
  expect(
    await page.evaluate(async () => {
      const names = await caches.keys();
      const requests = await Promise.all(
        names
          .filter((name) => name.startsWith("weblounge-shell-"))
          .map(async (name) => (await caches.open(name)).keys()),
      );
      return requests
        .flat()
        .some((request) =>
          new URL(request.url).pathname.startsWith("/startup/"),
        );
    }),
  ).toBe(false);
});

test("uses network HTML online and the cached shell offline", async ({
  context,
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

  await poisonCachedIndex(page);
  await page.reload();
  await expect(page.locator('meta[name="cached-shell-sentinel"]')).toHaveCount(
    0,
  );

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('meta[name="cached-shell-sentinel"]')).toHaveCount(
    1,
  );
});

test("upgrades the last deployed build to the current build", async ({
  context,
}) => {
  test.skip(
    development ||
      process.env.WEBLOUNGE_PREVIOUS_APP_DIR === undefined ||
      process.env.WEBLOUNGE_PREVIOUS_BUILD_SHA === undefined,
    "requires both production app artifacts",
  );
  const builds = await swappableBuildServer(
    process.env.WEBLOUNGE_PREVIOUS_APP_DIR ?? "",
  );
  try {
    const page = await context.newPage();
    await page.goto(builds.origin);
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
    await expect.poll(() => activeWorkerState(page)).toBe("activated");
    await expect
      .poll(() =>
        page.evaluate(() => navigator.serviceWorker.controller !== null),
      )
      .toBe(true);
    expect(await page.evaluate(() => window.weblounge.version)).toContain(
      process.env.WEBLOUNGE_PREVIOUS_BUILD_SHA,
    );

    await page.evaluate(() =>
      localStorage.removeItem("weblounge.deployment-config.v1"),
    );
    builds.serveNext();
    await page.reload();

    await expect
      .poll(() => page.evaluate(() => window.weblounge.version))
      .toMatch(/^weblounge ci · built /u);
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
    expect(page.isClosed()).toBe(false);
  } finally {
    await builds.close();
  }
});

test("activation removes obsolete app-shell caches", async ({ page }) => {
  test.skip(
    development,
    "the service worker is intentionally disabled in development",
  );
  await page.addInitScript(async () => {
    await caches.open("weblounge-shell-obsolete-oldest");
    await caches.open("weblounge-shell-obsolete-previous");
  });

  await page.goto("/");

  await expect.poll(() => activeWorkerState(page)).toBe("activated");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await caches.keys()).includes("weblounge-shell-obsolete-oldest"),
      ),
    )
    .toBe(false);
  expect(
    await page.evaluate(async () =>
      (await caches.keys()).includes("weblounge-shell-obsolete-previous"),
    ),
  ).toBe(true);
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
  expect([...seen].sort()).toEqual(
    ["GET /api/probe", "GET /oauth/probe", "POST /session-token"].sort(),
  );

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

async function poisonCachedIndex(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const cacheName = (await caches.keys()).find((name) =>
      name.startsWith("weblounge-shell-"),
    );
    if (cacheName === undefined) throw new Error("shell cache is missing");
    const cache = await caches.open(cacheName);
    const cached = await cache.match("/index.html");
    if (cached === undefined) throw new Error("cached index is missing");
    const html = (await cached.text()).replace(
      "</head>",
      '<meta name="cached-shell-sentinel"></head>',
    );
    await cache.put(
      "/index.html",
      new Response(html, {
        headers: cached.headers,
        status: cached.status,
        statusText: cached.statusText,
      }),
    );
  });
}

async function swappableBuildServer(previous: string): Promise<{
  readonly origin: string;
  serveNext(): void;
  close(): Promise<void>;
}> {
  const source =
    process.env.WEBLOUNGE_APP_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  const temporary = await mkdtemp(join(tmpdir(), "weblounge-build-swap-"));
  const first = join(temporary, "first");
  const next = join(temporary, "next");
  await cp(previous, first, { recursive: true });
  await cp(source, next, { recursive: true });
  let served = first;
  const config = '{"mode":"app","future_server_field":true}';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/config.json") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      response.end(config);
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const path = resolve(served, relative);
    if (!path.startsWith(`${served}/`)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path).then(
      (body) => {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": contentType(path),
        });
        response.end(body);
      },
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("build swap server has no TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    serveNext: () => {
      served = next;
    },
    close: async () => {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        }),
      );
      await makeWritable(temporary);
      await rm(temporary, { recursive: true });
    },
  };
}

async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o700);
  const entries = await readdir(path, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => makeWritable(join(path, entry.name))),
  );
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".js":
      return "text/javascript";
    case ".json":
    case ".webmanifest":
      return "application/json";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".wasm":
      return "application/wasm";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
