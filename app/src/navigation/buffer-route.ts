import type { BufferProjection, NetworkProjection } from "../engine/protocol";

export type BufferRoute =
  | { readonly kind: "server"; readonly network: string }
  | {
      readonly kind: "channel" | "direct";
      readonly network: string;
      readonly name: string;
    };

export type ResolvedBufferRoute =
  | { readonly kind: "buffer"; readonly bufferId: number }
  | {
      readonly kind: "not_joined";
      readonly networkId: number;
      readonly channel: string;
    };

export function bufferPath(
  network: NetworkProjection,
  buffer: BufferProjection,
): string {
  const networkSegment = encodeURIComponent(network.label);
  if (buffer.kind === "server") return `/${networkSegment}`;
  const destination =
    buffer.kind === "direct"
      ? `@${encodeURIComponent(buffer.title)}`
      : encodeURIComponent(channelDestination(buffer.title));
  return `/${networkSegment}/${destination}`;
}

export function parseBufferRoute(pathname: string): BufferRoute | undefined {
  const segments = pathname.split("/").slice(1);
  if (
    segments.length < 1 ||
    segments.length > 2 ||
    segments.some((segment) => segment === "")
  )
    return undefined;
  let decoded: string[];
  try {
    decoded = segments.map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [network, destination] = decoded;
  if (network === undefined || network === "") return undefined;
  if (destination === undefined) return { kind: "server", network };
  if (destination.startsWith("@")) {
    const name = destination.slice(1);
    return name === "" ? undefined : { kind: "direct", network, name };
  }
  return {
    kind: "channel",
    network,
    name: destination.startsWith("&") ? destination : `#${destination}`,
  };
}

export function resolveBufferRoute(
  route: BufferRoute,
  networks: readonly NetworkProjection[],
  buffers: readonly BufferProjection[],
): ResolvedBufferRoute | undefined {
  const network = networks.find(
    (candidate) =>
      candidate.label.toLowerCase() === route.network.toLowerCase(),
  );
  if (network === undefined) return undefined;
  const candidates = buffers.filter(
    (buffer) => buffer.network_id === network.id && buffer.kind === route.kind,
  );
  if (route.kind === "server") {
    const server = candidates[0];
    return server === undefined
      ? undefined
      : { kind: "buffer", bufferId: server.id };
  }
  const buffer = candidates.find(
    (candidate) =>
      candidate.title === route.name ||
      foldedDraftName(candidate, network.label) ===
        foldName(route.name, draftCasemapping(candidate, network.label)),
  );
  if (buffer !== undefined) return { kind: "buffer", bufferId: buffer.id };
  return route.kind === "channel"
    ? { kind: "not_joined", networkId: network.id, channel: route.name }
    : undefined;
}

function channelDestination(title: string): string {
  return title.startsWith("#") ? title.slice(1) : title;
}

type Casemapping = "ascii" | "rfc1459" | "rfc1459-strict" | "rfc7613";

function draftParts(
  buffer: BufferProjection,
  network: string,
): { mapping: Casemapping; name: string } | undefined {
  const prefix = `${new TextEncoder().encode(network).length}:${network}:`;
  if (!buffer.draft_key.startsWith(prefix)) return undefined;
  const remainder = buffer.draft_key.slice(prefix.length);
  const separator = remainder.indexOf(":");
  const mapping = remainder.slice(0, separator);
  if (!isCasemapping(mapping)) return undefined;
  return { mapping, name: remainder.slice(separator + 1) };
}

function draftCasemapping(
  buffer: BufferProjection,
  network: string,
): Casemapping {
  return draftParts(buffer, network)?.mapping ?? "ascii";
}

function foldedDraftName(buffer: BufferProjection, network: string): string {
  return draftParts(buffer, network)?.name ?? buffer.title.toLowerCase();
}

function foldName(name: string, mapping: Casemapping): string {
  const lower = name.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  if (mapping === "ascii" || mapping === "rfc7613") return lower;
  return [...lower]
    .map((character) => {
      if (character === "[") return "{";
      if (character === "]") return "}";
      if (character === "\\") return "|";
      if (character === "~" && mapping === "rfc1459") return "^";
      return character;
    })
    .join("");
}

function isCasemapping(value: string): value is Casemapping {
  return ["ascii", "rfc1459", "rfc1459-strict", "rfc7613"].includes(value);
}
