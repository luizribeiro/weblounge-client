import { chmod, cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

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

test("upgrades the last deployed build and preserves its active push route", async ({
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
    await seedPreviousPushRoute(page);

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
    const currentShell = await page.evaluate(async () => {
      const worker = await (await fetch("/service-worker.js")).text();
      const match = /SHELL_VERSION = "([^"]+)"/u.exec(worker);
      if (match?.[1] === undefined)
        throw new Error("current shell version is missing");
      return `weblounge-shell-${match[1]}`;
    });
    await expect
      .poll(() => page.evaluate(() => caches.keys()))
      .toContain(currentShell);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration =
            await navigator.serviceWorker.getRegistration("/");
          return {
            active: registration?.active?.state ?? null,
            installing: registration?.installing?.state ?? null,
            waiting: registration?.waiting?.state ?? null,
          };
        }),
      )
      .toEqual({ active: "activated", installing: null, waiting: null });

    await expect(page.evaluate(readPreviousPushRoute)).resolves.toEqual({
      keyPath: "networkId",
      routeId: "previous-active-route",
      version: 2,
    });
  } finally {
    await builds.close();
  }
});

test("a minimum hosted build navigates to the current build once", async ({
  context,
}) => {
  test.skip(development, "requires the production service worker");
  const deployment = await emergencyConfigServer();
  try {
    const page = await context.newPage();
    await page.goto(deployment.origin);
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
    await expect.poll(() => activeWorkerState(page)).toBe("activated");
    await expect
      .poll(() =>
        page.evaluate(() => navigator.serviceWorker.controller !== null),
      )
      .toBe(true);
    const currentVersion = await page.evaluate(() => window.weblounge.version);
    await poisonCachedIndex(page);

    deployment.serveClient({ min_build: "99999999999999999999" });
    await page.reload();
    await expect.poll(() => deployment.navigations()).toBe(3);
    await expect
      .poll(() => deployment.configRequests())
      .toBeGreaterThanOrEqual(3);
    await expect(
      page.locator('meta[name="cached-shell-sentinel"]'),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.weblounge.version))
      .toBe(currentVersion);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("weblounge.client-min-build-reload.v1"),
      ),
    ).toBe("attempted");
    expect(new URL(page.url()).searchParams.has("_weblounge_reload")).toBe(
      false,
    );

    const navigations = deployment.navigations();
    const configRequests = deployment.configRequests();
    await page.reload();
    await expect
      .poll(() => deployment.configRequests())
      .toBeGreaterThan(configRequests);
    expect(deployment.navigations()).toBe(navigations + 1);
  } finally {
    await deployment.close();
  }
});

for (const scenario of [
  { name: "without a client block", client: undefined },
  { name: "with a satisfied minimum build", client: { min_build: "0" } },
] as const) {
  test(`hosted startup does not navigate ${scenario.name}`, async ({
    context,
  }) => {
    test.skip(development, "requires the production build");
    const deployment = await emergencyConfigServer();
    try {
      deployment.serveClient(scenario.client);
      const page = await context.newPage();
      await page.goto(deployment.origin);

      await expect.poll(() => deployment.sessionRequests()).toBe(1);
      expect(deployment.navigations()).toBe(1);
    } finally {
      await deployment.close();
    }
  });
}

async function seedPreviousPushRoute(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    )) as CryptoKeyPair;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push", 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("routes", { keyPath: "networkId" });
        request.result.createObjectStore("state");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("routes", "readwrite");
      transaction.objectStore("routes").put({
        networkId: 41,
        networkLabel: "Lounge",
        nickname: "weblounge",
        vapid: "home-vapid",
        routeId: "previous-active-route",
        endpoint: "https://push.weblounge.org/v1/r/previous-active-route",
        p256dh: "AQID",
        auth: "BAUG",
        privateKey: pair.privateKey,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
}

async function readPreviousPushRoute(): Promise<{
  keyPath: string | string[] | null;
  routeId: string;
  version: number;
}> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("weblounge-push");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction("routes", "readonly");
  const store = transaction.objectStore("routes");
  const route = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      const request = store.get(41);
      request.onsuccess = () =>
        resolve(request.result as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    },
  );
  const result = {
    keyPath: store.keyPath,
    routeId: String(route.routeId),
    version: database.version,
  };
  database.close();
  return result;
}

test("a hosted reset token clears the shell only once", async ({ context }) => {
  test.skip(development, "requires the production service worker");
  const deployment = await emergencyConfigServer();
  try {
    const page = await context.newPage();
    await page.goto(deployment.origin);
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
    await expect.poll(() => activeWorkerState(page)).toBe("activated");
    await page.evaluate(async () => {
      await caches.open("weblounge-emergency-reset-sentinel");
    });

    deployment.serveClient({ reset_token: "incident-1" });
    await page.reload();
    await expect.poll(() => deployment.navigations()).toBe(3);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.keys()).includes("weblounge-emergency-reset-sentinel"),
        ),
      )
      .toBe(false);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("weblounge.client-reset-token.v1"),
      ),
    ).toBe("incident-1");

    await page.evaluate(async () => {
      await caches.open("weblounge-emergency-reset-second-sentinel");
    });
    const navigations = deployment.navigations();
    const configRequests = deployment.configRequests();
    await page.reload();
    await expect
      .poll(() => deployment.configRequests())
      .toBeGreaterThan(configRequests);
    expect(deployment.navigations()).toBe(navigations + 1);
    expect(
      await page.evaluate(async () =>
        (await caches.keys()).includes(
          "weblounge-emergency-reset-second-sentinel",
        ),
      ),
    ).toBe(true);
  } finally {
    await deployment.close();
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

async function emergencyConfigServer(): Promise<{
  readonly origin: string;
  serveClient(client?: {
    readonly min_build?: string;
    readonly reset_token?: string;
  }): void;
  navigations(): number;
  configRequests(): number;
  sessionRequests(): number;
  close(): Promise<void>;
}> {
  const source =
    process.env.WEBLOUNGE_APP_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  let config: object = { mode: "app" };
  let navigationCount = 0;
  let configRequestCount = 0;
  let sessionRequestCount = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/config.json") {
      configRequestCount += 1;
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(config));
      return;
    }
    if (pathname === "/oauth/session-token") {
      sessionRequestCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: "emergency-test-token",
          token_type: "Bearer",
          expires_in: 300,
        }),
      );
      return;
    }
    if (pathname === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (pathname === "/") navigationCount += 1;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const path = resolve(source, relative);
    if (!path.startsWith(`${source}/`)) {
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
    throw new Error("emergency config server has no TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    serveClient: (client) => {
      config = {
        mode: "hosted",
        network: {
          name: "weblounge",
          endpoint: `ws://127.0.0.1:${address.port}/socket`,
          autojoin: ["#lounge"],
        },
        oauth: {
          issuer: origin,
          client_id: "weblounge-client",
          redirect_uri: `${origin}/`,
          session_token_endpoint: `${origin}/oauth/session-token`,
        },
        client,
      };
    },
    navigations: () => navigationCount,
    configRequests: () => configRequestCount,
    sessionRequests: () => sessionRequestCount,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        }),
      );
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
