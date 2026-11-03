import { expect, type Page, type Route, test } from "@playwright/test";
import { installFakeOAuth, oauthIssuer } from "./fake-oauth-route";

const engineWasmRequest = /\/engine_bg(?:-[^/?]+)?\.wasm(?:\?.*)?$/u;
const builtEngineWorkerRequest =
  /\/engine\.(?:shared|dedicated)-worker-[^/]+\.js$/u;
const developmentEngineWorkerRequest =
  /\/engine\.(?:shared|dedicated)-worker\.ts$/u;

function isEngineWorkerRequest(url: URL): boolean {
  return (
    builtEngineWorkerRequest.test(url.pathname) ||
    (developmentEngineWorkerRequest.test(url.pathname) &&
      url.searchParams.has("worker_file"))
  );
}

for (const failure of [
  {
    name: "missing session token endpoint",
    expected: "oauth.session_token_endpoint",
    response: "missing-session-endpoint",
  },
  {
    name: "invalid issuer",
    expected: "oauth.issuer",
    response: "invalid-issuer",
  },
  {
    name: "missing config",
    expected: "/config.json",
    response: "404",
  },
  {
    name: "failed config request",
    expected: "Can't reach weblounge",
    response: "500",
  },
] as const) {
  test(`shows a deployment config error for a ${failure.name}`, async ({
    page,
  }) => {
    await installFakeEngine(page);
    const startupErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        message.text().startsWith("[weblounge startup]")
      ) {
        startupErrors.push(message.text());
      }
    });
    let configRequests = 0;
    await page.route("**/config.json", async (route) => {
      configRequests += 1;
      if (configRequests > 1) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ mode: "app" }),
        });
        return;
      }
      if (failure.response === "404" || failure.response === "500") {
        await route.fulfill({ status: Number(failure.response) });
        return;
      }
      const config = hostedConfig(route.request().url());
      if (failure.response === "missing-session-endpoint") {
        config.oauth.session_token_endpoint = undefined;
      } else {
        config.oauth.issuer = "not a URL";
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(config),
      });
    });

    const startedAt = performance.now();
    await page.goto("/");

    const error = page.getByRole("alert");
    await expect(error).toContainText(failure.expected);
    expect(performance.now() - startedAt).toBeLessThan(4_000);
    await expect(page.locator("[data-initial-splash]")).toBeVisible();
    await expect.poll(() => startupErrors).toHaveLength(1);
    expect(startupErrors[0]).toContain(failure.expected);

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
  });
}

test("authorizes with PKCE and hands the bearer token once to the engine", async ({
  page,
}) => {
  await installFakeEngine(page, true);
  const redirectUri = await installHostedConfig(page);

  await page.goto(`${oauthIssuer}/health`);
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
        type: "reconnect_hosted",
        oauth_token: "fake-hosted-access-token",
      }),
    );
  await page.evaluate(() => {
    const complete = Reflect.get(globalThis, "completeHostedConnection");
    if (typeof complete !== "function")
      throw new Error("hosted connection release is missing");
    complete();
  });
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "hostedStartupSequence")),
  ).toEqual(expect.arrayContaining(["worker", "config"]));
  expect(
    await page.evaluate(() =>
      (Reflect.get(globalThis, "hostedStartupSequence") as string[]).indexOf(
        "worker",
      ),
    ),
  ).toBeLessThan(
    await page.evaluate(() =>
      (Reflect.get(globalThis, "hostedStartupSequence") as string[]).indexOf(
        "config",
      ),
    ),
  );
  await expect.poll(() => page.evaluate(() => sessionStorage.length)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(`${oauthIssuer}/health`);
});

test("reveals cached chats while config and session requests are blocked", async ({
  page,
}) => {
  await page.addInitScript((issuer) => {
    const config = {
      mode: "hosted",
      network: {
        name: "weblounge",
        endpoint: "wss://beta.weblounge.org/socket",
        autojoin: ["#lounge"],
      },
      oauth: {
        issuer,
        client_id: "weblounge-client",
        redirect_uri: new URL("/", location.href).href,
        session_token_endpoint: `${issuer}/oauth/session-token`,
      },
    };
    localStorage.setItem(
      "weblounge.deployment-config.v1",
      JSON.stringify({ config, schema: 1 }),
    );
    Reflect.set(globalThis, "hostedCachedChatList", true);
  }, oauthIssuer);
  await installFakeEngine(page);
  await page.route("**/config.json", () => new Promise(() => {}));
  await page.route(
    `${oauthIssuer}/oauth/session-token`,
    () => new Promise(() => {}),
  );

  await page.goto("/");

  await expect(page.getByRole("button", { name: "#cached" })).toBeVisible();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await expect(page.getByText(/misconfigured/iu)).toHaveCount(0);
});

