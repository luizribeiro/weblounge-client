// Signing needs the login keychain and notarization needs the network, so this runs on Luiz's
// Mac outside the Nix sandbox (design 28). System tools are called by absolute path because the
// dev shell puts Nix's own xcrun and codesign shims first on PATH.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockers,
  desktopBuildArgs,
  foreignLibraries,
  imageName,
  publishedBlocker,
} from "./plan.mjs";
import { releaseTag } from "./release-version.mjs";
import { commitVersionOf, crateFile, gitState, repo, run, step } from "./shell.mjs";

const IDENTITY = "Developer ID Application: LUIZ GUSTAVO CARDOSO RIBEIRO (JR4C2QJKWJ)";
const NOTARY_PROFILE = "weblounge";
const releaseIdentity = JSON.parse(crateFile("tauri.release.conf.json"));
const BUNDLE_ID = releaseIdentity.identifier;
const APP = `${releaseIdentity.productName}.app`;

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// Gatekeeper checks register each copy with LaunchServices, which could then open a deleted
// temporary copy for the installed app's bundle ID.
const forget = (app) => spawnSync(LSREGISTER, ["-u", app]);

// Node rewrites relative symlinks to absolute paths unless told not to, which breaks a sealed bundle.
const copyBundle = (from, to) =>
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });

const SYSTEM = "aarch64-darwin";

function githubReleaseExists(tag) {
  const view = spawnSync("gh", ["release", "view", tag, "--json", "tagName"], {
    cwd: repo,
    encoding: "utf8",
  });
  if (view.status === 0) return true;
  if (/release not found/i.test(view.stderr)) return false;
  throw new Error(`cannot tell whether the GitHub release ${tag} exists: ${view.stderr.trim()}`);
}

function preflight() {
  const git = gitState();
  const head = git.head;
  const release = { ...commitVersionOf(head), head };
  const tag = releaseTag(release.version);
  const problems = [...blockers(git), publishedBlocker(tag, githubReleaseExists(tag))].filter(
    Boolean,
  );
  if (problems.length > 0) {
    throw new Error(`cannot release ${release.display}:\n- ${problems.join("\n- ")}`);
  }
  return { ...release, tag };
}

const sign = (path, extra = []) =>
  step("/usr/bin/codesign", ["--force", "--timestamp", ...extra, "--sign", IDENTITY, path]);

function assertSystemLibrariesOnly(app) {
  const binary = join(app, "Contents/MacOS/weblounge-desktop");
  const foreign = foreignLibraries(run("/usr/bin/otool", ["-L", binary]));
  if (foreign.length > 0) {
    throw new Error(`${binary} links libraries other Macs lack: ${foreign.join(", ")}`);
  }
}

function assertDeveloperIdSignature(app) {
  const details = spawnSync("/usr/bin/codesign", ["-dvv", app], { encoding: "utf8" }).stderr;
  const missing = [
    `Identifier=${BUNDLE_ID}`,
    "(runtime)",
    `Authority=${IDENTITY}`,
    "Info.plist entries=",
  ].filter((expected) => !details.includes(expected));
  if (missing.length > 0) throw new Error(`${app} signature lacks: ${missing.join(", ")}`);
}

function notarize(path) {
  const submission = spawnSync(
    "/usr/bin/xcrun",
    [
      "notarytool",
      "submit",
      path,
      "--keychain-profile",
      NOTARY_PROFILE,
      "--wait",
      "--output-format",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const result = JSON.parse(submission.stdout || "{}");
  if (result.status !== "Accepted") {
    if (!result.id) throw new Error(`could not submit ${path} for notarization`);
    step("/usr/bin/xcrun", ["notarytool", "log", result.id, "--keychain-profile", NOTARY_PROFILE]);
    throw new Error(`notarization of ${path} ended ${result.status}`);
  }
}

const staple = (path) => step("/usr/bin/xcrun", ["stapler", "staple", path]);

// Stapling the app as well as the image lets a dragged-out or cask-installed copy pass Gatekeeper
// on its first launch without reaching Apple.
function notarizedApp(work, release) {
  const built = run("nix", desktopBuildArgs({ repo, system: SYSTEM, ...release }));
  const app = join(work, APP);
  copyBundle(join(built, "Applications", APP), app);
  step("/bin/chmod", ["-R", "u+w", app]);
  assertSystemLibrariesOnly(app);
  sign(app, ["--options", "runtime"]);
  assertDeveloperIdSignature(app);
  const archive = join(work, "app.zip");
  step("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive]);
  notarize(archive);
  staple(app);
  return app;
}

function notarizedImage(work, app, version) {
  const stage = join(work, "stage");
  copyBundle(app, join(stage, APP));
  symlinkSync("/Applications", join(stage, "Applications"));
  const image = join(work, imageName(version));
  step("/usr/bin/hdiutil", [
    "create",
    "-volname",
    "weblounge",
    "-srcfolder",
    stage,
    "-format",
    "UDZO",
    image,
  ]);
  sign(image);
  notarize(image);
  staple(image);
  return image;
}

function verify(image) {
  step("/usr/bin/xcrun", ["stapler", "validate", image]);
  step("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose",
    image,
  ]);
  const mount = mkdtempSync(join(tmpdir(), "weblounge-verify-"));
  step("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, image]);
  try {
    const app = join(mount, APP);
    step("/usr/bin/codesign", ["--verify", "--strict", "--deep", "--verbose=2", app]);
    step("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose", app]);
    step("/usr/bin/xcrun", ["stapler", "validate", app]);
  } finally {
    forget(join(mount, APP));
    step("/usr/bin/hdiutil", ["detach", mount]);
    rmSync(mount, { recursive: true, force: true });
  }
}

function publish(image, { version, display, build, head, tag }) {
  if (run("git", ["rev-parse", "HEAD"]) !== head) {
    throw new Error("HEAD moved during the build; the image no longer matches it");
  }
  step("gh", [
    "release",
    "create",
    tag,
    image,
    "--verify-tag",
    "--title",
    `weblounge ${version}`,
    "--notes",
    `Notarized macOS app ${display} (build ${build}, ${head}; Apple silicon). ` +
      "Install with `brew install --cask luizribeiro/tap/weblounge`.",
  ]);
}

const dryRun = process.argv.includes("--dry-run");
const release = preflight();
const work = mkdtempSync(join(tmpdir(), "weblounge-release-"));
try {
  const app = notarizedApp(work, release);
  const image = notarizedImage(work, app, release.version);
  verify(image);
  forget(app);
  forget(join(work, "stage", APP));
  if (dryRun) {
    console.log(`dry run: verified ${image}; nothing was published`);
  } else {
    publish(image, release);
    rmSync(work, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`release stopped; its files are kept in ${work}`);
  throw error;
}
