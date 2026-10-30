export type MessageToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "nick"; readonly value: string }
  | { readonly kind: "channel"; readonly value: string }
  | { readonly kind: "link"; readonly href: string; readonly value: string };

const candidatePattern =
  /(?:https?|irc):\/\/[^\s<]+|www\.[^\s<]+|[#&][\p{L}\p{N}_\-[\]{}\\`^|]+|[\p{L}\p{N}_\-[\]{}\\`^|]+/giu;

export function tokenizeMessage(
  text: string,
  nicknames: Iterable<string> = [],
): readonly MessageToken[] {
  const foldedNicks = new Set(
    [...nicknames].map((nickname) => nickname.toLocaleLowerCase()),
  );
  const tokens: MessageToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(candidatePattern)) {
    const index = match.index;
    const candidate = match[0];
    appendText(tokens, text.slice(cursor, index));
    if (isLinkCandidate(candidate)) {
      const link = normalizeLink(candidate);
      if (link === undefined) appendText(tokens, candidate);
      else {
        tokens.push({ kind: "link", href: link.href, value: link.value });
        appendText(tokens, candidate.slice(link.value.length));
      }
    } else if (isChannelCandidate(text, index, candidate)) {
      tokens.push({ kind: "channel", value: candidate });
    } else if (foldedNicks.has(candidate.toLocaleLowerCase())) {
      tokens.push({ kind: "nick", value: candidate });
    } else appendText(tokens, candidate);
    cursor = index + candidate.length;
  }
  appendText(tokens, text.slice(cursor));
  return tokens;
}

function isLinkCandidate(value: string): boolean {
  return /^(?:https?|irc):\/\//iu.test(value) || /^www\./iu.test(value);
}

function normalizeLink(
  candidate: string,
): { readonly href: string; readonly value: string } | undefined {
  const value = trimLinkEnd(candidate);
  const href = /^www\./iu.test(value) ? `https://${value}` : value;
  try {
    const url = new URL(href);
    if (!["http:", "https:", "irc:"].includes(url.protocol)) return undefined;
    if (url.hostname === "") return undefined;
    return { href: url.href, value };
  } catch {
    return undefined;
  }
}

function trimLinkEnd(candidate: string): string {
  let value = candidate;
  while (/[.,!?;:'">]$/u.test(value)) value = value.slice(0, -1);
  for (const [opening, closing] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    while (
      value.endsWith(closing) &&
      count(value, closing) > count(value, opening)
    )
      value = value.slice(0, -1);
  }
  return value;
}

function count(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}

function isChannelCandidate(
  text: string,
  index: number,
  candidate: string,
): boolean {
  if (!candidate.startsWith("#") && !candidate.startsWith("&")) return false;
  const previous = text.slice(0, index).at(-1);
  return previous === undefined || !/[\p{L}\p{N}_]/u.test(previous);
}

function appendText(tokens: MessageToken[], value: string): void {
  if (value === "") return;
  const previous = tokens.at(-1);
  if (previous?.kind === "text") {
    tokens[tokens.length - 1] = {
      kind: "text",
      value: previous.value + value,
    };
  } else tokens.push({ kind: "text", value });
}
