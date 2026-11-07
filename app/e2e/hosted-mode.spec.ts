import { devices, expect, type Page, type Route, test } from "@playwright/test";
import { installFakeOAuth, oauthIssuer } from "./fake-oauth-route";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

const engineWasmRequest = /\/engine_bg(?:-[^/?]+)?\.wasm(?:\?.*)?$/u;
const builtEngineWorkerRequest =
  /\/engine\.(?:shared|dedicated)-worker-[^/]+\.js$/u;
const developmentEngineWorkerRequest =
  /\/engine\.(?:shared|dedicated)-worker\.ts$/u;
const { defaultBrowserType: _pixelBrowser, ...pixel7 } = devices["Pixel 7"];
const { defaultBrowserType: _iphoneBrowser, ...iphone16Pro } =
  devices["iPhone 16 Pro"];

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
  }, testInfo) => {
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
    testInfo.annotations.push({
      type: "deployment-error-ms",
      description: (performance.now() - startedAt).toFixed(0),
    });
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
  });
}

test("falls back to PKCE after a fresh session request is aborted", async ({
  page,
}, testInfo) => {
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
      return;
    }
    await route.abort("failed");
  });
  let authorizationRequests = 0;
  await page.route(`${oauthIssuer}/authorize**`, async (route) => {
    authorizationRequests += 1;
    await route.fulfill({ contentType: "text/html", body: "Member sign in" });
  });

  const startedAt = performance.now();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page).toHaveURL(redirectUri());
  await page.clock.runFor(2_999);
  expect(authorizationRequests).toBe(0);
  await expect(page).toHaveURL(redirectUri());

  await page.clock.runFor(1);
  await expect(page).toHaveURL(new RegExp(`^${oauthIssuer}/authorize\\?`, "u"));
  expect(authorizationRequests).toBe(1);
  const elapsed = performance.now() - startedAt;
  testInfo.annotations.push({
    type: "network-failure-fallback-ms",
    description: elapsed.toFixed(0),
  });
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

