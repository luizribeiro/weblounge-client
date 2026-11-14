import { randomBytes } from "node:crypto";

const recordedBodyLimit = 256 * 1024;
const typesByMagic = [
  { magic: [0x89, 0x50, 0x4e, 0x47], type: "image/png", extension: "png" },
  { magic: [0xff, 0xd8, 0xff], type: "image/jpeg", extension: "jpg" },
  { magic: [0x47, 0x49, 0x46, 0x38], type: "image/gif", extension: "gif" },
];

// Each Ergo spec signs in with its own account, so test controls and records are kept per
// account: concurrent workers never see each other's uploads.
const scopes = new Map();
const stored = new Map();

function scopeState(account) {
  let state = scopes.get(account);
  if (state === undefined) {
    state = { uploads: [], queued: [], limit: undefined, hold: undefined };
    scopes.set(account, state);
  }
  return state;
}

/** Serves POST /upload and its test controls; returns false for other requests. */
export function handleUpload(request, response, url, release) {
  if (url.pathname.startsWith("/control/")) {
    control(url, response);
    return true;
  }
  if (url.pathname === "/upload") {
    cors(request, response);
    if (request.method === "OPTIONS") response.writeHead(204).end();
    else if (request.method === "POST") receive(request, response, release);
    else response.writeHead(405).end();
    return true;
  }
  const upload = stored.get(url.pathname);
  if (upload === undefined) return false;
  response.writeHead(200, { "Content-Type": upload.type }).end(upload.body);
  return true;
}

function control(url, response) {
  const account = url.searchParams.get("scope");
  if (account === null) {
    response.writeHead(400).end("missing scope");
    return;
  }
  const state = scopeState(account);
  switch (url.pathname) {
    case "/control/reset":
      scopes.delete(account);
      break;
    case "/control/next":
      state.queued.push(Number(url.searchParams.get("status")));
      break;
    case "/control/limit":
      state.limit = Number(url.searchParams.get("bytes"));
      break;
    case "/control/hold":
      state.hold = url.searchParams.get("key") ?? undefined;
      break;
    case "/control/uploads":
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(state.uploads));
      return;
    default:
      response.writeHead(404).end();
      return;
  }
  response.writeHead(204).end();
}

function cors(request, response) {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "POST");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Content-Disposition",
  );
  response.setHeader("Access-Control-Expose-Headers", "Location, Upload-Limit");
}

// The e2e Ergo accounts' SASL PLAIN passwords (isolatedPassword in irc-client.ts), as
// draft/FILEHOST maps them to Basic.
function signedInAccount(authorization) {
  const encoded = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(authorization ?? "")?.[1];
  if (encoded === undefined) return undefined;
  const [account, ...password] = Buffer.from(encoded, "base64")
    .toString()
    .split(":");
  return account !== undefined && password.join(":") === `test-${account}`
    ? account
    : undefined;
}

// A held upload stops reading its body half-way, so the browser's progress stalls part-way
// until the test releases it.
function receive(request, response, release) {
  const account = signedInAccount(request.headers.authorization);
  const state = account === undefined ? undefined : scopeState(account);
  const chunks = [];
  const hold = state?.hold;
  if (state !== undefined) state.hold = undefined;
  const half = Number(request.headers["content-length"] ?? 0) / 2;
  let received = 0;
  let paused = false;
  request.on("data", (chunk) => {
    chunks.push(chunk);
    received += chunk.length;
    if (hold === undefined || paused || received < half) return;
    paused = true;
    request.pause();
    release(hold, () => request.resume());
  });
  request.on("end", () =>
    respond(request, response, state, Buffer.concat(chunks)),
  );
}

function respond(request, response, state, body) {
  const plain = { "Content-Type": "text/plain; charset=utf-8" };
  if (state === undefined) {
    response.writeHead(401, plain).end("Sign in to upload.");
    return;
  }
  state.uploads.push({
    authorization: request.headers.authorization ?? null,
    contentType: request.headers["content-type"] ?? null,
    disposition: request.headers["content-disposition"] ?? null,
    size: body.length,
    body: body.length <= recordedBodyLimit ? body.toString("base64") : null,
  });
  const queued = state.queued.shift();
  if (queued !== undefined) {
    response.writeHead(queued, plain).end(`Refused with ${queued}.`);
    return;
  }
  if (state.limit !== undefined && body.length > state.limit) {
    response
      .writeHead(413, { ...plain, "Upload-Limit": `maxsize=${state.limit}` })
      .end("That image is too large.");
    return;
  }
  const kind = typesByMagic.find(({ magic }) =>
    magic.every((byte, index) => body[index] === byte),
  );
  if (kind === undefined) {
    response.writeHead(415, plain).end("Only images can be uploaded.");
    return;
  }
  const path = `/${randomBytes(16).toString("base64url").slice(0, 22)}.${kind.extension}`;
  stored.set(path, { type: kind.type, body });
  const location = `https://${request.headers.host}${path}`;
  response.writeHead(201, { ...plain, Location: location }).end(location);
}
