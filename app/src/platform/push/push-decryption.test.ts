import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeBase64Url } from "./base64url";
import { decryptPushPayload } from "./push-decryption";

const receiverPrivate = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const receiverPublic =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const authenticationSecret = "BTBZMqHH6r4Tts7J_aSIgg";
const encrypted =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

describe("RFC 8291 decryption", () => {
  it("decrypts the section 5 test vector", async () => {
    const privateKey = await receiverPrivateKeyBytes();

    const plaintext = await decryptPushPayload(
      decodeBase64Url(encrypted),
      privateKey,
      receiverPublic,
      authenticationSecret,
      webcrypto as unknown as Crypto,
    );

    expect(new TextDecoder().decode(plaintext)).toBe(
      "When I grow up, I want to be a watermelon",
    );
  });

  it("rejects authentication failures and invalid padding", async () => {
    const privateKey = await receiverPrivateKeyBytes();
    const tampered = decodeBase64Url(encrypted);
    const finalIndex = tampered.length - 1;
    tampered[finalIndex] = (tampered[finalIndex] ?? 0) ^ 1;

    await expect(
      decryptPushPayload(
        tampered,
        privateKey,
        receiverPublic,
        authenticationSecret,
        webcrypto as unknown as Crypto,
      ),
    ).rejects.toThrow();
    await expect(
      decryptPushPayload(
        decodeBase64Url(encrypted).slice(0, 90),
        privateKey,
        receiverPublic,
        authenticationSecret,
        webcrypto as unknown as Crypto,
      ),
    ).rejects.toThrow();
  });
});

async function receiverPrivateKeyBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const point = decodeBase64Url(receiverPublic);
  const coordinateLength = 32;
  const x = point.slice(1, coordinateLength + 1);
  const y = point.slice(coordinateLength + 1);
  const privateKey = await webcrypto.subtle.importKey(
    "jwk",
    {
      crv: "P-256",
      d: receiverPrivate,
      ext: true,
      key_ops: ["deriveBits"],
      kty: "EC",
      x: encodeBase64UrlForTest(x),
      y: encodeBase64UrlForTest(y),
    },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", privateKey));
}

function encodeBase64UrlForTest(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
