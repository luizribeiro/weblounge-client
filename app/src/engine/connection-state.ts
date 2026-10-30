import type { NetworkProjection } from "./protocol";

export type ConnectionStateKind =
  | "connecting"
  | "registering"
  | "online"
  | "reconnecting"
  | "offline"
  | "failed";

export type ConnectionColorToken = "online" | "muted";

export interface ConnectionPresentation {
  readonly kind: ConnectionStateKind;
  readonly label: string;
  readonly colorToken: ConnectionColorToken;
}

export function connectionStateKind(
  state: NetworkProjection["state"],
): ConnectionStateKind {
  return connectionPresentation(state).kind;
}

export function connectionPresentation(
  state: NetworkProjection["state"],
): ConnectionPresentation {
  if (state === "online")
    return { kind: state, label: "Online", colorToken: "online" };
  if (state === "connecting" || state === "registering")
    return { kind: state, label: "Connecting…", colorToken: "muted" };
  if (typeof state === "object" && "reconnecting" in state)
    return {
      kind: "reconnecting",
      label: "Reconnecting…",
      colorToken: "muted",
    };
  if (typeof state === "object" && "failed" in state)
    return {
      kind: "failed",
      label: "Offline · Retry",
      colorToken: "muted",
    };
  return { kind: "offline", label: "Offline", colorToken: "muted" };
}

export function connectionOverview(
  networks: readonly NetworkProjection[],
): ConnectionPresentation {
  const presentations = networks.map((network) =>
    connectionPresentation(network.state),
  );
  for (const kind of [
    "reconnecting",
    "connecting",
    "registering",
    "failed",
    "offline",
  ] as const) {
    const presentation = presentations.find((item) => item.kind === kind);
    if (presentation !== undefined) return presentation;
  }
  return (
    presentations[0] ?? {
      kind: "offline",
      label: "Offline",
      colorToken: "muted",
    }
  );
}

export function connectionSummary(
  networks: readonly NetworkProjection[],
): string {
  const overview = connectionOverview(networks);
  return overview.kind === "online" ? "" : overview.label;
}

export function connectionFailureMessage(
  state: NetworkProjection["state"],
): string | undefined {
  return typeof state === "object" && "failed" in state
    ? state.failed.message_key
    : undefined;
}
