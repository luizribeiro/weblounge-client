import { connectionOverview } from "../../engine/connection-state";
import type { NetworkProjection } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "./Sidebar.module.css";

interface SidebarFooterProps {
  readonly networks: readonly NetworkProjection[];
  readonly onOpenSettings: () => void;
  readonly settingsTooltip: string;
}

export function SidebarFooter(props: SidebarFooterProps) {
  const connection = () => connectionOverview(props.networks);
  return (
    <footer class={styles.footer}>
      <span
        aria-hidden="true"
        class={styles.userDot}
        data-connection-color={connection().colorToken}
        data-connection-indicator="account"
      />
      <div class={styles.userIdentity}>
        <Line class={styles.nickname}>
          {props.networks[0]?.nickname ?? "Offline"}
        </Line>
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
