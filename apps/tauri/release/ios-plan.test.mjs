import assert from "node:assert/strict";
import test from "node:test";
import {
  altoolArgs,
  iosBuildArgs,
  iosBuildEnv,
  ipaProblems,
  uploadCredentials,
} from "./ios-plan.mjs";

const credentials = {
  APP_STORE_CONNECT_KEY_ID: "2X9R4HXF34",
  APP_STORE_CONNECT_ISSUER_ID: "57246542-96fe-1a63-e053-0824d011072a",
};

test("upload credentials come from the environment and the key file", () => {
  assert.deepEqual(
    uploadCredentials(credentials, (keyId) => keyId === "2X9R4HXF34"),
    {
      keyId: "2X9R4HXF34",
      issuer: "57246542-96fe-1a63-e053-0824d011072a",
      problems: [],
    },
  );
});

test("reports every missing upload credential", () => {
  assert.deepEqual(uploadCredentials({}, () => true).problems, [
    "APP_STORE_CONNECT_KEY_ID is not set",
    "APP_STORE_CONNECT_ISSUER_ID is not set",
  ]);
  assert.deepEqual(uploadCredentials(credentials, () => false).problems, [
    "~/.appstoreconnect/private_keys/AuthKey_2X9R4HXF34.p8 does not exist",
  ]);
});

test("without a key id there is no key file to look for", () => {
  const lookedUp = [];
  const { problems } = uploadCredentials(
    { APP_STORE_CONNECT_ISSUER_ID: credentials.APP_STORE_CONNECT_ISSUER_ID },
    (keyId) => lookedUp.push(keyId),
  );
  assert.deepEqual(problems, ["APP_STORE_CONNECT_KEY_ID is not set"]);
  assert.deepEqual(lookedUp, []);
});

const devShell = {
  PATH: "/nix/store/abc-cargo/bin:/nix/store/def-xcbuild/bin:/usr/bin",
  DEVELOPER_DIR: "/nix/store/ghi-apple-sdk",
  SDKROOT: "/nix/store/ghi-apple-sdk/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
  CC: "clang",
  CXX: "clang++",
  LD: "ld",
  HOME: "/Users/luiz",
  IN_NIX_SHELL: "impure",
};

const release = {
  toolDir: "/repo/apps/tauri/scripts/ios-path",
  appIdentifier: "org.weblounge.ios",
  display: "0.2.0+3",
};

test("the iOS build sees Xcode's toolchain, the rustup stand-in, the app identifier and the version", () => {
  assert.deepEqual(iosBuildEnv(devShell, release), {
    PATH: "/repo/apps/tauri/scripts/ios-path:/usr/bin:/nix/store/abc-cargo/bin:/nix/store/def-xcbuild/bin:/usr/bin",
    HOME: "/Users/luiz",
    IN_NIX_SHELL: "impure",
    TAURI_WEBLOUNGE_APP_IDENTIFIER: "org.weblounge.ios",
    TAURI_WEBLOUNGE_VERSION: "0.2.0+3",
  });
});

test("an iOS build without a shell version refuses to start", () => {
  assert.throws(
    () => iosBuildEnv(devShell, { ...release, display: undefined }),
    /needs the version the shell shows/,
  );
});

test("an environment without PATH still finds the stand-in and Apple's tools", () => {
  assert.equal(
    iosBuildEnv({}, { ...release, toolDir: "/tools" }).PATH,
    "/tools:/usr/bin",
  );
});

test("builds the release identity for App Store Connect with the build number", () => {
  assert.deepEqual(iosBuildArgs("2620"), [
    "tauri",
    "ios",
    "build",
    "--ci",
    "--config",
    "tauri.ios.release.conf.json",
    "--config",
    '{"bundle":{"iOS":{"bundleVersion":"2620"}}}',
    "--export-method",
    "app-store-connect",
  ]);
});

test("validates and uploads the IPA with the API key", () => {
  const credentials = { ipa: "/tmp/weblounge.ipa", keyId: "2X9R4HXF34", issuer: "57246542" };
  for (const action of ["validate-app", "upload-app"]) {
    assert.deepEqual(altoolArgs(action, credentials), [
      "altool",
      `--${action}`,
      "--type",
      "ios",
      "-f",
      "/tmp/weblounge.ipa",
      "--apiKey",
      "2X9R4HXF34",
      "--apiIssuer",
      "57246542",
    ]);
  }
});

