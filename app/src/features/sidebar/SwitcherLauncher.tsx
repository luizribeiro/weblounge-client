import { Show } from "solid-js";
import styles from "./SwitcherLauncher.module.css";

type SwitcherLauncherVariant = "button" | "icon";

export const SWITCHER_LAUNCHER_VARIANT: SwitcherLauncherVariant = "icon";

interface SwitcherLauncherProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly shortcut: string | undefined;
}

export function SwitcherLauncher(props: SwitcherLauncherProps) {
  const variant = (): SwitcherLauncherVariant => SWITCHER_LAUNCHER_VARIANT;
  const tooltip = () =>
    props.shortcut === undefined
      ? props.label
      : `${props.label} (${props.shortcut})`;
  return (
    <button
      aria-label={props.label}
      class={variant() === "icon" ? styles.iconButton : styles.button}
      data-switcher-launcher={variant()}
      onClick={props.onClick}
      title={tooltip()}
      type="button"
    >
      <svg aria-hidden="true" class={styles.icon} viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <Show when={variant() === "button"}>
        <span class={styles.label}>{props.label}…</span>
        <Show when={props.shortcut} keyed>
          {(shortcut) => <kbd>{shortcut}</kbd>}
        </Show>
      </Show>
    </button>
  );
}
