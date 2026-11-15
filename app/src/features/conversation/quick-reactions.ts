/** Fixed by design 25: the phone sheet offers six, the desktop toolbar the first three. */
export const phoneQuickReactions = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;
export const desktopQuickReactions = phoneQuickReactions.slice(0, 3);
