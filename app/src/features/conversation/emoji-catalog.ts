export interface EmojiEntry {
  readonly emoji: string;
  readonly name: string;
}

export interface EmojiGroup {
  readonly name: string;
  readonly entries: readonly EmojiEntry[];
}

const frequentGroup = "Frequent";

const source: readonly (readonly [string, string])[] = [
  [
    frequentGroup,
    "👍 thumbs up +1|❤️ heart love|😂 joy laugh|🎉 party tada|👀 eyes looking|✅ check done|🙏 thanks pray|🔥 fire",
  ],
  [
    "Smileys",
    "😀 grin|😃 smile|😄 happy|😁 beam|😆 laughing|😅 sweat smile|🤣 rofl|🙂 slight smile|🙃 upside down|😉 wink|😊 blush|😇 halo|🥰 adore|😍 heart eyes|🤩 star struck|😘 kiss|😋 yum|😛 tongue|😜 wink tongue|🤪 zany|🤔 thinking|🤨 raised brow|😐 neutral|😑 expressionless|😶 no mouth|🙄 eye roll|😏 smirk|😬 grimace|😮 wow surprised|😯 hushed|😲 astonished|😳 flushed|🥺 pleading|😢 sad cry|😭 sob|😤 huff|😡 angry|🤯 mind blown|😱 scream|🥳 partying|😎 cool sunglasses|🤓 nerd|🥱 yawn|😴 sleeping|🤒 sick|🤧 sneeze|🥶 cold|🥵 hot|🤡 clown|💀 skull|👻 ghost|🤖 robot",
  ],
  [
    "People",
    "👋 wave hi|🤚 raised back|✋ hand|🖖 vulcan|👌 ok|🤌 pinched|✌️ peace|🤞 fingers crossed|🤟 love you|🤘 rock|👈 left|👉 right|👆 up|👇 down|👎 thumbs down|✊ fist|👏 clap|🙌 raised hands|🤝 handshake|💪 strong|🧠 brain|👁️ eye|🫶 heart hands|🙇 bow|🤷 shrug|🤦 facepalm|🙋 raising hand|🏃 run",
  ],
  [
    "Nature",
    "🐛 bug|🐞 ladybug|🐝 bee|🦀 crab rust|🐍 snake python|🐧 penguin linux|🐳 whale docker|🦊 fox|🐱 cat|🐶 dog|🦉 owl|🐢 turtle slow|🌱 seedling|🌵 cactus|🌸 blossom|🍀 clover luck|🌈 rainbow|☀️ sun|🌙 moon|⭐ star|⚡ lightning|❄️ snow|🌊 wave water|🌍 earth",
  ],
  [
    "Food",
    "☕ coffee|🍵 tea|🍺 beer|🍷 wine|🍕 pizza|🍔 burger|🌮 taco|🍣 sushi|🍜 ramen|🍩 donut|🍪 cookie|🎂 cake|🍎 apple|🍋 lemon|🥑 avocado|🌶️ pepper hot|🍿 popcorn|🧀 cheese",
  ],
  [
    "Objects",
    "🚀 rocket ship|💻 laptop|⌨️ keyboard|🖥️ desktop|📱 phone|🔋 battery|🔌 plug|💡 idea bulb|🔧 wrench fix|🔨 hammer|⚙️ gear|🧪 test tube|📦 package|📌 pin|📎 clip|🔒 lock|🔑 key|📝 memo|📚 books|🎯 target|🏆 trophy|🎁 gift|🔔 bell|⏰ alarm|⌛ hourglass",
  ],
  [
    "Symbols",
    "💯 hundred|✔️ check mark|❌ cross|❗ exclamation|❓ question|⚠️ warning|🚫 no|♻️ recycle|➕ plus|➖ minus|💬 speech|💭 thought|💤 zzz|🆗 ok button|🆕 new|🆒 cool button|🔴 red circle|🟢 green circle|🟡 yellow circle|🔵 blue circle|💔 broken heart|💜 purple heart|💚 green heart|💙 blue heart",
  ],
];

export const emojiGroups: readonly EmojiGroup[] = source.map(
  ([name, list]) => ({
    name,
    entries: list.split("|").map((item) => {
      const space = item.indexOf(" ");
      return { emoji: item.slice(0, space), name: item.slice(space + 1) };
    }),
  }),
);

/** Searching hides Frequent, whose entries repeat in their own categories. */
export function searchEmoji(query: string): readonly EmojiGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return emojiGroups;
  return emojiGroups
    .filter((group) => group.name !== frequentGroup)
    .map((group) => ({
      name: group.name,
      entries: group.entries.filter(
        (entry) => entry.name.includes(needle) || entry.emoji === needle,
      ),
    }))
    .filter((group) => group.entries.length > 0);
}
