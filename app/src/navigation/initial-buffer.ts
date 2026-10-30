import type { BufferProjection, NetworkProjection } from "../engine/protocol";
import {
  bufferPath,
  parseBufferRoute,
  type ResolvedBufferRoute,
  resolveBufferRoute,
} from "./buffer-route";

const lastViewedKey = "weblounge.navigation.last-viewed";

export type InitialDestination =
  | {
      readonly kind: "buffer";
      readonly bufferId: number;
      readonly path: string;
    }
  | {
      readonly kind: "not_joined";
      readonly networkId: number;
      readonly channel: string;
    };

export function initialDestination(
  pathname: string,
  storedPath: string | undefined,
  networks: readonly NetworkProjection[],
  buffers: readonly BufferProjection[],
  loadedNetworkIds: ReadonlySet<number>,
): InitialDestination | undefined {
  if (loadedNetworkIds.size === 0) return undefined;
  const route = parseBufferRoute(pathname);
  const fromUrl = routeDestination(route, networks, buffers, loadedNetworkIds);
  if (fromUrl === "waiting") return undefined;
  if (fromUrl !== undefined) return fromUrl;
  const storedRoute =
    storedPath === undefined ? undefined : parseBufferRoute(storedPath);
  const fromStorage = routeDestination(
    storedRoute,
    networks,
    buffers,
    loadedNetworkIds,
  );
  if (fromStorage === "waiting") return undefined;
  if (fromStorage?.kind === "buffer") return fromStorage;
  const fallback =
    buffers.find(
      (buffer) =>
        loadedNetworkIds.has(buffer.network_id) && buffer.kind === "channel",
    ) ?? buffers.find((buffer) => loadedNetworkIds.has(buffer.network_id));
  if (fallback === undefined) return undefined;
  const network = networks.find(
    (candidate) => candidate.id === fallback.network_id,
  );
  return network === undefined
    ? undefined
    : {
        kind: "buffer",
        bufferId: fallback.id,
        path: bufferPath(network, fallback),
      };
}

export function readLastViewedPath(
  storage: Storage = localStorage,
): string | undefined {
  try {
    return storage.getItem(lastViewedKey) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLastViewedPath(
  path: string,
  storage: Storage = localStorage,
): void {
  if (parseBufferRoute(path) === undefined) return;
  try {
    storage.setItem(lastViewedKey, path);
  } catch {
    // Browsing remains usable when device-local storage is unavailable.
  }
}

function routeDestination(
  route: ReturnType<typeof parseBufferRoute>,
  networks: readonly NetworkProjection[],
  buffers: readonly BufferProjection[],
  loadedNetworkIds: ReadonlySet<number>,
): InitialDestination | "waiting" | undefined {
  if (route === undefined) return undefined;
  const network = networks.find(
    (candidate) =>
      candidate.label.toLowerCase() === route.network.toLowerCase(),
  );
  if (network !== undefined && !loadedNetworkIds.has(network.id))
    return "waiting";
  const resolved = resolveBufferRoute(route, networks, buffers);
  if (resolved === undefined) return undefined;
  return withPath(resolved, networks, buffers);
}

function withPath(
  resolved: ResolvedBufferRoute,
  networks: readonly NetworkProjection[],
  buffers: readonly BufferProjection[],
): InitialDestination | undefined {
  if (resolved.kind === "not_joined") return resolved;
  const buffer = buffers.find(
    (candidate) => candidate.id === resolved.bufferId,
  );
  const network = networks.find(
    (candidate) => candidate.id === buffer?.network_id,
  );
  return buffer === undefined || network === undefined
    ? undefined
    : {
        kind: "buffer",
        bufferId: buffer.id,
        path: bufferPath(network, buffer),
      };
}
