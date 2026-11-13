import http from "node:http";
import net from "node:net";
import { injectedIrcFrame } from "./socket-forwarder-inject.mjs";
import { WebSocketIrcTimeRewriter } from "./socket-forwarder-rewrite.mjs";
import {
  inScope,
  ScopedFlag,
  upgradeRequestScope,
} from "./socket-forwarder-scope.mjs";

const listenPort = Number(process.env.WEBLOUNGE_FORWARDER_PORT ?? "8066");
const targetPort = Number(
  process.env.WEBLOUNGE_FORWARDER_TARGET_PORT ?? "8067",
);
const controlPort = Number(
  process.env.WEBLOUNGE_FORWARDER_CONTROL_PORT ?? "8091",
);

const connections = new Set();
const incomingTimeRewrites = [];
const dropped = new ScopedFlag();
const incomingPaused = new ScopedFlag();

const server = net.createServer((client) => {
  if (dropped.has(null)) {
    client.resetAndDestroy();
    return;
  }

  const connection = {
    client,
    upstream: undefined,
    scope: undefined,
    requestHead: Buffer.alloc(0),
    silent: false,
    dropIncomingContaining: undefined,
    incomingHandshake: Buffer.alloc(0),
    injectedOpcode: 0x81,
    incomingTimeRewriter: new WebSocketIrcTimeRewriter(incomingTimeRewrites),
    recentIncoming: Buffer.alloc(0),
  };
  const upstream = net.connect(targetPort, "127.0.0.1");
  connection.upstream = upstream;
  connections.add(connection);

  client.on("data", (data) => {
    const forwarded =
      connection.scope === undefined ? identifyScope(connection, data) : data;
    if (forwarded !== undefined && !connection.silent)
      connection.upstream?.write(forwarded);
  });
  upstream.on("data", (data) => {
    observeIncomingProtocol(connection, data);
    const target = connection.dropIncomingContaining;
    if (target !== undefined) {
      const candidate = Buffer.concat([connection.recentIncoming, data]);
      if (candidate.includes(target)) {
        connection.dropIncomingContaining = undefined;
        closeConnection(connection);
        return;
      }
      connection.recentIncoming = candidate.subarray(
        Math.max(0, candidate.length - target.length + 1),
      );
    }
    const rewritten = connection.incomingTimeRewriter.push(data);
    if (rewritten.length > 0) client.write(rewritten);
  });
  client.on("close", () => closeConnection(connection));
  client.on("error", () => closeConnection(connection));
  upstream.on("close", () => {
    connection.upstream = undefined;
    if (!connection.silent) closeConnection(connection);
  });
  upstream.on("error", () => {
    if (!connection.silent) closeConnection(connection);
  });
});

function identifyScope(connection, data) {
  const head = Buffer.concat([connection.requestHead, data]);
  const scope = upgradeRequestScope(head);
  if (scope === undefined) {
    connection.requestHead = head;
    return undefined;
  }
  connection.scope = scope;
  connection.requestHead = undefined;
  if (dropped.has(scope)) {
    closeConnection(connection);
    return undefined;
  }
  if (incomingPaused.has(scope)) connection.upstream?.pause();
  return head;
}

function scopedConnections(scope) {
  return [...connections].filter((connection) =>
    inScope(connection.scope, scope),
  );
}

const control = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const scope = url.searchParams.get("scope");
  const selected = () => scopedConnections(scope);
  if (request.method === "GET" && url.pathname === "/health") {
    response.end("ok");
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  if (url.pathname === "/drop") {
    dropped.set(scope, true);
    for (const connection of selected()) {
      connection.silent = true;
      connection.upstream?.destroy();
      connection.upstream = undefined;
    }
    response.end("dropped");
    return;
  }
  if (url.pathname === "/restore") {
    dropped.set(scope, false);
    response.end("restored");
    return;
  }
  if (url.pathname === "/pause-incoming") {
    incomingPaused.set(scope, true);
    for (const connection of selected()) connection.upstream?.pause();
    response.end("paused");
    return;
  }
  if (url.pathname === "/resume-incoming") {
    incomingPaused.set(scope, false);
    for (const connection of selected()) connection.upstream?.resume();
    response.end("resumed");
    return;
  }
  if (url.pathname === "/inject") {
    readRequestBody(request, response, (line) => {
      if (line.length === 0) {
        response.writeHead(400).end("missing IRC line");
        return;
      }
      const targets = selected();
      try {
        for (const connection of targets)
          connection.client.write(
            injectedIrcFrame(line, connection.injectedOpcode),
          );
      } catch (error) {
        response.writeHead(413).end(String(error));
        return;
      }
      response.end(`injected into ${targets.length} connection(s)`);
    });
    return;
  }
  if (url.pathname === "/drop-incoming") {
    const contains = url.searchParams.get("contains");
    if (contains === null || contains.length === 0) {
      response.writeHead(400).end("missing contains");
      return;
    }
    const target = Buffer.from(contains);
    for (const connection of selected()) {
      connection.dropIncomingContaining = target;
      connection.recentIncoming = Buffer.alloc(0);
    }
    response.end("armed");
    return;
  }
  if (url.pathname === "/rewrite-time") {
    const contains = url.searchParams.get("contains");
    const time = url.searchParams.get("time");
    if (
      contains === null ||
      contains.length === 0 ||
      time === null ||
      !Number.isFinite(Date.parse(time))
    ) {
      response.writeHead(400).end("missing contains or time");
      return;
    }
    const existing = incomingTimeRewrites.find(
      (rule) => rule.contains === contains,
    );
    if (existing === undefined) incomingTimeRewrites.push({ contains, time });
    else existing.time = time;
    response.end("armed");
    return;
  }
  response.writeHead(404).end();
});

function closeConnection(connection) {
  if (!connections.delete(connection)) return;
  connection.client.destroy();
  connection.upstream?.destroy();
}

function observeIncomingProtocol(connection, data) {
  if (connection.incomingHandshake === undefined) return;
  const handshake = Buffer.concat([connection.incomingHandshake, data]);
  const end = handshake.indexOf("\r\n\r\n");
  if (end < 0) {
    connection.incomingHandshake = handshake;
    return;
  }
  const headers = handshake.subarray(0, end).toString().toLowerCase();
  if (headers.includes("sec-websocket-protocol: binary.ircv3.net"))
    connection.injectedOpcode = 0x82;
  connection.incomingHandshake = undefined;
}

function readRequestBody(request, response, receive) {
  const chunks = [];
  let length = 0;
  request.on("data", (chunk) => {
    length += chunk.length;
    if (length <= 65_535) chunks.push(chunk);
  });
  request.on("end", () => {
    if (length > 65_535) {
      response.writeHead(413).end("IRC line is too long");
      return;
    }
    receive(Buffer.concat(chunks).toString());
  });
}

server.listen(listenPort, "127.0.0.1");
control.listen(controlPort, "127.0.0.1", () => {
  console.log("WebLounge socket forwarder is ready");
});
