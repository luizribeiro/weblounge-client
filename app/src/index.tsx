import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { installDensity } from "./density/density";
import type { DeploymentConfig } from "./engine/generated/DeploymentConfig";
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
import "./styles/base.css";
import { installSystemTheme } from "./theme/theme-controller";

type HostedConfig = Extract<DeploymentConfig, { mode: "hosted" }>;

type BootstrapState =
  | { type: "starting"; message: string }
  | { type: "error"; message: string }
  | { type: "app" }
  | { type: "hosted"; config: HostedConfig; session: HostedSession };

function Bootstrap() {
  const theme = installSystemTheme(document, window);
  const removeDensity = installDensity(document);
  onCleanup(() => theme.dispose());
  onCleanup(removeDensity);
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

  const content = createMemo(() => {
    const current = state();
    switch (current.type) {
      case "starting":
        return <HostedStatus message={current.message} />;
      case "error":
        return <HostedStatus message={current.message} error />;
      case "app":
        return <App />;
      case "hosted":
        return (
          <App
            hostedSession={current.session}
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
  });
  return <>{content()}</>;
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

root.replaceChildren();
render(() => <Bootstrap />, root);
