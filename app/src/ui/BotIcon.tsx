import { t } from "../strings";
import styles from "./BotIcon.module.css";

interface BotIconProps {
  readonly class?: string | undefined;
  readonly color: string;
}

export function BotIcon(props: BotIconProps) {
  return (
    <span
      aria-label={t("common.bot_icon")}
      class={`${styles.icon} ${props.class ?? ""}`}
      role="img"
      style={{ color: props.color }}
    />
  );
}
