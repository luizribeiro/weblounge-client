import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";

export interface SwitcherBuffer {
  readonly buffer: BufferProjection;
  readonly network: string;
}

export type SwitcherKeyIntent = "dismiss" | "next" | "open" | "previous";

export function switcherBuffers(
  buffers: readonly BufferProjection[],
  networks: readonly NetworkProjection[],
  recentBufferIds: readonly number[],
  query: string,
): readonly SwitcherBuffer[] {
  const networkNames = new Map(
    networks.map((network) => [network.id, network.label]),
  );
  const recency = new Map(recentBufferIds.map((id, index) => [id, index]));
  const needle = normalize(query);
  return buffers
    .filter(
      (buffer) =>
        buffer.kind !== "server" &&
        buffer.available !== false &&
        networkNames.has(buffer.network_id),
    )
    .map((buffer) => ({
      buffer,
      network: networkNames.get(buffer.network_id) ?? "",
      score: fuzzyScore(normalize(buffer.title), needle),
    }))
    .filter((item) => item.score !== undefined)
    .sort((first, second) => {
      if (needle !== "" && first.score !== second.score)
        return (first.score ?? 0) - (second.score ?? 0);
      const firstRecent = recency.get(first.buffer.id);
      const secondRecent = recency.get(second.buffer.id);
      if (firstRecent !== undefined || secondRecent !== undefined)
        return (
          (firstRecent ?? Number.MAX_SAFE_INTEGER) -
          (secondRecent ?? Number.MAX_SAFE_INTEGER)
        );
      if (needle === "")
        return (
          (second.buffer.last_activity_ms ?? 0) -
          (first.buffer.last_activity_ms ?? 0)
        );
      return first.buffer.title.localeCompare(second.buffer.title);
    })
    .map(({ buffer, network }) => ({ buffer, network }));
}

export function moveSwitcherSelection(
  current: number,
  count: number,
  offset: -1 | 1,
): number {
  if (count === 0) return 0;
  return (current + offset + count) % count;
}

export function switcherKeyIntent(
  event: Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "isComposing"
    | "key"
    | "metaKey"
    | "repeat"
    | "shiftKey"
  >,
): SwitcherKeyIntent | undefined {
  if (event.isComposing || event.altKey || event.metaKey || event.shiftKey)
    return undefined;
  if (event.key === "Escape") return "dismiss";
  if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n"))
    return "next";
  if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p"))
    return "previous";
  if (event.key === "Enter" && !event.ctrlKey && !event.repeat) return "open";
  return undefined;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function fuzzyScore(
  haystack: string,
  needle: string,
): number | undefined {
  if (needle === "") return 0;
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 10 + haystack.length - needle.length;
  const includedAt = haystack.indexOf(needle);
  if (includedAt >= 0)
    return 100 + includedAt * 4 + haystack.length - needle.length;

  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const matchedAt = haystack.indexOf(character, cursor);
    if (matchedAt < 0) return undefined;
    gaps += matchedAt - cursor;
    cursor = matchedAt + 1;
  }
  return 1_000 + gaps * 4 + haystack.length - needle.length;
}
