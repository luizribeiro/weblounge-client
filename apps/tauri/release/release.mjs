// Signing needs the login keychain and notarization needs the network, so this runs on Luiz's
// Mac outside the Nix sandbox (design 28). System tools are called by absolute path because the
// dev shell puts Nix's own xcrun and codesign shims first on PATH.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockers, imageName, releaseTag, releaseVersion } from "./plan.mjs";

const IDENTITY = "Developer ID Application: LUIZ GUSTAVO CARDOSO RIBEIRO (JR4C2QJKWJ)";
const BUNDLE_ID = "org.weblounge.desktop";
const NOTARY_PROFILE = "weblounge";
const APP = "weblounge.app";
const repo = new URL("../../../", import.meta.url).pathname;
const crate = join(repo, "apps/tauri");

const run = (command, args) =>
  execFileSync(command, args, { cwd: repo, encoding: "utf8" }).trim();
const step = (command, args) =>
  execFileSync(command, args, { cwd: repo, stdio: "inherit" });

// Node rewrites relative symlinks to absolute paths unless told not to, which breaks a sealed bundle.
const copyBundle = (from, to) =>
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });

function preflight() {
  const version = releaseVersion({
    cargoToml: readFileSync(join(crate, "Cargo.toml"), "utf8"),
    tauriConf: readFileSync(join(crate, "tauri.conf.json"), "utf8"),
  });
  run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
  const head = run("git", ["rev-parse", "HEAD"]);
  const problems = blockers({
    status: run("git", ["status", "--porcelain"]),
    head,
    originMain: run("git", ["rev-parse", "origin/main"]),
    tags: run("git", ["tag", "--list"]).split("\n"),
    version,
  });
  if (problems.length > 0) {
    throw new Error(`cannot release ${version}:\n- ${problems.join("\n- ")}`);
  }
  return { version, head };
}

const sign = (path, extra = []) =>
  step("/usr/bin/codesign", ["--force", "--timestamp", ...extra, "--sign", IDENTITY, path]);

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
function notarizedApp(work) {
  const built = run("nix", ["build", "--no-link", "--print-out-paths", ".#desktop"]);
  const app = join(work, APP);
  copyBundle(join(built, "Applications", APP), app);
  step("/bin/chmod", ["-R", "u+w", app]);
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
    step("/usr/bin/hdiutil", ["detach", mount]);
    rmSync(mount, { recursive: true, force: true });
  }
}

// GitHub creates the tag together with the release, so a failed upload leaves no tag behind that
// would block a retry.
function publish(image, { version, head }) {
  if (run("git", ["rev-parse", "HEAD"]) !== head) {
    throw new Error("HEAD moved during the build; the image no longer matches it");
  }
  const tag = releaseTag(version);
  step("gh", [
    "release",
    "create",
    tag,
    image,
    "--target",
    head,
    "--title",
    `weblounge desktop ${version}`,
    "--notes",
    "Notarized macOS app (Apple silicon). Install with `brew install --cask luizribeiro/tap/weblounge`.",
  ]);
}

const dryRun = process.argv.includes("--dry-run");
const release = preflight();
const work = mkdtempSync(join(tmpdir(), "weblounge-release-"));
try {
  const image = notarizedImage(work, notarizedApp(work), release.version);
  verify(image);
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
