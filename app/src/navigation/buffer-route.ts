import type { BufferProjection, NetworkProjection } from "../engine/protocol";

export type BufferRoute =
  | { readonly kind: "server"; readonly network: string }
  | {
      readonly kind: "channel" | "direct";
      readonly network: string;
      readonly name: string;
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

function channelDestination(title: string): string {
  return title.startsWith("#") ? title.slice(1) : title;
}
