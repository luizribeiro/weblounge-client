import { describe, expect, it, vi } from "vitest";
import {
  DeploymentConfigError,
  decodeDeploymentConfig,
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

describe("deployment config", () => {
  it("decodes the beta hosted preset", () => {
    expect(decodeDeploymentConfig(hosted)).toEqual(hosted);
  });

  it.each([
    [
      {},
      'This deployment is misconfigured. Invalid /config.json: "mode" must be "app" or "hosted"',
    ],
    [
      { mode: "app", network: {} },
      'This deployment is misconfigured. Invalid /config.json: app configuration has unknown field "network"',
    ],
    [
      { ...hosted, extra: true },
      'This deployment is misconfigured. Invalid /config.json: hosted configuration has unknown field "extra"',
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
  ])("rejects malformed input", (value, message) => {
    expect(() => decodeDeploymentConfig(value)).toThrow(message);
  });

  it("requires an explicit config", async () => {
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(loadDeploymentConfig(missing)).rejects.toThrow(
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
    await expect(loadDeploymentConfig(spaFallback)).rejects.toThrow(
      "This deployment is misconfigured",
    );

    const appMode = vi.fn(async () => Response.json({ mode: "app" }));
    await expect(loadDeploymentConfig(appMode)).resolves.toEqual({
      mode: "app",
    });
  });

  it("reports config loading failures", async () => {
    const unavailable = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(loadDeploymentConfig(unavailable)).rejects.toBeInstanceOf(
      DeploymentConfigError,
    );

    const unreachable = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(loadDeploymentConfig(unreachable)).rejects.toThrow(
      "This deployment is misconfigured. Invalid /config.json: could not be loaded",
    );
  });
});
