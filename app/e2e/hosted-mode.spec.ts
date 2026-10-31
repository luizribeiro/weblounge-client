import { expect, type Page, type Route, test } from "@playwright/test";

test("retries startup without reloading when production config was missing", async ({
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_DEV === "1",
    "development intentionally permits missing config",
  );
  let configRequests = 0;
  await page.route("**/config.json", (route) => {
    configRequests += 1;
    return configRequests === 1
      ? route.fulfill({ status: 404 })
      : route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ mode: "app" }),
        });
  });

  await page.goto("/");

  const error = page.getByText("This deployment is misconfigured");
  await expect(error).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  expect(configRequests).toBe(2);
  await expect(page).toHaveURL(/\/$/u);
});

test("authorizes with PKCE and hands the bearer token once to the engine", async ({
  page,
}) => {
  await installFakeEngine(page, true);
  const redirectUri = await installHostedConfig(page);

  await page.goto("http://127.0.0.1:4174/health");
  await page.goto("/");
  // A cold CI browser completes two cross-origin OAuth navigations before returning.
  await expect(page).toHaveURL(redirectUri());
  await expect(page.locator("[data-hosted-status]")).toHaveCount(0);
  await expect(page.getByText("Signing in…")).toHaveCount(0);
  await expect(page.locator("[data-initial-splash]")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const requests = Reflect.get(globalThis, "hostedEngineRequests");
        return Array.isArray(requests) ? requests : [];
      }),
    )
    .toContainEqual(
      expect.objectContaining({
        type: "connect_hosted",
        endpoint: "wss://beta.weblounge.org/socket",
        oauth_token: "fake-hosted-access-token",
        autojoin: ["#lounge"],
      }),
    );
  await page.evaluate(() => {
    const complete = Reflect.get(globalThis, "completeHostedConnection");
    if (typeof complete !== "function")
      throw new Error("hosted connection release is missing");
    complete();
  });
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.length)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL("http://127.0.0.1:4174/health");
});

test("cleans the callback URL before a failed token exchange", async ({
  page,
}) => {
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  await page.route("http://127.0.0.1:4174/token", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": new URL(redirectUri()).origin,
      },
      body: JSON.stringify({ error: "invalid_grant" }),
    }),
  );

  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("code expired");
  await expect(
    page.getByRole("button", { name: "Sign in again" }),
  ).toBeVisible();
  await expect(page).toHaveURL(redirectUri());
});

test("recovers from a state mismatch with a fresh sign-in", async ({
  page,
}) => {
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  const mismatch = async (route: Route) => {
    const authorization = new URL(route.request().url());
    const callback = new URL(
      authorization.searchParams.get("redirect_uri") ?? "",
    );
    callback.searchParams.set("code", "mismatched-code");
    callback.searchParams.set("state", "wrong-state");
    await route.fulfill({ status: 302, headers: { Location: callback.href } });
  };
  await page.route("http://127.0.0.1:4174/authorize**", mismatch);

  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("did not match this tab");
  await expect(page).toHaveURL(redirectUri());
  await expect(
    page.getByRole("button", { name: "Sign in again" }),
  ).toBeVisible();

  await page.unroute("http://127.0.0.1:4174/authorize**", mismatch);
  await page.getByRole("button", { name: "Sign in again" }).click();
  await expectHostedConnection(page);
});

test("returns to sign-in when the hosted token expires", async ({ page }) => {
  await installFakeEngine(page);
  await installHostedConfig(page);
  let authorizationCount = 0;
  await page.route("http://127.0.0.1:4174/authorize**", async (route) => {
    authorizationCount += 1;
    if (authorizationCount === 1) {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: "<main>Hosted sign-in requested after expiry</main>",
    });
  });
  await page.route("http://127.0.0.1:4174/token", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        access_token: "short-lived-hosted-token",
        token_type: "Bearer",
        expires_in: 0.2,
      }),
    }),
  );

  await page.goto("/");

  await expect(
    page.getByText("Hosted sign-in requested after expiry"),
  ).toBeVisible();
  expect(authorizationCount).toBe(2);
});

