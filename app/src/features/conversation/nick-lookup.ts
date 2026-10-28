import type { MessageProjection } from "../../engine/protocol";

export type NickDisplay = Pick<
  MessageProjection,
  "authorship" | "nick_color_index"
>;

export function createNickLookup(
  messages: readonly MessageProjection[],
): ReadonlyMap<string, NickDisplay> {
  const lookup = new Map<string, NickDisplay>();
  for (const message of messages) {
    const key = message.author.toLocaleLowerCase();
    if (!lookup.has(key)) lookup.set(key, message);
  }
  return lookup;
}
