import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { t } from "../../strings";

export type ChatFilter = "all" | "channels" | "direct" | "unread";

export const chatFilters: readonly { id: ChatFilter; label: string }[] = [
  { id: "all", label: t("mobile.filter.all") },
  { id: "unread", label: t("mobile.filter.unread") },
  { id: "channels", label: t("mobile.filter.channels") },
  { id: "direct", label: t("mobile.filter.direct") },
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
