import assert from "node:assert/strict";
import test from "node:test";
import { injectedIrcFrame } from "./socket-forwarder-inject.mjs";
import {
  IrcTimeRewriter,
  textRewriteRule,
  WebSocketIrcTimeRewriter,
} from "./socket-forwarder-rewrite.mjs";

const rules = [{ contains: "armed message", time: "2026-01-02T03:04:05.678Z" }];

test("encodes injected IRC lines as unmasked WebSocket text frames", () => {
  const frame = injectedIrcFrame(":irc.test WALLOPS :maintenance");

  assert.equal(frame[0], 0x81);
  assert.equal(frame[1] & 0x80, 0);
  assert.equal(frameText(frame), ":irc.test WALLOPS :maintenance");
});

test("encodes injected lines for a negotiated binary IRC connection", () => {
  const frame = injectedIrcFrame(":irc.test WALLOPS :maintenance", 0x82);

  assert.equal(frame[0], 0x82);
  assert.equal(frame[1] & 0x80, 0);
  assert.equal(frameText(frame), ":irc.test WALLOPS :maintenance");
});

test("swaps equal-length text in every incoming line", () => {
  const rule = textRewriteRule("127.0.0.1:4175", "localhost:4175");
  const rewriter = new IrcTimeRewriter([rule]);
  const line =
    ":irc.localhost 005 weblounge draft/FILEHOST=https://127.0.0.1:4175/upload :are supported\r\n";

  assert.equal(
    rewriter.push(Buffer.from(line)).toString(),
    line.replace("127.0.0.1:4175", "localhost:4175"),
  );
  assert.equal(textRewriteRule("draft/FILEHOST", "x"), undefined);
  assert.equal(textRewriteRule("", ""), undefined);
});

test("passes traffic through while no rewrite is armed", () => {
  const rewriter = new IrcTimeRewriter([]);
  const websocketFrame = Buffer.from([0x81, 0x05, ...Buffer.from("hello")]);

  assert.deepEqual(rewriter.push(websocketFrame), websocketFrame);
});

test("buffers split IRC lines until their CRLF arrives", () => {
  const rewriter = new IrcTimeRewriter(rules);

  assert.equal(
    rewriter.push(
      Buffer.from("@time=2025-01-01T00:00:00.000Z :nick PRIVMSG #room :armed"),
    ).length,
    0,
  );
  assert.equal(
    rewriter.push(Buffer.from(" message\r\n")).toString(),
    "@time=2026-01-02T03:04:05.678Z :nick PRIVMSG #room :armed message\r\n",
  );
});

test("rewrites every matching IRC line in one chunk", () => {
  const rewriter = new IrcTimeRewriter(rules);

  assert.equal(
    rewriter
      .push(
        Buffer.from(
          "@time=2025-01-01T00:00:00.000Z :a PRIVMSG #room :armed message\r\n" +
            "@time=2025-02-02T00:00:00.000Z :b PRIVMSG #room :armed message\r\n",
        ),
      )
      .toString(),
    "@time=2026-01-02T03:04:05.678Z :a PRIVMSG #room :armed message\r\n" +
      "@time=2026-01-02T03:04:05.678Z :b PRIVMSG #room :armed message\r\n",
  );
});

test("leaves a matching line without time unchanged and continues", () => {
  const rewriter = new IrcTimeRewriter(rules);
  const input =
    "@time=2025-01-01T00:00:00.000Z :server NOTICE * :earlier\r\n" +
    ":nick PRIVMSG #room :armed message\r\n" +
    "@time=2025-03-03T00:00:00.000Z :nick PRIVMSG #room :armed message\r\n";

  assert.equal(
    rewriter.push(Buffer.from(input)).toString(),
    "@time=2025-01-01T00:00:00.000Z :server NOTICE * :earlier\r\n" +
      ":nick PRIVMSG #room :armed message\r\n" +
      "@time=2026-01-02T03:04:05.678Z :nick PRIVMSG #room :armed message\r\n",
  );
});

test("rewrites complete IRC messages inside split WebSocket frames", () => {
  const rewriter = new WebSocketIrcTimeRewriter(rules);
  const handshake = Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n",
  );
  const frame = textFrame(
    "@time=2025-01-01T00:00:00.000Z :nick PRIVMSG #room :armed message",
  );

  assert.deepEqual(
    rewriter.push(Buffer.concat([handshake, frame.subarray(0, 8)])),
    handshake,
  );
  assert.equal(
    frameText(rewriter.push(frame.subarray(8))),
    "@time=2026-01-02T03:04:05.678Z :nick PRIVMSG #room :armed message",
  );
});

test("applies a scoped text rewrite only to its own connection", () => {
  const rule = textRewriteRule("127.0.0.1:4175", "localhost:4175", "me1");
  const handshake = Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  const line =
    ":irc.localhost 005 me1 draft/FILEHOST=https://127.0.0.1:4175/upload";
  const forScope = (scope) =>
    new WebSocketIrcTimeRewriter(
      [rule],
      (candidate) => candidate.scope === scope,
    );

  const own = forScope("me1").push(Buffer.concat([handshake, textFrame(line)]));
  const other = forScope("me2").push(
    Buffer.concat([handshake, textFrame(line)]),
  );

  assert.equal(
    frameText(own.subarray(handshake.length)),
    line.replace("127.0.0.1:4175", "localhost:4175"),
  );
  assert.equal(frameText(other.subarray(handshake.length)), line);
});

test("rewrites the binary IRC WebSocket subprotocol", () => {
  const rewriter = new WebSocketIrcTimeRewriter(rules);
  const handshake = Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  const frame = textFrame(
    "@time=2025-01-01T00:00:00.000Z :nick PRIVMSG #room :armed message",
    0x82,
  );

  const rewritten = rewriter.push(Buffer.concat([handshake, frame]));
  assert.equal(
    frameText(rewritten.subarray(handshake.length)),
    "@time=2026-01-02T03:04:05.678Z :nick PRIVMSG #room :armed message",
  );
});

test("rewrites IRC lines split across fragmented WebSocket messages", () => {
  const rewriter = new WebSocketIrcTimeRewriter(rules);
  const handshake = Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  const start = textFrame(
    "@time=2025-01-01T00:00:00.000Z :nick PRIVMSG #room :armed",
    0x02,
  );
  const end = textFrame(" message", 0x80);

  assert.deepEqual(rewriter.push(Buffer.concat([handshake, start])), handshake);
  const rewritten = rewriter.push(end);
  assert.equal(
    Buffer.concat([
      framePayload(rewritten),
      framePayload(rewritten, start.length),
    ]).toString(),
    "@time=2026-01-02T03:04:05.678Z :nick PRIVMSG #room :armed message",
  );
});

function textFrame(text, firstByte = 0x81) {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126);
  return Buffer.concat([Buffer.from([firstByte, payload.length]), payload]);
}

function frameText(frame) {
  return frame.subarray(2).toString();
}

function framePayload(frames, offset = 0) {
  const length = frames[offset + 1] & 0x7f;
  return frames.subarray(offset + 2, offset + 2 + length);
}
