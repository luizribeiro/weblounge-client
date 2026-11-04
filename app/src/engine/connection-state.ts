import type { NetworkProjection } from "./protocol";

export type ConnectionStateKind =
  | "connecting"
  | "registering"
  | "online"
  | "reconnecting"
  | "offline"
  | "failed";

export interface ActionableConnectionError {
  readonly action: "retry" | "sign_in";
  readonly message: string;
  readonly networkId: number;
}

export interface ConnectionPresentation {
  readonly error: ActionableConnectionError | undefined;
  readonly progressing: boolean;
  readonly sendsBlocked: boolean;
}

export function connectionStateKind(
  state: NetworkProjection["state"],
): ConnectionStateKind {
  if (typeof state === "string") return state;
  if ("reconnecting" in state) return "reconnecting";
  if ("failed" in state) return "failed";
  return "offline";
}

export function connectionPresentation(
  networks: readonly NetworkProjection[],
  hydrating = false,
): ConnectionPresentation {
  const failed = networks.find(
    (network) => connectionStateKind(network.state) === "failed",
  );
  const failure =
    failed?.state !== undefined &&
    typeof failed.state === "object" &&
    "failed" in failed.state
      ? failed.state.failed
      : undefined;
  return {
    error:
      failed === undefined || failure === undefined
        ? undefined
        : {
            action: failure.reason === "authentication" ? "sign_in" : "retry",
            message:
              failure.reason === "authentication"
                ? "Session expired"
                : "Couldn't connect",
            networkId: failed.id,
          },
    progressing:
      failure === undefined &&
      (hydrating ||
        networks.some((network) => {
          const kind = connectionStateKind(network.state);
          return (
            kind === "connecting" ||
            kind === "registering" ||
            kind === "reconnecting" ||
            (kind === "offline" &&
              typeof network.state === "object" &&
              "offline" in network.state &&
              network.state.offline.reason === "device_offline")
          );
        })),
    sendsBlocked: networks.some(
      (network) => connectionStateKind(network.state) !== "online",
    ),
  };
}

export function connectionFailureMessage(
  state: NetworkProjection["state"],
): string | undefined {
  return typeof state === "object" && "failed" in state
    ? state.failed.message_key
    : undefined;
}
