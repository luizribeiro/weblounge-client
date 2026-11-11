import { expect, it } from "vitest";
import { decodeTimelineItem } from "./decodeTimelineItem";

it.each([
  ["bad order tuple", { ...gapItem(), order: [1, 2] }],
  ["unknown family", { ...gapItem(), body: { family: "future" } }],
  ["missing fields", { order: [1, 1, 1], body: gapItem().body }],
  [
    "unknown clause",
    systemItem({ type: "run", clauses: [{ type: "future" }] }),
  ],
])("rejects %s", (_name, value) => {
  expect(decodeTimelineItem(value)).toBeUndefined();
});

it("decodes a message body", () => {
  const value = {
    ...gapItem(),
    body: {
      family: "message",
      id: 1,
      author: "mel",
      text: "hello",
      kind: "text",
      bot: false,
      authorship: "other",
      nick_color_index: 2,
      highlighted: false,
      delivery: "received",
      local_send_id: null,
      server_ids: ["msg-1"],
      server_time_ms: 1,
      received_at_ms: 2,
    },
  };

  expect(decodeTimelineItem(value)).toEqual(value);
});

it("decodes kick and topic bodies", () => {
  const user = person("operator");
  const kicked = systemItem({
    type: "event",
    event: {
      type: "kick",
      actor: { type: "user", ...user },
      subject: { type: "other", ...person("mel") },
      reason: "cleanup",
    },
  });
  const topic = systemItem({
    type: "event",
    event: {
      type: "topic",
      actor: { type: "server", name: "irc.example" },
      topic: "Welcome",
    },
  });

  expect(decodeTimelineItem(kicked)).toEqual(kicked);
  expect(decodeTimelineItem(topic)).toEqual(topic);
});

it("decodes a mode run through the shared person shape", () => {
  const value = systemItem({
    type: "run",
    clauses: [
      {
        type: "modes",
        actor: { type: "user", ...person("operator") },
        changes: [
          {
            added: true,
            meaning: {
              type: "rank",
              rank: { mode: "o", symbol: "@" },
              member: person("mel"),
            },
            raw: "+o mel",
          },
        ],
      },
    ],
  });

  expect(decodeTimelineItem(value)).toEqual(value);
});

function gapItem() {
  return {
    id: 1,
    order: [1, 1, 1],
    day: 1,
    content_version: 0,
    body: { family: "gap", from_ms: 1, to_ms: 2 },
  };
}

function systemItem(line: unknown) {
  return {
    ...gapItem(),
    body: { family: "system", time_ms: 1, line },
  };
}

function person(nick: string) {
  return { nick, nick_color_index: 2, me: false };
}
