import type { PushState } from "../../engine/generated/PushState";
import type { NetworkProjection } from "../../engine/protocol";
import {
  formatNotificationPromptVisibility,
  type NotificationPromptVisibility,
} from "../../features/notifications/notification-prompt-visibility";
import type { PushDebugSnapshot } from "../debug-overlay";
import type { PushRouteDiagnostic } from "./push-sync";

export function buildPushDebugSnapshot(
  prompt: NotificationPromptVisibility,
  networks: readonly NetworkProjection[],
  engineStates: ReadonlyMap<number, PushState>,
  relayStates: ReadonlyMap<number, PushRouteDiagnostic>,
): PushDebugSnapshot {
  const networkReadings = networks.map((network) => {
    const engine = formatEngineState(engineStates.get(network.id));
    const relay = formatRelayState(relayStates.get(network.id));
    const lastError = relayStates.get(network.id)?.lastError ?? "none";
    return [
      `network ${network.label}`,
      `engine=${engine} / relay=${relay} / last error=${lastError}`,
    ] as const;
  });
  return {
    summary:
      networkReadings.length === 0
        ? "no networks"
        : networkReadings
            .map(([label, value]) => `${label}: ${value}`)
            .join("; "),
    readings: [
      ["prompt", formatNotificationPromptVisibility(prompt)],
      ...networkReadings,
    ],
  };
}

function formatEngineState(state: PushState | undefined): string {
  if (state === undefined) return "none";
  switch (state.status) {
    case "registered":
      return `Registered (${idPrefix(state.route_id)})`;
    case "registered_but_no_delivery":
      return `RegisteredButNoDelivery (${idPrefix(state.route_id)})`;
    case "unsupported":
      return `Unsupported(${state.reason})`;
    case "failed":
      return `Failed(${state.reason})`;
  }
}

function formatRelayState(state: PushRouteDiagnostic | undefined): string {
  if (state === undefined) return "none";
  return state.routeIdPrefix === undefined
    ? state.state
    : `${state.state} (${state.routeIdPrefix})`;
}

function idPrefix(id: string): string {
  return id.slice(0, 8);
}
