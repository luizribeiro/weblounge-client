import { t } from "../../strings";
import { type EmojiEntry, type EmojiIndex, searchEmoji } from "./emoji-search";
import { phoneQuickReactions } from "./quick-reactions";

export interface EmojiGroup {
  readonly name: string;
  readonly entries: readonly EmojiEntry[];
}

interface BrowseGroup {
  readonly name: string;
  readonly emoji: readonly string[];
}

const categories: readonly (readonly [string, string])[] = [
  [
    "Smileys",
    "😀 😃 😄 😁 😆 😅 🤣 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤔 🤨 😐 😑 😶 🙄 😏 😬 😮 😯 😲 😳 🥺 😢 😭 😤 😡 🤯 😱 🥳 😎 🤓 🥱 😴 🤒 🤧 🥶 🥵 🤡 💀 👻 🤖",
  ],
  [
    "People",
    "👋 🤚 ✋ 🖖 👌 🤌 ✌️ 🤞 🤟 🤘 👈 👉 👆 👇 👎 ✊ 👏 🙌 🤝 💪 🧠 👁️ 🫶 🙇 🤷 🤦 🙋 🏃",
  ],
  [
    "Nature",
    "🐛 🐞 🐝 🦀 🐍 🐧 🐳 🦊 🐱 🐶 🦉 🐢 🌱 🌵 🌸 🍀 🌈 ☀️ 🌙 ⭐ ⚡ ❄️ 🌊 🌍",
  ],
  ["Food", "☕ 🍵 🍺 🍷 🍕 🍔 🌮 🍣 🍜 🍩 🍪 🎂 🍎 🍋 🥑 🌶️ 🍿 🧀"],
  [
    "Objects",
    "🚀 💻 ⌨️ 🖥️ 📱 🔋 🔌 💡 🔧 🔨 ⚙️ 🧪 📦 📌 📎 🔒 🔑 📝 📚 🎯 🏆 🎁 🔔 ⏰ ⌛",
  ],
  [
    "Symbols",
    "💯 ✔️ ❌ ❗ ❓ ⚠️ 🚫 ♻️ ➕ ➖ 💬 💭 💤 🆗 🆕 🆒 🔴 🟢 🟡 🔵 💔 💜 💚 💙",
  ],
];

export const browseGroups: readonly BrowseGroup[] = [
  { name: "Frequent", emoji: [...phoneQuickReactions, "🙏", "🔥"] },
  ...categories.map(([name, list]) => ({ name, emoji: list.split(" ") })),
];

/**
 * The hand-picked categories while the query is empty, else one ranked list of
 * matches. Until the annotations load, browsing labels each emoji with itself
 * and search has nothing to show.
 */
export function pickerGroups(
  index: EmojiIndex | undefined,
  query: string,
): readonly EmojiGroup[] {
  if (query.trim() === "") {
    return browseGroups.map(({ name, emoji }) => ({
      name,
      entries: emoji.map(
        (glyph) => index?.byEmoji.get(glyph) ?? { emoji: glyph, name: glyph },
      ),
    }));
  }
  const entries = index === undefined ? [] : searchEmoji(index, query);
  return entries.length === 0 ? [] : [{ name: t("reaction.results"), entries }];
}