async function exerciseNotificationPromptRegistration(
  page: Page,
  baseURL: string | undefined,
  surface: {
    readonly browser: "chromium" | "webkit";
    readonly name: "desktop" | "mobile";
  },
): Promise<void> {
  if (baseURL === undefined) throw new Error("app base URL is missing");
  if (surface.name === "desktop" && surface.browser === "chromium") {
    await installNativeFeelInstrumentation(page);
  }
  if (surface.name === "mobile") await installStandaloneDisplay(page);
  await installPushManagerStub(page, "default", "granted");
  await installAppBadgeSpy(page);
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
  let relayRouteSequence = 0;
  let currentRelayRouteId: string | undefined;
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
      const ensureBody: unknown = request.postDataJSON();
      expect(ensureBody).toMatchObject({ home_vapid: "home-vapid" });
      const suppliedRouteId =
        typeof ensureBody === "object" &&
        ensureBody !== null &&
        "my_route_id" in ensureBody &&
        typeof ensureBody.my_route_id === "string"
          ? ensureBody.my_route_id
          : undefined;
      if (suppliedRouteId !== undefined)
        expect(suppliedRouteId).toBe(currentRelayRouteId);
      let routeId = currentRelayRouteId;
      if (routeId === undefined || suppliedRouteId === undefined) {
        relayRouteSequence += 1;
        routeId =
          relayRouteSequence === 1
            ? "route-123456789"
            : `route-recovered-${relayRouteSequence}`;
        currentRelayRouteId = routeId;
        await page.evaluate((id) => {
          const sequence = Reflect.get(globalThis, "pushRegistrationSequence");
          if (Array.isArray(sequence)) sequence.push(`create:${id}`);
        }, routeId);
      }
      await route.fulfill({
        status: 201,
        headers: cors,
        contentType: "application/json",
        body: JSON.stringify({
          id: routeId,
          endpoint: `https://push.weblounge.org/v1/r/${routeId}`,
        }),
      });
      return;
    }
    if (request.method() === "DELETE" && path.startsWith("/v1/routes/")) {
      const deletedRouteId = path.slice("/v1/routes/".length);
      if (deletedRouteId === currentRelayRouteId)
        currentRelayRouteId = undefined;
      await page.evaluate((id) => {
        const sequence = Reflect.get(globalThis, "pushRegistrationSequence");
        if (Array.isArray(sequence)) sequence.push(`delete:${id}`);
      }, deletedRouteId);
    }
    if (path === "/v1/devices/device-1/dead-endpoints") {
      await route.fulfill({
        status: 200,
        headers: cors,
        contentType: "application/json",
        body: JSON.stringify({ endpoints: [] }),
      });
      return;
    }
    await route.fulfill({ status: 204, headers: cors });
  });

  await page.goto("/");

  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  const prompt = page.getByRole("region", { name: "Notifications" });
  await expect(prompt).toBeVisible();
  if (surface.browser === "chromium") {
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({
      path: `e2e/screenshots/notification-prompt-${surface.name}-light.png`,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({
      path: `e2e/screenshots/notification-prompt-${surface.name}-dark.png`,
    });
    await page.emulateMedia({ colorScheme: "light" });
  }
  if (surface.name === "desktop" && surface.browser === "chromium") {
    await nativeFeelAudit(page);
  }
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(prompt).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Reflect.get(globalThis, "notificationPermissionRequests"),
    ),
  ).toBe(1);

  await expect
    .poll(() => relayRequests)
    .toEqual(
      expect.arrayContaining([
        "POST /v1/devices",
        "POST /v1/devices/device-1/routes",
        "POST /v1/devices/device-1/lease",
      ]),
    );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const requests = Reflect.get(globalThis, "hostedEngineRequests");
        return Array.isArray(requests) ? requests : [];
      }),
    )
    .toContainEqual(
      expect.objectContaining({
        type: "ensure_push",
        network_id: 1,
        route: expect.objectContaining({ route_id: "route-123456789" }),
      }),
    );
  expect(relayRequests).not.toContain("PUT /v1/routes/route-123456789/active");

  const composer = page.getByRole("textbox", { name: /^Message /u });
  if ((await composer.count()) === 0) {
    await page.getByRole("button", { name: "#lounge" }).click();
  }
  await composer.fill("/debug push");
  await composer.press("Enter");
  const debug = page.locator("[data-debug-overlay]");
  await expect(debug).toContainText("[push]");
  await expect(debug).toContainText(
    "prompt: configured=true / supported=true / permission=granted / dismissed=false",
  );
  await expect(debug).toContainText(
    /ios=(?:true|false) \/ display=(?:browser|standalone)/u,
  );
  await expect(debug).toContainText(
    "network weblounge: engine=none / relay=probing (route-12) / last error=none",
  );
  await expect(debug).not.toContainText("route-123456789");

  await page.evaluate(() => {
    const complete = Reflect.get(globalThis, "completePushRegistration");
    if (typeof complete !== "function")
      throw new Error("push registration release is missing");
    complete();
  });
  await expect
    .poll(() => relayRequests)
    .toContain("PUT /v1/routes/route-123456789/active");
  await expect(debug).toContainText(
    "engine=Registered (route-12) / relay=active (route-12) / last error=none",
  );
  await page.evaluate(() => {
    const fail = Reflect.get(globalThis, "failPushRegistration");
    if (typeof fail !== "function")
      throw new Error("push registration failure control is missing");
    fail();
  });
  await expect(debug).toContainText("engine=Failed(invalid_parameters)");
  await expect(debug).toContainText(
    "relay=probing (route-re) / last error=none",
  );
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "pushRegistrationSequence")),
    )
    .toEqual([
      "create:route-123456789",
      "ensure:route-123456789",
      "create:route-recovered-2",
      "ensure:route-recovered-2",
    ]);
  await composer.fill("/debug");
  await composer.press("Enter");
  await expect(debug).toContainText("[debug]");
  await expect(debug).toContainText(
    "push: network weblounge: engine=Failed(invalid_parameters) / relay=probing (route-re) / last error=none",
  );
  await page.evaluate(() => {
    const complete = Reflect.get(globalThis, "completePushRegistration");
    if (typeof complete !== "function")
      throw new Error("replacement push registration release is missing");
    complete();
  });
  await expect(debug).toContainText(
    "engine=Registered (route-re) / relay=active (route-re) / last error=none",
  );
  await page.evaluate(() => {
    const setUnread = Reflect.get(globalThis, "setHostedUnread");
    if (typeof setUnread !== "function")
      throw new Error("hosted unread control is missing");
    setUnread(7, 2);
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "appBadgeCalls")))
    .toContainEqual(["set", 2]);
  await page.evaluate(() => {
    const setUnread = Reflect.get(globalThis, "setHostedUnread");
    if (typeof setUnread === "function") setUnread(0, 0);
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "appBadgeCalls")))
    .toContainEqual(["clear"]);
  if (surface.browser === "chromium") {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(() => relayRequests)
      .toContain("POST /v1/devices/device-1/lease/release");
  }
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "pushSubscribeOptions")),
    )
    .toMatchObject({ userVisibleOnly: true });
}

