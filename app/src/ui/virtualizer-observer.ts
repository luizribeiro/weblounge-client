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
  const dispose = observeElementOffset(instance, (_offset, isScrolling) => {
    if (frame !== undefined) target.cancelAnimationFrame(frame);
    frame = target.requestAnimationFrame(() => {
      frame = undefined;
      const element = instance.scrollElement;
      if (element === null) return;
      const { horizontal, isRtl } = instance.options;
      const offset = horizontal
        ? element.scrollLeft * (isRtl ? -1 : 1)
        : element.scrollTop;
      callback(offset, isScrolling);
    });
  });
  return () => {
    if (frame !== undefined) target.cancelAnimationFrame(frame);
    dispose?.();
  };
}
