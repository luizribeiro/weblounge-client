import { connectionStateKind } from "../../engine/connection-state";
import type { NetworkProjection } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "./Sidebar.module.css";

interface SidebarFooterProps {
  readonly networks: readonly NetworkProjection[];
  readonly onOpenSettings: () => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly settingsTooltip: string;
}

export function SidebarFooter(props: SidebarFooterProps) {
  const failedNetwork = () =>
    props.networks.find(
      (network) => connectionStateKind(network.state) === "failed",
    );
  return (
    <footer class={styles.footer}>
      <span aria-hidden="true" class={styles.userDot} />
      <div class={styles.userIdentity}>
        <Line class={styles.nickname}>
          {props.networks[0]?.nickname ?? "Offline"}
        </Line>
        {failedNetwork() !== undefined ? (
          <button
            class={styles.retry}
            onClick={() => props.onRetryNetwork?.(failedNetwork()?.id ?? 0)}
            type="button"
          >
            Offline · Retry
          </button>
        ) : footerStatus(props.networks) !== "" ? (
          <Line class={styles.userStatus}>{footerStatus(props.networks)}</Line>
        ) : null}
      </div>
      <button
        aria-label="Settings"
        class={styles.settings}
        onClick={props.onOpenSettings}
        title={props.settingsTooltip}
        type="button"
      >
        <span aria-hidden="true">⚙</span>
      </button>
    </footer>
  );
}

export function footerStatus(networks: readonly NetworkProjection[]): string {
  const states = networks.map((network) => connectionStateKind(network.state));
  if (states.includes("reconnecting")) return "Reconnecting…";
  if (states.includes("connecting") || states.includes("registering"))
    return "Connecting…";
  if (states.includes("failed")) return "Offline · Retry";
  if (states.includes("offline") || networks.length === 0) return "Offline";
  return "";
}
