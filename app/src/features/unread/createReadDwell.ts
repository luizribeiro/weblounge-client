import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { MessageProjection } from "../../engine/protocol";

interface ReadDwellOptions {
  readonly atLiveEdge: Accessor<boolean>;
  readonly bufferId: Accessor<number | undefined>;
  readonly foreground: Accessor<boolean>;
  readonly foregroundExitEpoch: Accessor<number | undefined>;
  readonly newestCommittedMessageId: Accessor<number | undefined>;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly visible: Accessor<boolean>;
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
    options.foregroundExitEpoch();
    clearDwellTimer();
    setDwelledBufferId(undefined);
    setEligibleBufferId(undefined);
    if (
      bufferId === undefined ||
      !options.visible() ||
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
      messageId === undefined ||
      !options.visible() ||
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
      typeof message.kind === "object" ||
      message.server_time_ms === null
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
  const leftTime = left.server_time_ms ?? Number.MIN_SAFE_INTEGER;
  const rightTime = right.server_time_ms ?? Number.MIN_SAFE_INTEGER;
  return leftTime === rightTime ? left.id - right.id : leftTime - rightTime;
}
