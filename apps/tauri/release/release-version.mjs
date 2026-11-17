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
