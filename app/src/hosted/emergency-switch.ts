import type { DeploymentConfig } from "../engine/generated/DeploymentConfig";
import { prepareProductionServiceWorkerUpdate } from "../service-worker";
import { clearWebAppShell } from "./reset-app";

export const clientResetTokenKey = "weblounge.client-reset-token.v1";
export const clientMinBuildReloadKey = "weblounge.client-min-build-reload.v1";
const emergencyReloadParameter = "_weblounge_reload";

type MarkerStorage = Pick<Storage, "getItem" | "setItem">;

interface RemediationDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
  querySelector(selectors: string): Element | null;
}

interface EmergencySwitchOptions {
  readonly production: boolean;
  readonly buildTimestamp: string;
  readonly deviceStorage: MarkerStorage;
  readonly sessionStorage: MarkerStorage;
  readonly document: RemediationDocument;
  readonly clearShell: () => Promise<void>;
  readonly prepareUpdate: () => Promise<void>;
  readonly currentUrl: () => string;
  readonly navigate: (url: string) => void;
  readonly nonce: () => string;
}

export function runningBuildIsOlder(
  runningBuild: string,
  minimumBuild: string,
): boolean {
  return BigInt(runningBuild) < BigInt(minimumBuild);
}

export class HostedEmergencySwitch {
  readonly #options: EmergencySwitchOptions;
  #scheduled = false;

  constructor(options: Partial<EmergencySwitchOptions> = {}) {
    this.#options = {
      production: import.meta.env.PROD,
      buildTimestamp: __BUILD_TIMESTAMP__,
      deviceStorage: localStorage,
      sessionStorage,
      document,
      clearShell: clearWebAppShell,
      prepareUpdate: prepareProductionServiceWorkerUpdate,
      currentUrl: () => window.location.href,
      navigate: (url) => window.location.replace(url),
      nonce: () => crypto.randomUUID(),
      ...options,
    };
  }

  async evaluate(config: DeploymentConfig): Promise<boolean> {
    if (
      !this.#options.production ||
      this.#scheduled ||
      config.mode !== "hosted" ||
      config.client === undefined
    ) {
      return false;
    }

    const reset = this.#claimReset(config.client.reset_token);
    const stale = this.#claimMinimumBuild(config.client.min_build);
    if (!reset && !stale) return false;
    this.#scheduled = true;

    const remediate = async () => {
      if (reset) await this.#options.clearShell();
      else await this.#options.prepareUpdate();
      const url = new URL(this.#options.currentUrl());
      url.searchParams.set(emergencyReloadParameter, this.#options.nonce());
      this.#options.navigate(url.href);
    };
    if (!safeToNavigate(this.#options.document)) {
      const onVisibilityChange = () => {
        if (this.#options.document.visibilityState !== "hidden") return;
        this.#options.document.removeEventListener(
          "visibilitychange",
          onVisibilityChange,
        );
        void remediate();
      };
      this.#options.document.addEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
      return false;
    }
    await remediate();
    return true;
  }

  #claimReset(resetToken: string | undefined): boolean {
    if (resetToken === undefined) return false;
    return claimChangedValue(
      this.#options.deviceStorage,
      clientResetTokenKey,
      resetToken,
    );
  }

  #claimMinimumBuild(minimumBuild: string | undefined): boolean {
    if (
      minimumBuild === undefined ||
      !runningBuildIsOlder(this.#options.buildTimestamp, minimumBuild)
    ) {
      return false;
    }
    return claimChangedValue(
      this.#options.sessionStorage,
      clientMinBuildReloadKey,
      "attempted",
    );
  }
}

export function stripEmergencyReloadParameter(browserWindow: Window): void {
  const url = new URL(browserWindow.location.href);
  if (!url.searchParams.has(emergencyReloadParameter)) return;
  url.searchParams.delete(emergencyReloadParameter);
  browserWindow.history.replaceState(browserWindow.history.state, "", url);
}

function safeToNavigate(pageDocument: RemediationDocument): boolean {
  return (
    pageDocument.visibilityState === "hidden" ||
    pageDocument.querySelector(
      "[data-initial-splash]:not([data-state='leaving'])",
    ) !== null
  );
}

function claimChangedValue(
  storage: MarkerStorage,
  key: string,
  value: string,
): boolean {
  try {
    if (storage.getItem(key) === value) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
