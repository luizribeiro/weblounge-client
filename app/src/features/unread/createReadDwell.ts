import { type Accessor, createEffect, onCleanup } from "solid-js";
import type { MessageProjection } from "../../engine/protocol";

interface ReadDwellOptions {
  readonly atLiveEdge: Accessor<boolean>;
  readonly bufferId: Accessor<number | undefined>;
  readonly foreground: Accessor<boolean>;
  readonly newestCommittedMessageId: Accessor<number | undefined>;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly unread: Accessor<number>;
}

export function createReadDwell(options: ReadDwellOptions): void {
  createEffect(() => {
    const bufferId = options.bufferId();
    const messageId = options.newestCommittedMessageId();
    if (
      bufferId === undefined ||
      options.unread() === 0 ||
      messageId === undefined ||
      !options.atLiveEdge() ||
      !options.foreground()
    ) {
      return;
    }
    const timeout = window.setTimeout(
      () => options.onMarkRead(bufferId, messageId),
      500,
    );
    onCleanup(() => window.clearTimeout(timeout));
  });
}

export function newestCommittedMessageId(
  messages: readonly MessageProjection[],
): number | undefined {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        message.delivery === "received" || message.delivery === "confirmed",
    )?.id;
}
