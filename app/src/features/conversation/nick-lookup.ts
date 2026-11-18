import type { MessageProjection } from "../../engine/protocol";

export type NickDisplay = Pick<
  MessageProjection,
  "authorship" | "nick_color_index"
>;

export function createNickLookup(
  messages: readonly MessageProjection[],
): ReadonlyMap<string, NickDisplay> {
  const lookup = new Map<string, NickDisplay>();
  const remember = (nick: string, display: NickDisplay) => {
    const key = nick.toLocaleLowerCase();
    if (!lookup.has(key)) lookup.set(key, display);
  };
  for (const message of messages) {
    remember(message.author, message);
    for (const person of message.mentions ?? [])
      remember(person.nick, {
        authorship: person.me ? "own" : "other",
        nick_color_index: person.nick_color_index,
      });
  }
  return lookup;
}
