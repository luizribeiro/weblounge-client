export const mobileShellBoundary = 760;

export type Shell = "desktop" | "mobile";

export function shellForWidth(width: number): Shell {
  return width < mobileShellBoundary ? "mobile" : "desktop";
}

export function observeContainerShell(
  element: Element,
  onShell: (shell: Shell) => void,
): () => void {
  const observer = new ResizeObserver(([entry]) => {
    if (entry !== undefined) onShell(shellForWidth(entry.contentRect.width));
  });
  observer.observe(element);
  return () => observer.disconnect();
}
