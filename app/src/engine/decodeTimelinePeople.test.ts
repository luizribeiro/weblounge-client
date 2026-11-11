import { expect, it } from "vitest";
import { decodeMode, decodePerson } from "./decodeTimelinePeople";

it("keeps timeline people distinct from legacy membership rows", () => {
  expect(decodePerson(person("mel"))).toEqual(person("mel"));
  expect(
    decodePerson({
      type: "change",
      id: 1,
      kind: "joined",
      nicks: ["mel"],
      server_time_ms: 1,
      received_at_ms: 1,
    }),
  ).toBeUndefined();
});

it("decodes rank modes through the one person decoder", () => {
  const value = {
    added: true,
    meaning: {
      type: "rank",
      rank: { mode: "o", symbol: "@" },
      member: person("mel"),
    },
    raw: "+o mel",
  };

  expect(decodeMode(value)).toEqual(value);
  expect(decodeMode({ ...value, meaning: { type: "future" } })).toBeUndefined();
});

function person(nick: string) {
  return { nick, nick_color_index: 2, me: false };
}
