import type { DeploymentConfig } from "../engine/generated/DeploymentConfig";

export class DeploymentConfigError extends Error {
  constructor(message: string) {
    super(`This deployment is misconfigured. Invalid /config.json: ${message}`);
    this.name = "DeploymentConfigError";
  }
}

export async function loadDeploymentConfig(
  fetchConfig: typeof fetch = fetch,
  requireExplicitConfig = import.meta.env.PROD,
): Promise<DeploymentConfig> {
  let response: Response;
  try {
    response = await fetchConfig("/config.json", {
      cache: "no-cache",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new DeploymentConfigError("could not be loaded");
  }
  const missingConfig =
    response.status === 404 ||
    response.headers.get("Content-Type")?.includes("text/html");
  if (missingConfig && requireExplicitConfig) {
    throw new DeploymentConfigError(
      'expected an explicit {"mode":"app"} or hosted configuration',
    );
  }
  if (missingConfig) {
    return { mode: "app" };
  }
  if (!response.ok) {
    throw new DeploymentConfigError(`server returned ${response.status}`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DeploymentConfigError("response is not JSON");
  }
  return decodeDeploymentConfig(value);
}

export function decodeDeploymentConfig(value: unknown): DeploymentConfig {
  const root = record(value, "top level");
  if (root.mode === "app") {
    exactKeys(root, ["mode"], "app configuration");
    return { mode: "app" };
  }
  if (root.mode !== "hosted") {
    throw new DeploymentConfigError('"mode" must be "app" or "hosted"');
  }
  exactKeys(root, ["mode", "network", "oauth"], "hosted configuration");
  const network = record(root.network, '"network"');
  exactKeys(network, ["name", "endpoint", "autojoin"], '"network"');
  const oauth = record(root.oauth, '"oauth"');
  exactKeys(oauth, ["issuer", "client_id", "redirect_uri"], '"oauth"');

  const name = nonemptyString(network.name, '"network.name"');
  const endpoint = webSocketUrl(network.endpoint, '"network.endpoint"');
  const autojoin = stringArray(network.autojoin, '"network.autojoin"');
  if (autojoin.some((channel) => channel.length === 0)) {
    throw new DeploymentConfigError('"network.autojoin" has an empty channel');
  }
  const issuer = issuerUrl(oauth.issuer);
  const clientId = nonemptyString(oauth.client_id, '"oauth.client_id"');
  const redirectUri = redirectUrl(oauth.redirect_uri);

  return {
    mode: "hosted",
    network: { name, endpoint, autojoin },
    oauth: { issuer, client_id: clientId, redirect_uri: redirectUri },
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeploymentConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const extras = Object.keys(value).filter((key) => !expected.includes(key));
  if (extras.length > 0) {
    throw new DeploymentConfigError(
      `${field} has unknown field "${extras[0]}"`,
    );
  }
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DeploymentConfigError(`${field} must be a nonempty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DeploymentConfigError(`${field} must be an array of strings`);
  }
  return value;
}

function webSocketUrl(value: unknown, field: string): string {
  const url = parsedUrl(value, field);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url))) {
    throw new DeploymentConfigError(`${field} must use wss`);
  }
  return url.href;
}

function issuerUrl(value: unknown): string {
  const url = parsedUrl(value, '"oauth.issuer"');
  if (url.search !== "" || url.hash !== "") {
    throw new DeploymentConfigError(
      '"oauth.issuer" cannot have a query or fragment',
    );
  }
  requireSecure(url, '"oauth.issuer"');
  return trimTrailingSlash(url.href);
}

function redirectUrl(value: unknown): string {
  const url = parsedUrl(value, '"oauth.redirect_uri"');
  if (url.hash !== "") {
    throw new DeploymentConfigError(
      '"oauth.redirect_uri" cannot have a fragment',
    );
  }
  requireSecure(url, '"oauth.redirect_uri"');
  return url.href;
}

function parsedUrl(value: unknown, field: string): URL {
  if (typeof value !== "string") {
    throw new DeploymentConfigError(`${field} must be a URL`);
  }
  try {
    return new URL(value);
  } catch {
    throw new DeploymentConfigError(`${field} must be a URL`);
  }
}

function requireSecure(url: URL, field: string): void {
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopback(url))
  ) {
    throw new DeploymentConfigError(`${field} must use https`);
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