for (const worker of ["shared", "dedicated"] as const) {
  test(`uses the member session through the ${worker} worker`, async ({
    page,
  }) => {
    await installFakeEngine(page, false, worker);
    const redirectUri = await installHostedConfig(page);
    let authorizationRequests = 0;
    let sessionRequests = 0;
    await page.route(`${oauthIssuer}/authorize**`, async (route) => {
      authorizationRequests += 1;
      await route.fallback();
    });
    await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
        return;
      }
      expect(route.request().method()).toBe("POST");
      await expect(
        route.request().headerValue("content-type"),
      ).resolves.toContain("application/json");
      expect(route.request().postData()).toBe("{}");
      sessionRequests += 1;
      await fulfillSessionToken(
        route,
        redirectUri(),
        sessionRequests === 1 ? "session-token" : "refreshed-token",
      );
    });

    await page.goto("/");

    await expectHostedToken(page, "session-token");
    await expect(page.getByRole("heading", { name: "#lounge" })).toBeVisible();
    await expect(page).toHaveURL(redirectUri());
    expect(authorizationRequests).toBe(0);
    await page.evaluate(() => {
      const request = Reflect.get(globalThis, "requestHostedToken");
      if (typeof request !== "function")
        throw new Error("hosted token request is missing");
      request();
    });
    await expectHostedToken(page, "refreshed-token", "reconnect_hosted");
  });
}

test("falls back to PKCE when the member session needs login", async ({
  page,
}) => {
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      headers: sessionCors(new URL(redirectUri()).origin),
      body: JSON.stringify({ error: "login_required" }),
    });
  });

  await page.goto("/");

  await expectHostedToken(page, "fake-hosted-access-token");
  await expect(page).toHaveURL(redirectUri());
});

for (const worker of ["shared", "dedicated"] as const) {
  test(`redirects a signed-out member with the real ${worker} worker`, async ({
    page,
  }) => {
    if (worker === "dedicated") await disableSharedWorker(page);
    const redirectUri = await installHostedConfig(page);
    const sessionRequests: string[] = [];
    await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
      sessionRequests.push(route.request().method());
      if (route.request().method() === "OPTIONS") {
        await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: sessionCors(new URL(redirectUri()).origin),
        body: JSON.stringify({ error: "login_required" }),
      });
    });
    await page.route(`${oauthIssuer}/authorize**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "Member sign in" }),
    );

    await page.goto("/");

    await expect.poll(() => sessionRequests).toContain("POST");
    await expect(page).toHaveURL(
      new RegExp(`^${oauthIssuer}/authorize\\?`, "u"),
    );
    await expect(page.getByText("Member sign in")).toBeVisible();
  });
}

for (const worker of ["shared", "dedicated"] as const) {
  test(`redirects a signed-out member before a slow real ${worker} worker starts`, async ({
    browserName,
    context,
    page,
  }, testInfo) => {
    if (browserName === "chromium") {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    }
    if (worker === "dedicated") await disableSharedWorker(page);
    const redirectUri = await installHostedConfig(page);
    let workerAssetRequests = 0;
    let releaseWorker = () => undefined;
    const workerCanStart = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let wasmAssetRequests = 0;
    let releaseWasm = () => undefined;
    const wasmCanStart = new Promise<void>((resolve) => {
      releaseWasm = resolve;
    });
    await page.route(isEngineWorkerRequest, async (route) => {
      workerAssetRequests += 1;
      await workerCanStart;
      await route.continue();
    });
    await page.route(engineWasmRequest, async (route) => {
      wasmAssetRequests += 1;
      await wasmCanStart;
      await route.continue();
    });
    await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: sessionCors(new URL(redirectUri()).origin),
        body: JSON.stringify({ error: "login_required" }),
      });
    });
    await page.route(`${oauthIssuer}/authorize**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "Member sign in" }),
    );

    const startedAt = performance.now();
    await page.goto("/");
    await expect(page).toHaveURL(
      new RegExp(`^${oauthIssuer}/authorize\\?`, "u"),
    );
    const elapsed = performance.now() - startedAt;
    testInfo.annotations.push({
      type: "signed-out-redirect-ms",
      description: elapsed.toFixed(0),
    });
    const measurement = {
      browser: browserName,
      elapsedMilliseconds: Math.round(elapsed),
      wasmAssetRequests,
      worker,
      workerAssetRequests,
    };
    await testInfo.attach("signed-out-redirect-timing", {
      body: JSON.stringify(measurement),
      contentType: "application/json",
    });
    console.info(`signed-out-redirect ${JSON.stringify(measurement)}`);
    releaseWorker();
    releaseWasm();

    expect(workerAssetRequests).toBe(1);
    expect(wasmAssetRequests).toBe(0);
    await expect(page.getByText("Member sign in")).toBeVisible();
  });
}

