import { storePushedMessage } from "../push/pushed-message-store";
import type { PushedMessage } from "./generated/PushedMessage";
import type { NativeBridge } from "./native-bridge";

export type PushedMessageDrain = () => Promise<void>;

/**
 * Moves the messages the notification extension showed into the engine's cache, one drain at a
 * time, so a route opened after it finds them.
 */
export function nativePushedMessageDrain(
  bridge: NativeBridge,
  store: (message: PushedMessage) => Promise<unknown> = storePushedMessage,
): PushedMessageDrain {
  let draining: Promise<void> | undefined;
  const drain = async () => {
    const messages = await bridge.call("take_pushed_messages");
    // Taking empties the shell's queue, so one message that fails to store must not drop the rest.
    for (const message of messages) await store(message).catch(() => undefined);
  };
  return () => {
    draining ??= drain()
      .catch(() => undefined)
      .finally(() => {
        draining = undefined;
      });
    return draining;
  };
}
