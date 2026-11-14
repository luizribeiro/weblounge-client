export type HostShellKind = "macos-app";
export type HostShell = HostShellKind | "web";

export interface HostShellIdentity {
  readonly kind: HostShellKind;
  readonly version: string;
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
  return kind === undefined ? undefined : { kind, version: shell.version };
}

export function hostShell(
  scope: Pick<Window, "__WEBLOUNGE_SHELL__"> = window,
): HostShell {
  return hostShellIdentity(scope)?.kind ?? "web";
}
