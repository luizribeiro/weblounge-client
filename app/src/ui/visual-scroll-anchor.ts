export function preserveVisualScrollAnchor(
  scroller: HTMLElement,
  mutate: () => void,
): void {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const anchor = [
    ...scroller.querySelectorAll<HTMLElement>("[data-row-key]"),
  ].find((row) => row.getBoundingClientRect().bottom > scrollerTop);
  const key = anchor?.dataset.rowKey;
  const offset = anchor?.getBoundingClientRect().top;
  mutate();
  if (key === undefined || offset === undefined) return;
  const moved = [
    ...scroller.querySelectorAll<HTMLElement>("[data-row-key]"),
  ].find((row) => row.dataset.rowKey === key);
  if (moved === undefined) return;
  scroller.scrollTop += moved.getBoundingClientRect().top - offset;
}
