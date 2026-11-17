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

export const CREDENTIAL_VARIABLES = {
  keyId: "APP_STORE_CONNECT_KEY_ID",
  issuer: "APP_STORE_CONNECT_ISSUER_ID",
};

export const keyFile = (home, keyId) =>
  `${home}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`;

export function uploadCredentials(env, keyFileExists) {
  const keyId = env[CREDENTIAL_VARIABLES.keyId];
  const issuer = env[CREDENTIAL_VARIABLES.issuer];
  const problems = [
    !keyId && `${CREDENTIAL_VARIABLES.keyId} is not set`,
    !issuer && `${CREDENTIAL_VARIABLES.issuer} is not set`,
    keyId && !keyFileExists(keyId) && `${keyFile("~", keyId)} does not exist`,
  ].filter(Boolean);
  return { keyId, issuer, problems };
}
