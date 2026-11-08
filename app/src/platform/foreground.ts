import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { pageIsForeground } from "./push/foreground-state";

export function createForegroundSignal(): Accessor<boolean> {
  const [foreground, setForeground] = createSignal(
    pageIsForeground(document, navigator),
  );

  onMount(() => {
    const update = () => setForeground(pageIsForeground(document, navigator));
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    });
  });

  return foreground;
}
