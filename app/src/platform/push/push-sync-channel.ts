import type { PushState } from "../../engine/generated/PushState";
import type { EngineClientMessage } from "../../engine/protocol";
import type { RelayDevice } from "./relay-client";
import type { PushRouteDiagnostic } from "./push-sync";
import type { WebPushTarget } from "./subscription";

export type PushSyncEvent = Extract<
  EngineClientMessage,
  { readonly type: "push_route_required" | "push_state_changed" }
>;

export type PushSyncMessage =
  | { readonly kind: "event"; readonly event: PushSyncEvent }
  | { readonly kind: "refresh"; readonly target: WebPushTarget }
  | { readonly kind: "device"; readonly device: RelayDevice }
  | { readonly kind: "diagnostic"; readonly value: PushRouteDiagnostic }
  | { readonly kind: "sign_out" };

export function decodePushSyncMessage(
  value: unknown,
): PushSyncMessage | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "sign_out") return { kind: "sign_out" };
  if (value.kind === "event" && isPushSyncEvent(value.event)) {
    return { kind: "event", event: value.event };
  }
  if (value.kind === "refresh" && isWebPushTarget(value.target)) {
    return { kind: "refresh", target: value.target };
  }
  if (value.kind === "device" && isRelayDevice(value.device)) {
    return { kind: "device", device: value.device };
  }
  if (value.kind === "diagnostic" && isPushDiagnostic(value.value)) {
    return { kind: "diagnostic", value: value.value };
  }
  return undefined;
}

function isPushSyncEvent(value: unknown): value is PushSyncEvent {
  if (!isRecord(value) || typeof value.network_id !== "number") return false;
  if (value.type === "push_route_required") {
    return (
      typeof value.vapid === "string" &&
      (value.previous_route_id === null ||
        typeof value.previous_route_id === "string")
    );
  }
  return value.type === "push_state_changed" && isPushState(value.state);
}

function isPushState(value: unknown): value is PushState {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (
    value.status === "registered" ||
    value.status === "registered_but_no_delivery"
  ) {
    return typeof value.route_id === "string";
  }
  if (value.status === "unsupported") {
    return ["no_web_push", "no_account", "no_vapid"].includes(
      String(value.reason),
    );
  }
  return (
    value.status === "failed" &&
    typeof value.route_id === "string" &&
    [
      "web_push_forbidden",
      "registration_limit",
      "request_limit",
      "invalid_parameters",
      "internal",
      "connection",
      "other",
    ].includes(String(value.reason))
  );
}

function isWebPushTarget(value: unknown): value is WebPushTarget {
  return (
    isRecord(value) &&
    typeof value.endpoint === "string" &&
    typeof value.p256dh === "string" &&
    typeof value.auth === "string"
  );
}

function isRelayDevice(value: unknown): value is RelayDevice {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.secret === "string"
  );
}

function isPushDiagnostic(value: unknown): value is PushRouteDiagnostic {
  return (
    isRecord(value) &&
    typeof value.networkId === "number" &&
    ["none", "probing", "active", "dead"].includes(String(value.state)) &&
    (value.routeIdPrefix === undefined ||
      typeof value.routeIdPrefix === "string") &&
    (value.lastError === undefined || typeof value.lastError === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
