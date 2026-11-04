import { describe, expect, it, vi } from "vitest";
import type { DeploymentConfig } from "../engine/generated/DeploymentConfig";
import {
  clientMinBuildReloadKey,
  clientResetTokenKey,
  HostedEmergencySwitch,
  runningBuildIsOlder,
} from "./emergency-switch";

describe("hosted emergency switch", () => {
  it("orders builds by their decimal timestamp", () => {
    expect(runningBuildIsOlder("1793768399", "1793768400")).toBe(true);
    expect(runningBuildIsOlder("1793768400", "1793768400")).toBe(false);
    expect(runningBuildIsOlder("1793768401", "1793768400")).toBe(false);
    expect(
      runningBuildIsOlder("99999999999999999999", "100000000000000000000"),
    ).toBe(true);
  });

  it("requests one current-build navigation per tab launch", async () => {
    const harness = createHarness();
    const config = hostedConfig({ min_build: "101" });

    await expect(harness.emergency.evaluate(config)).resolves.toBe(true);
    expect(harness.prepareUpdate).toHaveBeenCalledOnce();
    expect(harness.clearShell).not.toHaveBeenCalled();
    expect(harness.sessionStorage.getItem(clientMinBuildReloadKey)).toBe(
      "attempted",
    );
    expect(new URL(harness.navigate.mock.calls[0]?.[0] ?? "").search).toBe(
      "?view=chat&_weblounge_reload=nonce",
    );

    const nextLoad = createHarness({
      deviceStorage: harness.deviceStorage,
      sessionStorage: harness.sessionStorage,
    });
    await expect(nextLoad.emergency.evaluate(config)).resolves.toBe(false);
    expect(nextLoad.navigate).not.toHaveBeenCalled();
  });

  it("clears the shell once for each reset token", async () => {
    const harness = createHarness();
    const first = hostedConfig({ min_build: "101", reset_token: "one" });

    await expect(harness.emergency.evaluate(first)).resolves.toBe(true);
    expect(harness.clearShell).toHaveBeenCalledOnce();
    expect(harness.prepareUpdate).not.toHaveBeenCalled();
    expect(harness.deviceStorage.getItem(clientResetTokenKey)).toBe("one");
    expect(harness.sessionStorage.getItem(clientMinBuildReloadKey)).toBe(
      "attempted",
    );

    const sameToken = createHarness({
      deviceStorage: harness.deviceStorage,
      sessionStorage: harness.sessionStorage,
    });
    await expect(sameToken.emergency.evaluate(first)).resolves.toBe(false);
    expect(sameToken.clearShell).not.toHaveBeenCalled();

    const changedToken = hostedConfig({ reset_token: "two" });
    await expect(sameToken.emergency.evaluate(changedToken)).resolves.toBe(
      true,
    );
    expect(sameToken.clearShell).toHaveBeenCalledOnce();
  });

  it("waits for an interactive page to become hidden", async () => {
    const pageDocument = new TestDocument(false);
    const harness = createHarness({ pageDocument });

    await expect(
      harness.emergency.evaluate(hostedConfig({ min_build: "101" })),
    ).resolves.toBe(false);
    expect(harness.navigate).not.toHaveBeenCalled();

    pageDocument.visibilityState = "hidden";
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(harness.navigate).toHaveBeenCalledOnce());
  });

  it("does not act when its loop marker cannot be persisted", async () => {
    const unavailable = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };
    const harness = createHarness({
      deviceStorage: unavailable,
      sessionStorage: unavailable,
    });

    await expect(
      harness.emergency.evaluate(
        hostedConfig({ min_build: "101", reset_token: "one" }),
      ),
    ).resolves.toBe(false);
    expect(harness.navigate).not.toHaveBeenCalled();
  });
});

class TestDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  constructor(private readonly splash: boolean) {
    super();
  }

  querySelector(): Element | null {
    return this.splash ? document.createElement("main") : null;
  }
}

function createHarness(
  overrides: {
    deviceStorage?: Pick<Storage, "getItem" | "setItem">;
    sessionStorage?: Pick<Storage, "getItem" | "setItem">;
    pageDocument?: TestDocument;
  } = {},
) {
  const deviceStorage = overrides.deviceStorage ?? memoryStorage();
  const sessionStorage = overrides.sessionStorage ?? memoryStorage();
  const pageDocument = overrides.pageDocument ?? new TestDocument(true);
  const clearShell = vi.fn(async () => {});
  const prepareUpdate = vi.fn(async () => {});
  const navigate = vi.fn<(url: string) => void>();
  return {
    clearShell,
    deviceStorage,
    emergency: new HostedEmergencySwitch({
      production: true,
      buildTimestamp: "100",
      deviceStorage,
      sessionStorage,
      document: pageDocument,
      clearShell,
      prepareUpdate,
      currentUrl: () => "https://beta.weblounge.org/?view=chat",
      navigate,
      nonce: () => "nonce",
    }),
    navigate,
    prepareUpdate,
    sessionStorage,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function hostedConfig(
  client: NonNullable<Extract<DeploymentConfig, { mode: "hosted" }>["client"]>,
): DeploymentConfig {
  return {
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
      session_token_endpoint:
        "https://members.weblounge.org/oauth/session-token",
    },
    client,
  };
}
