import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const emojiVersion = "15.1";
const cldrVersion = "49.0.0";
const locales = ["en", "pt"];
const cldrBase = `https://raw.githubusercontent.com/unicode-org/cldr-json/${cldrVersion}/cldr-json`;
const outputPath = resolve(
  import.meta.dirname,
  "../src/assets/emoji-annotations.json",
);

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function cldrAnnotations(locale) {
  const [plain, derived] = await Promise.all([
    download(
      `${cldrBase}/cldr-annotations-full/annotations/${locale}/annotations.json`,
    ),
    download(
      `${cldrBase}/cldr-annotations-derived-full/annotationsDerived/${locale}/annotations.json`,
    ),
  ]);
  return {
    ...JSON.parse(derived).annotationsDerived.annotations,
    ...JSON.parse(plain).annotations.annotations,
  };
}

const skinToneModifier = /[\u{1F3FB}-\u{1F3FF}]/u;

/** Fully-qualified emoji in Unicode order, without skin-tone variants or bare components. */
function listedEmoji(emojiTest) {
  const listed = [];
  let group = "";
  for (const line of emojiTest.split("\n")) {
    if (line.startsWith("# group: ")) group = line.slice("# group: ".length);
    const match = /; fully-qualified\s+# (\S+) E\S+ (.+)$/u.exec(line);
    if (match === null || group === "Component") continue;
    const [, emoji, name] = match;
    if (!skinToneModifier.test(emoji)) listed.push({ emoji, name });
  }
  return listed;
}

/** CLDR keys drop the emoji presentation selector. */
function annotationFor(annotations, emoji) {
  return annotations[emoji] ?? annotations[emoji.replaceAll("️", "")];
}

function localeFields(annotation, fallbackName) {
  const name = annotation?.tts?.[0] ?? fallbackName;
  const keywords = (annotation?.default ?? []).filter(
    (keyword) => keyword !== name,
  );
  return [name, keywords.join("|")];
}

const emojiTest = await download(
  `https://unicode.org/Public/emoji/${emojiVersion}/emoji-test.txt`,
);
const annotations = await Promise.all(locales.map(cldrAnnotations));
const entries = listedEmoji(emojiTest).map(({ emoji, name }) => [
  emoji,
  ...annotations.flatMap((byEmoji, index) =>
    localeFields(
      annotationFor(byEmoji, emoji),
      locales[index] === "en" ? name : "",
    ),
  ),
]);
await writeFile(
  outputPath,
  `${JSON.stringify({ emojiVersion, cldrVersion, locales, entries })}\n`,
);
console.log(`wrote ${entries.length} emoji to ${outputPath}`);
