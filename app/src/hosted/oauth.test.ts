import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedOAuthConfig } from "../engine/generated/HostedOAuthConfig";
import {
  clearAuthorizationParameters,
  consumeAuthorizationCallback,
  createAuthorizationUrl,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  HostedAuthorizationError,
  metadataUrl,
  pkceChallenge,
} from "./oauth";

const config: HostedOAuthConfig = {
  issuer: "https://members.weblounge.org",
  client_id: "weblounge-client",
  redirect_uri: "https://beta.weblounge.org/",
};

const metadata = {
  issuer: config.issuer,
  authorizationEndpoint: "https://members.weblounge.org/oauth/authorize",
  tokenEndpoint: "https://members.weblounge.org/oauth/token",
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("OAuth authorization code with PKCE", () => {
  it("builds the RFC 8414 well-known URL for an issuer path", () => {
    expect(metadataUrl("https://example.test/issuer/")).toBe(
      "https://example.test/.well-known/oauth-authorization-server/issuer",
    );
  });

  it("discovers and validates metadata", async () => {
    const fetchMetadata = vi.fn(async () =>
      Response.json({
        issuer: config.issuer,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        code_challenge_methods_supported: ["S256"],
      }),
    );
    await expect(discoverOAuthMetadata(config, fetchMetadata)).resolves.toEqual(
      metadata,
    );
    expect(fetchMetadata).toHaveBeenCalledWith(
      "https://members.weblounge.org/.well-known/oauth-authorization-server",
      expect.any(Object),
    );
  });

  it.each([
    [
      "authorization endpoint",
      "https://login.example.test/oauth/authorize",
      metadata.tokenEndpoint,
    ],
    [
      "token endpoint",
      metadata.authorizationEndpoint,
      "https://tokens.example.test/oauth/token",
    ],
  ])(
    "rejects a cross-origin %s",
    async (field, authorizationEndpoint, tokenEndpoint) => {
      const fetchMetadata = vi.fn(async () =>
        Response.json({
          issuer: config.issuer,
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: tokenEndpoint,
        }),
      );

      await expect(
        discoverOAuthMetadata(config, fetchMetadata),
      ).rejects.toThrow(`The sign-in ${field} must use the issuer's origin.`);
    },
  );

  it.each([
    ["https://members.weblounge.org", "https://members.weblounge.org/"],
    ["https://members.weblounge.org/", "https://members.weblounge.org"],
  ])(
    "accepts equivalent issuer trailing slashes",
    async (configuredIssuer, discoveredIssuer) => {
      const fetchMetadata = vi.fn(async () =>
        Response.json({
          issuer: discoveredIssuer,
          authorization_endpoint: metadata.authorizationEndpoint,
          token_endpoint: metadata.tokenEndpoint,
        }),
      );

      await expect(
        discoverOAuthMetadata(
          { ...config, issuer: configuredIssuer },
          fetchMetadata,
        ),
      ).resolves.toMatchObject({
        issuer: configuredIssuer.replace(/\/$/u, ""),
      });
    },
  );

  it("reports an unreachable sign-in service in human terms", async () => {
    const unreachable = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(discoverOAuthMetadata(config, unreachable)).rejects.toThrow(
      "Couldn't reach the sign-in service.",
    );
  });

  it("stores state and a verifier only in session storage", async () => {
    const authorization = new URL(
      await createAuthorizationUrl(metadata, config),
    );
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("client_id")).toBe(config.client_id);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = authorization.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(localStorage.length).toBe(0);

    const callback = new URL(config.redirect_uri);
    callback.searchParams.set("code", "one-minute-code");
    callback.searchParams.set("state", state ?? "");
    const code = consumeAuthorizationCallback(callback);
    expect(code?.code).toBe("one-minute-code");
    expect(code?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(sessionStorage.length).toBe(0);
  });

  it("checks state once and clears a mismatched verifier", async () => {
    await createAuthorizationUrl(metadata, config);
    const callback = new URL(`${config.redirect_uri}?code=x&state=wrong`);
    const replace = vi.fn();
    expect(() =>
      consumeAuthorizationCallback(callback, sessionStorage, replace),
    ).toThrow("did not match this tab");
    expect(replace).toHaveBeenCalledWith("/");
    expect(sessionStorage.length).toBe(0);
    expect(() => consumeAuthorizationCallback(callback)).toThrow(
      HostedAuthorizationError,
    );
  });

  it("clears the verifier when callback state is missing", async () => {
    await createAuthorizationUrl(metadata, config);
    const callback = new URL(`${config.redirect_uri}?code=x`);

    expect(() => consumeAuthorizationCallback(callback)).toThrow(
      "did not match this tab",
    );
    expect(sessionStorage.length).toBe(0);
  });

  it("turns authorization denial into a human error", async () => {
    const authorization = new URL(
      await createAuthorizationUrl(metadata, config),
    );
    const callback = new URL(config.redirect_uri);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state") ?? "",
    );
    expect(() => consumeAuthorizationCallback(callback)).toThrow(
      "Authorization was denied",
    );
  });

  it("exchanges the code without a client secret and records expiry", async () => {
    const fetchToken = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code_verifier")).toBe("verifier");
        expect(body.get("client_id")).toBe("weblounge-client");
        expect(body.has("client_secret")).toBe(false);
        return Response.json({
          access_token: "bearer-token",
          token_type: "Bearer",
          expires_in: 60,
        });
      },
    );
    await expect(
      exchangeAuthorizationCode(
        metadata,
        config,
        { code: "code", verifier: "verifier" },
        fetchToken,
        () => 1_000,
      ),
    ).resolves.toEqual({ accessToken: "bearer-token", expiresAt: 61_000 });
  });

  it("uses the S256 challenge", async () => {
    await expect(
      pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("removes OAuth callback fields without disturbing other query state", () => {
    expect(
      clearAuthorizationParameters(
        new URL("https://beta.weblounge.org/?code=x&state=y&keep=1#chat"),
      ),
    ).toBe("/?keep=1#chat");
  });
});
