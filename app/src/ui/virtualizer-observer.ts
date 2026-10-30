import {
  observeElementOffset,
  type Virtualizer,
} from "@tanstack/solid-virtual";

export function observeVirtualizerOffset<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  callback: (offset: number, isScrolling: boolean) => void,
): () => void {
  let frame: number | undefined;
  const target = instance.targetWindow ?? window;
  const dispose = observeElementOffset(instance, (offset, isScrolling) => {
    if (frame !== undefined) target.cancelAnimationFrame(frame);
    frame = target.requestAnimationFrame(() => {
      frame = undefined;
      callback(offset, isScrolling);
    });
  });
  return () => {
    if (frame !== undefined) target.cancelAnimationFrame(frame);
    dispose?.();
  };
}
