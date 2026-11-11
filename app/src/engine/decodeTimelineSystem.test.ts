import { expect, it } from "vitest";
import { decodeSystemLine } from "./decodeTimelineSystem";

it("decodes standalone events", () => {
  const kick = {
    type: "event",
    event: {
      type: "kick",
      actor: { type: "user", ...person("operator") },
      subject: { type: "other", ...person("mel") },
      reason: "cleanup",
    },
  };
  const topic = {
    type: "event",
    event: {
      type: "topic",
      actor: { type: "server", name: "irc.example" },
      topic: "Welcome",
    },
  };

  expect(decodeSystemLine(kick)).toEqual(kick);
  expect(decodeSystemLine(topic)).toEqual(topic);
});

it("requires a known non-empty run", () => {
  expect(decodeSystemLine({ type: "run", clauses: [] })).toBeUndefined();
  expect(
    decodeSystemLine({ type: "run", clauses: [{ type: "future" }] }),
  ).toBeUndefined();
});

function person(nick: string) {
  return { nick, nick_color_index: 2, me: false };
}
