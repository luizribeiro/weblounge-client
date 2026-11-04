import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { exposeBuildVersion } from "./build-version";
import { installDensity } from "./density/density";
import { createEngineClient } from "./engine/createEngineClient";
import type { EngineClient } from "./engine/EngineClient";
import type { DeploymentConfig } from "./engine/generated/DeploymentConfig";
import { AppErrorBoundary } from "./hosted/AppErrorBoundary";
import {
  DeploymentConfigUnavailableError,
  loadDeploymentConfig,
} from "./hosted/deployment-config";
import { type HostedSession, OneShotAccessToken } from "./hosted/HostedSession";
import {
  authorizationReturnPath,
  consumeAuthorizationCallback,
  createAuthorizationUrl,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  HostedAuthorizationError,
  type OAuthMetadata,
} from "./hosted/oauth";
import {
  requiresAuthorization,
  type SessionAccessToken,
  SessionTokenProvider,
} from "./hosted/session-token";
import { withStartupDeadline } from "./hosted/startup-deadline";
import {
  installPlatformEnvironment,
  platformEnvironment,
} from "./platform/environment";
import "./platform/platform.css";
import { installPageZoomGuard } from "./page-zoom";
import { installRequestedDebugOverlays } from "./platform/debug-overlays";
import { registerProductionServiceWorker } from "./service-worker";
import "./styles/base.css";
import { installTheme } from "./theme/theme-controller";

type HostedConfig = Extract<DeploymentConfig, { mode: "hosted" }>;
type InitialSessionResult =
  | { readonly type: "token"; readonly token: SessionAccessToken }
  | { readonly type: "error"; readonly error: unknown };
type InitialMetadataResult =
  | { readonly type: "metadata"; readonly metadata: OAuthMetadata }
  | { readonly type: "error"; readonly error: unknown };

type DeploymentAttempt =
  | {
      readonly type: "app";
      readonly config: Extract<DeploymentConfig, { mode: "app" }>;
    }
  | {
      readonly type: "hosted";
      readonly config: HostedConfig;
      readonly metadata: Promise<InitialMetadataResult>;
    };

let prewarmedEngine:
  | { readonly type: "client"; readonly client: EngineClient }
  | { readonly type: "error"; readonly error: unknown }
  | undefined;
try {
  prewarmedEngine = { type: "client", client: createEngineClient() };
} catch (error: unknown) {
  prewarmedEngine = { type: "error", error };
}

type BootstrapState =
  | { type: "starting" }
  | { type: "app"; attempt: number; engineClient: EngineClient }
  | {
      type: "hosted";
      config: HostedConfig;
      session: HostedSession;
      engineClient: EngineClient;
    };

interface BootstrapProps {
  readonly beforeReveal: () => Promise<void>;
  readonly onReady: () => void;
  readonly showError: (
    message: string,
    retryLabel: string,
    retry: () => void,
    retryWhenReachable: boolean,
  ) => void;
}

