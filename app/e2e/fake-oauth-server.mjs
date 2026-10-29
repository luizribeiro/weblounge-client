import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const issuer = "http://127.0.0.1:4174";
const codes = new Map();

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", issuer);
  response.setHeader(
    "Access-Control-Allow-Origin",
    request.headers.origin ?? "*",
  );
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  if (url.pathname === "/health") return json(response, { ready: true });
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(response, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.pathname === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    if (
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("client_id") !== "weblounge-client" ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      redirectUri === null ||
      state === null ||
      challenge === null
    ) {
      response.writeHead(400).end("invalid authorization request");
      return;
    }
    const code = randomUUID();
    codes.set(code, { challenge, redirectUri });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    response.writeHead(302, { Location: callback.href }).end();
    return;
  }
  if (url.pathname === "/token" && request.method === "POST") {
    const body = new URLSearchParams(await readBody(request));
    const code = body.get("code");
    const pending = code === null ? undefined : codes.get(code);
    if (code !== null) codes.delete(code);
    const verifier = body.get("code_verifier") ?? "";
    if (
      pending === undefined ||
      body.get("grant_type") !== "authorization_code" ||
      body.get("client_id") !== "weblounge-client" ||
      body.has("client_secret") ||
      body.get("redirect_uri") !== pending.redirectUri ||
      challenge(verifier) !== pending.challenge
    ) {
      return json(response, { error: "invalid_grant" }, 400);
    }
    return json(response, {
      access_token: "fake-hosted-access-token",
      token_type: "Bearer",
      expires_in: 300,
    });
  }
  response.writeHead(404).end();
}).listen(4174, "127.0.0.1");

function challenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
