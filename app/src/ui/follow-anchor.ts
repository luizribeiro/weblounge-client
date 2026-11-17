/**
 * Keeps a floating layer on the element it opened from: `move` gets the anchor's new box after
 * any scroll or resize that can move it, and `lose` runs once the anchor is detached or scrolled
 * out of view. Returns the function that stops following.
 */
export function followAnchor(
  anchor: Element,
  move: (box: DOMRect) => void,
  lose: () => void,
): () => void {
  const update = (event: Event) => {
    if (anchor.isConnected && !movesAnchor(event.target, anchor)) return;
    if (!anchor.isConnected || !isInScrollView(anchor)) {
      stop();
      lose();
    } else move(anchor.getBoundingClientRect());
  };
  const stop = () => {
    document.removeEventListener("scroll", update, true);
    window.removeEventListener("resize", update);
  };
  document.addEventListener("scroll", update, { capture: true, passive: true });
  window.addEventListener("resize", update);
  return stop;
}

function movesAnchor(target: EventTarget | null, anchor: Element): boolean {
  return !(target instanceof Node) || target.contains(anchor);
}

function isInScrollView(element: Element): boolean {
  const box = element.getBoundingClientRect();
  for (
    let parent = element.parentElement;
    parent !== null;
    parent = parent.parentElement
  ) {
    if (getComputedStyle(parent).overflowY === "visible") continue;
    const clip = parent.getBoundingClientRect();
    if (box.bottom <= clip.top || box.top >= clip.bottom) return false;
  }
  return true;
}
