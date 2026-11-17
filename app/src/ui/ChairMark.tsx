import { type JSX, splitProps } from "solid-js";
import styles from "./ChairMark.module.css";

type ChairMarkProps = JSX.HTMLAttributes<HTMLSpanElement>;

export function ChairMark(props: ChairMarkProps) {
  const [local, attributes] = splitProps(props, ["class"]);

  return (
    <span
      aria-hidden="true"
      {...attributes}
      class={[styles.chair, local.class].filter(Boolean).join(" ")}
    />
  );
}
