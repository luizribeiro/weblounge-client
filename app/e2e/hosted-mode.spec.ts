import { expect, type Page, type Route, test } from "@playwright/test";

test("shows a clear error when production config is missing", async ({
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_DEV === "1",
    "development intentionally permits missing config",
  );
  await page.route("**/config.json", (route) => route.fulfill({ status: 404 }));

  await page.goto("/");

  await expect(
    page.getByText("This deployment is misconfigured"),
  ).toBeVisible();
});

test("authorizes with PKCE and hands the bearer token once to the engine", async ({
  page,
}) => {
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);

  await page.goto("/");
  await expect(page).toHaveURL(redirectUri());
  await expect(page.locator("[data-hosted-status]")).toHaveCount(0);
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
  await expect.poll(() => page.evaluate(() => sessionStorage.length)).toBe(0);
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

  await page.unroute("http://127.0.0.1:4174/authorize**", mismatch);
  await page.goto("/");
  await expectHostedConnection(page);
});

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

async function installFakeEngine(page: Page) {
  await page.addInitScript(() => {
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
          this.emit({
            type: "network_state_changed",
            network: {
              id: 1,
              label: "weblounge",
              nickname: "weblounge",
              state: "online",
            },
          });
          this.emit({ type: "buffers_changed", network_id: 1, buffers: [] });
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
  });
}
