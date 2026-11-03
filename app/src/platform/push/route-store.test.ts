import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { decodeBase64Url } from "./base64url";
import { createRouteKeys } from "./route-store";

it("creates route encryption material with a non-extractable P-256 private key", async () => {
  const keys = await createRouteKeys(webcrypto as unknown as Crypto);

  expect(decodeBase64Url(keys.p256dh)).toHaveLength(65);
  expect(decodeBase64Url(keys.auth)).toHaveLength(16);
  expect(keys.privateKey.algorithm).toMatchObject({
    name: "ECDH",
    namedCurve: "P-256",
  });
  expect(keys.privateKey.extractable).toBe(false);
  await expect(
    webcrypto.subtle.exportKey(
      "jwk",
      keys.privateKey as unknown as import("node:crypto").webcrypto.CryptoKey,
    ),
  ).rejects.toThrow();
});
