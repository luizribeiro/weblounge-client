import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNumber,
  iosBuildArgs,
  iosBuildEnv,
  iosReleaseTag,
  staleBuild,
  unshippableVersion,
  uploadArgs,
  uploadCredentials,
} from "./ios-plan.mjs";

test("names the tag after the version and the build", () => {
  assert.equal(iosReleaseTag("0.1.3", "2620"), "ios-v0.1.3+2620");
});

test("the build number is the commit count", () => {
  assert.equal(buildNumber("2620\n"), "2620");
});

test("a commit count that is not a positive number is no build number", () => {
  for (const count of ["", "0", "-3", "12a", "fatal: bad revision"]) {
    assert.throws(() => buildNumber(count), /is not a build number/);
  }
});

const tags = ["desktop-v0.1.3", "ios-v0.1.2+2580", "ios-v0.1.3+2600", "v0.1.0"];

test("a build above every uploaded one is fresh", () => {
  assert.equal(staleBuild({ tags, build: "2620" }), false);
  assert.equal(staleBuild({ tags: ["desktop-v0.1.3"], build: "1" }), false);
});

test("a build at or below an uploaded one is stale, whatever the version", () => {
  assert.equal(
    staleBuild({ tags, build: "2600" }),
    "build 2600 is not above the last uploaded build 2600; release from origin/main",
  );
  assert.match(staleBuild({ tags: ["ios-v0.0.9+3000"], build: "2620" }), /last uploaded build 3000/);
});

test("tags that name no uploaded build are ignored", () => {
  assert.equal(
    staleBuild({ tags: ["ios-v0.1.3", "ios-v0.1.3+abc", "desktop-v0.1.3+9999"], build: "1" }),
    false,
  );
});

test("only plain integer versions ship to App Store Connect", () => {
  for (const version of ["0.1.3", "1.0", "2"]) assert.equal(unshippableVersion(version), false);
  for (const version of ["0.1.3-beta.1", "0.1.3.4", "v0.1.3"]) {
    assert.match(unshippableVersion(version), /is not an App Store version/);
  }
});

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

test("the iOS build sees Xcode's toolchain, the rustup stand-in and the app identifier", () => {
  assert.deepEqual(
    iosBuildEnv(devShell, { toolDir: "/repo/apps/tauri/scripts/ios-path", appIdentifier: "org.weblounge.ios" }),
    {
      PATH: "/repo/apps/tauri/scripts/ios-path:/usr/bin:/nix/store/abc-cargo/bin:/nix/store/def-xcbuild/bin:/usr/bin",
      HOME: "/Users/luiz",
      IN_NIX_SHELL: "impure",
      TAURI_WEBLOUNGE_APP_IDENTIFIER: "org.weblounge.ios",
    },
  );
});

test("an environment without PATH still finds the stand-in and Apple's tools", () => {
  assert.equal(
    iosBuildEnv({}, { toolDir: "/tools", appIdentifier: "org.weblounge.ios" }).PATH,
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

test("uploads the IPA with the API key", () => {
  assert.deepEqual(
    uploadArgs({ ipa: "/tmp/weblounge.ipa", keyId: "2X9R4HXF34", issuer: "57246542" }),
    [
      "altool",
      "--upload-app",
      "--type",
      "ios",
      "-f",
      "/tmp/weblounge.ipa",
      "--apiKey",
      "2X9R4HXF34",
      "--apiIssuer",
      "57246542",
    ],
  );
});
