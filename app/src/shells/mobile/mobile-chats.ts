import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";

export type ChatFilter = "all" | "channels" | "direct" | "unread";

export const chatFilters: readonly { id: ChatFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "channels", label: "Channels" },
  { id: "direct", label: "Direct" },
];

export function filterChats(
  buffers: readonly BufferProjection[],
  filter: ChatFilter,
  query: string,
): BufferProjection[] {
  const search = query.trim().toLocaleLowerCase();
  return buffers.filter((buffer) => {
    if (buffer.kind === "server") return false;
    if (filter === "channels" && buffer.kind !== "channel") return false;
    if (filter === "direct" && buffer.kind !== "direct") return false;
    if (filter === "unread" && buffer.unread === 0 && buffer.mentions === 0)
      return false;
    if (search === "") return true;
    const message = buffer.last_message;
    return [buffer.title, message?.author, message?.text]
      .filter((part) => part !== undefined)
      .some((part) => part.toLocaleLowerCase().includes(search));
  });
}

export function networkLabel(
  networks: readonly NetworkProjection[],
  networkId: number,
): string | undefined {
  if (networkId === networks[0]?.id) return undefined;
  return networks.find((network) => network.id === networkId)?.label;
}

export function connectionSummary(
  networks: readonly NetworkProjection[],
): string {
  const online = networks.filter(
    (network) => network.state === "online",
  ).length;
  if (online === networks.length && online > 0) {
    return `connected · ${online} ${online === 1 ? "network" : "networks"}`;
  }
  if (networks.some((network) => network.state === "reconnecting"))
    return "reconnecting";
  if (networks.some((network) => network.state === "connecting"))
    return "connecting";
  return networks.length === 0 ? "offline" : `${online} connected`;
}
