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

// The dev shell points these at Nix's macOS SDK and toolchain, which know neither `iphoneos` nor
// `iphonesimulator`, and puts xcbuild's `xcrun` before Apple's.
const NIX_APPLE_OVERRIDES = ["DEVELOPER_DIR", "SDKROOT", "CC", "CXX", "LD"];

export function iosBuildEnv(env, { toolDir, appIdentifier, display }) {
  if (!display) throw new Error("the iOS build needs the version the shell shows");
  const inherited = Object.entries(env).filter(([name]) => !NIX_APPLE_OVERRIDES.includes(name));
  return {
    ...Object.fromEntries(inherited),
    PATH: [toolDir, "/usr/bin", env.PATH].filter(Boolean).join(":"),
    TAURI_WEBLOUNGE_APP_IDENTIFIER: appIdentifier,
    TAURI_WEBLOUNGE_VERSION: display,
  };
}

export const iosBuildArgs = ({ version, build }) => [
  "tauri",
  "ios",
  "build",
  "--ci",
  "--config",
  "tauri.ios.release.conf.json",
  "--config",
  JSON.stringify({ version, bundle: { iOS: { bundleVersion: build } } }),
  "--export-method",
  "app-store-connect",
];

export const altoolArgs = (action, { ipa, keyId, issuer }) => [
  "altool",
  `--${action}`,
  "--type",
  "ios",
  "-f",
  ipa,
  "--apiKey",
  keyId,
  "--apiIssuer",
  issuer,
];

const mismatch = (label, actual, expected) =>
  actual !== expected && `${label} is ${actual ?? "missing"}, not ${expected}`;

const lacks = (label, list, expected) =>
  !(list ?? []).includes(expected) && `${label} lacks ${expected}`;

const REQUIRED_BUNDLE_KEYS = ["CFBundleExecutable", "CFBundleName", "CFBundlePackageType"];
// App Store Connect rejects an app extension without a display name (90360).
const REQUIRED_EXTENSION_KEYS = [...REQUIRED_BUNDLE_KEYS, "CFBundleDisplayName"];

const missingKeys = (name, info, keys) =>
  keys.filter((key) => !info[key]).map((key) => `${name} Info.plist lacks ${key}`);

function bundleProblems(name, { info, entitlements }, { identifier, version, build, group, keys }) {
  return [
    ...missingKeys(name, info, keys),
    mismatch(`${name} CFBundleIdentifier`, info.CFBundleIdentifier, identifier),
    mismatch(`${name} CFBundleShortVersionString`, info.CFBundleShortVersionString, version),
    mismatch(`${name} CFBundleVersion`, info.CFBundleVersion, build),
    mismatch(`${name} WebloungeAppGroup`, info.WebloungeAppGroup, group),
    lacks(
      `${name} application groups`,
      entitlements["com.apple.security.application-groups"],
      group,
    ),
    lacks(
      `${name} keychain groups`,
      entitlements["keychain-access-groups"],
      info.WebloungeKeychainGroup,
    ),
  ];
}

export function ipaProblems({ app, extension, emptyDirectories }, { appIdentifier, version, build }) {
  const expected = { version, build, group: `group.${appIdentifier}` };
  return [
    ...emptyDirectories.map((dir) => `the app holds the empty directory ${dir}`),
    ...bundleProblems("app", app, {
      ...expected,
      identifier: appIdentifier,
      keys: REQUIRED_BUNDLE_KEYS,
    }),
    ...bundleProblems("extension", extension, {
      ...expected,
      identifier: `${appIdentifier}.notifications`,
      keys: REQUIRED_EXTENSION_KEYS,
    }),
    mismatch(
      "extension WebloungeKeychainGroup",
      extension.info.WebloungeKeychainGroup,
      app.info.WebloungeKeychainGroup,
    ),
    mismatch("app aps-environment", app.entitlements["aps-environment"], "production"),
  ].filter(Boolean);
}
