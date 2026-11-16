export type HostShellKind = "macos-app";
export type HostShell = HostShellKind | "web";

export interface WindowControls {
  readonly inlineStart: number;
  readonly blockSize: number;
}

export interface HostShellIdentity {
  readonly kind: HostShellKind;
  readonly version: string;
  readonly windowControls?: WindowControls;
}

declare global {
  interface Window {
    readonly __WEBLOUNGE_SHELL__?: unknown;
  }
}

const hostShellKinds: readonly HostShellKind[] = ["macos-app"];

// Presentation only: any page script can set this global, so it must never gate a security decision.
export function hostShellIdentity(
  scope: Pick<Window, "__WEBLOUNGE_SHELL__"> = window,
): HostShellIdentity | undefined {
  const shell = scope.__WEBLOUNGE_SHELL__;
  if (
    typeof shell !== "object" ||
    shell === null ||
    !("kind" in shell) ||
    !("version" in shell) ||
    typeof shell.version !== "string"
  )
    return undefined;
  const kind = hostShellKinds.find((known) => known === shell.kind);
  if (kind === undefined) return undefined;
  const windowControls =
    "windowControls" in shell
      ? parseWindowControls(shell.windowControls)
      : undefined;
  return windowControls === undefined
    ? { kind, version: shell.version }
    : { kind, version: shell.version, windowControls };
}

export function hostShell(
  scope: Pick<Window, "__WEBLOUNGE_SHELL__"> = window,
): HostShell {
  return hostShellIdentity(scope)?.kind ?? "web";
}

function parseWindowControls(value: unknown): WindowControls | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("inlineStart" in value) ||
    !("blockSize" in value) ||
    !isCssLength(value.inlineStart) ||
    !isCssLength(value.blockSize)
  )
    return undefined;
  return { inlineStart: value.inlineStart, blockSize: value.blockSize };
}

function isCssLength(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
