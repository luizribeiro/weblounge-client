import { describe, expect, it } from "vitest";
import type { Actor } from "../../../engine/generated/Actor";
import type { ModeMeaning } from "../../../engine/generated/ModeMeaning";
import type { Person } from "../../../engine/generated/Person";
import type { RunClauses } from "../../../engine/generated/RunClauses";
import { systemLineText, systemLineWords } from "./system-line-words";

const mel = person("mel", 1);
const iris = person("iris", 2);
const louro = person("louro", 3);
const actor: Actor = { type: "user", ...mel };

describe("systemLineWords", () => {
  it.each<readonly [RunClauses[number], string]>([
    [{ type: "joined", people: [iris] }, "iris joined"],
    [{ type: "joined_and_left", people: [iris] }, "iris joined and left"],
    [
      { type: "left", people: [{ person: iris, reason: "dinner" }] },
      "iris left: “dinner”",
    ],
    [
      { type: "quit", people: [{ person: iris, reason: "timeout" }] },
      "iris quit: “timeout”",
    ],
    [{ type: "reconnected", people: [iris] }, "iris reconnected"],
    [{ type: "rejoined", people: [iris] }, "iris rejoined"],
    [
      { type: "nick", changes: [{ old: iris, new: louro }] },
      "iris is now louro",
    ],
    [{ type: "invited", actor, people: [iris] }, "mel invited iris"],
  ])("renders the %# run clause", (clause, expected) => {
    expect(textFor([clause])).toBe(expected);
  });

  it("uses You for an own nick change", () => {
    expect(
      textFor([
        {
          type: "nick",
          changes: [{ old: { ...mel, me: true }, new: louro }],
        },
      ]),
    ).toBe("You are now louro");
  });

  it("shows three names and an accessible N others expander", () => {
    const people = ["kiwi", "zed", "ana", "tomo", "bob", "eve"].map(
      (nick, index) => person(nick, index),
    );
    const words = systemLineWords({
      type: "run",
      clauses: [{ type: "joined", people }],
    });

    expect(systemLineText(words.segments)).toBe(
      "kiwi, zed, ana and 3 others joined",
    );
    expect(words.segments).toContainEqual({
      kind: "button",
      action: "expand",
      accessibleName: "Show 3 others",
      text: "3 others",
    });
  });

  it("shows the fourth name instead of one other", () => {
    const people = ["ana", "tomo", "eve", "bob"].map((nick, index) =>
      person(nick, index),
    );
    const words = systemLineWords({
      type: "run",
      clauses: [
        {
          type: "quit",
          people: people.map((person) => ({ person, reason: null })),
        },
      ],
    });

    expect(systemLineText(words.segments)).toBe("ana, tomo, eve and bob quit");
    expect(words.segments.some((segment) => segment.kind === "button")).toBe(
      false,
    );
  });

  it("expands to a count, Show less, and one reason-preserving line per person", () => {
    const people = ["kiwi", "zed", "ana", "tomo", "bob"].map((nick, index) => ({
      person: person(nick, index),
      reason: index === 4 ? "switching clients" : null,
    }));
    const words = systemLineWords(
      { type: "run", clauses: [{ type: "left", people }] },
      { expanded: true },
    );

    expect(systemLineText(words.segments)).toBe("5 people left · Show less");
    expect(words.details.map(systemLineText)).toEqual([
      "kiwi left",
      "zed left",
      "ana left",
      "tomo left",
      "bob left: “switching clients”",
    ]);
  });

  it("joins mixed clauses with a middle dot", () => {
    expect(
      textFor([
        { type: "joined", people: [iris, louro] },
        { type: "reconnected", people: [mel] },
      ]),
    ).toBe("iris and louro joined · mel reconnected");
  });

  it.each<readonly [ModeMeaning, boolean, string]>([
    [
      { type: "rank", rank: { mode: "o", symbol: "@" }, member: iris },
      true,
      "mel gave op to iris",
    ],
    [
      { type: "rank", rank: { mode: "v", symbol: "+" }, member: iris },
      false,
      "mel took voice from iris",
    ],
    [
      { type: "ban", mask: "*!*@spam.example" },
      true,
      "mel banned *!*@spam.example",
    ],
    [
      { type: "ban", mask: "*!*@spam.example" },
      false,
      "mel lifted the ban on *!*@spam.example",
    ],
    [{ type: "moderated" }, true, "mel made the channel moderated"],
    [{ type: "topic_locked" }, true, "mel locked the topic"],
    [{ type: "key" }, true, "mel set a key"],
    [{ type: "limit", limit: "50" }, true, "mel set a 50-person limit"],
  ])("words a mode change %#", (meaning, added, expected) => {
    expect(modeText(meaning, added)).toBe(expected);
  });

  it("combines one actor's modes in natural language", () => {
    const words = systemLineWords({
      type: "run",
      clauses: [
        {
          type: "modes",
          actor,
          changes: [
            mode(
              { type: "rank", rank: { mode: "o", symbol: "@" }, member: iris },
              "+o iris",
            ),
            mode(
              { type: "rank", rank: { mode: "v", symbol: "+" }, member: louro },
              "+v louro",
            ),
            mode({ type: "moderated" }, "+m"),
          ],
        },
      ],
    });
    expect(systemLineText(words.segments)).toBe(
      "mel gave op to iris, voice to louro, and made the channel moderated",
    );
  });

  it("never reveals a channel key, including in the desktop raw suffix", () => {
    const words = systemLineWords(
      {
        type: "run",
        clauses: [
          {
            type: "modes",
            actor,
            changes: [mode({ type: "key" }, "+k swordfish")],
          },
        ],
      },
      { includeRawModes: true },
    );

    expect(systemLineText(words.segments)).toBe("mel set a key   +k");
    expect(systemLineText(words.segments)).not.toContain("swordfish");
  });
});

function textFor(clauses: RunClauses): string {
  return systemLineText(systemLineWords({ type: "run", clauses }).segments);
}

function modeText(meaning: ModeMeaning, added: boolean): string {
  return textFor([
    { type: "modes", actor, changes: [{ added, meaning, raw: "+x" }] },
  ]);
}

function mode(meaning: ModeMeaning, raw: string) {
  return { added: true, meaning, raw };
}

function person(nick: string, nickColorIndex: number): Person {
  return {
    nick,
    nick_color_index: nickColorIndex,
    me: false,
  };
}
