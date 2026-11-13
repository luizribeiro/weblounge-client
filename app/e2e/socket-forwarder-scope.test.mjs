import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { injectedIrcFrame } from "./socket-forwarder-inject.mjs";
import {
  inScope,
  ScopedFlag,
  scopeCookieName,
  upgradeRequestScope,
} from "./socket-forwarder-scope.mjs";

const upgrade = (headers) =>
  Buffer.from(
    `GET /socket HTTP/1.1\r\nHost: 127.0.0.1:4173\r\n${headers}Upgrade: websocket\r\n\r\n`,
  );

test("waits for the whole upgrade request before naming a scope", () => {
  assert.equal(
    upgradeRequestScope(Buffer.from("GET /socket HTTP/1.1\r\nCookie: a")),
    undefined,
  );
});

test("reads the scope cookie among the browser's other cookies", () => {
  assert.equal(
    upgradeRequestScope(
      upgrade(`cookie: theme=dark; ${scopeCookieName}=ana-w1k3x9; lang=en\r\n`),
    ),
    "ana-w1k3x9",
  );
});

test("keeps a cookie value byte for byte", () => {
  assert.equal(
    upgradeRequestScope(upgrade(`Cookie: ${scopeCookieName}=50%off\r\n`)),
    "50%off",
  );
});

test("leaves an upgrade without the scope cookie unscoped", () => {
  assert.equal(upgradeRequestScope(upgrade("Cookie: theme=dark\r\n")), null);
  assert.equal(upgradeRequestScope(upgrade("")), null);
});

test("an unscoped control reaches every connection, a scoped one only its own", () => {
  assert.equal(inScope("ana", null), true);
  assert.equal(inScope(null, null), true);
  assert.equal(inScope("ana", "ana"), true);
  assert.equal(inScope("bob", "ana"), false);
  assert.equal(inScope(null, "ana"), false);
});

test("a scoped flag holds per scope and a global one holds everywhere", () => {
  const flag = new ScopedFlag();
  flag.set("ana", true);
  assert.equal(flag.has("ana"), true);
  assert.equal(flag.has("bob"), false);
  assert.equal(flag.has(null), false);
  flag.set(null, true);
  assert.equal(flag.has("bob"), true);
  assert.equal(flag.has(null), true);
  flag.set(null, false);
  flag.set("ana", false);
  assert.equal(flag.has("ana"), false);
});

test("a scoped drop cuts and refuses only that scope's sockets", async (t) => {
  const forwarder = await startForwarder(t);
  const ana = await forwarder.open("ana");
  const unscoped = await forwarder.open(undefined);
  const bob = await forwarder.open("bob");

  await forwarder.control("/drop?scope=ana");
  await forwarder.send(bob, "still here");
  await forwarder.send(unscoped, "unscoped too");
  const refused = await forwarder.connect("ana");
  await new Promise((resolve) => refused.on("close", resolve));
  await forwarder.control("/restore?scope=ana");
  const back = await forwarder.open("ana");
  await forwarder.send(back, "back again");

  assert.equal(ana.destroyed, false);
  assert.equal(
    await forwarder.control("/inject?scope=ana", "PING x"),
    "injected into 2 connection(s)",
  );
  assert.equal(
    await forwarder.control("/inject?scope=bob", "PING x"),
    "injected into 1 connection(s)",
  );
});

async function startForwarder(t) {
  const base = 20_000 + Math.floor(Math.random() * 20_000);
  const ports = { listen: base, target: base + 1, control: base + 2 };
  const echo = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  echo.listen(ports.target, "127.0.0.1");
  await once(echo, "listening");
  const child = spawn(
    process.execPath,
    [new URL("./socket-forwarder.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        WEBLOUNGE_FORWARDER_PORT: String(ports.listen),
        WEBLOUNGE_FORWARDER_TARGET_PORT: String(ports.target),
        WEBLOUNGE_FORWARDER_CONTROL_PORT: String(ports.control),
      },
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    },
  );
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    child.kill();
    echo.close();
  });
  await once(child.stdout, "data");
  const received = new Map();
  const connect = (scope) => {
    const socket = net.connect(ports.listen, "127.0.0.1");
    sockets.push(socket);
    received.set(socket, "");
    socket.on("data", (chunk) => {
      received.set(socket, received.get(socket) + chunk.toString());
    });
    socket.on("error", () => {});
    const head = upgrade(
      scope === undefined ? "" : `Cookie: ${scopeCookieName}=${scope}\r\n`,
    );
    socket.write(head.subarray(0, 20));
    socket.write(head.subarray(20));
    return socket;
  };
  const send = async (socket, text) => {
    socket.write(injectedIrcFrame(text));
    while (!received.get(socket).includes(text)) await once(socket, "data");
  };
  return {
    connect,
    send,
    open: async (scope) => {
      const socket = connect(scope);
      await send(socket, `hello ${scope}`);
      return socket;
    },
    control: async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${ports.control}${path}`, {
        method: "POST",
        body,
      });
      return response.text();
    },
  };
}
