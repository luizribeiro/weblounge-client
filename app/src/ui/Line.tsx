import { type JSX, splitProps } from "solid-js";
import styles from "./primitives.module.css";

type LineProps = JSX.HTMLAttributes<HTMLSpanElement>;

export function Line(props: LineProps) {
  const [local, attributes] = splitProps(props, ["children", "class"]);

  return (
    <span
      {...attributes}
      class={`${styles.line} ${local.class ?? ""}`}
      data-line="true"
    >
      {local.children}
    </span>
  );
}