for (const shell of [
  {
    name: "desktop",
    use: {
      hasTouch: false,
      isMobile: false,
      viewport: { width: 1280, height: 900 },
    },
  },
  {
    name: "mobile",
    use: {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    },
  },
] as const) {
  test.describe(`hosted deep links on ${shell.name}`, () => {
    test.use(shell.use);

    test("survive sign-in and a plain reload", async ({ page }) => {
      await installFakeEngine(page);
      await installHostedConfig(page);
      let authorizationCount = 0;
      await page.route("http://127.0.0.1:4174/authorize**", async (route) => {
        authorizationCount += 1;
        await route.continue();
      });

      await page.goto("/weblounge/ops");

      await expect(page.getByRole("heading", { name: "#ops" })).toBeVisible();
      await expect(page).toHaveURL(/\/weblounge\/ops$/u);
      expect(authorizationCount).toBe(1);
      await expect
        .poll(() => page.evaluate(() => sessionStorage.length))
        .toBe(0);

      await page.reload();

      await expect(page.getByRole("heading", { name: "#ops" })).toBeVisible();
      await expect(page).toHaveURL(/\/weblounge\/ops$/u);
      expect(authorizationCount).toBe(2);
    });
  });
}

async function installHostedConfig(page: Page): Promise<() => string> {
  let redirectUri = "";
  await page.route("**/config.json", async (route) => {
    redirectUri = new URL("/", route.request().url()).href;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        mode: "hosted",
        network: {
          name: "weblounge",
          endpoint: "wss://beta.weblounge.org/socket",
          autojoin: ["#lounge"],
        },
        oauth: {
          issuer: "http://127.0.0.1:4174",
          client_id: "weblounge-client",
          redirect_uri: redirectUri,
        },
      }),
    });
  });
  return () => redirectUri;
}

async function expectHostedConnection(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page
        .evaluate(() => {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          return Array.isArray(requests) ? requests : [];
        })
        .catch(() => []),
    )
    .toContainEqual(expect.objectContaining({ type: "connect_hosted" }));
}

async function installFakeEngine(page: Page, holdConnection = false) {
  await page.addInitScript((holdHostedConnection) => {
    Reflect.set(globalThis, "hostedEngineRequests", []);
    class FakePort extends EventTarget {
      postMessage(message: unknown) {
        if (typeof message !== "object" || message === null) return;
        const envelope = message as {
          type?: string;
          payload?: { id?: string; request?: { type?: string } };
        };
        if (envelope.type === "hello") {
          this.emit({
            type: "ready",
            engine_instance: "hosted-e2e",
            revision: 0,
          });
          this.emit({ type: "command_specs_changed", specs: [] });
          return;
        }
        const request = envelope.payload?.request;
        const id = envelope.payload?.id;
        if (request?.type === "diagnostic") {
          this.emit({
            type: "diagnostic",
            command_id: id,
            message: "wasm worker round trip complete",
          });
        }
        if (request?.type === "connect_hosted") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          const complete = () => {
            this.emit({
              type: "network_state_changed",
              network: {
                id: 1,
                label: "weblounge",
                nickname: "weblounge",
                state: "online",
              },
            });
            this.emit({
              type: "buffers_changed",
              network_id: 1,
              buffers: [
                {
                  id: 1,
                  network_id: 1,
                  kind: "server",
                  title: "weblounge",
                  draft_key: "10:weblounge:rfc1459:weblounge",
                  topic: null,
                  unread: 0,
                  mentions: 0,
                  read_through: null,
                },
                {
                  id: 2,
                  network_id: 1,
                  kind: "channel",
                  title: "#ops",
                  draft_key: "10:weblounge:rfc1459:#ops",
                  topic: null,
                  member_count: 0,
                  unread: 0,
                  mentions: 0,
                  read_through: null,
                },
              ],
            });
          };
          if (holdHostedConnection) {
            Reflect.set(globalThis, "completeHostedConnection", complete);
          } else {
            complete();
          }
        }
        if (id !== undefined) this.emit({ type: "command_result", id });
      }

      start() {}
      close() {}

      private emit(data: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }

    class FakeSharedWorker {
      readonly port = new FakePort();
    }
    Reflect.set(globalThis, "SharedWorker", FakeSharedWorker);
  }, holdConnection);
}
