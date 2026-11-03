import {
  type BufferRoute,
  parseBufferRoute,
} from "../../navigation/buffer-route";

export interface OpenRouteMessage {
  readonly path: string;
  readonly route: BufferRoute;
}

export function decodeOpenRouteMessage(
  value: unknown,
): OpenRouteMessage | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "open-route" ||
    !("route" in value) ||
    typeof value.route !== "string"
  ) {
    return undefined;
  }
  const route = parseBufferRoute(value.route);
  return route === undefined ? undefined : { path: value.route, route };
}
