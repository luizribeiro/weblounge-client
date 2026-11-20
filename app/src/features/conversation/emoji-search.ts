export interface EmojiEntry {
  readonly emoji: string;
  readonly name: string;
}

interface SearchableEmoji extends EmojiEntry {
  readonly names: readonly string[];
  readonly keywords: readonly string[];
}

export interface EmojiIndex {
  readonly entries: readonly SearchableEmoji[];
  readonly byEmoji: ReadonlyMap<string, SearchableEmoji>;
}

/** Per emoji: the emoji, then a name and `|`-joined keywords for each locale, English first. */
export interface EmojiAnnotations {
  readonly entries: readonly (readonly string[])[];
}

export const searchResultLimit = 112;

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function searchable(row: readonly string[]): SearchableEmoji {
  const [emoji = "", ...locales] = row;
  const names = locales.filter((_, index) => index % 2 === 0);
  const keywords = locales
    .filter((_, index) => index % 2 === 1)
    .flatMap((list) => (list === "" ? [] : list.split("|")));
  return {
    emoji,
    name: names[0] ?? emoji,
    names: names.map(fold),
    keywords: keywords.map(fold),
  };
}

export function buildEmojiIndex(annotations: EmojiAnnotations): EmojiIndex {
  const entries = annotations.entries.map(searchable);
  return {
    entries,
    byEmoji: new Map(entries.map((entry) => [entry.emoji, entry])),
  };
}

function matchTier(entry: SearchableEmoji, needle: string): number {
  if (entry.names.includes(needle)) return 0;
  if (entry.names.some((name) => name.startsWith(needle))) return 1;
  if (entry.keywords.some((keyword) => keyword.startsWith(needle))) return 2;
  const terms = [...entry.names, ...entry.keywords];
  return terms.some((term) => term.includes(needle)) ? 3 : Infinity;
}

/** Best match first; ties keep Unicode order. */
export function searchEmoji(
  index: EmojiIndex,
  query: string,
): readonly EmojiEntry[] {
  const typed = query.trim();
  const exact = index.byEmoji.get(typed);
  if (exact !== undefined) return [exact];
  const needle = fold(typed);
  if (needle === "") return [];
  return index.entries
    .map((entry, order) => ({ entry, order, tier: matchTier(entry, needle) }))
    .filter((match) => match.tier !== Infinity)
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, searchResultLimit)
    .map((match) => match.entry);
}

let loading: Promise<EmojiIndex> | undefined;

/** Loads the CLDR annotations chunk once; a failed load is retried on the next call. */
export function loadEmojiIndex(): Promise<EmojiIndex> {
  loading ??= import("../../assets/emoji-annotations.json").then(
    (module) => buildEmojiIndex(module.default),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}
