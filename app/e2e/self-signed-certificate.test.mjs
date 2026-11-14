import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createServer, get } from "node:https";
import { test } from "node:test";
import { selfSignedCertificate } from "./self-signed-certificate.mjs";

test("issues a valid self-signed certificate for an IP address", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const { cert, key } = selfSignedCertificate("127.0.0.1", now);
  const certificate = new X509Certificate(cert);

  assert.equal(certificate.subject, "CN=127.0.0.1");
  assert.equal(certificate.issuer, "CN=127.0.0.1");
  assert.equal(certificate.subjectAltName, "IP Address:127.0.0.1");
  assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(certificate.checkPrivateKey(createPrivateKey(key)), true);
  assert.ok(new Date(certificate.validFrom) < now);
  assert.ok(new Date(certificate.validTo) > now);
});

test("encodes every random serial number as a parseable DER integer", () => {
  for (let run = 0; run < 1000; run += 1) {
    const { cert } = selfSignedCertificate("127.0.0.1");
    assert.doesNotThrow(() => new X509Certificate(cert));
  }
});

test("serves TLS that a client pinned to the certificate accepts", async () => {
  const { cert, key } = selfSignedCertificate("127.0.0.1");
  const server = createServer({ cert, key }, (_request, response) =>
    response.end("ok"),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const response = await new Promise((resolve, reject) => {
      get(
        { ca: cert, host: "127.0.0.1", port: address.port, path: "/" },
        resolve,
      ).on("error", reject);
    });
    assert.equal(response.statusCode, 200);
    response.resume();
  } finally {
    server.close();
  }
});