function Bootstrap(props: BootstrapProps) {
  const [revalidatedConfig, setRevalidatedConfig] =
    createSignal<DeploymentConfig>();
  let deploymentAttempt: Promise<DeploymentAttempt> | undefined =
    loadDeploymentAttempt(setRevalidatedConfig);
  const platform = platformEnvironment();
  const theme = installTheme(document, platform.prefersDark());
  const removeDensity = installDensity(document);
  const removePageZoomGuard = installPageZoomGuard(document);
  createEffect(() => theme.setSystemDark(platform.prefersDark()));
  onCleanup(() => theme.dispose());
  onCleanup(removeDensity);
  onCleanup(removePageZoomGuard);
  const [state, setState] = createSignal<BootstrapState>({
    type: "starting",
  });
  let starting = false;
  let authorizing = false;

  onMount(() => void start());

  async function start(): Promise<void> {
    if (starting) return;
    starting = true;
    try {
      const attempt =
        deploymentAttempt ?? loadDeploymentAttempt(setRevalidatedConfig);
      deploymentAttempt = undefined;
      const deployment = await attempt;
      if (deployment.type === "app") {
        setState({
          type: "app",
          attempt: 1,
          engineClient: takePrewarmedEngineClient(),
        });
        return;
      }
      const { config } = deployment;
      requireCurrentRedirect(config);
      setHostedState(
        config,
        acquireInitialAccessToken(config, deployment.metadata),
      );
    } catch (error: unknown) {
      const message = userFacingError(error);
      console.error(`[weblounge startup] ${message}`);
      props.showError(
        message,
        error instanceof HostedAuthorizationError ? "Sign in again" : "Retry",
        () => void start(),
        error instanceof DeploymentConfigUnavailableError,
      );
    } finally {
      starting = false;
    }
  }

  function setHostedState(
    config: HostedConfig,
    token: Promise<SessionAccessToken>,
  ): void {
    const engineClient = takePrewarmedEngineClient();
    let startupCancelled = false;
    const tokenResult = token.then(
      (value) => ({
        type: "token" as const,
        token: new OneShotAccessToken(value.accessToken, value.expiresAt),
      }),
      (error: unknown) => ({ type: "error" as const, error }),
    );
    void tokenResult.then(async (result) => {
      if (result.type === "error" && requiresAuthorization(result.error)) {
        startupCancelled = true;
        await engineClient.close().catch(() => undefined);
        void restartAuthorization(config);
      } else if (
        result.type === "error" &&
        result.error instanceof HostedAuthorizationError
      ) {
        props.showError(
          result.error.message,
          "Sign in again",
          () => void restartAuthorization(config),
          false,
        );
      }
    });
    setState({
      type: "hosted",
      config,
      engineClient,
      session: {
        network: config.network,
        sessionTokenEndpoint: config.oauth.session_token_endpoint,
        startupCancelled: () => startupCancelled,
        token: tokenResult,
      },
    });
  }

  function retryHosted(config: HostedConfig): void {
    const metadata = acquireInitialMetadata(config);
    setHostedState(config, acquireInitialAccessToken(config, metadata));
  }

  async function restartAuthorization(
    config: HostedConfig,
    prefetched?: Promise<InitialMetadataResult>,
  ): Promise<void> {
    if (authorizing) return;
    authorizing = true;
    try {
      const metadata =
        prefetched === undefined
          ? await discoverOAuthMetadata(config.oauth)
          : await acquireMetadata(prefetched);
      window.location.replace(
        await createAuthorizationUrl(
          metadata,
          config.oauth,
          authorizationReturnPath(
            new URL(window.location.href),
            window.location.origin,
          ),
        ),
      );
    } catch (error: unknown) {
      authorizing = false;
      const message = userFacingError(error);
      console.error(`[weblounge startup] ${message}`);
      props.showError(
        message,
        "Sign in again",
        () => void restartAuthorization(config),
        false,
      );
    }
  }

  const content = () => {
    const current = state();
    switch (current.type) {
      case "starting":
        return null;
      case "app":
        return (
          <Show keyed when={current.attempt}>
            {(attempt) => (
              <App
                beforeReveal={props.beforeReveal}
                engineClient={current.engineClient}
                onReady={props.onReady}
                onStartupError={(message, retry) =>
                  props.showError(
                    message,
                    "Retry",
                    retry ?? (() => void start()),
                    false,
                  )
                }
                onRetryStartup={() => {
                  setState({
                    type: "app",
                    attempt: attempt + 1,
                    engineClient: createEngineClient(),
                  });
                }}
              />
            )}
          </Show>
        );
      case "hosted":
        return (
          <Show keyed when={current.session}>
            {(session) => (
              <App
                beforeReveal={props.beforeReveal}
                engineClient={current.engineClient}
                hostedSession={session}
                pushConfig={livePushConfig(current.config, revalidatedConfig())}
                onReady={props.onReady}
                onStartupError={(message, retry) =>
                  props.showError(
                    message,
                    "Retry",
                    retry ?? (() => retryHosted(current.config)),
                    false,
                  )
                }
                onHostedAuthorizationRequired={() =>
                  void restartAuthorization(current.config)
                }
                onRetryStartup={() => retryHosted(current.config)}
              />
            )}
          </Show>
        );
      default: {
        const exhaustive: never = current;
        return exhaustive;
      }
    }
  };
  return <AppErrorBoundary>{content()}</AppErrorBoundary>;
}

function takePrewarmedEngineClient(): EngineClient {
  const warmed = prewarmedEngine;
  prewarmedEngine = undefined;
  if (warmed === undefined) return createEngineClient();
  if (warmed.type === "error") throw warmed.error;
  return warmed.client;
}

async function loadDeploymentAttempt(
  onRevalidated: (config: DeploymentConfig) => void,
): Promise<DeploymentAttempt> {
  const config = await loadDeploymentConfig(fetch, localStorage, onRevalidated);
  if (config.mode === "app") return { type: "app", config };
  requireCurrentRedirect(config);
  const metadata = acquireInitialMetadata(config);
  return { type: "hosted", config, metadata };
}

function livePushConfig(
  initial: HostedConfig,
  revalidated: DeploymentConfig | undefined,
): HostedConfig["push"] {
  if (
    revalidated?.mode !== "hosted" ||
    !sameHostedIdentity(initial, revalidated)
  ) {
    return initial.push;
  }
  return revalidated.push;
}

function sameHostedIdentity(left: HostedConfig, right: HostedConfig): boolean {
  return (
    left.network.name === right.network.name &&
    left.network.endpoint === right.network.endpoint &&
    left.network.autojoin.length === right.network.autojoin.length &&
    left.network.autojoin.every(
      (channel, index) => channel === right.network.autojoin[index],
    ) &&
    left.oauth.issuer === right.oauth.issuer &&
    left.oauth.client_id === right.oauth.client_id &&
    left.oauth.redirect_uri === right.oauth.redirect_uri &&
    left.oauth.session_token_endpoint === right.oauth.session_token_endpoint
  );
}

