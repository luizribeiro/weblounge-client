import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
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
  const [eligibleBufferId, setEligibleBufferId] = createSignal<number>();
  const [dwelledBufferId, setDwelledBufferId] = createSignal<number>();
  let dwellTimer: number | undefined;
  const clearDwellTimer = () => {
    if (dwellTimer !== undefined) window.clearTimeout(dwellTimer);
    dwellTimer = undefined;
  };

  createEffect(() => {
    const bufferId = options.bufferId();
    clearDwellTimer();
    setDwelledBufferId(undefined);
    setEligibleBufferId(undefined);
    if (
      bufferId === undefined ||
      !options.atLiveEdge() ||
      !options.foreground()
    ) {
      return;
    }
    setEligibleBufferId(bufferId);
    onCleanup(() => {
      if (eligibleBufferId() === bufferId) setEligibleBufferId(undefined);
      clearDwellTimer();
    });
  });

  createEffect(() => {
    const bufferId = options.bufferId();
    const messageId = options.newestCommittedMessageId();
    if (
      bufferId === undefined ||
      eligibleBufferId() !== bufferId ||
      options.unread() === 0 ||
      messageId === undefined ||
      !options.atLiveEdge() ||
      !options.foreground()
    ) {
      return;
    }
    if (dwelledBufferId() === bufferId) {
      options.onMarkRead(bufferId, messageId);
      return;
    }
    if (dwellTimer !== undefined) return;
    dwellTimer = window.setTimeout(() => {
      dwellTimer = undefined;
      if (eligibleBufferId() === bufferId) setDwelledBufferId(bufferId);
    }, 500);
  });
}

export function newestCommittedMessageId(
  messages: readonly MessageProjection[],
): number | undefined {
  let newest: MessageProjection | undefined;
  for (const message of messages) {
    if (
      (message.delivery !== "received" && message.delivery !== "confirmed") ||
      typeof message.kind === "object"
    ) {
      continue;
    }
    if (newest === undefined || compareMessageTime(message, newest) > 0)
      newest = message;
  }
  return newest?.id;
}

function compareMessageTime(
  left: MessageProjection,
  right: MessageProjection,
): number {
  const primary = messageTime(left) - messageTime(right);
  if (primary !== 0) return primary;
  const receipt = left.received_at_ms - right.received_at_ms;
  return receipt === 0 ? left.id - right.id : receipt;
}

function messageTime(message: MessageProjection): number {
  return message.server_time_ms ?? message.received_at_ms;
}
