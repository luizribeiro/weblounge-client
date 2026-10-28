import { describe, expect, it } from "vitest";
import { type CopyRow, serializeCopyRows } from "./copy-rows";

describe("serializeCopyRows", () => {
  it("produces IRC-style text for a realistic selected range", () => {
    const rows: CopyRow[] = [
      { kind: "day-divider", label: "Today" },
      {
        kind: "message",
        time: new Date(2026, 9, 27, 22, 1),
        author: "luiz",
        text: "welcome tomo",
      },
      { kind: "action", author: "tomo", text: "is grabbing coffee" },
      {
        kind: "message",
        time: new Date(2026, 9, 27, 22, 3),
        author: "alice",
        text: "weblounge: this mention is for you",
      },
    ];

    expect(serializeCopyRows(rows)).toBe(
      [
        "--- Today ---",
        "[22:01] <luiz> welcome tomo",
        "* tomo is grabbing coffee",
        "[22:03] <alice> weblounge: this mention is for you",
      ].join("\n"),
    );
  });

  it("normalizes embedded newlines without creating fake rows", () => {
    expect(
      serializeCopyRows([
        {
          kind: "message",
          time: new Date(2026, 9, 27, 9, 5),
          author: "ali\nce",
          text: "first\r\nsecond",
        },
      ]),
    ).toBe("[09:05] <ali ce> first second");
  });

  it("serializes an empty range as empty text", () => {
    expect(serializeCopyRows([])).toBe("");
  });
});
