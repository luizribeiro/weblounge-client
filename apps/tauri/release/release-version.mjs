const RELEASE_TAG_PREFIX = "v";
export const BUMPS = ["patch", "minor", "major"];
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const releaseTag = (version) => `${RELEASE_TAG_PREFIX}${version}`;

export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  return match === null ? undefined : match.slice(1).map(Number);
}

const byVersion = (left, right) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

export function nextReleaseVersion(tags, bump) {
  const latest = tags.map(parseReleaseTag).filter(Boolean).sort(byVersion).at(-1);
  if (latest === undefined) throw new Error("there is no vX.Y.Z release tag to bump");
  const [major, minor, patch] = latest;
  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`unknown bump ${bump}`);
  }
}

const count = (label, value, minimum) => {
  const text = value.trim();
  if (!/^\d+$/.test(text) || Number(text) < minimum) {
    throw new Error(`the ${label} (${text}) is not a commit count`);
  }
  return Number(text);
};

export function commitVersion({ tag, commitsSinceTag, commitsTotal }) {
  const release = parseReleaseTag(tag);
  if (release === undefined) throw new Error(`${tag} is not a vX.Y.Z release tag`);
  const version = release.join(".");
  const since = count("count since the release", commitsSinceTag, 0);
  return {
    version,
    display: since === 0 ? version : `${version}+${since}`,
    build: String(count("build number", commitsTotal, 1)),
  };
}

// Pre-release and build-metadata tags are skipped, so they never name a build's release.
const NEAREST_RELEASE_TAG = [
  "describe",
  "--tags",
  "--abbrev=0",
  "--match",
  "v[0-9]*.[0-9]*.[0-9]*",
  "--exclude",
  "*[-+]*",
];

export function describeCommit(commit, git) {
  const tag = git([...NEAREST_RELEASE_TAG, commit]);
  return commitVersion({
    tag,
    commitsSinceTag: git(["rev-list", "--count", `${tag}..${commit}`]),
    commitsTotal: git(["rev-list", "--count", commit]),
  });
}
