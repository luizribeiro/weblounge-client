import type { BuildVersion } from "../../build-version";
import type { ReleaseChannel } from "../../engine/generated/ReleaseChannel";
import type { DisplayMode } from "../../platform/environment";
import type {
  HostShellIdentity,
  HostShellKind,
} from "../../platform/host-shell";
import { type MessageKey, t } from "../../strings";

export interface AboutInput {
  readonly build: BuildVersion;
  readonly channel: ReleaseChannel;
  readonly shell: HostShellIdentity | undefined;
  readonly display: DisplayMode;
}

export interface AboutFact {
  readonly label: MessageKey;
  readonly value: string;
  readonly copied: string;
}

const channelNames: Readonly<Record<ReleaseChannel, MessageKey>> = {
  beta: "settings.about.channel.beta",
  release: "settings.about.channel.release",
};

const nativeApps: Readonly<Record<HostShellKind, MessageKey>> = {
  "macos-app": "settings.about.platform.macos_app",
  "ios-app": "settings.about.platform.ios_app",
};

const webPlatforms: Readonly<Record<DisplayMode, MessageKey>> = {
  browser: "settings.about.platform.browser_tab",
  standalone: "settings.about.platform.installed",
  tauri: "settings.about.platform.native",
};

function platformName(
  shell: HostShellIdentity | undefined,
  display: DisplayMode,
): string {
  return shell === undefined
    ? t(webPlatforms[display])
    : t(nativeApps[shell.kind], { version: shell.version });
}

export function channelName(channel: ReleaseChannel): string {
  return t(channelNames[channel]);
}

export function aboutFacts(input: AboutInput): readonly AboutFact[] {
  const { build } = input;
  const built = build.built ?? t("settings.about.built.dev");
  const platform = platformName(input.shell, input.display);
  const channel = channelName(input.channel);
  return [
    fact("settings.about.version", build.version),
    { label: "settings.about.commit", value: build.sha, copied: build.commit },
    fact("settings.about.built", built),
    fact("settings.about.channel", channel),
    fact("settings.about.platform", platform),
  ];
}

export function debugInfoText(
  facts: readonly AboutFact[],
  userAgent: string,
): string {
  const lines = [
    ...facts.map(({ label, copied }) => line(t(label), copied)),
    line(t("settings.about.user_agent"), userAgent),
  ];
  return [t("settings.about.copy_heading"), ...lines].join("\n");
}

function fact(label: MessageKey, value: string): AboutFact {
  return { label, value, copied: value };
}

function line(label: string, value: string): string {
  return `${label}: ${value}`;
}
