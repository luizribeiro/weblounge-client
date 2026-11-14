import { Show } from "solid-js";
import { HeaderIconButton, labelWithShortcut } from "../../ui/HeaderIconButton";
import { SearchIcon } from "../../ui/icons/SearchIcon";
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
  return (
    <Show
      fallback={
        <HeaderIconButton
          data-switcher-launcher="icon"
          label={props.label}
          onClick={props.onClick}
          shortcut={props.shortcut}
        >
          <SearchIcon />
        </HeaderIconButton>
      }
      when={variant() === "button"}
    >
      <button
        aria-label={props.label}
        class={styles.button}
        data-switcher-launcher="button"
        onClick={props.onClick}
        title={labelWithShortcut(props.label, props.shortcut)}
        type="button"
      >
        <SearchIcon class={styles.icon} />
        <span class={styles.label}>{props.label}…</span>
        <Show when={props.shortcut} keyed>
          {(shortcut) => <kbd>{shortcut}</kbd>}
        </Show>
      </button>
    </Show>
  );
}
