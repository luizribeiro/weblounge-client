import { decodeBase64Url } from "./base64url";

const saltLength = 16;
const recordSizeLength = 4;
const keyLengthLength = 1;
const p256PublicKeyLength = 65;
const headerLength =
  saltLength + recordSizeLength + keyLengthLength + p256PublicKeyLength;
const authenticationTagLength = 16;
const textEncoder = new TextEncoder();

interface EncryptedRecord {
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly senderPublicKey: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
}

export async function decryptPushPayload(
  encrypted: Uint8Array<ArrayBuffer>,
  receiverPrivateKey: CryptoKey,
  receiverPublicKey: string,
  authenticationSecret: string,
  webCrypto: Crypto = crypto,
): Promise<Uint8Array<ArrayBuffer>> {
  const record = decodeRecord(encrypted);
  const receiverPublic = decodeBase64Url(receiverPublicKey);
  const authentication = decodeBase64Url(authenticationSecret);
  if (
    receiverPublic.byteLength !== p256PublicKeyLength ||
    authentication.byteLength !== 16
  ) {
    throw new Error("invalid push route key material");
  }
  const senderPublic = await webCrypto.subtle.importKey(
    "raw",
    record.senderPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = await webCrypto.subtle.deriveBits(
    { name: "ECDH", public: senderPublic },
    receiverPrivateKey,
    256,
  );
  const keyInfo = concatenate(
    textEncoder.encode("WebPush: info\0"),
    receiverPublic,
    record.senderPublicKey,
  );
  const inputKeyMaterial = await hkdf(
    webCrypto,
    sharedSecret,
    authentication,
    keyInfo,
    256,
  );
  const contentKey = await hkdf(
    webCrypto,
    inputKeyMaterial,
    record.salt,
    textEncoder.encode("Content-Encoding: aes128gcm\0"),
    128,
  );
  const nonce = await hkdf(
    webCrypto,
    inputKeyMaterial,
    record.salt,
    textEncoder.encode("Content-Encoding: nonce\0"),
    96,
  );
  const key = await webCrypto.subtle.importKey(
    "raw",
    contentKey,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const decrypted = new Uint8Array(
    await webCrypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      key,
      record.ciphertext,
    ),
  );
  return unpadRecord(decrypted);
}

function decodeRecord(encrypted: Uint8Array<ArrayBuffer>): EncryptedRecord {
  if (encrypted.byteLength < headerLength + authenticationTagLength + 1) {
    throw new Error("encrypted push payload is truncated");
  }
  const view = new DataView(
    encrypted.buffer,
    encrypted.byteOffset,
    encrypted.byteLength,
  );
  const recordSize = view.getUint32(saltLength);
  const keyLength = encrypted[saltLength + recordSizeLength];
  if (
    recordSize <= authenticationTagLength + 1 ||
    keyLength !== p256PublicKeyLength ||
    encrypted[21] !== 4
  ) {
    throw new Error("encrypted push payload has an invalid header");
  }
  return {
    salt: encrypted.slice(0, saltLength),
    senderPublicKey: encrypted.slice(
      saltLength + recordSizeLength + keyLengthLength,
      headerLength,
    ),
    ciphertext: encrypted.slice(headerLength),
  };
}

async function hkdf(
  webCrypto: Crypto,
  input: BufferSource,
  salt: BufferSource,
  info: BufferSource,
  length: number,
): Promise<ArrayBuffer> {
  const key = await webCrypto.subtle.importKey("raw", input, "HKDF", false, [
    "deriveBits",
  ]);
  return webCrypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length,
  );
}

function unpadRecord(record: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let delimiter = record.byteLength - 1;
  while (delimiter >= 0 && record[delimiter] === 0) delimiter -= 1;
  if (delimiter < 0 || record[delimiter] !== 2) {
    throw new Error("encrypted push payload has invalid padding");
  }
  return record.slice(0, delimiter);
}

function concatenate(
  ...parts: readonly Uint8Array<ArrayBuffer>[]
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