async function acquireInitialAccessToken(
  config: HostedConfig,
  metadata: Promise<InitialMetadataResult>,
): Promise<SessionAccessToken> {
  const currentUrl = new URL(window.location.href);
  const authorization = consumeAuthorizationCallback(currentUrl);
  if (authorization === null) {
    const result = await acquireSession(config.oauth.session_token_endpoint);
    if (result.type === "error") throw result.error;
    return result.token;
  }
  const token = await exchangeAuthorizationCode(
    await acquireMetadata(metadata),
    config.oauth,
    authorization,
  );
  if (authorization.returnPath !== undefined) {
    history.replaceState(history.state, "", authorization.returnPath);
  }
  return token;
}

function acquireInitialMetadata(
  config: HostedConfig,
): Promise<InitialMetadataResult> {
  return discoverOAuthMetadata(config.oauth).then(
    (metadata): InitialMetadataResult => ({ type: "metadata", metadata }),
    (error: unknown): InitialMetadataResult => ({ type: "error", error }),
  );
}

async function acquireMetadata(
  result: Promise<InitialMetadataResult>,
): Promise<OAuthMetadata> {
  const metadata = await result;
  if (metadata.type === "error") throw metadata.error;
  return metadata.metadata;
}

function acquireSession(endpoint: string): Promise<InitialSessionResult> {
  return new SessionTokenProvider(endpoint).acquire().then(
    (token): InitialSessionResult => ({ type: "token", token }),
    (error: unknown): InitialSessionResult => ({ type: "error", error }),
  );
}

function requireCurrentRedirect(config: HostedConfig): void {
  const expected = new URL("/", window.location.origin).href;
  if (config.oauth.redirect_uri !== expected) {
    throw new Error(
      `Invalid /config.json: "oauth.redirect_uri" must be ${expected}`,
    );
  }
}

function userFacingError(error: unknown): string {
  if (error instanceof HostedAuthorizationError || error instanceof Error) {
    return error.message;
  }
  return "Couldn't start the app.";
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("missing application root");
}

installPlatformEnvironment(root, window);
exposeBuildVersion(window);
installRequestedDebugOverlays(root, window);
const splash = root.querySelector<HTMLElement>("[data-initial-splash]");
if (splash === null) {
  throw new Error("missing initial splash");
}
const startup = createStartupGate(splash);
const application = document.createElement("div");
application.dataset.applicationMount = "true";
root.append(application);
render(
  () => (
    <Bootstrap
      beforeReveal={startup.beforeReveal}
      onReady={startup.onReady}
      showError={startup.showError}
    />
  ),
  application,
);
registerProductionServiceWorker();

function createStartupGate(splash: HTMLElement): BootstrapProps {
  let active = true;
  let retryOnRecovery: (() => void) | undefined;
  const fontReady = withStartupDeadline(
    () => document.fonts.load("400 13px Inter", "Starting weblounge…"),
    () => new Error("startup font did not load in time"),
    1_000,
  ).catch(() => []);
  const retryButton = splash.querySelector<HTMLButtonElement>(
    "[data-splash-retry]",
  );
  const status = splash.querySelector<HTMLElement>("[data-splash-status]");
  const retry = () => {
    const action = retryOnRecovery;
    retryOnRecovery = undefined;
    action?.();
  };
  const retryVisible = () => {
    if (document.visibilityState === "visible") retry();
  };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", retryVisible);

  return {
    beforeReveal: async () => {
      await fontReady;
    },
    onReady: () => {
      if (!active) return;
      active = false;
      retryOnRecovery = undefined;
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retryVisible);
      splash
        .querySelector<HTMLElement>("[data-splash-status]")
        ?.setAttribute("data-hidden", "true");
      splash.setAttribute("aria-hidden", "true");
      splash.dataset.state = "leaving";
      const animations = splash.getAnimations();
      if (animations.length === 0) {
        splash.remove();
        return;
      }
      void Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(() => {
        splash.remove();
      });
    },
    showError: (message, retryLabel, onRetry, retryWhenReachable) => {
      if (!active || status === null || retryButton === null) return;
      if (
        status.textContent === message &&
        retryButton.textContent === "Sign in again"
      ) {
        return;
      }
      status.dataset.error = "true";
      status.setAttribute("role", "alert");
      status.textContent = message;
      retryButton.textContent = retryLabel;
      retryButton.hidden = false;
      const beginRetry = () => {
        retryButton.hidden = true;
        status.removeAttribute("data-error");
        status.setAttribute("role", "status");
        status.textContent = "";
        const a11y = document.createElement("span");
        a11y.dataset.splashA11y = "true";
        a11y.textContent = "Starting weblounge…";
        const visible = document.createElement("span");
        visible.dataset.splashMessage = "true";
        visible.setAttribute("aria-hidden", "true");
        status.append(a11y, visible);
        onRetry();
      };
      retryButton.onclick = beginRetry;
      retryOnRecovery = retryWhenReachable ? beginRetry : undefined;
    },
  };
}
