import type { DeploymentConfig } from "../engine/generated/DeploymentConfig";
import type { ReleaseChannel } from "../engine/generated/ReleaseChannel";
import { type MessageKey, t } from "../strings";

const titles: Readonly<Record<ReleaseChannel, MessageKey>> = {
  beta: "common.weblounge_beta",
  release: "common.weblounge",
};

export function deploymentChannel(config: DeploymentConfig): ReleaseChannel {
  return config.mode === "hosted" ? (config.channel ?? "release") : "release";
}

export function appTitle(channel: ReleaseChannel): string {
  return t(titles[channel]);
}