test.describe("cross-tab push request budget", () => {
  test.use({ serviceWorkers: "block" });

  test("backs off a no-CORS 429 while tabs change visibility", async ({
    baseURL,
    browserName,
    context,
    page,
  }) => {
    test.skip(browserName !== "chromium");
    if (baseURL === undefined) throw new Error("app base URL is missing");
    const requests: string[] = [];
    let failNextLease = false;
    const cors = {
      "Access-Control-Allow-Origin": new URL(baseURL).origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
    };
    await context.route("https://push.weblounge.org/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const path = new URL(request.url()).pathname;
      requests.push(`${request.method()} ${path}`);
      if (
        failNextLease &&
        request.method() === "POST" &&
        path === "/v1/devices/device-budget/lease"
      ) {
        failNextLease = false;
        await route.fulfill({ status: 429 });
        return;
      }
      if (path === "/v1/devices") {
        await route.fulfill({
          status: 201,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({
            id: "device-budget",
            secret: "device-budget-secret",
          }),
        });
        return;
      }
      if (path === "/v1/devices/device-budget/routes") {
        await route.fulfill({
          status: 201,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({
            id: "route-budget",
            endpoint: "https://push.weblounge.org/v1/r/route-budget",
          }),
        });
        return;
      }
      if (path === "/v1/devices/device-budget/dead-endpoints") {
        await route.fulfill({
          status: 200,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({ endpoints: [] }),
        });
        return;
      }
      await route.fulfill({ status: 204, headers: cors });
    });

    const preparePage = async (candidate: Page) => {
      await installPushBudgetForegroundControl(candidate);
      await installPushManagerStub(candidate);
      await installFakeEngine(candidate);
      await installFakeOAuth(candidate);
      await candidate.addInitScript(() => {
        Reflect.set(globalThis, "hostedPushEnabled", true);
      });
      await candidate.route("**/config.json", async (route) => {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(pushHostedConfig(route.request().url())),
        });
      });
      await candidate.route(
        `${oauthIssuer}/oauth/session-token`,
        async (route) => {
          if (route.request().method() === "OPTIONS") {
            await fulfillSessionPreflight(route, new URL(baseURL).origin);
            return;
          }
          await fulfillSessionToken(route, baseURL, "push-session-token");
        },
      );
    };

    await preparePage(page);
    await page.goto("/");
    await expect
      .poll(() => requests)
      .toContain("POST /v1/devices/device-budget/lease");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            typeof Reflect.get(globalThis, "completePushRegistration") ===
            "function",
        ),
      )
      .toBe(true);
    await emitPushRegistration(page);
    await emitPushRegistration(page);

    const second = await context.newPage();
    await preparePage(second);
    await second.goto("/");
    await expect(second.locator("[data-initial-splash]")).toHaveCount(0);
    await page.clock.install();
    await second.clock.install();
    await setPushBudgetForeground(page, false);
    failNextLease = true;

    for (let elapsed = 0; elapsed < 60_000; elapsed += 10_000) {
      const foreground = elapsed % 20_000 === 0 ? page : second;
      const background = foreground === page ? second : page;
      await setPushBudgetForeground(background, false);
      await setPushBudgetForeground(foreground, true);
      await page.clock.fastForward(10_000);
      await second.clock.fastForward(10_000);
    }

    await expect.poll(() => failNextLease).toBe(false);
    expect(
      requests.filter((value) => value === "POST /v1/devices"),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (value) => value === "POST /v1/devices/device-budget/routes",
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (value) => value === "PUT /v1/routes/route-budget/active",
      ),
    ).toHaveLength(1);
    expect(requests.length, requests.join("\n")).toBeLessThanOrEqual(20);
    await second.close();
  });
});

