import { describe, expect, it } from "vitest";
import type { DeploymentConfig } from "../engine/generated/DeploymentConfig";
import { appTitle, deploymentChannel } from "./release-channel";

const hosted: DeploymentConfig = {
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

describe("release channel", () => {
  it("is the hosted config's channel when it names one", () => {
    expect(deploymentChannel({ ...hosted, channel: "beta" })).toBe("beta");
    expect(deploymentChannel({ ...hosted, channel: "release" })).toBe(
      "release",
    );
  });

  it("is release when the host names none", () => {
    expect(deploymentChannel(hosted)).toBe("release");
    expect(deploymentChannel({ mode: "app" })).toBe("release");
  });

  it("marks only beta's title", () => {
    expect(appTitle("beta")).toBe("weblounge β");
    expect(appTitle("release")).toBe("weblounge");
  });
});
