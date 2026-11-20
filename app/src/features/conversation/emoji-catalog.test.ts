import { expect, it } from "vitest";
import { searchEmoji } from "./emoji-catalog";

function found(query: string): readonly string[] {
  return searchEmoji(query).flatMap((group) =>
    group.entries.map((entry) => entry.emoji),
  );
}

it.each([
  ["fire", "🔥"],
  ["thumbs", "👍"],
  ["heart", "❤️"],
  ["party", "🎉"],
  ["eyes", "👀"],
])("finds %s in search, not only in the Frequent row", (query, emoji) => {
  expect(found(query)).toContain(emoji);
});

it("lists each matching emoji once", () => {
  const results = found("heart");

  expect(results).toEqual([...new Set(results)]);
});
