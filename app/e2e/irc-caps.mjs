/** Capabilities every test client needs; registration fails clearly without them. */
export const requiredCaps = [
  "account-tag",
  "batch",
  "draft/multiline",
  "draft/read-marker",
  "echo-message",
  "message-tags",
  "sasl",
  "server-time",
];

/** Capabilities a test client takes only where the server offers them. */
export const optionalCaps = ["draft/message-redaction"];

/** Whether a `CAP LS` reply line is the last of its list (`CAP * LS :…`, not `CAP * LS * :…`). */
export function isFinalCapList(line) {
  return / CAP \S+ LS :/u.test(line);
}

/** The capability names a `CAP LS` reply line advertises, without their values. */
export function advertisedCaps(line) {
  const list = line.slice(line.indexOf(" :", line.indexOf(" LS ")) + 2);
  return list
    .split(" ")
    .filter((cap) => cap.length > 0)
    .map((cap) => cap.split("=")[0]);
}

/**
 * The capabilities to request from what the server advertised. Requesting one the server does
 * not offer makes it refuse the whole request, so optional ones are dropped and a missing required
 * one is an error.
 */
export function capabilityRequest(
  advertised,
  required = requiredCaps,
  optional = optionalCaps,
) {
  const offered = new Set(advertised);
  const missing = required.filter((cap) => !offered.has(cap));
  if (missing.length > 0)
    throw new Error(`IRC server does not offer ${missing.join(", ")}`);
  return [...required, ...optional.filter((cap) => offered.has(cap))];
}
