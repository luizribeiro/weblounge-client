import { type JSX, splitProps } from "solid-js";
import { t } from "../strings";
import styles from "./BotIcon.module.css";
import primitives from "./primitives.module.css";

interface BotIconProps
  extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly class?: string | undefined;
  readonly color?: string | undefined;
}

export function BotIcon(props: BotIconProps) {
  const [own, rest] = splitProps(props, ["class", "color"]);
  return (
    <span
      {...rest}
      aria-label={t("common.bot_icon")}
      class={`${styles.icon} ${primitives.textMark} ${own.class ?? ""}`}
      role="img"
      style={own.color === undefined ? undefined : { color: own.color }}
    />
  );
}
