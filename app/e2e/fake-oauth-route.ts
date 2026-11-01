import { createHash, randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";

export const oauthIssuer = "https://members.weblounge.org";

export async function installFakeOAuth(page: Page): Promise<void> {
  const codes = new Map<
    string,
    { readonly challenge: string; readonly redirectUri: string }
  >();
  await page.route(`${oauthIssuer}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      "Access-Control-Allow-Origin": request.headers().origin ?? "*",
      "Cache-Control": "no-store",
    };
    if (url.pathname === "/health") {
      await route.fulfill({ body: "OAuth fixture", headers });
      return;
    }
    if (url.pathname === "/oauth/session-token") {
      const cors = {
        ...headers,
        "Access-Control-Allow-Credentials": "true",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            ...cors,
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST",
          },
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        headers: cors,
        body: JSON.stringify({ error: "not_found" }),
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      await route.fulfill({
        contentType: "application/json",
        headers,
        body: JSON.stringify({
          issuer: oauthIssuer,
          authorization_endpoint: `${oauthIssuer}/authorize`,
          token_endpoint: `${oauthIssuer}/token`,
          code_challenge_methods_supported: ["S256"],
        }),
      });
      return;
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("client_id") !== "weblounge-client" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        redirectUri === null ||
        state === null ||
        challenge === null
      ) {
        await route.fulfill({ status: 400, body: "invalid authorization" });
        return;
      }
      const code = randomUUID();
      codes.set(code, { challenge, redirectUri });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      await route.fulfill({
        status: 302,
        headers: { Location: callback.href },
      });
      return;
    }
    if (url.pathname === "/token" && request.method() === "POST") {
      await exchangeCode(route, codes, headers);
      return;
    }
    await route.fulfill({ status: 404, headers });
  });
}

async function exchangeCode(
  route: Route,
  codes: Map<
    string,
    { readonly challenge: string; readonly redirectUri: string }
  >,
  headers: Record<string, string>,
): Promise<void> {
  const body = new URLSearchParams(route.request().postData() ?? "");
  const code = body.get("code");
  const pending = code === null ? undefined : codes.get(code);
  if (code !== null) codes.delete(code);
  const challenge = createHash("sha256")
    .update(body.get("code_verifier") ?? "")
    .digest("base64url");
  if (
    pending === undefined ||
    body.get("grant_type") !== "authorization_code" ||
    body.get("client_id") !== "weblounge-client" ||
    body.has("client_secret") ||
    body.get("redirect_uri") !== pending.redirectUri ||
    challenge !== pending.challenge
  ) {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      headers,
      body: JSON.stringify({ error: "invalid_grant" }),
    });
    return;
  }
  await route.fulfill({
    contentType: "application/json",
    headers,
    body: JSON.stringify({
      access_token: "fake-hosted-access-token",
      token_type: "Bearer",
      expires_in: 300,
    }),
  });
}
