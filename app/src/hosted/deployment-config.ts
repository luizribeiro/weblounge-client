import type { DeploymentConfig } from "../engine/generated/DeploymentConfig";
import { withStartupDeadline } from "./startup-deadline";
import { startupStrings } from "./strings";

export const deploymentConfigCacheKey = "weblounge.deployment-config.v1";
const unknownFields = new Set<string>();

interface CachedDeploymentConfig {
  readonly config: DeploymentConfig;
  readonly schema: 1;
}

type ConfigStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class DeploymentConfigUnavailableError extends Error {
  constructor() {
    super(startupStrings.unreachable);
    this.name = "DeploymentConfigUnavailableError";
  }
}

export class DeploymentConfigError extends Error {
  constructor(message: string) {
    super(`${startupStrings.misconfigured} Invalid /config.json: ${message}`);
    this.name = "DeploymentConfigError";
  }
}

export async function loadDeploymentConfig(
  fetchConfig: typeof fetch = fetch,
  storage: ConfigStorage = localStorage,
  onRevalidated: (config: DeploymentConfig) => void = () => {},
): Promise<DeploymentConfig> {
  const cached = readCachedDeploymentConfig(storage);
  if (cached !== undefined) {
    void fetchDeploymentConfig(fetchConfig)
      .then((config) => {
        writeCachedDeploymentConfig(storage, config);
        onRevalidated(config);
      })
      .catch(() => undefined);
    return cached;
  }
  const config = await fetchDeploymentConfig(fetchConfig);
  writeCachedDeploymentConfig(storage, config);
  return config;
}

async function fetchDeploymentConfig(
  fetchConfig: typeof fetch,
): Promise<DeploymentConfig> {
  let response: Response;
  try {
    response = await withStartupDeadline(
      (signal) =>
        fetchConfig("/config.json", {
          cache: "no-cache",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        }),
      () => new DeploymentConfigUnavailableError(),
    );
  } catch (error: unknown) {
    if (
      error instanceof DeploymentConfigError ||
      error instanceof DeploymentConfigUnavailableError
    ) {
      throw error;
    }
    throw new DeploymentConfigUnavailableError();
  }
  const missingConfig =
    response.status === 404 ||
    response.headers.get("Content-Type")?.includes("text/html");
  if (missingConfig) {
    throw new DeploymentConfigError(
      'expected an explicit {"mode":"app"} or hosted configuration',
    );
  }
  if (!response.ok) {
    if (response.status >= 500) throw new DeploymentConfigUnavailableError();
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

function readCachedDeploymentConfig(
  storage: ConfigStorage,
): DeploymentConfig | undefined {
  try {
    const encoded = storage.getItem(deploymentConfigCacheKey);
    if (encoded === null) return undefined;
    const value: unknown = JSON.parse(encoded);
    if (
      typeof value !== "object" ||
      value === null ||
      !("schema" in value) ||
      value.schema !== 1 ||
      !("config" in value)
    ) {
      storage.removeItem(deploymentConfigCacheKey);
      return undefined;
    }
    return decodeDeploymentConfig(value.config);
  } catch {
    try {
      storage.removeItem(deploymentConfigCacheKey);
    } catch {
      // Storage is an optional startup optimization.
    }
    return undefined;
  }
}

function writeCachedDeploymentConfig(
  storage: ConfigStorage,
  config: DeploymentConfig,
): void {
  const cached: CachedDeploymentConfig = { config, schema: 1 };
  try {
    storage.setItem(deploymentConfigCacheKey, JSON.stringify(cached));
  } catch {
    // Storage is an optional startup optimization.
  }
}

export function decodeDeploymentConfig(value: unknown): DeploymentConfig {
  const root = record(value, "top level");
  if (root.mode === "app") {
    recordUnknownFields(root, ["mode"], "app");
    return { mode: "app" };
  }
  if (root.mode !== "hosted") {
    throw new DeploymentConfigError('"mode" must be "app" or "hosted"');
  }
  recordUnknownFields(root, ["mode", "network", "oauth", "push"], "hosted");
  const network = record(root.network, '"network"');
  recordUnknownFields(network, ["name", "endpoint", "autojoin"], "network");
  const oauth = record(root.oauth, '"oauth"');
  recordUnknownFields(
    oauth,
    ["issuer", "client_id", "redirect_uri", "session_token_endpoint"],
    "oauth",
  );

  const name = nonemptyString(network.name, '"network.name"');
  const endpoint = webSocketUrl(network.endpoint, '"network.endpoint"');
  const autojoin = stringArray(network.autojoin, '"network.autojoin"');
  if (autojoin.some((channel) => channel.length === 0)) {
    throw new DeploymentConfigError('"network.autojoin" has an empty channel');
  }
  const issuer = issuerUrl(oauth.issuer);
  const clientId = nonemptyString(oauth.client_id, '"oauth.client_id"');
  const redirectUri = redirectUrl(oauth.redirect_uri);
  const sessionTokenEndpoint = sessionTokenUrl(
    oauth.session_token_endpoint,
    issuer,
  );
  const push = root.push === undefined ? undefined : pushConfig(root.push);

  return {
    mode: "hosted",
    network: { name, endpoint, autojoin },
    oauth: {
      issuer,
      client_id: clientId,
      redirect_uri: redirectUri,
      session_token_endpoint: sessionTokenEndpoint,
    },
    ...(push === undefined ? {} : { push }),
  };
}

function pushConfig(value: unknown): { relay: string; relay_vapid: string } {
  const push = record(value, '"push"');
  recordUnknownFields(push, ["relay", "relay_vapid"], "push");
  return {
    relay: httpsOrigin(push.relay, '"push.relay"'),
    relay_vapid: p256PublicKey(push.relay_vapid, '"push.relay_vapid"'),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeploymentConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function recordUnknownFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value))
    if (!expected.includes(key)) unknownFields.add(`${field}.${key}`);
}

export function deploymentConfigUnknownFields(): readonly string[] {
  return [...unknownFields].sort();
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

function sessionTokenUrl(value: unknown, issuer: string): string {
  const url = parsedUrl(value, '"oauth.session_token_endpoint"');
  if (url.hash !== "") {
    throw new DeploymentConfigError(
      '"oauth.session_token_endpoint" cannot have a fragment',
    );
  }
  requireSecure(url, '"oauth.session_token_endpoint"');
  if (url.origin !== new URL(issuer).origin) {
    throw new DeploymentConfigError(
      '"oauth.session_token_endpoint" must use the issuer origin',
    );
  }
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

function httpsOrigin(value: unknown, field: string): string {
  const url = parsedUrl(value, field);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new DeploymentConfigError(`${field} must be an https origin`);
  }
  return url.origin;
}

function p256PublicKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DeploymentConfigError(
      `${field} must be a base64url P-256 public key`,
    );
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw new DeploymentConfigError(
      `${field} must be a base64url P-256 public key`,
    );
  }
  if (bytes.length !== 65 || bytes[0] !== 4 || !isP256Point(bytes)) {
    throw new DeploymentConfigError(
      `${field} must be a base64url P-256 public key`,
    );
  }
  return value;
}

function isP256Point(bytes: Uint8Array): boolean {
  const prime = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n;
  const curveB =
    0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  const coordinate = (start: number) =>
    bytes
      .slice(start, start + 32)
      .reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  const x = coordinate(1);
  const y = coordinate(33);
  if (x >= prime || y >= prime) return false;
  const left = (y * y) % prime;
  const right = (((x * x) % prime) * x - 3n * x + curveB) % prime;
  return left === (right + prime) % prime;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
