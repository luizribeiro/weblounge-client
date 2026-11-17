import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findEmptyDirectories } from "./bundle-files.mjs";

const appTree = (files) => {
  const root = mkdtempSync(join(tmpdir(), "weblounge-app-"));
  for (const file of files) {
    const isDirectory = file.endsWith("/");
    mkdirSync(join(root, isDirectory ? file : dirname(file)), { recursive: true });
    if (!isDirectory) writeFileSync(join(root, file), "");
  }
  return root;
};

const signedApp = [
  "weblounge",
  "Info.plist",
  "_CodeSignature/CodeResources",
  "Assets.car",
  "PlugIns/weblounge-notifications.appex/weblounge-notifications",
  "PlugIns/weblounge-notifications.appex/Info.plist",
  "PlugIns/weblounge-notifications.appex/_CodeSignature/CodeResources",
];

test("a signed app with only files in its directories has no empty directory", (t) => {
  const app = appTree(signedApp);
  t.after(() => rmSync(app, { recursive: true }));
  assert.deepEqual(findEmptyDirectories(app), []);
});

test("finds Tauri's empty assets folder and one nested in the extension", (t) => {
  const app = appTree([
    ...signedApp,
    "assets/",
    "PlugIns/weblounge-notifications.appex/Frameworks/",
  ]);
  t.after(() => rmSync(app, { recursive: true }));
  assert.deepEqual(findEmptyDirectories(app).sort(), [
    "PlugIns/weblounge-notifications.appex/Frameworks",
    "assets",
  ]);
});

test("reports only the innermost of nested empty directories", (t) => {
  const app = appTree([...signedApp, "PlugIns/weblounge-notifications.appex/Frameworks/Swift/"]);
  t.after(() => rmSync(app, { recursive: true }));
  assert.deepEqual(findEmptyDirectories(app), [
    "PlugIns/weblounge-notifications.appex/Frameworks/Swift",
  ]);
});

test("a directory holding only an empty file is not empty", (t) => {
  const app = appTree([...signedApp, "assets/.keep"]);
  t.after(() => rmSync(app, { recursive: true }));
  assert.deepEqual(findEmptyDirectories(app), []);
});
