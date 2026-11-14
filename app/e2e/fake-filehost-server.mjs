import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { basename, extname } from "node:path";
import { handleUpload } from "./fake-filehost-uploads.mjs";
import { selfSignedCertificate } from "./self-signed-certificate.mjs";

// Must match the FILEHOST in nix/ergo.nix and E2E_FILEHOST_ORIGIN in app/csp.ts.
const filehostOrigin = "https://127.0.0.1:4175";

const fixtures = new URL("./fixtures/filehost/", import.meta.url);
const contentTypes = new Map([
  [".gif", "image/gif"],
  [".png", "image/png"],
]);
const released = new Set();
const held = new Map();

createServer(
  selfSignedCertificate(new URL(filehostOrigin).hostname),
  (request, response) => {
    const url = new URL(request.url ?? "/", filehostOrigin);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (url.pathname === "/health") {
      response.writeHead(200).end("ready");
      return;
    }
    const release = /^\/release\/([\w-]+)$/u.exec(url.pathname);
    if (release?.[1] !== undefined) {
      releaseHeld(release[1]);
      response.writeHead(204).end();
      return;
    }
    if (handleUpload(request, response, url, afterRelease)) return;
    const hold = /^\/held\/([\w-]+)\//u.exec(url.pathname);
    if (hold?.[1] !== undefined) {
      afterRelease(hold[1], () => serveFixture(url.pathname, response));
      return;
    }
    serveFixture(url.pathname, response);
  },
).listen(4175, "127.0.0.1");

function afterRelease(key, continuation) {
  if (released.has(key)) {
    continuation();
    return;
  }
  const waiting = held.get(key) ?? [];
  waiting.push(continuation);
  held.set(key, waiting);
}

function releaseHeld(key) {
  released.add(key);
  for (const serve of held.get(key) ?? []) serve();
  held.delete(key);
}

function serveFixture(pathname, response) {
  const name = basename(pathname);
  const contentType = contentTypes.get(extname(name));
  if (contentType === undefined || name.startsWith("missing")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = readFileSync(new URL(name, fixtures));
    response.writeHead(200, { "Content-Type": contentType }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}
