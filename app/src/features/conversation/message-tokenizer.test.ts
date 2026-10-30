import { describe, expect, it } from "vitest";
import { tokenizeMessage } from "./message-tokenizer";

describe("message tokenizer", () => {
  it.each([
    [
      "(see https://x.org/a_(b))",
      [
        { kind: "text", value: "(see " },
        {
          kind: "link",
          href: "https://x.org/a_(b)",
          value: "https://x.org/a_(b)",
        },
        { kind: "text", value: ")" },
      ],
    ],
    [
      "https://x.org.",
      [
        { kind: "link", href: "https://x.org/", value: "https://x.org" },
        { kind: "text", value: "." },
      ],
    ],
    [
      "<https://x.org>",
      [
        { kind: "text", value: "<" },
        { kind: "link", href: "https://x.org/", value: "https://x.org" },
        { kind: "text", value: ">" },
      ],
    ],
    [
      "www.example.com/path",
      [
        {
          kind: "link",
          href: "https://www.example.com/path",
          value: "www.example.com/path",
        },
      ],
    ],
    [
      "irc://irc.example.org/#lounge",
      [
        {
          kind: "link",
          href: "irc://irc.example.org/#lounge",
          value: "irc://irc.example.org/#lounge",
        },
      ],
    ],
    [
      "javascript:alert(1) ftp://x.org",
      [{ kind: "text", value: "javascript:alert(1) ftp://x.org" }],
    ],
    [
      "open #lounge and &local",
      [
        { kind: "text", value: "open " },
        { kind: "channel", value: "#lounge" },
        { kind: "text", value: " and " },
        { kind: "channel", value: "&local" },
      ],
    ],
  ])("tokenizes %s", (text, expected) => {
    expect(tokenizeMessage(text)).toEqual(expected);
  });

  it("emits known nicks without mistaking embedded channels for links", () => {
    expect(tokenizeMessage("Alex said hi in word#room", ["alex"])).toEqual([
      { kind: "nick", value: "Alex" },
      { kind: "text", value: " said hi in word#room" },
    ]);
  });
});
