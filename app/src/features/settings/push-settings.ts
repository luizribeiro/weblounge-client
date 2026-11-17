export type PushSwitchStatus = "off" | "on" | "blocked" | "failed";

export type PushBlockedIn = "ios" | "macos" | "browser";

export interface PushSettings {
  /** Undefined until the engine's settings load. */
  readonly status: PushSwitchStatus | undefined;
  readonly blockedIn: PushBlockedIn;
  readonly onToggle: (on: boolean) => void;
  readonly onRetry: () => void;
  readonly onOpenSystemSettings: (() => void) | undefined;
}

export interface PushSwitchInputs {
  readonly enabled: boolean | undefined;
  readonly permission: NotificationPermission;
  readonly failing: boolean;
}

export function pushSwitchStatus(
  inputs: PushSwitchInputs,
): PushSwitchStatus | undefined {
  if (inputs.permission === "denied") return "blocked";
  if (inputs.enabled === undefined) return undefined;
  if (!inputs.enabled || inputs.permission !== "granted") return "off";
  return inputs.failing ? "failed" : "on";
}
