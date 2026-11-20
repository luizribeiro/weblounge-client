import { expect, it } from "vitest";
import annotations from "../../assets/emoji-annotations.json";
import { browseGroups, pickerGroups } from "./emoji-catalog";
import { buildEmojiIndex } from "./emoji-search";

const index = buildEmojiIndex(annotations);

it("browses the hand-picked categories with their CLDR names", () => {
  const groups = pickerGroups(index, "");

  expect(groups.map((group) => group.name)).toEqual(
    browseGroups.map(({ name }) => name),
  );
  expect(
    groups[0]?.entries.slice(0, 3).map(({ emoji, name }) => ({ emoji, name })),
  ).toEqual([
    { emoji: "👍", name: "thumbs up" },
    { emoji: "❤️", name: "red heart" },
    { emoji: "😂", name: "face with tears of joy" },
  ]);
});

it("names every browsed emoji from the annotations", () => {
  const unnamed = browseGroups
    .flatMap(({ emoji }) => emoji)
    .filter((emoji) => !index.byEmoji.has(emoji));

  expect(unnamed).toEqual([]);
});

it("shows matches as one ranked list, including emoji outside the categories", () => {
  const groups = pickerGroups(index, "fire");

  expect(groups.map((group) => group.name)).toEqual(["Results"]);
  const found = groups[0]?.entries.map((entry) => entry.emoji);
  expect(found?.[0]).toBe("🔥");
  expect(found).toContain("🧯");
});

it("shows no group when nothing matches", () => {
  expect(pickerGroups(index, "zebra-unicorn")).toEqual([]);
});

it("browses before the annotations load, but searches only after", () => {
  expect(pickerGroups(undefined, "")[0]?.entries[0]).toEqual({
    emoji: "👍",
    name: "👍",
  });
  expect(pickerGroups(undefined, "fire")).toEqual([]);
});