test.describe("iOS stale app badge", () => {
  test.use({ ...iphone16Pro, serviceWorkers: "block" });

  test("converges an Apple badge after a dropped MARKREAD on foreground", async ({
    baseURL,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.use.browserName !== "webkit");
    if (baseURL === undefined) throw new Error("app base URL is missing");
    await page.addInitScript(() => {
      let focused = true;
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => focused,
      });
      Reflect.set(globalThis, "setBadgeTestFocus", (value: boolean) => {
        focused = value;
      });
      Reflect.set(globalThis, "hostedReadDirect", true);
    });
    await installAppBadgeSpy(page);
    await installFakeEngine(page);
    await installHostedConfig(page);
    await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillSessionPreflight(route, new URL(baseURL).origin);
        return;
      }
      await fulfillSessionToken(route, baseURL, "badge-session-token");
    });

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
    await expect.poll(() => currentAppBadge(page)).toBe(0);

    await page.evaluate(async () => {
      Reflect.set(globalThis, "appBadgeCalls", []);
      const setFocus = Reflect.get(globalThis, "setBadgeTestFocus");
      if (typeof setFocus !== "function")
        throw new Error("badge focus control is unavailable");
      setFocus(false);
      window.dispatchEvent(new Event("blur"));

      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("weblounge-push-v2", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction(
        ["routes", "state"],
        "readwrite",
      );
      transaction.objectStore("routes").put({
        vapid: "apple-home",
        routeId: "apple-route",
        endpoint: "https://web.push.apple.com/Q-e2e",
      });
      const state = transaction.objectStore("state");
      state.put(1, "app-badge");
      state.put(
        {
          schema: 2,
          conversations: [{ tag: "weblounge/mel", count: 1, read_at_ms: null }],
          untagged: 0,
        },
        "notification-counts",
      );
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      await navigator.setAppBadge?.(1);
    });
    await expect.poll(() => currentAppBadge(page)).toBe(1);

    await page.evaluate(() => {
      const setFocus = Reflect.get(globalThis, "setBadgeTestFocus");
      if (typeof setFocus !== "function")
        throw new Error("badge focus control is unavailable");
      setFocus(true);
      window.dispatchEvent(new Event("focus"));
    });

    await expect.poll(() => currentAppBadge(page)).toBe(0);
    await expect
      .poll(() => storedPushBadge(page))
      .toEqual({
        badge: 0,
        direct: {
          messages: [],
          read_at_ms: null,
          tag: "weblounge/mel",
          unknown_count: 0,
        },
      });
  });
});

async function installAppBadgeSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.set(globalThis, "appBadgeCalls", []);
    Object.defineProperties(Navigator.prototype, {
      setAppBadge: {
        configurable: true,
        value: async (count: number) => {
          const calls = Reflect.get(globalThis, "appBadgeCalls");
          if (Array.isArray(calls)) calls.push(["set", count]);
        },
      },
      clearAppBadge: {
        configurable: true,
        value: async () => {
          const calls = Reflect.get(globalThis, "appBadgeCalls");
          if (Array.isArray(calls)) calls.push(["clear"]);
        },
      },
    });
  });
}

async function currentAppBadge(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const calls: unknown = Reflect.get(globalThis, "appBadgeCalls");
    if (!Array.isArray(calls)) return undefined;
    const last: unknown = calls.at(-1);
    if (!Array.isArray(last)) return undefined;
    if (last[0] === "clear") return 0;
    return last[0] === "set" && typeof last[1] === "number"
      ? last[1]
      : undefined;
  });
}

async function storedPushBadge(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weblounge-push-v2", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readonly");
    const store = transaction.objectStore("state");
    const read = (key: string) =>
      new Promise<unknown>((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const [badge, counts] = await Promise.all([
      read("app-badge"),
      read("notification-counts"),
    ]);
    database.close();
    const conversations =
      typeof counts === "object" &&
      counts !== null &&
      "conversations" in counts &&
      Array.isArray(counts.conversations)
        ? counts.conversations
        : [];
    return {
      badge,
      direct: conversations.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "tag" in entry &&
          entry.tag === "weblounge/mel",
      ),
    };
  });
}

