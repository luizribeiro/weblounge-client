import type { HostedOAuthConfig } from "../engine/generated/HostedOAuthConfig";

const pendingKey = "weblounge.oauth.pending";

export interface OAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface AuthorizationCode {
  code: string;
  verifier: string;
}

export interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

export class HostedAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedAuthorizationError";
  }
}

export async function discoverOAuthMetadata(
  config: HostedOAuthConfig,
  fetchMetadata: typeof fetch = fetch,
): Promise<OAuthMetadata> {
  let response: Response;
  try {
    response = await fetchMetadata(metadataUrl(config.issuer), {
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new HostedAuthorizationError("Couldn't reach the sign-in service.");
  }
  if (!response.ok) {
    throw new HostedAuthorizationError(
      `Couldn't reach the sign-in service (${response.status}).`,
    );
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!isRecord(value)) {
    throw new HostedAuthorizationError(
      "The sign-in service returned invalid metadata.",
    );
  }
  const issuer = normalizeIssuer(secureUrl(value.issuer, "issuer"));
  if (normalizeIssuer(issuer) !== normalizeIssuer(config.issuer)) {
    throw new HostedAuthorizationError(
      "The sign-in service reported the wrong issuer.",
    );
  }
  const methods = value.code_challenge_methods_supported;
  if (
    methods !== undefined &&
    (!Array.isArray(methods) || !methods.includes("S256"))
  ) {
    throw new HostedAuthorizationError(
      "The sign-in service doesn't support secure PKCE.",
    );
  }
  const authorizationEndpoint = secureUrl(
    value.authorization_endpoint,
    "authorization endpoint",
  );
  const tokenEndpoint = secureUrl(value.token_endpoint, "token endpoint");
  requireIssuerOrigin(issuer, authorizationEndpoint, "authorization endpoint");
  requireIssuerOrigin(issuer, tokenEndpoint, "token endpoint");
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
  };
}

export async function createAuthorizationUrl(
  metadata: OAuthMetadata,
  config: HostedOAuthConfig,
  storage: Storage = sessionStorage,
): Promise<string> {
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(32);
  const challenge = await pkceChallenge(verifier);
  storage.setItem(pendingKey, JSON.stringify({ state, verifier }));
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.client_id);
  url.searchParams.set("redirect_uri", config.redirect_uri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

export function consumeAuthorizationCallback(
  url: URL,
  storage: Storage = sessionStorage,
  replace: (path: string) => void = (path) =>
    history.replaceState(history.state, "", path),
): AuthorizationCode | null {
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (code === null && oauthError === null) return null;
  try {
    const verifier = consumePending(url.searchParams.get("state"), storage);
    if (oauthError !== null) {
      if (oauthError === "access_denied") {
        throw new HostedAuthorizationError(
          "Authorization was denied. Sign in again to continue.",
        );
      }
      throw new HostedAuthorizationError(
        "Sign-in could not be completed. Please try again.",
      );
    }
    return { code: code ?? "", verifier };
  } finally {
    replace(clearAuthorizationParameters(url));
  }
}

export async function exchangeAuthorizationCode(
  metadata: OAuthMetadata,
  config: HostedOAuthConfig,
  authorization: AuthorizationCode,
  fetchToken: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<AccessToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorization.code,
    code_verifier: authorization.verifier,
    redirect_uri: config.redirect_uri,
    client_id: config.client_id,
  });
  let response: Response;
  try {
    response = await fetchToken(metadata.tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    throw new HostedAuthorizationError("Couldn't reach the sign-in service.");
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new HostedAuthorizationError(
      response.status === 400
        ? "The sign-in code expired. Please sign in again."
        : "The sign-in service couldn't issue a session. Please try again.",
    );
  }
  if (!isRecord(value)) {
    throw new HostedAuthorizationError(
      "The sign-in service returned an invalid session.",
    );
  }
  if (
    typeof value.access_token !== "string" ||
    value.access_token === "" ||
    (typeof value.token_type === "string" &&
      value.token_type.toLowerCase() !== "bearer") ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new HostedAuthorizationError(
      "The sign-in service returned an invalid session.",
    );
  }
  return {
    accessToken: value.access_token,
    expiresAt: now() + value.expires_in * 1000,
  };
}

export function clearAuthorizationParameters(url: URL): string {
  const cleaned = new URL(url);
  for (const parameter of ["code", "state", "error", "error_description"]) {
    cleaned.searchParams.delete(parameter);
  }
  return `${cleaned.pathname}${cleaned.search}${cleaned.hash}`;
}

export function metadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath =
    url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

function consumePending(state: string | null, storage: Storage): string {
  const encoded = storage.getItem(pendingKey);
  storage.removeItem(pendingKey);
  if (encoded === null || state === null) {
    throw new HostedAuthorizationError(
      "The sign-in response did not match this tab.",
    );
  }
  let pending: unknown;
  try {
    pending = JSON.parse(encoded);
  } catch {
    throw new HostedAuthorizationError(
      "The sign-in response did not match this tab.",
    );
  }
  if (
    !isRecord(pending) ||
    pending.state !== state ||
    typeof pending.verifier !== "string"
  ) {
    throw new HostedAuthorizationError(
      "The sign-in response did not match this tab.",
    );
  }
  return pending.verifier;
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function secureUrl(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HostedAuthorizationError(`The sign-in ${field} is invalid.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostedAuthorizationError(`The sign-in ${field} is invalid.`);
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    )
  ) {
    throw new HostedAuthorizationError(`The sign-in ${field} must use HTTPS.`);
  }
  return url.href;
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function requireIssuerOrigin(
  issuer: string,
  endpoint: string,
  field: string,
): void {
  if (new URL(endpoint).origin !== new URL(issuer).origin) {
    throw new HostedAuthorizationError(
      `The sign-in ${field} must use the issuer's origin.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
