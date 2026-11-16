export function focusComposerIn(root: () => HTMLElement | undefined): void {
  queueMicrotask(() =>
    root()
      ?.querySelector<HTMLTextAreaElement>("[data-composer] textarea")
      ?.focus({ preventScroll: true }),
  );
}