for (const failure of ["rate limit", "network failure"] as const) {
  test(`shows a ${failure}, then redirects immediately on login-required`, async ({
    page,
  }, testInfo) => {
    const redirectUri = await installHostedConfig(page);
    let attempts = 0;
    await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
        return;
      }
      attempts += 1;
      if (attempts === 1 && failure === "network failure") {
        await route.abort("failed");
        return;
      }
      const status = attempts === 1 ? 429 : 401;
      await route.fulfill({
        status,
        contentType: "application/json",
        headers: sessionCors(new URL(redirectUri()).origin),
        body: JSON.stringify({
          error: status === 429 ? "invalid_request" : "login_required",
        }),
      });
    });
    await page.route(`${oauthIssuer}/authorize**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "Member sign in" }),
    );

    await page.goto("/");
    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();
    const retryStartedAt = performance.now();
    await retry.click();
    await expect(page).toHaveURL(
      new RegExp(`^${oauthIssuer}/authorize\\?`, "u"),
    );
    const elapsed = performance.now() - retryStartedAt;
    testInfo.annotations.push({
      type: "later-login-required-redirect-ms",
      description: elapsed.toFixed(0),
    });

    expect(attempts).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
  });
}

test("falls back to PKCE after a fresh session request is aborted", async ({
  page,
}, testInfo) => {
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
      return;
    }
    await route.abort("failed");
  });
  await page.route(`${oauthIssuer}/authorize**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "Member sign in" }),
  );

  const startedAt = performance.now();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`^${oauthIssuer}/authorize\\?`, "u"),
    { timeout: 4_000 },
  );
  const elapsed = performance.now() - startedAt;
  testInfo.annotations.push({
    type: "network-failure-fallback-ms",
    description: elapsed.toFixed(0),
  });
  expect(elapsed).toBeLessThan(4_000);
});

for (const worker of ["shared", "dedicated"] as const) {
  for (const failure of ["rate limit", "network"] as const) {
    test(`recovers from a ${failure} failure with the ${worker} worker`, async ({
      page,
    }) => {
      await installFakeEngine(page, false, worker);
      const redirectUri = await installHostedConfig(page);
      let releaseInitialResponse = () => undefined;
      const initialResponse = new Promise<void>((resolve) => {
        releaseInitialResponse = resolve;
      });
      let markInitialRequestStarted = () => undefined;
      const initialRequestStarted = new Promise<void>((resolve) => {
        markInitialRequestStarted = resolve;
      });
      let authorizationRequests = 0;
      let attempts = 0;
      await page.route(`${oauthIssuer}/authorize**`, async (route) => {
        authorizationRequests += 1;
        await route.fallback();
      });
      await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
          return;
        }
        attempts += 1;
        if (attempts === 1) {
          markInitialRequestStarted();
          await initialResponse;
        }
        if (attempts === 1 && failure === "rate limit") {
          await route.fulfill({
            status: 429,
            contentType: "application/json",
            headers: sessionCors(new URL(redirectUri()).origin),
            body: JSON.stringify({ error: "invalid_request" }),
          });
          return;
        }
        if (attempts === 1) {
          await route.abort("failed");
          return;
        }
        await fulfillSessionToken(route, redirectUri(), "recovered-token");
      });

      await page.goto("/");
      await initialRequestStarted;
      releaseInitialResponse();

      await expect(
        page
          .locator("[data-initial-splash]", { has: page.getByRole("alert") })
          .getByRole("button", { name: "Retry" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.poll(() => attempts).toBe(2);
      expect(authorizationRequests).toBe(0);
      await expect(page).toHaveURL(redirectUri());
      await expectHostedToken(page, "recovered-token");
      await expect(
        page.getByRole("heading", { name: "#lounge" }),
      ).toBeVisible();
    });
  }
}

