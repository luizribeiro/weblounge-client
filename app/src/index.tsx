import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { installDensity } from "./density/density";
import type { DeploymentConfig } from "./engine/generated/DeploymentConfig";
import { AppErrorBoundary } from "./hosted/AppErrorBoundary";
import { loadDeploymentConfig } from "./hosted/deployment-config";
import { type HostedSession, OneShotAccessToken } from "./hosted/HostedSession";
import { HostedStatus } from "./hosted/HostedStatus";
import {
  consumeAuthorizationCallback,
  createAuthorizationUrl,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  HostedAuthorizationError,
} from "./hosted/oauth";
import { installPageZoomGuard } from "./page-zoom";
import "./styles/base.css";
import { installSystemTheme } from "./theme/theme-controller";

type HostedConfig = Extract<DeploymentConfig, { mode: "hosted" }>;

type BootstrapState =
  | { type: "starting"; message: string }
  | { type: "error"; message: string }
  | { type: "app" }
  | { type: "hosted"; config: HostedConfig; session: HostedSession };

interface BootstrapProps {
  readonly beforeReveal: () => Promise<void>;
  readonly onReady: () => void;
}

function Bootstrap(props: BootstrapProps) {
  const theme = installSystemTheme(document, window);
  const removeDensity = installDensity(document);
  const removePageZoomGuard = installPageZoomGuard(document);
  onCleanup(() => theme.dispose());
  onCleanup(removeDensity);
  onCleanup(removePageZoomGuard);
  const [state, setState] = createSignal<BootstrapState>({
    type: "starting",
    message: "Starting…",
  });

  onMount(() => void start());

  async function start(): Promise<void> {
    try {
      const config = await loadDeploymentConfig();
      if (config.mode === "app") {
        setState({ type: "app" });
        return;
      }
      requireCurrentRedirect(config);
      const authorization = consumeAuthorizationCallback(
        new URL(window.location.href),
      );
      const metadata = await discoverOAuthMetadata(config.oauth);
      if (authorization === null) {
        setState({ type: "starting", message: "Opening sign in…" });
        window.location.assign(
          await createAuthorizationUrl(metadata, config.oauth),
        );
        return;
      }
      const token = await exchangeAuthorizationCode(
        metadata,
        config.oauth,
        authorization,
      );
      setState({
        type: "hosted",
        config,
        session: {
          network: config.network,
          token: new OneShotAccessToken(token.accessToken, token.expiresAt),
        },
      });
    } catch (error: unknown) {
      setState({ type: "error", message: userFacingError(error) });
      await props.beforeReveal();
      props.onReady();
    }
  }

  async function restartAuthorization(config: HostedConfig): Promise<void> {
    setState({
      type: "starting",
      message: "Your session expired. Signing in again…",
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      const metadata = await discoverOAuthMetadata(config.oauth);
      window.location.assign(
        await createAuthorizationUrl(metadata, config.oauth),
      );
    } catch (error: unknown) {
      setState({ type: "error", message: userFacingError(error) });
    }
  }

  const content = () => {
    const current = state();
    switch (current.type) {
      case "starting":
        return <HostedStatus message={current.message} />;
      case "error":
        return <HostedStatus message={current.message} error />;
      case "app":
        return (
          <App beforeReveal={props.beforeReveal} onReady={props.onReady} />
        );
      case "hosted":
        return (
          <App
            beforeReveal={props.beforeReveal}
            hostedSession={current.session}
            onReady={props.onReady}
            onHostedAuthorizationRequired={() =>
              void restartAuthorization(current.config)
            }
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
  return "Couldn't start the app. Reload to try again.";
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("missing application root");
}

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
    status.dataset.error = "true";
    status.setAttribute("role", "alert");
    status.textContent = "Couldn't start weblounge. Reload to try again.";
  }, 15_000);

  return {
    beforeReveal: async () => {
      await fontReady;
    },
    onReady: () => {
      if (!active) return;
      active = false;
      window.clearTimeout(timeout);
      splash.setAttribute("aria-hidden", "true");
      splash.dataset.state = "leaving";
      const animations = splash.getAnimations();
      if (animations.length === 0) {
        splash.remove();
        return;
      }
      void Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(() => splash.remove());
    },
  };
}
