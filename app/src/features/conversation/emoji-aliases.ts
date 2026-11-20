/**
 * Chat words that CLDR lacks for an emoji, or lists on so many others that the
 * emoji people mean ranks too low. Each alias ranks like an exact name.
 */
export const emojiAliases: Readonly<Record<string, string>> = {
  heart: "❤️",
  lol: "😂",
  lit: "🔥",
  yay: "🎉",
  ty: "🙏",
  done: "✅",
  lgtm: "👍",
  shipit: "🚀",
  fix: "🔧",
  rust: "🦀",
  python: "🐍",
  linux: "🐧",
  docker: "🐳",
};