for (const worker of ["shared", "dedicated"] as const) {
  test(`shows an unrecoverable token failure with the ${worker} worker`, async ({
    page,
  }) => {
    await installFakeEngine(page, false, worker);
    const redirectUri = await installHostedConfig(page);
    await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        headers: sessionCors(new URL(redirectUri()).origin),
        body: JSON.stringify({ token_type: "Bearer", expires_in: 900 }),
      });
    });

    await page.goto("/");

    await expect(page.getByRole("alert")).toContainText("invalid access token");
    await expect(page.locator("[data-initial-splash]")).toBeVisible();
    await expect(page).toHaveURL(redirectUri());
  });
}

test("falls back to PKCE while the session endpoint is undeployed", async ({
  page,
}) => {
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      headers: sessionCors(new URL(redirectUri()).origin),
      body: JSON.stringify({ error: "not_found" }),
    });
  });

  await page.goto("/");

  await expectHostedToken(page, "fake-hosted-access-token");
  await expect(page).toHaveURL(redirectUri());
});

test("cleans the callback URL before a failed token exchange", async ({
  page,
}) => {
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  await page.route(`${oauthIssuer}/token`, (route) =>
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
  await page.route(`${oauthIssuer}/authorize**`, mismatch);

  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("did not match this tab");
  await expect(page).toHaveURL(redirectUri());
  await expect(
    page.getByRole("button", { name: "Sign in again" }),
  ).toBeVisible();

  await page.unroute(`${oauthIssuer}/authorize**`, mismatch);
  await page.getByRole("button", { name: "Sign in again" }).click();
  await expectHostedConnection(page);
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
      await page.route(`${oauthIssuer}/authorize**`, async (route) => {
        authorizationCount += 1;
        await route.fallback();
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

test("creates and activates a relay route after engine registration", async ({
  baseURL,
  context,
  page,
}) => {
  if (baseURL === undefined) throw new Error("app base URL is missing");
  await context.grantPermissions(["notifications"], {
    origin: new URL(baseURL).origin,
  });
  await installPushManagerStub(page);
  await installFakeEngine(page);
  await installFakeOAuth(page);
  await page.addInitScript(() => {
    Reflect.set(globalThis, "hostedPushEnabled", true);
  });
  await page.route("**/config.json", async (route) => {
    const config = hostedConfig(route.request().url());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...config,
        push: {
          relay: "https://push.weblounge.org",
          relay_vapid:
            "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
        },
      }),
    });
  });
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(baseURL).origin);
      return;
    }
    await fulfillSessionToken(route, baseURL, "push-session-token");
  });
  const relayRequests: string[] = [];
  await page.route("https://push.weblounge.org/**", async (route) => {
    const request = route.request();
    const cors = {
      "Access-Control-Allow-Origin": new URL(baseURL).origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "POST, PUT, DELETE",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const path = new URL(request.url()).pathname;
    relayRequests.push(`${request.method()} ${path}`);
    if (path === "/v1/devices") {
      expect(await request.headerValue("authorization")).toBe(
        "Bearer push-session-token",
      );
      expect(request.postDataJSON()).toMatchObject({
        target: {
          platform: "web_push",
          endpoint: "https://fcm.googleapis.com/fcm/send/e2e",
        },
      });
      await route.fulfill({
        status: 201,
        headers: cors,
        contentType: "application/json",
        body: JSON.stringify({ id: "device-1", secret: "device-secret" }),
      });
      return;
    }
    if (path === "/v1/devices/device-1/routes") {
      expect(await request.headerValue("authorization")).toBe(
        "Bearer device-secret",
      );
      expect(request.postDataJSON()).toEqual({ home_vapid: "home-vapid" });
      await route.fulfill({
        status: 201,
        headers: cors,
        contentType: "application/json",
        body: JSON.stringify({
          id: "route-1",
          endpoint: "https://push.weblounge.org/v1/r/route-1",
        }),
      });
      return;
    }
    await route.fulfill({ status: 204, headers: cors });
  });

  await page.goto("/");

  await expect
    .poll(() => relayRequests)
    .toEqual(["POST /v1/devices", "POST /v1/devices/device-1/routes"]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const requests = Reflect.get(globalThis, "hostedEngineRequests");
        return Array.isArray(requests) ? requests : [];
      }),
    )
    .toContainEqual(
      expect.objectContaining({
        type: "register_push",
        network_id: 1,
        route: expect.objectContaining({ route_id: "route-1" }),
      }),
    );
  expect(relayRequests).not.toContain("PUT /v1/routes/route-1/active");

  await page.evaluate(() => {
    const complete = Reflect.get(globalThis, "completePushRegistration");
    if (typeof complete !== "function")
      throw new Error("push registration release is missing");
    complete();
  });
  await expect
    .poll(() => relayRequests)
    .toContain("PUT /v1/routes/route-1/active");
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "pushSubscribeOptions")),
    )
    .toMatchObject({ userVisibleOnly: true });
});

