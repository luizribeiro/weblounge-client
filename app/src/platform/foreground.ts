import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { pageIsForeground } from "./push/foreground-state";

export interface ForegroundSignal extends Accessor<boolean> {
  readonly exitEpoch: Accessor<number>;
}

export function createForegroundSignal(): ForegroundSignal {
  let current = pageIsForeground(document, navigator);
  const [foreground, setForeground] = createSignal(current);
  const [exitEpoch, setExitEpoch] = createSignal(0);

  onMount(() => {
    const update = () => {
      const next = pageIsForeground(document, navigator);
      if (current && !next) setExitEpoch((epoch) => epoch + 1);
      current = next;
      setForeground(next);
    };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    });
  });

  return Object.assign(foreground, { exitEpoch });
}
