export function trapTab(
  event: KeyboardEvent,
  root: HTMLElement | undefined,
): void {
  if (event.key !== "Tab") return;
  const elements = focusable(root);
  const first = elements[0];
  const last = elements.at(-1);
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  const outside = !elements.some((element) => element === active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

function focusable(root: HTMLElement | undefined): HTMLElement[] {
  if (root === undefined) return [];
  return [
    ...root.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]"),
  ].filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0,
  );
}