async function installHostedConfig(page: Page): Promise<() => string> {
  let redirectUri = "";
  await installFakeOAuth(page);
  await page.route("**/config.json", async (route) => {
    redirectUri = new URL("/", route.request().url()).href;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(hostedConfig(route.request().url())),
    });
  });
  return () => redirectUri;
}

function hostedConfig(requestUrl: string) {
  return {
    mode: "hosted",
    network: {
      name: "weblounge",
      endpoint: "wss://beta.weblounge.org/socket",
      autojoin: ["#lounge"],
    },
    oauth: {
      issuer: oauthIssuer,
      client_id: "weblounge-client",
      redirect_uri: new URL("/", requestUrl).href,
      session_token_endpoint: `${oauthIssuer}/oauth/session-token` as
        | string
        | undefined,
    },
  };
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
    .toContainEqual(expect.objectContaining({ type: "reconnect_hosted" }));
}

async function expectHostedToken(
  page: Page,
  token: string,
  requestType = "reconnect_hosted",
): Promise<void> {
  await expect
    .poll(async () =>
      page
        .evaluate(() => {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          return Array.isArray(requests) ? requests : [];
        })
        .catch(() => []),
    )
    .toContainEqual(
      expect.objectContaining({ type: requestType, oauth_token: token }),
    );
}

async function fulfillSessionPreflight(
  route: Route,
  origin: string,
): Promise<void> {
  await route.fulfill({
    status: 204,
    headers: {
      ...sessionCors(origin),
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Max-Age": "3600",
    },
  });
}

function sessionCors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
  };
}

async function fulfillSessionToken(
  route: Route,
  redirectUri: string,
  token: string,
): Promise<void> {
  await route.fulfill({
    contentType: "application/json",
    headers: sessionCors(new URL(redirectUri).origin),
    body: JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: 900,
    }),
  });
}

