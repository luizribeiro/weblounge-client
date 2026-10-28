import type { NetworkProjection } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "./Sidebar.module.css";

interface SidebarFooterProps {
  readonly networks: readonly NetworkProjection[];
  readonly onOpenSettings: () => void;
  readonly settingsTooltip: string;
}

export function SidebarFooter(props: SidebarFooterProps) {
  return (
    <footer class={styles.footer}>
      <span aria-hidden="true" class={styles.userDot} />
      <div class={styles.userIdentity}>
        <Line class={styles.nickname}>
          {props.networks[0]?.nickname ?? "Offline"}
        </Line>
        <Line class={styles.userStatus}>{footerStatus(props.networks)}</Line>
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
  if (
    networks.some(
      (network) =>
        network.state === "connecting" || network.state === "reconnecting",
    )
  ) {
    return "connecting";
  }
  return networks.some((network) => network.state === "online")
    ? "connected"
    : "offline";
}
