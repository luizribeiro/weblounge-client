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
const incomingTimeRewrites = [];
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
    let rewritten = data;
    const ruleIndex = incomingTimeRewrites.findIndex(
      ({ contains }) => data.indexOf(Buffer.from(contains)) >= 0,
    );
    const rule = incomingTimeRewrites[ruleIndex];
    if (rule !== undefined) {
      const match = data.indexOf(Buffer.from(rule.contains));
      const lineStart = data.lastIndexOf("\r\n", match) + 2;
      const timeTagStart = data.indexOf("time=", lineStart);
      if (timeTagStart < lineStart || timeTagStart >= match)
        throw new Error("matched IRC line has no server-time tag");
      const timeStart = timeTagStart + 5;
      const timeEnd = findTagEnd(data, timeStart);
      const replacement = Buffer.from(
        withTimestampPrecision(rule.time, timeEnd - timeStart),
      );
      rewritten = Buffer.from(data);
      replacement.copy(rewritten, timeStart);
      incomingTimeRewrites.splice(ruleIndex, 1);
    }
    client.write(rewritten);
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
  if (request.method === "POST" && url.pathname === "/rewrite-time") {
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
    incomingTimeRewrites.push({ contains, time });
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

function withTimestampPrecision(time, length) {
  if (length === time.length) return time;
  const fractionalDigits = length - 21;
  if (fractionalDigits < 0)
    throw new Error("server time is shorter than an IRCv3 timestamp");
  const milliseconds = time.slice(20, 23);
  return `${time.slice(0, 19)}.${milliseconds.padEnd(fractionalDigits, "0").slice(0, fractionalDigits)}Z`;
}

function findTagEnd(data, start) {
  let index = start;
  while (index < data.length && ![32, 59, 13, 10].includes(data[index]))
    index += 1;
  return index;
}

server.listen(listenPort, "127.0.0.1");
control.listen(controlPort, "127.0.0.1", () => {
  console.log("WebLounge socket forwarder is ready");
});
