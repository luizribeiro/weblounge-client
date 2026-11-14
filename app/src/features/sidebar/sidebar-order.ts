import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";

type OrderedBuffer = Pick<
  BufferProjection,
  "available" | "id" | "kind" | "network_id"
>;
type OrderedNetwork = Pick<NetworkProjection, "id">;

export function networkBuffers<Buffer extends OrderedBuffer>(
  network: OrderedNetwork,
  buffers: readonly Buffer[],
): Buffer[] {
  return buffers.filter(
    (buffer) => buffer.network_id === network.id && buffer.available !== false,
  );
}

export function serverBuffer<Buffer extends OrderedBuffer>(
  buffers: readonly Buffer[],
): Buffer | undefined {
  return buffers.find((buffer) => buffer.kind === "server");
}

export function conversations<Buffer extends OrderedBuffer>(
  buffers: readonly Buffer[],
): Buffer[] {
  return buffers.filter((buffer) => buffer.kind !== "server");
}

export function sidebarRowIds(
  networks: readonly OrderedNetwork[],
  buffers: readonly OrderedBuffer[],
): number[] {
  return networks.flatMap((network) => {
    const rows = networkBuffers(network, buffers);
    const header = serverBuffer(rows);
    return [
      ...(header === undefined ? [] : [header.id]),
      ...conversations(rows).map((buffer) => buffer.id),
    ];
  });
}

export function jumpSlotsById(
  networks: readonly OrderedNetwork[],
  buffers: readonly OrderedBuffer[],
  slotCount: number,
): ReadonlyMap<number, number> {
  return new Map(
    conversationRowIds(networks, buffers)
      .slice(0, slotCount)
      .map((id, index) => [id, index + 1]),
  );
}

export function conversationRowIds(
  networks: readonly OrderedNetwork[],
  buffers: readonly OrderedBuffer[],
): number[] {
  return networks.flatMap((network) =>
    conversations(networkBuffers(network, buffers)).map((buffer) => buffer.id),
  );
}
