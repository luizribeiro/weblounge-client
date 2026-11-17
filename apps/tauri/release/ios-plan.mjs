const IOS_TAG_PREFIX = "ios-v";

export const iosReleaseTag = (version, build) => `${IOS_TAG_PREFIX}${version}+${build}`;

export function buildNumber(commitCount) {
  const count = commitCount.trim();
  if (!/^[1-9]\d*$/.test(count)) {
    throw new Error(`the commit count (${count}) is not a build number`);
  }
  return count;
}

const uploadedBuild = (tag) =>
  tag.startsWith(IOS_TAG_PREFIX) ? Number(tag.match(/\+(\d+)$/)?.[1] ?? 0) : 0;

// App Store Connect takes only up to three period-separated integers as a short version.
export const unshippableVersion = (version) =>
  !/^\d+(\.\d+){0,2}$/.test(version) &&
  `version ${version} is not an App Store version (up to three integers, no pre-release)`;

export function staleBuild({ tags, build }) {
  const last = Math.max(0, ...tags.map(uploadedBuild));
  return (
    last >= Number(build) &&
    `build ${build} is not above the last uploaded build ${last}; release from origin/main`
  );
}
