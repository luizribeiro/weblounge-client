import { currentAppLifecycle, onAppLifecycle } from "./app-lifecycle";
import { type NativeBridge, nativeBridge } from "./native-bridge";
import { observeNativePageEvents } from "./page-events";
import { nativePushedMessageDrain } from "./pushed-message-drain";

export interface HostEvents {
  openRoute(route: string): void;
  background(): void;
  foreground(): void;
}

const earlyTaps: string[] = [];
let stopEarlyTaps: (() => void) | undefined;

/**
 * Holds the shell's taps and lifecycle from page start until `startHostIntegration` runs: the app
 * mounts only after config and sign-in, while the shell taps as soon as the page has loaded.
 */
export function captureNativeEventsAtStartup(
  bridge: NativeBridge | undefined = nativeBridge(),
): void {
  if (bridge === undefined || stopEarlyTaps !== undefined) return;
  currentAppLifecycle();
  stopEarlyTaps = observeNativePageEvents(window, {
    "weblounge:open-route": (route) => earlyTaps.push(route),
  });
}

/**
 * Inside the iPhone app, follows the shell's taps and lifecycle and opens the launch route, each
 * route only after the extension's pushed messages reached the engine. Does nothing in a browser.
 */
export function startHostIntegration(
  events: HostEvents,
  launchRoute: string,
  bridge: NativeBridge | undefined = nativeBridge(),
): () => void {
  if (bridge === undefined) return () => {};
  const drain = nativePushedMessageDrain(bridge);
  let stopped = false;
  // Joining an in-flight drain is enough: the extension queues a message before showing it, so
  // anything tappable was queued before the drain that a tap or foreground started.
  const openAfterDrain = (route: string) => {
    void drain().then(() => {
      if (!stopped) events.openRoute(route);
    });
  };
  stopEarlyTaps?.();
  stopEarlyTaps = undefined;
  const stopTaps = observeNativePageEvents(window, {
    "weblounge:open-route": openAfterDrain,
  });
  const stopLifecycle = onAppLifecycle((lifecycle) => {
    if (lifecycle === "background") {
      events.background();
      return;
    }
    void drain();
    events.foreground();
  });
  openAfterDrain(launchRoute);
  for (const route of earlyTaps.splice(0)) openAfterDrain(route);
  return () => {
    stopped = true;
    stopTaps();
    stopLifecycle();
  };
}
