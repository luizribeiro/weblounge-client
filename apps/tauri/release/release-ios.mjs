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
  iosBuildArgs,
  iosBuildEnv,
  ipaProblems,
  keyFile,
  uploadCredentials,
} from "./ios-plan.mjs";
import { blockers } from "./plan.mjs";
import { commitVersionOf, crate, crateFile, gitState, repo, run, step } from "./shell.mjs";
import { snapshotFiles } from "./snapshot.mjs";

const appleProject = join(crate, "gen/apple");
const releaseIdentity = JSON.parse(crateFile("tauri.ios.release.conf.json"));
const APP_IDENTIFIER = releaseIdentity.identifier;
const APP = `${releaseIdentity.productName}.app`;
const IPA = join(appleProject, "build/arm64", `${releaseIdentity.productName}.ipa`);
const EXTENSION = join("PlugIns", "weblounge-notifications.appex");

function preflight() {
  const git = gitState();
  const { version, display, build } = commitVersionOf(git.head);
  const credentials = uploadCredentials(process.env, (keyId) =>
    existsSync(keyFile(homedir(), keyId)),
  );
  const problems = [
    !process.env.IN_NIX_SHELL && "this must run inside `nix develop`",
    ...blockers(git),
    ...credentials.problems,
  ].filter(Boolean);
  const env = iosBuildEnv(process.env, {
    toolDir: join(crate, "scripts/ios-path"),
    appIdentifier: APP_IDENTIFIER,
    display,
  });
  return {
    version,
    display,
    build,
    env,
    head: git.head,
    clean: git.status === "",
    credentials,
    problems,
  };
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

// Tauri writes the config's version into the app's Info.plist only, so agvtool gives the
// extension the same short version.
const setMarketingVersion = (version, env) =>
  step("/usr/bin/xcrun", ["agvtool", "new-marketing-version", version], {
    cwd: appleProject,
    env,
  });

function exportIpa({ version, build, env }) {
  const restore = snapshotAppleProject();
  rmSync(IPA, { force: true });
  try {
    setMarketingVersion(version, env);
    step("cargo", iosBuildArgs({ version, build }), { cwd: crate, env });
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

// Under the dev shell's DEVELOPER_DIR and SDKROOT, altool finds no executable in the app and App
// Store Connect rejects it with 90207, so it runs with the build's Xcode environment.
const altool = (action, { credentials, env }) =>
  step("/usr/bin/xcrun", altoolArgs(action, { ipa: IPA, ...credentials }), { env });

// App Store Connect refuses a build number it has already taken in validate-app, so a reused
// commit stops here, before the upload.
function publish(release) {
  if (run("git", ["rev-parse", "HEAD"]) !== release.head) {
    throw new Error("HEAD moved during the build; the IPA no longer matches it");
  }
  altool("validate-app", release);
  altool("upload-app", release);
}

const dryRun = process.argv.includes("--dry-run");
const release = preflight();
const { version, display, build, head } = release;
const releaseLabel = `iOS release ${display}`;
console.log(`${releaseLabel}: ${APP_IDENTIFIER} ${version} build ${build} at ${head}`);
if (release.problems.length > 0) {
  const report = `- ${release.problems.join("\n- ")}`;
  if (!dryRun) throw new Error(`cannot start the ${releaseLabel}:\n${report}`);
  console.warn(`a release would refuse to start:\n${report}`);
}
exportIpa(release);
if (release.clean && run("git", ["status", "--porcelain"]) !== "") {
  throw new Error("the build left the worktree changed");
}
verify(release);
if (dryRun) {
  if (release.credentials.problems.length === 0) altool("validate-app", release);
  console.log(`dry run: verified ${IPA}; nothing was uploaded`);
} else {
  publish(release);
}
