import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const standIn = new URL("../scripts/ios-path/rustup", import.meta.url).pathname;

function devShell(t) {
  const root = mkdtempSync(join(tmpdir(), "weblounge-rustup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sysroot = join(root, "sysroot");
  for (const target of ["aarch64-apple-darwin", "aarch64-apple-ios", "aarch64-apple-ios-sim"]) {
    mkdirSync(join(sysroot, "lib/rustlib", target, "lib"), { recursive: true });
  }
  mkdirSync(join(sysroot, "lib/rustlib/etc"));
  writeFileSync(join(sysroot, "lib/rustlib/components"), "rustc\nrust-std\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rustc"), `#!/bin/sh\necho "${sysroot}"\n`);
  chmodSync(join(bin, "rustc"), 0o755);
  return (...args) =>
    spawnSync(standIn, args, {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
}

test("lists the targets the dev shell's sysroot carries", (t) => {
  const rustup = devShell(t);
  const listed = rustup("target", "list", "--installed");
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.stdout.trim().split("\n").sort(), [
    "aarch64-apple-darwin",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
  ]);
});

test("adding targets the sysroot carries succeeds", (t) => {
  const rustup = devShell(t);
  assert.equal(rustup("target", "add", "aarch64-apple-ios", "aarch64-apple-ios-sim").status, 0);
});

test("adding a target the dev shell lacks fails", (t) => {
  const rustup = devShell(t);
  const added = rustup("target", "add", "aarch64-apple-ios", "x86_64-apple-ios");
  assert.equal(added.status, 1);
  assert.match(added.stderr, /the dev shell lacks the x86_64-apple-ios target/);
});

test("refuses anything else rustup would do", (t) => {
  const rustup = devShell(t);
  const updated = rustup("update");
  assert.equal(updated.status, 1);
  assert.match(updated.stderr, /unsupported: rustup update/);
});
