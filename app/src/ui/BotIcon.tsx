import { t } from "../strings";
import styles from "./BotIcon.module.css";

interface BotIconProps {
  readonly class?: string | undefined;
  readonly color: string;
}

export function BotIcon(props: BotIconProps) {
  return (
    <svg
      aria-label={t("common.bot_icon")}
      class={`${styles.icon} ${props.class ?? ""}`}
      fill="none"
      role="img"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      style={{ color: props.color }}
      viewBox="0 0 24 24"
    >
      <path d="M12 8V4H8" />
      <rect height="12" rx="2" width="16" x="4" y="8" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  );
}
