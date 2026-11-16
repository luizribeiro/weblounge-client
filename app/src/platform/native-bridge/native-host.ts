import { type NativeBridge, nativeBridge } from "./native-bridge";
import { observeNativePageEvents } from "./page-events";
import { nativePushedMessageDrain } from "./pushed-message-drain";

export interface HostEvents {
  openRoute(route: string): void;
  background(): void;
  foreground(): void;
}

/**
 * Inside the iPhone app, follows the shell's taps and lifecycle and opens the launch route, each
 * route only after the extension's pushed messages reached the engine. Does nothing in a browser.
 */
export function startHostIntegration(
  events: HostEvents,
  launchRoute: string,
  bridge: NativeBridge | undefined = nativeBridge(),
  target: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  > = window,
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
  const stopListening = observeNativePageEvents(target, {
    "weblounge:open-route": openAfterDrain,
    "weblounge:lifecycle": (lifecycle) => {
      if (lifecycle === "background") {
        events.background();
        return;
      }
      void drain();
      events.foreground();
    },
  });
  openAfterDrain(launchRoute);
  return () => {
    stopped = true;
    stopListening();
  };
}
