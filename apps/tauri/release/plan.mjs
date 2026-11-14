export const TAG_PREFIX = "desktop-v";

export function releaseVersion({ cargoToml, tauriConf }) {
  const crate = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
  const bundle = JSON.parse(tauriConf).version;
  if (!crate || crate !== bundle) {
    throw new Error(
      `Cargo.toml (${crate}) and tauri.conf.json (${bundle}) must name the same version`,
    );
  }
  return crate;
}

export const releaseTag = (version) => `${TAG_PREFIX}${version}`;

export const imageName = (version) => `Weblounge-${version}.dmg`;

export function blockers({ status, head, originMain, tags, version }) {
  return [
    status.trim() !== "" && "the worktree has uncommitted changes",
    head !== originMain && "HEAD is not origin/main",
    tags.includes(releaseTag(version)) &&
      `${releaseTag(version)} already exists; bump the version first`,
  ].filter(Boolean);
}