async function installFakeEngine(
  page: Page,
  holdConnection = false,
  worker: "shared" | "dedicated" = "shared",
) {
  await page.addInitScript((workerKind) => {
    Reflect.set(globalThis, "hostedWorkerKind", workerKind);
  }, worker);
  await page.addInitScript((holdHostedConnection) => {
    const workerKind = Reflect.get(globalThis, "hostedWorkerKind");
    Reflect.set(globalThis, "hostedEngineRequests", []);
    Reflect.set(globalThis, "hostedStartupSequence", []);
    let pushDevice: {
      relay: string;
      device_id: string;
      secret: string;
    } | null = null;
    if (holdHostedConnection) {
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (new URL(url, location.href).pathname === "/config.json") {
          const sequence = Reflect.get(globalThis, "hostedStartupSequence");
          if (Array.isArray(sequence)) sequence.push("config");
        }
        return originalFetch(input, init);
      };
    }
    class FakePort extends EventTarget {
      postMessage(message: unknown) {
        if (typeof message !== "object" || message === null) return;
        const envelope = message as {
          type?: string;
          payload?: {
            id?: string;
            request?: { type?: string; credentials?: typeof pushDevice };
          };
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
        if (request?.type === "prepare_hosted") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          this.emit({
            type: "network_state_changed",
            network: {
              id: 1,
              label: "weblounge",
              nickname: "weblounge",
              state: "connecting",
            },
          });
          if (Reflect.get(globalThis, "hostedCachedChatList") === true) {
            this.emit({
              type: "chat_list_snapshot_loaded",
              network_id: 1,
              buffers: [
                {
                  id: 2,
                  network_id: 1,
                  kind: "channel",
                  title: "#cached",
                  draft_key: "10:weblounge:rfc1459:#cached",
                  topic: null,
                  member_count: 0,
                  unread: 1,
                  mentions: 0,
                  read_through: null,
                  cached: true,
                  cached_preview: "available before credentials",
                },
              ],
            });
          }
        }
        if (request?.type === "load_push_device") {
          this.emit({
            type: "push_device_loaded",
            command_id: id,
            credentials: pushDevice,
          });
        }
        if (request?.type === "store_push_device") {
          pushDevice = request.credentials ?? null;
        }
        if (request?.type === "clear_push_device") pushDevice = null;
        if (request?.type === "register_push") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          Reflect.set(globalThis, "completePushRegistration", () => {
            this.emit({
              type: "push_state_changed",
              network_id: 1,
              state: { status: "registered", route_id: "route-1" },
            });
          });
        }
        if (request?.type === "reconnect_hosted") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          Reflect.set(globalThis, "requestHostedToken", () => {
            this.emit({ type: "hosted_token_required", network_id: 1 });
          });
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
                  title: "#lounge",
                  draft_key: "10:weblounge:rfc1459:#lounge",
                  topic: null,
                  member_count: 0,
                  unread: 0,
                  mentions: 0,
                  read_through: null,
                },
                {
                  id: 3,
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
            if (Reflect.get(globalThis, "hostedPushEnabled") === true) {
              this.emit({
                type: "push_route_required",
                network_id: 1,
                vapid: "home-vapid",
                previous_route_id: null,
              });
            }
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

      constructor() {
        const sequence = Reflect.get(globalThis, "hostedStartupSequence");
        if (Array.isArray(sequence)) sequence.push("worker");
      }
    }
    if (workerKind === "shared") {
      Reflect.set(globalThis, "SharedWorker", FakeSharedWorker);
      return;
    }
    class FakeDedicatedWorker extends FakePort {
      terminate() {}
    }
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
    Reflect.set(globalThis, "Worker", FakeDedicatedWorker);
  }, holdConnection);
}

async function installPushManagerStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "granted",
    });
    const applicationServerKey = Uint8Array.from({ length: 65 }, (_, index) =>
      index === 0 ? 4 : index,
    ).buffer;
    PushManager.prototype.getSubscription = async () => null;
    PushManager.prototype.subscribe = async (options) => {
      Reflect.set(globalThis, "pushSubscribeOptions", {
        userVisibleOnly: options.userVisibleOnly,
        applicationServerKey: Array.from(
          new Uint8Array(options.applicationServerKey as ArrayBuffer),
        ),
      });
      return {
        endpoint: "https://fcm.googleapis.com/fcm/send/e2e",
        expirationTime: null,
        options: { applicationServerKey, userVisibleOnly: true },
        getKey: (name: PushEncryptionKeyName) =>
          name === "p256dh"
            ? Uint8Array.from({ length: 65 }, (_, index) => index).buffer
            : Uint8Array.from({ length: 16 }, (_, index) => index).buffer,
        toJSON: () => ({}),
        unsubscribe: async () => true,
      } as PushSubscription;
    };
    const pushManager = Object.create(PushManager.prototype) as PushManager;
    const registration = { pushManager } as ServiceWorkerRegistration;
    Object.defineProperty(ServiceWorkerContainer.prototype, "ready", {
      configurable: true,
      get: () => Promise.resolve(registration),
    });
  });
}

async function disableSharedWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
}
