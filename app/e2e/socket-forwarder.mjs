import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.WEBLOUNGE_FORWARDER_PORT ?? "8066");
const targetPort = Number(
  process.env.WEBLOUNGE_FORWARDER_TARGET_PORT ?? "8067",
);
const controlPort = Number(
  process.env.WEBLOUNGE_FORWARDER_CONTROL_PORT ?? "8091",
);

const connections = new Set();
let available = true;

const server = net.createServer((client) => {
  if (!available) {
    client.resetAndDestroy();
    return;
  }

  const connection = {
    client,
    upstream: undefined,
    silent: false,
    dropIncomingContaining: undefined,
    recentIncoming: Buffer.alloc(0),
  };
  const upstream = net.connect(targetPort, "127.0.0.1");
  connection.upstream = upstream;
  connections.add(connection);

  client.on("data", (data) => {
    if (!connection.silent) connection.upstream?.write(data);
  });
  upstream.on("data", (data) => {
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
    client.write(data);
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

const control = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.end("ok");
    return;
  }
  if (request.method === "POST" && request.url === "/drop") {
    available = false;
    for (const connection of connections) {
      connection.silent = true;
      connection.upstream?.destroy();
      connection.upstream = undefined;
    }
    response.end("dropped");
    return;
  }
  if (request.method === "POST" && request.url === "/restore") {
    available = true;
    response.end("restored");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/drop-incoming") {
    const contains = url.searchParams.get("contains");
    if (contains === null || contains.length === 0) {
      response.writeHead(400).end("missing contains");
      return;
    }
    const target = Buffer.from(contains);
    for (const connection of connections) {
      connection.dropIncomingContaining = target;
      connection.recentIncoming = Buffer.alloc(0);
    }
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

server.listen(listenPort, "127.0.0.1");
control.listen(controlPort, "127.0.0.1", () => {
  console.log("WebLounge socket forwarder is ready");
});
