// Xcode signs with the login keychain and its signed-in account, and altool needs the network, so
// this runs on Luiz's Mac inside `nix develop` (for cargo and the Tauri CLI) but outside the Nix
// sandbox. Apple's tools are called by absolute path because the dev shell puts Nix's own xcrun
// and codesign shims first on PATH.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findEmptyDirectories } from "./bundle-files.mjs";
import {
  altoolArgs,
  buildNumber,
  iosBuildArgs,
  iosBuildEnv,
  iosReleaseTag,
  ipaProblems,
  keyFile,
  staleBuild,
  unshippableVersion,
  uploadCredentials,
} from "./ios-plan.mjs";
import { blockers } from "./plan.mjs";
import { crate, crateFile, crateVersion, gitState, repo, run, step } from "./shell.mjs";
import { snapshotFiles } from "./snapshot.mjs";

const appleProject = join(crate, "gen/apple");
const releaseIdentity = JSON.parse(crateFile("tauri.ios.release.conf.json"));
const APP_IDENTIFIER = releaseIdentity.identifier;
const APP = `${releaseIdentity.productName}.app`;
const IPA = join(appleProject, "build/arm64", `${releaseIdentity.productName}.ipa`);
const EXTENSION = join("PlugIns", "weblounge-notifications.appex");
const buildEnv = iosBuildEnv(process.env, {
  toolDir: join(crate, "scripts/ios-path"),
  appIdentifier: APP_IDENTIFIER,
});

function preflight() {
  const version = crateVersion();
  const git = gitState();
  const build = buildNumber(run("git", ["rev-list", "--count", "HEAD"]));
  const tag = iosReleaseTag(version, build);
  const credentials = uploadCredentials(process.env, (keyId) =>
    existsSync(keyFile(homedir(), keyId)),
  );
  const problems = [
    !process.env.IN_NIX_SHELL && "this must run inside `nix develop`",
    unshippableVersion(version),
    ...blockers({ ...git, tag }),
    staleBuild({ tags: git.tags, build }),
    ...credentials.problems,
  ].filter(Boolean);
  return { version, build, head: git.head, tag, clean: git.status === "", credentials, problems };
}

// The Tauri CLI writes the release identity into the committed pbxproj, and agvtool writes the
// versions into it and both Info.plists.
const snapshotAppleProject = () =>
  snapshotFiles(
    run("git", ["ls-files", "-z", appleProject])
      .split("\0")
      .filter(Boolean)
      .map((file) => join(repo, file)),
  );

// Tauri sets only the app's short version, while agvtool's build number reaches both bundles.
const setMarketingVersion = (version) =>
  step("/usr/bin/xcrun", ["agvtool", "new-marketing-version", version], {
    cwd: appleProject,
    env: buildEnv,
  });

function exportIpa({ version, build }) {
  const restore = snapshotAppleProject();
  rmSync(IPA, { force: true });
  try {
    setMarketingVersion(version);
    step("cargo", iosBuildArgs(build), { cwd: crate, env: buildEnv });
  } finally {
    restore();
  }
}

const plist = (path, options) =>
  JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], options));

function entitlements(bundle) {
  const signed = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", bundle], {
    encoding: "utf8",
  });
  if (signed.status !== 0) {
    throw new Error(`cannot read ${bundle}'s entitlements: ${signed.stderr}`);
  }
  return signed.stdout === "" ? {} : plist("-", { input: signed.stdout });
}

const bundleContents = (bundle) => ({
  info: plist(join(bundle, "Info.plist")),
  entitlements: entitlements(bundle),
});

function verify(release) {
  const unpacked = mkdtempSync(join(tmpdir(), "weblounge-ipa-"));
  try {
    step("/usr/bin/ditto", ["-x", "-k", IPA, unpacked]);
    const app = join(unpacked, "Payload", APP);
    step("/usr/bin/codesign", ["--verify", "--strict", "--deep", "--verbose=2", app]);
    const problems = ipaProblems(
      {
        app: bundleContents(app),
        extension: bundleContents(join(app, EXTENSION)),
        emptyDirectories: findEmptyDirectories(app),
      },
      { appIdentifier: APP_IDENTIFIER, version: release.version, build: release.build },
    );
    if (problems.length > 0) throw new Error(`${IPA} is not ready:\n- ${problems.join("\n- ")}`);
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

const altool = (action, credentials) =>
  step("/usr/bin/xcrun", altoolArgs(action, { ipa: IPA, ...credentials }));

// The tag records that App Store Connect has taken this build number, so it follows a successful
// upload even if processing later rejects the build.
function publish({ head, tag, version, build, credentials }) {
  if (run("git", ["rev-parse", "HEAD"]) !== head) {
    throw new Error("HEAD moved during the build; the IPA no longer matches it");
  }
  // App Store Connect's own checks, so a build Apple would reject stops before it is uploaded.
  altool("validate-app", credentials);
  altool("upload-app", credentials);
  step("git", ["tag", "-a", tag, "-m", `weblounge iOS ${version} (${build})`, head]);
  try {
    step("git", ["push", "origin", `refs/tags/${tag}`]);
  } catch (error) {
    console.error(`build ${build} was uploaded; push its tag with: git push origin ${tag}`);
    throw error;
  }
}

const dryRun = process.argv.includes("--dry-run");
const release = preflight();
const { tag, version, build, head } = release;
console.log(`iOS release ${tag}: ${APP_IDENTIFIER} ${version} build ${build} at ${head}`);
if (release.problems.length > 0) {
  const report = `- ${release.problems.join("\n- ")}`;
  if (!dryRun) throw new Error(`cannot release ${release.tag}:\n${report}`);
  console.warn(`a release would refuse to start:\n${report}`);
}
exportIpa(release);
if (release.clean && run("git", ["status", "--porcelain"]) !== "") {
  throw new Error("the build left the worktree changed");
}
verify(release);
if (dryRun) {
  if (release.credentials.problems.length === 0) altool("validate-app", release.credentials);
  console.log(`dry run: verified ${IPA}; nothing was uploaded and ${release.tag} was not created`);
} else {
  publish(release);
}
