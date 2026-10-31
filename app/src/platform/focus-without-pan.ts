export function focusWithoutViewportPan(
  field: HTMLElement,
  browserWindow: Window = window,
): void {
  const previousTransform = field.style.transform;

  // Safari decides where to pan before honoring preventScroll. Moving the
  // field above the viewport for the synchronous focus makes that pan a no-op.
  // This follows React Aria's iOS workaround:
  // https://github.com/adobe/react-spectrum/blob/7eae25e124a9d235ff30f12bd86383b894a1ea04/packages/%40react-aria/overlays/src/usePreventScroll.ts#L142-L154
  field.style.transform = "translateY(-2000px)";
  try {
    field.focus({ preventScroll: true });
  } finally {
    browserWindow.requestAnimationFrame(() => {
      field.style.transform = previousTransform;
    });
  }
}
