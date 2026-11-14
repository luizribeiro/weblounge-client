import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

const ecdsaWithSha256 = "1.2.840.10045.4.3.2";
const commonName = "2.5.4.3";
const subjectAltName = "2.5.29.17";
const dayMilliseconds = 86_400_000;

// Node has no certificate builder, hence the minimal DER encoding below. The
// certificate has no basicConstraints, so only clients that skip verification
// or pin it as a CA accept it.
export function selfSignedCertificate(ipAddress, now = new Date()) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const algorithm = sequence(objectIdentifier(ecdsaWithSha256));
  const name = sequence(
    set(sequence(objectIdentifier(commonName), utf8String(ipAddress))),
  );
  const tbsCertificate = sequence(
    tagged(0xa0, integer(Buffer.from([2]))),
    integer(serialNumber()),
    algorithm,
    name,
    sequence(
      utcTime(new Date(now.getTime() - dayMilliseconds)),
      utcTime(new Date(now.getTime() + dayMilliseconds)),
    ),
    name,
    publicKey.export({ format: "der", type: "spki" }),
    tagged(
      0xa3,
      sequence(
        sequence(
          objectIdentifier(subjectAltName),
          tagged(0x04, sequence(tagged(0x87, ipv4(ipAddress)))),
        ),
      ),
    ),
  );
  const signature = sign("sha256", tbsCertificate, privateKey);
  const certificate = sequence(
    tbsCertificate,
    algorithm,
    tagged(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
}

function serialNumber() {
  const serial = randomBytes(8);
  // DER integers are positive only below 0x80 and minimal only above 0x00.
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;
  return serial;
}

function tagged(tag, ...contents) {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

function length(value) {
  if (value < 0x80) return Buffer.from([value]);
  const bytes = [];
  for (let rest = value; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function sequence(...contents) {
  return tagged(0x30, ...contents);
}

function set(...contents) {
  return tagged(0x31, ...contents);
}

function integer(bytes) {
  return tagged(0x02, bytes);
}

function utf8String(value) {
  return tagged(0x0c, Buffer.from(value, "utf8"));
}

function utcTime(date) {
  const digits = date.toISOString().replace(/[-:T]/gu, "").slice(2, 14);
  return tagged(0x17, Buffer.from(`${digits}Z`, "ascii"));
}

function objectIdentifier(dotted) {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7)
      groups.unshift(0x80 | (value & 0x7f));
    bytes.push(...groups);
  }
  return tagged(0x06, Buffer.from(bytes));
}

function ipv4(address) {
  return Buffer.from(address.split(".").map(Number));
}

function pem(label, der) {
  const lines = der.toString("base64").match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
