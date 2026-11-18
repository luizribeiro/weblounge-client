import { type JSX, Show, splitProps } from "solid-js";
import type { ThemePreference } from "../engine/generated/ThemePreference";
import { createDocumentTheme } from "../theme/document-theme";
import { ChairFlip } from "./ChairFlip";
import styles from "./ChairMark.module.css";

type ChairMarkProps = JSX.HTMLAttributes<HTMLSpanElement>;

const flippableTheme = "ne" satisfies ThemePreference;

export function ChairMark(props: ChairMarkProps) {
  const theme = createDocumentTheme();

  return (
    <Show when={theme() === flippableTheme} fallback={<ChairTile {...props} />}>
      <ChairFlip
        class={props.class}
        front={(faceClass) => <ChairTile {...props} faceClass={faceClass} />}
      />
    </Show>
  );
}

function ChairTile(props: ChairMarkProps & { readonly faceClass?: string }) {
  const [local, attributes] = splitProps(props, [
    "class",
    "children",
    "faceClass",
  ]);

  return (
    <span
      aria-hidden="true"
      {...attributes}
      class={[styles.tile, local.class, local.faceClass]
        .filter(Boolean)
        .join(" ")}
    >
      {local.children}
    </span>
  );
}
