import { type JSX, onCleanup, splitProps } from "solid-js";
import { contextMenuRegistry } from "./context-menu";
import styles from "./primitives.module.css";

interface SelectableProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  readonly surfaceId: string;
}

export function Selectable(props: SelectableProps) {
  const [local, attributes] = splitProps(props, [
    "children",
    "class",
    "surfaceId",
  ]);
  let unregister = () => {};
  onCleanup(() => unregister());

  return (
    <span
      {...attributes}
      class={`${styles.selectable} ${local.class ?? ""}`}
      data-selectable="true"
      ref={(element) => {
        unregister();
        unregister = contextMenuRegistry.register(element, {
          id: local.surfaceId,
          kind: "selectable",
        });
      }}
    >
      {local.children}
    </span>
  );
}
