/**
 * WebKit never starts a text selection from a press on an `a[href]`, even with link dragging
 * turned off, so a drag that begins on a link would select nothing. There the link drops its
 * `href` for the length of a plain primary mouse press and gets it back before the click, which
 * still opens it. Chromium selects from links already and opens one only if it had its `href` when
 * pressed, and a modified press (open in a new tab, extend the selection) needs the link as it is.
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
  const release = new AbortController();
  const restore = () => {
    link.setAttribute("href", href);
    release.abort();
  };
  for (const type of ["pointerup", "pointercancel", "dragend", "blur"])
    window.addEventListener(type, restore, {
      capture: true,
      signal: release.signal,
    });
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
