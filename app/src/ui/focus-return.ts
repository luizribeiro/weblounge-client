export function returnFocus(invoker: Element | null): boolean {
  if (
    !(invoker instanceof HTMLElement) ||
    !invoker.isConnected ||
    invoker === document.body ||
    invoker.closest("[inert]") !== null
  )
    return false;
  invoker.focus({ preventScroll: true });
  return document.activeElement === invoker;
}