for (const surface of [
  { browser: "chromium", name: "desktop", use: {} },
  { browser: "chromium", name: "mobile", use: pixel7 },
  { browser: "webkit", name: "mobile", use: iphone16Pro },
] as const) {
  test.describe(`${surface.name} ${surface.browser} notification prompt`, () => {
    test.use({ ...surface.use, serviceWorkers: "block" });
    test("requests permission and activates a relay route", async ({
      baseURL,
      page,
    }, testInfo) => {
      test.skip(testInfo.project.use.browserName !== surface.browser);
      await exerciseNotificationPromptRegistration(page, baseURL, surface);
    });
  });
}

test.describe("live notification configuration", () => {
  test.use({ serviceWorkers: "block" });

  test("shows the prompt when revalidation adds push", async ({
    baseURL,
    page,
  }) => {
    if (baseURL === undefined) throw new Error("app base URL is missing");
    await installPushManagerStub(page, "default", "granted");
    await installFakeEngine(page);
    await installFakeOAuth(page);
    await page.addInitScript(
      ({ config, key }) => {
        localStorage.setItem(key, JSON.stringify({ config, schema: 1 }));
      },
      {
        config: hostedConfig(baseURL),
        key: "weblounge.deployment-config.v1",
      },
    );
    let finishRevalidation = () => {};
    const revalidation = new Promise<void>((resolve) => {
      finishRevalidation = resolve;
    });
    await page.route("**/config.json", async (route) => {
      await revalidation;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pushHostedConfig(route.request().url())),
      });
    });
    await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillSessionPreflight(route, new URL(baseURL).origin);
        return;
      }
      await fulfillSessionToken(route, baseURL, "push-session-token");
    });

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Notifications" }),
    ).toHaveCount(0);

    finishRevalidation();
    await expect(
      page.getByRole("region", { name: "Notifications" }),
    ).toBeVisible();
  });

  test("shows the prompt when the dismissal read fails", async ({
    baseURL,
    page,
  }) => {
    if (baseURL === undefined) throw new Error("app base URL is missing");
    await prepareNotificationPrompt(page, baseURL, "granted");
    await page.addInitScript(() =>
      Reflect.set(globalThis, "failNotificationPromptRead", true),
    );

    await page.goto("/");

    await expect(
      page.getByRole("region", { name: "Notifications" }),
    ).toBeVisible();
  });
});

test("fresh Firefox and Chromium profiles show notification setup when the preference read stalls", async ({
  baseURL,
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium" && browserName !== "firefox");
  if (baseURL === undefined) throw new Error("app base URL is missing");
  if (browserName === "chromium")
    await installPushManagerStub(page, "default", "granted");
  await page.addInitScript(() =>
    Reflect.set(globalThis, "hangNotificationPromptRead", true),
  );
  await installFakeEngine(page);
  await installFakeOAuth(page);
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(pushHostedConfig(route.request().url())),
    });
  });
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(baseURL).origin);
      return;
    }
    await fulfillSessionToken(route, baseURL, "push-session-token");
  });

  await page.goto("/?debug=viewport");

  await expect(
    page.getByRole("region", { name: "Notifications" }),
  ).toBeVisible();
  await expect(page.locator("[data-debug-overlay]")).toContainText(
    "notifications: configured=true / supported=true / permission=default / dismissed=false / ios=false / display=browser",
  );
});

