import { type Accessor, createSignal, onCleanup } from "solid-js";

export function createDocumentTheme(
  root: HTMLElement = document.documentElement,
): Accessor<string | undefined> {
  const [theme, setTheme] = createSignal(root.dataset.theme);
  const observer = new MutationObserver(() => setTheme(root.dataset.theme));
  observer.observe(root, { attributeFilter: ["data-theme"] });
  onCleanup(() => observer.disconnect());
  return theme;
}
