import type { FrameScheduler } from "./scroll-intent";

export interface RowAnchor {
  readonly key: string;
  readonly top: number;
}

const anchorTolerance = 0.1;
const settledFrameCount = 2;

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
  const moved = rowByKey(scroller, key);
  if (moved === undefined) return;
  scroller.scrollTop += moved.getBoundingClientRect().top - offset;
}

/**
 * Corrects the scroller each frame until the scroller stays put for two frames after `settling`
 * reports false. A correction it cannot take (smaller than its scroll step, or past its range)
 * counts as held once settled: repeating it would never converge, and rows measured late are
 * measured while it is still settling.
 */
export function settleRowAnchor(
  scroller: HTMLElement,
  anchor: RowAnchor,
  frames: FrameScheduler,
  settling: () => boolean,
): () => void {
  let stableFrames = 0;
  let handle: number | undefined;
  const correct = () => {
    handle = undefined;
    const row = rowByKey(scroller, anchor.key);
    if (row === undefined) return;
    const delta =
      row.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      anchor.top;
    const before = scroller.scrollTop;
    if (Math.abs(delta) > anchorTolerance) scroller.scrollTop += delta;
    const held = scroller.scrollTop === before && !settling();
    stableFrames = held ? stableFrames + 1 : 0;
    if (stableFrames < settledFrameCount) handle = frames.request(correct);
  };
  handle = frames.request(correct);
  return () => {
    if (handle !== undefined) frames.cancel(handle);
    handle = undefined;
  };
}

function rowByKey(scroller: HTMLElement, key: string): HTMLElement | undefined {
  return [...scroller.querySelectorAll<HTMLElement>("[data-row-key]")].find(
    (row) => row.dataset.rowKey === key,
  );
}
