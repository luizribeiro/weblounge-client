import { type JSX, splitProps } from "solid-js";
import styles from "./HeaderIconButton.module.css";

interface HeaderIconButtonProps {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly ariaKeyShortcuts?: string | undefined;
  readonly hasPopup?: "dialog" | undefined;
  readonly size?: "header" | "touch";
  readonly onClick: (event: MouseEvent) => void;
  readonly children: JSX.Element;
  readonly [data: `data-${string}`]: string | undefined;
}

export function HeaderIconButton(props: HeaderIconButtonProps) {
  const [local, data] = splitProps(props, [
    "label",
    "shortcut",
    "ariaKeyShortcuts",
    "hasPopup",
    "size",
    "onClick",
    "children",
  ]);
  return (
    <button
      {...data}
      aria-haspopup={local.hasPopup}
      aria-keyshortcuts={local.ariaKeyShortcuts}
      aria-label={local.label}
      class={styles.button}
      data-size={local.size ?? "header"}
      onClick={(event) => local.onClick(event)}
      title={labelWithShortcut(local.label, local.shortcut)}
      type="button"
    >
      {local.children}
    </button>
  );
}

export function labelWithShortcut(
  label: string,
  shortcut: string | undefined,
): string {
  return shortcut === undefined ? label : `${label} (${shortcut})`;
}
