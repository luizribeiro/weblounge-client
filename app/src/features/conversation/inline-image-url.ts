import { tokenizeMessage } from "./message-tokenizer";

const imagePath = /\.(?:png|jpe?g|gif|webp)$/iu;

export function inlineImageUrl(
  text: string,
  filehostOrigin: string | undefined,
): string | undefined {
  if (filehostOrigin === undefined || !mentionsOrigin(text, filehostOrigin))
    return undefined;
  for (const token of tokenizeMessage(text)) {
    if (token.kind !== "link") continue;
    const url = new URL(token.href);
    if (url.origin === filehostOrigin && imagePath.test(url.pathname))
      return url.href;
  }
  return undefined;
}

// Every transcript row is classified whenever rows are rebuilt; skipping the
// tokenizer for the many messages that cannot match keeps that cheap.
function mentionsOrigin(text: string, origin: string): boolean {
  return text.toLowerCase().includes(new URL(origin).host);
}
