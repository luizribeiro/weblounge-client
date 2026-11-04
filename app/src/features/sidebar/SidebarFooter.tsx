import type { NetworkProjection } from "../../engine/protocol";
import { t } from "../../strings";
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
      <div class={styles.userIdentity}>
        <Line class={styles.nickname}>
          {props.networks[0]?.nickname ?? t("common.weblounge")}
        </Line>
      </div>
      <button
        aria-label={t("sidebar.settings")}
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
