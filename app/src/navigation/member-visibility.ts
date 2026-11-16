import type { BufferProjection } from "../engine/protocol";

export type ChannelKey = string & { readonly channelKey: unique symbol };

export interface MemberVisibility {
  readonly byChannel: ReadonlyMap<ChannelKey, boolean>;
  readonly lastChoice: boolean;
}

export const hiddenMembers: MemberVisibility = {
  byChannel: new Map(),
  lastChoice: false,
};

export function channelKey(buffer: BufferProjection): ChannelKey | undefined {
  return buffer.kind === "channel"
    ? (buffer.draft_key as ChannelKey)
    : undefined;
}

export function membersShown(
  visibility: MemberVisibility,
  channel: ChannelKey,
): boolean {
  return visibility.byChannel.get(channel) ?? visibility.lastChoice;
}

export function toggleMembers(
  visibility: MemberVisibility,
  channel: ChannelKey,
): MemberVisibility {
  const shown = !membersShown(visibility, channel);
  return {
    byChannel: new Map(visibility.byChannel).set(channel, shown),
    lastChoice: shown,
  };
}
