import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { snapshotFiles } from "./snapshot.mjs";

const pbxproj = "PRODUCT_BUNDLE_IDENTIFIER = org.weblounge.ios.dev;\n";
const infoPlist = "<key>CFBundleVersion</key>\n<string>0.1.3</string>\n";

function appleProject(t) {
  const root = mkdtempSync(join(tmpdir(), "weblounge-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "weblounge-desktop.xcodeproj"));
  mkdirSync(join(root, "NotificationService"));
  const files = {
    pbxproj: join(root, "weblounge-desktop.xcodeproj/project.pbxproj"),
    info: join(root, "NotificationService/Info.plist"),
  };
  writeFileSync(files.pbxproj, pbxproj);
  writeFileSync(files.info, infoPlist);
  return files;
}

test("puts back what a release build rewrote", (t) => {
  const files = appleProject(t);
  const restore = snapshotFiles(Object.values(files));
  writeFileSync(files.pbxproj, "PRODUCT_BUNDLE_IDENTIFIER = org.weblounge.ios;\n");
  writeFileSync(files.info, "<key>CFBundleVersion</key>\n<string>2620</string>\n");
  restore();
  assert.equal(readFileSync(files.pbxproj, "utf8"), pbxproj);
  assert.equal(readFileSync(files.info, "utf8"), infoPlist);
});

test("recreates a file the build removed", (t) => {
  const files = appleProject(t);
  const restore = snapshotFiles(Object.values(files));
  rmSync(join(files.info, ".."), { recursive: true });
  restore();
  assert.equal(readFileSync(files.info, "utf8"), infoPlist);
});

test("leaves untouched files alone", (t) => {
  const files = appleProject(t);
  const restore = snapshotFiles(Object.values(files));
  const before = statSync(files.pbxproj).mtimeMs;
  writeFileSync(files.info, "changed");
  restore();
  assert.equal(statSync(files.pbxproj).mtimeMs, before);
  assert.equal(readFileSync(files.info, "utf8"), infoPlist);
});