for (const surface of [
  { browser: "chromium", use: pixel7 },
  { browser: "webkit", use: iphone16Pro },
] as const) {
  test.describe(`mobile ${surface.browser} notification prompt decisions`, () => {
    test.use({ ...surface.use, serviceWorkers: "block" });

    test("dismissal persists across reload", async ({
      baseURL,
      page,
    }, testInfo) => {
      test.skip(testInfo.project.use.browserName !== surface.browser);
      if (baseURL === undefined) throw new Error("app base URL is missing");
      await prepareNotificationPrompt(page, baseURL, "granted");

      await page.goto("/");
      await expect(
        page.getByRole("region", { name: "Notifications" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Dismiss notification prompt" })
        .click();
      await expect(
        page.getByRole("region", { name: "Notifications" }),
      ).toHaveCount(0);

      await page.reload();
      await expect(
        page.getByRole("heading", { name: "weblounge" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Notifications" }),
      ).toHaveCount(0);
    });

    test("denied permission hides without starting push", async ({
      baseURL,
      page,
    }, testInfo) => {
      test.skip(testInfo.project.use.browserName !== surface.browser);
      if (baseURL === undefined) throw new Error("app base URL is missing");
      await prepareNotificationPrompt(page, baseURL, "denied");
      const relayRequests: string[] = [];
      await page.route("https://push.weblounge.org/**", async (route) => {
        relayRequests.push(route.request().url());
        await route.fulfill({ status: 204 });
      });

      await page.goto("/");
      await page.getByRole("button", { name: "Turn on" }).click();

      await expect(
        page.getByRole("region", { name: "Notifications" }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          Reflect.get(globalThis, "notificationPermissionRequests"),
        ),
      ).toBe(1);
      expect(relayRequests).toEqual([]);
    });
  });
}

async function prepareNotificationPrompt(
  page: Page,
  baseURL: string,
  requestResult: NotificationPermission,
): Promise<void> {
  await installStandaloneDisplay(page);
  await installPushManagerStub(page, "default", requestResult);
  await installFakeEngine(page);
  await installFakeOAuth(page);
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(pushHostedConfig(route.request().url())),
    });
  });
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(baseURL).origin);
      return;
    }
    await fulfillSessionToken(route, baseURL, "push-session-token");
  });
}

function pushHostedConfig(requestUrl: string) {
  return {
    ...hostedConfig(requestUrl),
    push: {
      relay: "https://push.weblounge.org",
      relay_vapid:
        "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
    },
  };
}

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
    Reflect.set(globalThis, "pushRegistrationSequence", []);
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
                  sync_state: "pending",
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
          const storedPushDevice = localStorage.getItem("e2e.push-device");
          this.emit({
            type: "push_device_loaded",
            command_id: id,
            credentials:
              storedPushDevice === null
                ? pushDevice
                : JSON.parse(storedPushDevice),
          });
        }
        if (request?.type === "load_notification_prompt_dismissal") {
          if (Reflect.get(globalThis, "hangNotificationPromptRead") === true)
            return;
          if (Reflect.get(globalThis, "failNotificationPromptRead") === true) {
            this.emit({
              type: "command_rejected",
              id,
              message_key: "engine.storage_unavailable",
            });
            return;
          }
          this.emit({
            type: "notification_prompt_dismissal_loaded",
            command_id: id,
            dismissed:
              localStorage.getItem("e2e.notification-prompt-dismissed") ===
              "true",
          });
        }
        if (request?.type === "dismiss_notification_prompt") {
          localStorage.setItem("e2e.notification-prompt-dismissed", "true");
        }
        if (request?.type === "store_push_device") {
          pushDevice = request.credentials ?? null;
          localStorage.setItem("e2e.push-device", JSON.stringify(pushDevice));
        }
        if (request?.type === "clear_push_device") {
          pushDevice = null;
          localStorage.removeItem("e2e.push-device");
        }
        if (request?.type === "ensure_push") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          const routeId =
            typeof request.route === "object" &&
            request.route !== null &&
            "route_id" in request.route &&
            typeof request.route.route_id === "string"
              ? request.route.route_id
              : "unknown-route";
          const sequence = Reflect.get(globalThis, "pushRegistrationSequence");
          if (Array.isArray(sequence)) sequence.push(`ensure:${routeId}`);
          Reflect.set(globalThis, "completePushRegistration", () => {
            this.emit({
              type: "push_state_changed",
              network_id: 1,
              state: { status: "registered", route_id: routeId },
            });
          });
          Reflect.set(globalThis, "failPushRegistration", () => {
            this.emit({
              type: "push_state_changed",
              network_id: 1,
              state: {
                status: "failed",
                route_id: routeId,
                reason: "invalid_parameters",
              },
            });
          });
        }
        if (request?.type === "unregister_push_route") {
          const sequence = Reflect.get(globalThis, "pushRegistrationSequence");
          if (Array.isArray(sequence)) {
            sequence.push(
              `unregister:${String(request.route_id)}:${String(request.endpoint)}`,
            );
          }
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
                  sync_state: "synced",
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
                  sync_state: "synced",
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
                  sync_state: "synced",
                  title: "#ops",
                  draft_key: "10:weblounge:rfc1459:#ops",
                  topic: null,
                  member_count: 0,
                  unread: 0,
                  mentions: 0,
                  read_through: null,
                },
                ...(Reflect.get(globalThis, "hostedReadDirect") === true
                  ? [
                      {
                        id: 4,
                        network_id: 1,
                        kind: "direct",
                        sync_state: "synced",
                        title: "mel",
                        draft_key: "10:weblounge:rfc1459:mel",
                        topic: null,
                        unread: 0,
                        mentions: 0,
                        read_through: null,
                        read_at_ms: Date.parse("2026-11-04T19:24:33.000Z"),
                      },
                    ]
                  : []),
              ],
            });
            Reflect.set(
              globalThis,
              "setHostedUnread",
              (unread: number, mentions: number) => {
                this.emit({
                  type: "unread_changed",
                  buffer_id: 2,
                  unread,
                  mentions,
                });
              },
            );
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

