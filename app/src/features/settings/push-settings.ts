import type { HostShell } from "../../platform/host-shell";

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

/** The one notification switch this host offers. */
export type NotificationSwitch = {
  readonly kind: "push";
  readonly push: PushSettings;
};

export interface PushSwitchInputs {
  readonly enabled: boolean | undefined;
  readonly permission: NotificationPermission;
  readonly failing: boolean;
}

/** On means the person chose push; a failing registration is still their choice. */
export function pushSwitchChecked(
  status: PushSwitchStatus | undefined,
): boolean | undefined {
  return status === undefined
    ? undefined
    : status === "on" || status === "failed";
}

export type PushNote =
  | {
      readonly kind: "blocked";
      readonly in: PushBlockedIn;
      readonly openSettings: boolean;
    }
  | { readonly kind: "failed" };

export function pushNote(push: PushSettings): PushNote | undefined {
  if (push.status === "blocked")
    return {
      kind: "blocked",
      in: push.blockedIn,
      openSettings: push.onOpenSystemSettings !== undefined,
    };
  return push.status === "failed" ? { kind: "failed" } : undefined;
}

export function pushBlockedIn(shell: HostShell, ios: boolean): PushBlockedIn {
  if (shell === "macos-app") return "macos";
  return shell === "ios-app" || ios ? "ios" : "browser";
}

export function pushSwitchStatus(
  inputs: PushSwitchInputs,
): PushSwitchStatus | undefined {
  if (inputs.permission === "denied") return "blocked";
  if (inputs.enabled === undefined) return undefined;
  if (!inputs.enabled || inputs.permission !== "granted") return "off";
  return inputs.failing ? "failed" : "on";
}
