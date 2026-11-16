import type { AppLifecycle } from "./generated/AppLifecycle";
import { observeNativePageEvents } from "./page-events";

type LifecycleListener = (lifecycle: AppLifecycle) => void;

let current: AppLifecycle = "foreground";
const listeners = new Set<LifecycleListener>();
let observing = false;

function observeOnce(): void {
  if (observing) return;
  observing = true;
  observeNativePageEvents(window, {
    "weblounge:lifecycle": (lifecycle) => {
      current = lifecycle;
      for (const notify of [...listeners]) notify(lifecycle);
    },
  });
}

/** The side of the app lifecycle the shell last reported; a browser never leaves the foreground. */
export function currentAppLifecycle(): AppLifecycle {
  observeOnce();
  return current;
}

/** Calls `listener` after each lifecycle change is recorded, so it reads the new state. */
export function onAppLifecycle(listener: LifecycleListener): () => void {
  observeOnce();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
