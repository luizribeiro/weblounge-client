import type { NetworkProjection } from "./protocol";

export type ConnectionStateKind =
  | "connecting"
  | "registering"
  | "online"
  | "reconnecting"
  | "offline"
  | "failed";

export function connectionStateKind(
  state: NetworkProjection["state"],
): ConnectionStateKind {
  if (typeof state === "string") return state;
  if ("reconnecting" in state) return "reconnecting";
  if ("offline" in state) return "offline";
  return "failed";
}

export function connectionFailureMessage(
  state: NetworkProjection["state"],
): string | undefined {
  return typeof state === "object" && "failed" in state
    ? state.failed.message_key
    : undefined;
}
