import { type DeviceTarget, isDeviceTarget } from "./device-target";
import type { PushRouteDiagnostic } from "./push-sync";
import type { RelayDevice } from "./relay-client";

export type PushSyncMessage =
  | { readonly kind: "refresh"; readonly target: DeviceTarget }
  | { readonly kind: "device"; readonly device: RelayDevice }
  | { readonly kind: "diagnostic"; readonly value: PushRouteDiagnostic }
  | { readonly kind: "sign_out" };

export function decodePushSyncMessage(
  value: unknown,
): PushSyncMessage | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "sign_out") return { kind: "sign_out" };
  if (value.kind === "refresh" && isDeviceTarget(value.target)) {
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
