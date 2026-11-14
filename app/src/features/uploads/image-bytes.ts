export type SendableImageType = "png" | "jpeg" | "gif" | "webp";

export const imageMimeTypes: Readonly<Record<SendableImageType, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function sniffImageType(
  bytes: Uint8Array,
): SendableImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
    return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return "webp";
  return undefined;
}

const soi = 0xd8;
const eoi = 0xd9;
const sos = 0xda;
const app0 = 0xe0;
const app1 = 0xe1;
const app2Icc = 0xe2;
const app14Adobe = 0xee;
const comment = 0xfe;
const orientationTag = 0x0112;

interface Segment {
  readonly marker: number;
  readonly bytes: Uint8Array;
}

/**
 * Drops every JPEG metadata segment except JFIF, ICC and Adobe, keeping a non-default EXIF
 * orientation in a fresh minimal APP1. Returns undefined for a stream it cannot parse.
 */
export function stripJpegMetadata(
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> | undefined {
  const parsed = jpegSegments(bytes);
  if (parsed === undefined) return undefined;
  const orientation = parsed.segments
    .filter((segment) => segment.marker === app1)
    .map((segment) => exifOrientation(segment.bytes))
    .find((value) => value !== undefined);
  const kept = parsed.segments.filter((segment) =>
    keepsSegment(segment.marker),
  );
  const orientationSegment =
    orientation === undefined || orientation === 1
      ? []
      : [{ marker: app1, bytes: orientationApp1(orientation) }];
  const leadingApp0 = kept[0]?.marker === app0 ? 1 : 0;
  const ordered = [
    ...kept.slice(0, leadingApp0),
    ...orientationSegment,
    ...kept.slice(leadingApp0),
  ];
  return concat([
    new Uint8Array([0xff, soi]),
    ...ordered.map((segment) => segment.bytes),
    parsed.tail,
  ]);
}

function keepsSegment(marker: number): boolean {
  const application = marker >= 0xe0 && marker <= 0xef;
  if (!application) return marker !== comment;
  return marker === app0 || marker === app2Icc || marker === app14Adobe;
}

function jpegSegments(
  bytes: Uint8Array,
): { readonly segments: Segment[]; readonly tail: Uint8Array } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== soi) return undefined;
  const segments: Segment[] = [];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    let markerOffset = offset + 1;
    while (bytes[markerOffset] === 0xff) markerOffset += 1;
    const marker = bytes[markerOffset];
    if (marker === undefined) return undefined;
    if (marker === sos || marker === eoi)
      return { segments, tail: bytes.subarray(offset) };
    const end = segmentEnd(bytes, marker, markerOffset);
    if (end === undefined) return undefined;
    segments.push({ marker, bytes: bytes.subarray(offset, end) });
    offset = end;
  }
  return undefined;
}

function segmentEnd(
  bytes: Uint8Array,
  marker: number,
  markerOffset: number,
): number | undefined {
  const standalone = marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
  if (standalone) return markerOffset + 1;
  const length = readUint16(bytes, markerOffset + 1, false);
  if (length === undefined || length < 2) return undefined;
  const end = markerOffset + 1 + length;
  return end <= bytes.length ? end : undefined;
}

function exifOrientation(segment: Uint8Array): number | undefined {
  const tiff = 4 + 6;
  if (ascii(segment, 4, 10) !== "Exif\0\0") return undefined;
  const order = ascii(segment, tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  const ifdOffset = readUint32(segment, tiff + 4, little);
  if (ifdOffset === undefined) return undefined;
  const ifd = tiff + ifdOffset;
  const count = readUint16(segment, ifd, little) ?? 0;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (readUint16(segment, entry, little) !== orientationTag) continue;
    const value = readUint16(segment, entry + 8, little);
    return value !== undefined && value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

function orientationApp1(orientation: number): Uint8Array {
  return new Uint8Array([
    0xff,
    app1,
    0x00,
    0x22,
    ...Array.from("Exif\0\0", (character) => character.charCodeAt(0)),
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

function readUint16(
  bytes: Uint8Array,
  offset: number,
  little: boolean,
): number | undefined {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (first === undefined || second === undefined) return undefined;
  return little ? first | (second << 8) : (first << 8) | second;
}

function readUint32(
  bytes: Uint8Array,
  offset: number,
  little: boolean,
): number | undefined {
  const high = readUint16(bytes, little ? offset + 2 : offset, little);
  const low = readUint16(bytes, little ? offset : offset + 2, little);
  if (high === undefined || low === undefined) return undefined;
  return high * 0x10000 + low;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