async function installPushManagerStub(
  page: Page,
  initialPermission: NotificationPermission = "granted",
  requestResult: NotificationPermission = initialPermission,
): Promise<void> {
  await page.addInitScript(
    ({ initial, result }) => {
      let permission = initial;
      Reflect.set(globalThis, "notificationPermissionRequests", 0);
      const PushManagerConstructor =
        globalThis.PushManager ?? class PushManagerStub {};
      const NotificationConstructor =
        globalThis.Notification ?? class NotificationStub {};
      Object.defineProperty(globalThis, "PushManager", {
        configurable: true,
        value: PushManagerConstructor,
      });
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: NotificationConstructor,
      });
      Object.defineProperty(NotificationConstructor, "permission", {
        configurable: true,
        get: () => permission,
      });
      Object.defineProperty(NotificationConstructor, "requestPermission", {
        configurable: true,
        value: () => {
          const calls = Reflect.get(
            globalThis,
            "notificationPermissionRequests",
          );
          Reflect.set(
            globalThis,
            "notificationPermissionRequests",
            typeof calls === "number" ? calls + 1 : 1,
          );
          permission = result;
          return Promise.resolve(result);
        },
      });
      const applicationServerKey = Uint8Array.from(
        { length: 65 },
        (_, index) => (index === 0 ? 4 : index),
      ).buffer;
      PushManagerConstructor.prototype.getSubscription = async () => null;
      PushManagerConstructor.prototype.subscribe = async (options) => {
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
      const pushManager = Object.create(
        PushManagerConstructor.prototype,
      ) as PushManager;
      const registration = { pushManager } as ServiceWorkerRegistration;
      for (const target of [
        ServiceWorkerContainer.prototype,
        navigator.serviceWorker,
      ]) {
        Object.defineProperty(target, "ready", {
          configurable: true,
          get: () => Promise.resolve(registration),
        });
      }
    },
    { initial: initialPermission, result: requestResult },
  );
}

async function installPushBudgetForegroundControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let foreground = true;
    Object.defineProperties(document, {
      hasFocus: {
        configurable: true,
        value: () => foreground,
      },
      hidden: {
        configurable: true,
        get: () => !foreground,
      },
      visibilityState: {
        configurable: true,
        get: () => (foreground ? "visible" : "hidden"),
      },
    });
    Reflect.set(globalThis, "setPushBudgetForeground", (value: boolean) => {
      foreground = value;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event(value ? "focus" : "blur"));
    });
  });
}

async function setPushBudgetForeground(
  page: Page,
  foreground: boolean,
): Promise<void> {
  await page.evaluate((value) => {
    const setForeground = Reflect.get(globalThis, "setPushBudgetForeground");
    if (typeof setForeground !== "function")
      throw new Error("push budget foreground control is missing");
    setForeground(value);
  }, foreground);
}

async function emitPushRegistration(page: Page): Promise<void> {
  await page.evaluate(() => {
    const complete = Reflect.get(globalThis, "completePushRegistration");
    if (typeof complete !== "function")
      throw new Error("push registration release is missing");
    complete();
  });
}

async function installStandaloneDisplay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query !== "(display-mode: standalone)") return matchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      };
    };
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