const bundle = (identifier, entitlements, keys) => ({
  info: {
    CFBundleExecutable: "weblounge",
    CFBundleName: "weblounge",
    CFBundlePackageType: "APPL",
    ...keys,
    CFBundleIdentifier: identifier,
    CFBundleShortVersionString: "0.2.0",
    CFBundleVersion: "2620",
    WebloungeAppGroup: "group.org.weblounge.ios",
    WebloungeKeychainGroup: "JR4C2QJKWJ.org.weblounge.ios",
  },
  entitlements: {
    "com.apple.security.application-groups": ["group.org.weblounge.ios"],
    "keychain-access-groups": ["JR4C2QJKWJ.org.weblounge.ios"],
    ...entitlements,
  },
});

const exported = {
  app: bundle("org.weblounge.ios", { "aps-environment": "production" }),
  extension: bundle("org.weblounge.ios.notifications", {}, {
    CFBundleExecutable: "weblounge-notifications",
    CFBundleName: "weblounge-notifications",
    CFBundleDisplayName: "weblounge",
    CFBundlePackageType: "XPC!",
  }),
  emptyDirectories: [],
};
const expected = { appIdentifier: "org.weblounge.ios", version: "0.2.0", build: "2620" };

test("an App Store IPA with the extension and production push passes", () => {
  assert.deepEqual(ipaProblems(exported, expected), []);
});

test("reports a development push environment and a dev extension", () => {
  assert.deepEqual(
    ipaProblems(
      {
        ...exported,
        app: bundle("org.weblounge.ios", { "aps-environment": "development" }),
        extension: {
          info: {
            ...exported.extension.info,
            CFBundleIdentifier: "org.weblounge.ios.dev.notifications",
            CFBundleVersion: "0.2.0",
            WebloungeAppGroup: "group.org.weblounge.ios.dev",
          },
          entitlements: {
            "com.apple.security.application-groups": ["group.org.weblounge.ios.dev"],
            "keychain-access-groups": ["JR4C2QJKWJ.org.weblounge.ios.dev"],
          },
        },
      },
      expected,
    ),
    [
      "extension CFBundleIdentifier is org.weblounge.ios.dev.notifications, not org.weblounge.ios.notifications",
      "extension CFBundleVersion is 0.2.0, not 2620",
      "extension WebloungeAppGroup is group.org.weblounge.ios.dev, not group.org.weblounge.ios",
      "extension application groups lacks group.org.weblounge.ios",
      "extension keychain groups lacks JR4C2QJKWJ.org.weblounge.ios",
      "app aps-environment is development, not production",
    ],
  );
});

test("an unsigned IPA lacks every entitlement", () => {
  const unsigned = (signed) => ({ ...signed, entitlements: {} });
  assert.deepEqual(
    ipaProblems(
      { ...exported, app: unsigned(exported.app), extension: unsigned(exported.extension) },
      expected,
    ),
    [
      "app application groups lacks group.org.weblounge.ios",
      "app keychain groups lacks JR4C2QJKWJ.org.weblounge.ios",
      "extension application groups lacks group.org.weblounge.ios",
      "extension keychain groups lacks JR4C2QJKWJ.org.weblounge.ios",
      "app aps-environment is missing, not production",
    ],
  );
});

test("reports an empty directory in the app", () => {
  assert.deepEqual(ipaProblems({ ...exported, emptyDirectories: ["assets"] }, expected), [
    "the app holds the empty directory assets",
  ]);
});

test("requires a display name on the extension only", () => {
  const { CFBundleDisplayName: _, ...info } = exported.extension.info;
  assert.deepEqual(
    ipaProblems({ ...exported, extension: { ...exported.extension, info } }, expected),
    ["extension Info.plist lacks CFBundleDisplayName"],
  );
});

test("reports every bundle key a bundle lacks", () => {
  const { CFBundleExecutable: _, CFBundlePackageType: __, ...info } = exported.app.info;
  assert.deepEqual(ipaProblems({ ...exported, app: { ...exported.app, info } }, expected), [
    "app Info.plist lacks CFBundleExecutable",
    "app Info.plist lacks CFBundlePackageType",
  ]);
});
