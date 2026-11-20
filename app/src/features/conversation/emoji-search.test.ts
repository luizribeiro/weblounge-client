import { expect, it } from "vitest";
import annotations from "../../assets/emoji-annotations.json";
import {
  buildEmojiIndex,
  loadEmojiIndex,
  searchEmoji,
  searchResultLimit,
} from "./emoji-search";

const index = buildEmojiIndex(annotations);

function found(query: string): readonly string[] {
  return searchEmoji(index, query).map((entry) => entry.emoji);
}

it.each([
  ["fire", "🔥"],
  ["eyes", "👀"],
  ["rocket", "🚀"],
  ["thumbs", "👍"],
  ["thumbs down", "👎"],
  ["+1", "👍"],
  ["fogo", "🔥"],
  ["coração vermelho", "❤️"],
])("ranks %s first as %s", (query, emoji) => {
  expect(found(query)[0]).toBe(emoji);
});

it.each([
  ["smile", ["😀", "😄", "🙂"]],
  ["laugh", ["😀", "😄", "😂"]],
  ["party", ["🥳", "🎉"]],
  ["check", ["✅", "☑️", "✔️"]],
])("lists the obvious %s emoji near the top", (query, emoji) => {
  expect(found(query).slice(0, 12)).toEqual(expect.arrayContaining(emoji));
});

it("ranks an exact name above a name prefix, then a keyword", () => {
  const results = found("fire");

  expect(results[0]).toBe("🔥");
  expect(results.indexOf("🚒")).toBeGreaterThan(0);
  expect(results.indexOf("🎇")).toBeGreaterThan(results.indexOf("🚒"));
});

it("falls back to a substring of a name or keyword", () => {
  expect(found("fighter")).toContain("🧑‍🚒");
});

it("ignores case, diacritics and surrounding space", () => {
  expect(found("  FIRE ")[0]).toBe("🔥");
  expect(found("coracao vermelho")[0]).toBe("❤️");
});

it("finds an emoji typed or pasted into the search", () => {
  expect(found("🔥")).toEqual(["🔥"]);
});

it("names every result in English", () => {
  expect(searchEmoji(index, "fogo")[0]?.name).toBe("fire");
});

it("lists skin-tone variants of an emoji once, as the base emoji", () => {
  expect(found("waving hand")).toEqual(["👋"]);
});

it("caps a broad query at the result limit", () => {
  expect(found("a")).toHaveLength(searchResultLimit);
});

it("finds nothing for an empty or unmatched query", () => {
  expect(found("   ")).toEqual([]);
  expect(found("zebra-unicorn")).toEqual([]);
});

it("loads the annotations chunk once", async () => {
  const first = await loadEmojiIndex();

  expect(await loadEmojiIndex()).toBe(first);
  expect(first.byEmoji.get("🔥")?.name).toBe("fire");
});
