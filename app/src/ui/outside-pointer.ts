import { onCleanup } from "solid-js";

export function onPointerDownOutside(
  inside: () => readonly (Node | undefined)[],
  handler: () => void,
): void {
  const listener = (event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Node &&
      inside().some((node) => node?.contains(target))
    )
      return;
    handler();
  };
  document.addEventListener("pointerdown", listener);
  onCleanup(() => document.removeEventListener("pointerdown", listener));
}
