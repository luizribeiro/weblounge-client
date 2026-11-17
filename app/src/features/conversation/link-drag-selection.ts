/**
 * Works around a WebKit bug: it never starts a text selection from a press on an `a[href]`, even
 * with link dragging turned off, so a drag that begins on a link would select nothing. There the
 * link drops its `href` only while a plain primary mouse press is held and gets it back before
 * the click, which still opens it; `role="link"` keeps it a link to assistive technology
 * meanwhile. Chromium selects from links already and opens one only if it had its `href` when
 * pressed, and modified, middle and secondary presses need the link as it is.
 */
export function selectFromLinkPress(event: PointerEvent): void {
  const link = event.currentTarget;
  if (
    !(link instanceof HTMLAnchorElement) ||
    !isWebKit() ||
    !isPlainPrimaryMousePress(event)
  )
    return;
  const href = link.getAttribute("href");
  if (href === null) return;
  link.removeAttribute("href");
  link.setAttribute("role", "link");
  const release = new AbortController();
  const restore = () => {
    link.setAttribute("href", href);
    link.removeAttribute("role");
    release.abort();
  };
  const options = { capture: true, signal: release.signal };
  for (const type of ["pointerup", "pointercancel", "dragend", "blur"])
    window.addEventListener(type, restore, options);
  document.addEventListener("visibilitychange", restore, options);
  const restoreOnceReleased = (move: PointerEvent) => {
    if (!isPrimaryHeld(move)) restore();
  };
  window.addEventListener("pointermove", restoreOnceReleased, options);
}

function isWebKit(): boolean {
  return navigator.vendor === "Apple Computer, Inc.";
}

function isPlainPrimaryMousePress(event: PointerEvent): boolean {
  return (
    event.pointerType === "mouse" &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** A release outside the window sends no pointerup; the next move shows the button is up. */
function isPrimaryHeld(event: PointerEvent): boolean {
  return (event.buttons & 1) === 1;
}
