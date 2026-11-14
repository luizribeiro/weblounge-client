import assert from "node:assert/strict";
import test from "node:test";
import { unguardedBlobUrls } from "./blob-url-policy.mjs";

const preview =
  'function Bn(e){if(!e.type.startsWith("image/"))throw new TypeError("weblounge:image-preview-only");return URL.createObjectURL(e)}function Hn(e){URL.revokeObjectURL(e)}';

test("allows the guarded image preview", () => {
  assert.deepEqual(unguardedBlobUrls(preview), []);
});

test("rejects a blob URL fed to a worker", () => {
  const worker =
    'const t=new Blob([s],{type:"text/javascript"});new Worker(URL.createObjectURL(t),{type:"module"})';
  assert.equal(unguardedBlobUrls(worker).length, 1);
  assert.equal(unguardedBlobUrls(`${preview}${worker}`).length, 1);
});

test("rejects a blob URL far from the preview marker", () => {
  const imported = `${preview}${"x".repeat(400)}importScripts(self.URL.createObjectURL(b))`;
  assert.equal(unguardedBlobUrls(imported).length, 1);
});
