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
  },
};

describe("deployment config", () => {
  it("decodes the beta hosted preset", () => {
    expect(decodeDeploymentConfig(hosted)).toEqual(hosted);
  });

  it.each([
    [{}, '"mode" must be'],
    [{ mode: "app", network: {} }, "unknown field"],
    [{ ...hosted, extra: true }, "unknown field"],
    [
      {
        ...hosted,
        network: { ...hosted.network, endpoint: "ws://example.com" },
      },
      "must use wss",
    ],
    [
      { ...hosted, oauth: { ...hosted.oauth, client_id: "" } },
      "nonempty string",
    ],
    [
      { ...hosted, oauth: { ...hosted.oauth, redirect_uri: "javascript:x" } },
      "must use https",
    ],
  ])("rejects malformed input", (value, message) => {
    expect(() => decodeDeploymentConfig(value)).toThrow(message);
  });

  it("allows a missing config only outside production", async () => {
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(loadDeploymentConfig(missing, false)).resolves.toEqual({
      mode: "app",
    });
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
    await expect(loadDeploymentConfig(spaFallback, false)).resolves.toEqual({
      mode: "app",
    });
  });

  it("requires an explicit config in production", async () => {
    for (const response of [
      new Response(null, { status: 404 }),
      Response.json({}, { headers: { "Content-Type": "text/html" } }),
    ]) {
      await expect(
        loadDeploymentConfig(
          vi.fn(async () => response),
          true,
        ),
      ).rejects.toThrow("This deployment is misconfigured");
    }

    const appMode = vi.fn(async () => Response.json({ mode: "app" }));
    await expect(loadDeploymentConfig(appMode, true)).resolves.toEqual({
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
