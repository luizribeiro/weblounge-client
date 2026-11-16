import { type JSX, Show, splitProps } from "solid-js";
import { Line } from "../../ui/Line";
import styles from "./OmnibarRow.module.css";

interface OmnibarRowProps
  extends Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "class" | "onPointerDown" | "role" | "tabIndex" | "type"
  > {
  readonly leading: JSX.Element;
  readonly label: string;
  readonly emphasized?: boolean;
  readonly suffix?: string | undefined;
  readonly trailing?: JSX.Element;
}

export function OmnibarRow(props: OmnibarRowProps) {
  const [own, rest] = splitProps(props, [
    "leading",
    "label",
    "emphasized",
    "suffix",
    "trailing",
  ]);
  return (
    <button
      {...rest}
      class={styles.row}
      onPointerDown={(event) => event.preventDefault()}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <span aria-hidden="true" class={styles.leading} data-omnibar-leading>
        {own.leading}
      </span>
      <span class={styles.label}>
        <Line
          class={`${styles.name} ${own.emphasized === true ? styles.emphasized : ""}`}
          data-omnibar-name
        >
          {own.label}
        </Line>
        <Show when={own.suffix} keyed>
          {(suffix) => (
            <Line class={styles.suffix} data-omnibar-suffix>
              {suffix}
            </Line>
          )}
        </Show>
      </span>
      <span class={styles.slot} data-omnibar-slot>
        {own.trailing}
      </span>
    </button>
  );
}
