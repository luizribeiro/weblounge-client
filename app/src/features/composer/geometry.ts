export const composerGeometryWillChangeEvent =
  "weblounge:composer-geometry-will-change";
export const composerGeometryChangeEvent = "weblounge:composer-geometry-change";

/** Marks the element that holds a transcript and the composer beside it. */
export const composerScopeSelector = "[data-composer-scope]";

/**
 * Runs a measurement that briefly collapses content inside `element` while the
 * element keeps its laid-out block size. A scroll container beside `element`
 * clamps its scroll offset whenever that collapse reaches layout.
 */
export function withBlockSizeHeld<T>(
  element: HTMLElement | null,
  measure: () => T,
): T {
  if (element === null) return measure();
  const inlineBlockSize = element.style.blockSize;
  element.style.blockSize = `${element.getBoundingClientRect().height}px`;
  try {
    return measure();
  } finally {
    element.style.blockSize = inlineBlockSize;
  }
}

/**
 * The border-box height that shows all of a textarea's content: the composer
 * sizes in border-box, and `scrollHeight` leaves out the borders.
 */
export function contentFittingHeight(textarea: HTMLTextAreaElement): number {
  const borders = textarea.offsetHeight - textarea.clientHeight;
  return textarea.scrollHeight + borders;
}
