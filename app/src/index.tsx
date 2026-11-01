import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { installDensity } from "./density/density";
import { createEngineClient } from "./engine/createEngineClient";
import type { EngineClient } from "./engine/EngineClient";
import type { DeploymentConfig } from "./engine/generated/DeploymentConfig";
import { AppErrorBoundary } from "./hosted/AppErrorBoundary";
import { loadDeploymentConfig } from "./hosted/deployment-config";
import { type HostedSession, OneShotAccessToken } from "./hosted/HostedSession";
import { HostedStatus } from "./hosted/HostedStatus";
import {
  authorizationReturnPath,
  consumeAuthorizationCallback,
  createAuthorizationUrl,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  HostedAuthorizationError,
} from "./hosted/oauth";
import {
  requiresAuthorization,
  SessionTokenProvider,
} from "./hosted/session-token";
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
  | { type: "starting"; message: string }
  | { type: "error"; message: string; retryLabel: string }
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
}

function Bootstrap(props: BootstrapProps) {
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
    message: "Starting…",
  });
  let starting = false;

  onMount(() => void start());

  async function start(): Promise<void> {
    if (starting) return;
    starting = true;
    try {
      const config = await loadDeploymentConfig();
      if (config.mode === "app") {
        setState({
          type: "app",
          attempt: 1,
          engineClient: takePrewarmedEngineClient(),
        });
        return;
      }
      requireCurrentRedirect(config);
      const currentUrl = new URL(window.location.href);
      const authorization = consumeAuthorizationCallback(currentUrl);
      if (authorization === null) {
        try {
          const token = await new SessionTokenProvider(
            config.oauth.session_token_endpoint,
          ).acquire();
          setHostedState(config, token);
          return;
        } catch (error: unknown) {
          if (!requiresAuthorization(error)) throw error;
        }
        const metadata = await discoverOAuthMetadata(config.oauth);
        setState({ type: "starting", message: "Opening sign in…" });
        window.location.replace(
          await createAuthorizationUrl(
            metadata,
            config.oauth,
            authorizationReturnPath(currentUrl, window.location.origin),
          ),
        );
        return;
      }
      const metadata = await discoverOAuthMetadata(config.oauth);
      const token = await exchangeAuthorizationCode(
        metadata,
        config.oauth,
        authorization,
      );
      if (authorization.returnPath !== undefined) {
        history.replaceState(history.state, "", authorization.returnPath);
      }
      setHostedState(config, token);
    } catch (error: unknown) {
      setState({
        type: "error",
        message: userFacingError(error),
        retryLabel:
          error instanceof HostedAuthorizationError ? "Sign in again" : "Retry",
      });
      await Promise.resolve();
      await props.beforeReveal();
      props.onReady();
    } finally {
      starting = false;
    }
  }

  function setHostedState(
    config: HostedConfig,
    token: { readonly accessToken: string; readonly expiresAt: number },
  ): void {
    setState({
      type: "hosted",
      config,
      engineClient: takePrewarmedEngineClient(),
      session: {
        network: config.network,
        sessionTokenEndpoint: config.oauth.session_token_endpoint,
        token: new OneShotAccessToken(token.accessToken, token.expiresAt),
      },
    });
  }

  async function restartAuthorization(config: HostedConfig): Promise<void> {
    try {
      const metadata = await discoverOAuthMetadata(config.oauth);
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
      setState({
        type: "error",
        message: userFacingError(error),
        retryLabel: "Sign in again",
      });
    }
  }

  const content = () => {
    const current = state();
    switch (current.type) {
      case "starting":
        return <HostedStatus message={current.message} />;
      case "error":
        return (
          <HostedStatus
            message={current.message}
            error
            onRetry={() => void start()}
            retryLabel={current.retryLabel}
          />
        );
      case "app":
        return (
          <Show keyed when={current.attempt}>
            {(attempt) => (
              <App
                beforeReveal={props.beforeReveal}
                engineClient={current.engineClient}
                onReady={props.onReady}
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
          <App
            beforeReveal={props.beforeReveal}
            engineClient={current.engineClient}
            hostedSession={current.session}
            onReady={props.onReady}
            onHostedAuthorizationRequired={() =>
              void restartAuthorization(current.config)
            }
            onRetryStartup={() => void restartAuthorization(current.config)}
          />
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
    <Bootstrap beforeReveal={startup.beforeReveal} onReady={startup.onReady} />
  ),
  application,
);

function createStartupGate(splash: HTMLElement): BootstrapProps {
  let active = true;
  const fontReady = document.fonts
    .load("400 13px Inter", "Connecting to weblounge…")
    .catch(() => []);
  const timeout = window.setTimeout(() => {
    if (!active) return;
    active = false;
    const status = splash.querySelector<HTMLElement>("[data-splash-status]");
    if (status === null) return;
    status.textContent = "Still starting weblounge…";
  }, 15_000);

  return {
    beforeReveal: async () => {
      await fontReady;
    },
    onReady: () => {
      if (!active) return;
      active = false;
      window.clearTimeout(timeout);
      splash
        .querySelector<HTMLElement>("[data-splash-status]")
        ?.setAttribute("data-hidden", "true");
      splash.setAttribute("aria-hidden", "true");
      splash.dataset.state = "leaving";
      const animations = splash.getAnimations();
      if (animations.length === 0) {
        splash.remove();
        registerProductionServiceWorker();
        return;
      }
      void Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(() => {
        splash.remove();
        registerProductionServiceWorker();
      });
    },
  };
}
