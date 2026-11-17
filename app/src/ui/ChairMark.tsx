import { type JSX, splitProps } from "solid-js";
import styles from "./ChairMark.module.css";

type ChairMarkProps = JSX.HTMLAttributes<HTMLSpanElement>;

export function ChairMark(props: ChairMarkProps) {
  const [local, attributes] = splitProps(props, ["class", "children"]);

  return (
    <span
      aria-hidden="true"
      {...attributes}
      class={[styles.tile, local.class].filter(Boolean).join(" ")}
    >
      {local.children}
    </span>
  );
}
