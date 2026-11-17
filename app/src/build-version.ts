export interface BuildVersion {
  readonly version: string;
  readonly commit: string;
  readonly sha: string;
  readonly builtAt: Date | null;
  readonly built: string | null;
  readonly text: string;
}

const shortCommitLength = 7;

export function formatBuildVersion(
  commit: string,
  builtAtEpochSeconds: number,
): BuildVersion {
  const sha = shortCommit(commit);
  const version = versionFor(sha);
  if (commit === "dev") {
    return {
      version,
      commit,
      sha,
      builtAt: null,
      built: null,
      text: `weblounge ${version}`,
    };
  }

  const builtAt = new Date(builtAtEpochSeconds * 1_000);
  if (
    !Number.isFinite(builtAtEpochSeconds) ||
    Number.isNaN(builtAt.valueOf())
  ) {
    throw new Error("invalid build timestamp");
  }
  const built = `${builtAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return {
    version,
    commit,
    sha,
    builtAt,
    built,
    text: `weblounge ${version} · built ${built}`,
  };
}

// Web releases are named only by their tag, which the build cannot read.
function versionFor(sha: string): string {
  return sha;
}

function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/u.test(commit)
    ? commit.slice(0, shortCommitLength)
    : commit;
}

export const buildVersion = Object.freeze(
  formatBuildVersion(__BUILD_SHA__, Number(__BUILD_TIMESTAMP__)),
);

export function exposeBuildVersion(browserWindow: Window): void {
  browserWindow.weblounge = Object.freeze({ version: buildVersion.text });
}
