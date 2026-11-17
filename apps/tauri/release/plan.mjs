export const imageName = (version) => `weblounge-${version}.dmg`;

// The Nix build sees no tags, so the versions reach it as an override of the locked commit's flake.
export function desktopBuildArgs({ repo, head, system, version, build, display }) {
  const versions = `{ marketing = "${version}"; build = "${build}"; display = "${display}"; }`;
  const desktop = `(builtins.getFlake "git+file://${repo}?rev=${head}").packages.${system}.desktop`;
  return [
    "build",
    "--no-link",
    "--print-out-paths",
    "--expr",
    `${desktop}.override { version = ${versions}; }`,
  ];
}

export const publishedBlocker = (tag, published) =>
  published &&
  `the GitHub release ${tag} already exists: one macOS build per release tag, so cut a new tag`;

export function blockers({ status, head, originMain, tags, tag }) {
  return [
    status.trim() !== "" && "the worktree has uncommitted changes",
    head !== originMain && "HEAD is not origin/main",
    tag !== undefined && tags.includes(tag) && `${tag} already exists`,
  ].filter(Boolean);
}

const SYSTEM_LIBRARY_ROOTS = ["/System/Library/", "/usr/lib/"];

export function foreignLibraries(otoolOutput) {
  return otoolOutput
    .split("\n")
    .filter((line) => !line.endsWith(":"))
    .map((line) => line.trim().split(" (")[0])
    .filter((path) => path && !SYSTEM_LIBRARY_ROOTS.some((root) => path.startsWith(root)));
}
