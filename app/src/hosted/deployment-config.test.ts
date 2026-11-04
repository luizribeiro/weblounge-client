import { describe, expect, it, vi } from "vitest";
import {
  DeploymentConfigUnavailableError,
  decodeDeploymentConfig,
  deploymentConfigCacheKey,
  deploymentConfigUnknownFields,
  loadDeploymentConfig,
} from "./deployment-config";

const hosted = {
  mode: "hosted",
  network: {
    name: "weblounge",
    endpoint: "wss://beta.weblounge.org/socket",
    autojoin: ["#lounge"],
  },
  oauth: {
    issuer: "https://members.weblounge.org",
    client_id: "weblounge-client",
    redirect_uri: "https://beta.weblounge.org/",
    session_token_endpoint: "https://members.weblounge.org/oauth/session-token",
  },
};

const relayVapid =
  "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";

describe("deployment config", () => {
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
  };

  it("decodes the beta hosted preset", () => {
    expect(decodeDeploymentConfig(hosted)).toEqual(hosted);
  });

  it("strictly decodes optional push configuration", () => {
    const configured = {
      ...hosted,
      push: {
        relay: "https://push.weblounge.org",
        relay_vapid: relayVapid,
      },
    };
    expect(decodeDeploymentConfig(configured)).toEqual(configured);
    expect(decodeDeploymentConfig(hosted)).not.toHaveProperty("push");
  });

  it("ignores and records unknown fields at every object level", () => {
    expect(
      decodeDeploymentConfig({
        ...hosted,
        future: true,
        network: { ...hosted.network, transport_hint: "webtransport" },
        oauth: { ...hosted.oauth, audience: "chat" },
        push: {
          relay: "https://push.weblounge.org",
          relay_vapid: relayVapid,
          urgency: "normal",
        },
      }),
    ).toEqual({
      ...hosted,
      push: {
        relay: "https://push.weblounge.org",
        relay_vapid: relayVapid,
      },
    });
    expect(decodeDeploymentConfig({ mode: "app", future: true })).toEqual({
      mode: "app",
    });
    expect(deploymentConfigUnknownFields()).toEqual(
      expect.arrayContaining([
        "app.future",
        "hosted.future",
        "network.transport_hint",
        "oauth.audience",
        "push.urgency",
      ]),
    );
  });

  it.each([
    [
      {},
      'This deployment is misconfigured. Invalid /config.json: "mode" must be "app" or "hosted"',
    ],
    [
      {
        ...hosted,
        network: { ...hosted.network, endpoint: "ws://example.com" },
      },
      'This deployment is misconfigured. Invalid /config.json: "network.endpoint" must use wss',
    ],
    [
      { ...hosted, oauth: { ...hosted.oauth, client_id: "" } },
      'This deployment is misconfigured. Invalid /config.json: "oauth.client_id" must be a nonempty string',
    ],
    [
      { ...hosted, oauth: { ...hosted.oauth, redirect_uri: "javascript:x" } },
      'This deployment is misconfigured. Invalid /config.json: "oauth.redirect_uri" must use https',
    ],
    [
      { ...hosted, oauth: { ...hosted.oauth, issuer: "not a URL" } },
      'This deployment is misconfigured. Invalid /config.json: "oauth.issuer" must be a URL',
    ],
    [
      {
        ...hosted,
        oauth: { ...hosted.oauth, session_token_endpoint: undefined },
      },
      'This deployment is misconfigured. Invalid /config.json: "oauth.session_token_endpoint" must be a URL',
    ],
    [
      {
        ...hosted,
        oauth: {
          ...hosted.oauth,
          session_token_endpoint: "https://tokens.example.test/session-token",
        },
      },
      'This deployment is misconfigured. Invalid /config.json: "oauth.session_token_endpoint" must use the issuer origin',
    ],
    [
      {
        ...hosted,
        push: {
          relay: "https://push.example.test/v1",
          relay_vapid: relayVapid,
        },
      },
      'This deployment is misconfigured. Invalid /config.json: "push.relay" must be an https origin',
    ],
    [
      {
        ...hosted,
        push: { relay: "http://push.example.test", relay_vapid: relayVapid },
      },
      'This deployment is misconfigured. Invalid /config.json: "push.relay" must be an https origin',
    ],
    [
      {
        ...hosted,
        push: { relay: "https://push.example.test", relay_vapid: "not-a-key" },
      },
      'This deployment is misconfigured. Invalid /config.json: "push.relay_vapid" must be a base64url P-256 public key',
    ],
  ])("rejects malformed input", (value, message) => {
    expect(() => decodeDeploymentConfig(value)).toThrow(message);
  });

  it("requires an explicit config", async () => {
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(loadDeploymentConfig(missing, storage())).rejects.toThrow(
      'expected an explicit {"mode":"app"} or hosted configuration',
    );
    expect(missing).toHaveBeenCalledWith(
      "/config.json",
      expect.objectContaining({
        cache: "no-cache",
        credentials: "same-origin",
      }),
    );

    const spaFallback = vi.fn(async () =>
      Response.json({}, { headers: { "Content-Type": "text/html" } }),
    );
    await expect(loadDeploymentConfig(spaFallback, storage())).rejects.toThrow(
      "This deployment is misconfigured",
    );

    const appMode = vi.fn(async () => Response.json({ mode: "app" }));
    await expect(loadDeploymentConfig(appMode, storage())).resolves.toEqual({
      mode: "app",
    });
  });

  it("reports config loading failures", async () => {
    const unavailable = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      loadDeploymentConfig(unavailable, storage()),
    ).rejects.toBeInstanceOf(DeploymentConfigUnavailableError);

    const serverFailure = vi.fn(async () => Response.json({}, { status: 503 }));
    await expect(
      loadDeploymentConfig(serverFailure, storage()),
    ).rejects.toBeInstanceOf(DeploymentConfigUnavailableError);

    const unreachable = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(loadDeploymentConfig(unreachable, storage())).rejects.toThrow(
      "Can't reach weblounge. Check your connection.",
    );
  });

  it("classifies a config timeout as unreachable", async () => {
    vi.useFakeTimers();
    const pending = loadDeploymentConfig(
      vi.fn(() => new Promise<Response>(() => {})),
      storage(),
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(
      DeploymentConfigUnavailableError,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    vi.useRealTimers();
  });

  it("starts from the last good config while revalidating it", async () => {
    const cache = storage();
    const firstFetch = vi.fn(async () => Response.json(hosted));
    await expect(loadDeploymentConfig(firstFetch, cache)).resolves.toEqual(
      hosted,
    );
    expect(cache.getItem(deploymentConfigCacheKey)).not.toBeNull();

    let finishRevalidation = (_response: Response) => {};
    const revalidation = new Promise<Response>((resolve) => {
      finishRevalidation = resolve;
    });
    const backgroundFetch = vi.fn(() => revalidation);
    await expect(loadDeploymentConfig(backgroundFetch, cache)).resolves.toEqual(
      hosted,
    );
    expect(backgroundFetch).toHaveBeenCalledOnce();

    finishRevalidation(Response.json({ mode: "app" }));
    await vi.waitFor(() =>
      expect(
        JSON.parse(cache.getItem(deploymentConfigCacheKey) ?? "null"),
      ).toEqual({ config: { mode: "app" }, schema: 1 }),
    );
  });

  it("restores validated push configuration from the cache", async () => {
    const cache = storage();
    const configured = {
      ...hosted,
      push: { relay: "https://push.weblounge.org", relay_vapid: relayVapid },
    };
    cache.setItem(
      deploymentConfigCacheKey,
      JSON.stringify({ config: configured, schema: 1 }),
    );
    await expect(
      loadDeploymentConfig(
        vi.fn(() => new Promise<Response>(() => {})),
        cache,
      ),
    ).resolves.toEqual(configured);
  });

  it("ignores corrupt cache records and keeps the last good config on failure", async () => {
    const cache = storage();
    cache.setItem(deploymentConfigCacheKey, "not json");
    const appMode = vi.fn(async () => Response.json({ mode: "app" }));
    await expect(loadDeploymentConfig(appMode, cache)).resolves.toEqual({
      mode: "app",
    });

    const unreachable = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(loadDeploymentConfig(unreachable, cache)).resolves.toEqual({
      mode: "app",
    });
    await vi.waitFor(() => expect(unreachable).toHaveBeenCalledOnce());
    expect(
      JSON.parse(cache.getItem(deploymentConfigCacheKey) ?? "null"),
    ).toEqual({ config: { mode: "app" }, schema: 1 });

    await expect(
      loadDeploymentConfig(
        vi.fn(async () => Response.json({ mode: "future" })),
        cache,
      ),
    ).resolves.toEqual({ mode: "app" });
    await vi.waitFor(() =>
      expect(
        JSON.parse(cache.getItem(deploymentConfigCacheKey) ?? "null"),
      ).toEqual({ config: { mode: "app" }, schema: 1 }),
    );
  });
});
