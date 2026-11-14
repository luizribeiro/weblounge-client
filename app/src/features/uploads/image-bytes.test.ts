import { describe, expect, it } from "vitest";
import { sniffImageType, stripJpegMetadata } from "./image-bytes";

const bytes = (...parts: readonly (readonly number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string"
        ? Array.from(part, (character) => character.charCodeAt(0))
        : [...part],
    ),
  );

function segment(marker: number, body: Uint8Array): Uint8Array {
  const length = body.length + 2;
  return bytes([0xff, marker, length >> 8, length & 0xff], [...body]);
}

// Little-endian EXIF whose IFD0 holds Orientation and a GPS IFD pointer, with a GPS latitude.
function exifWithGps(orientation: number): Uint8Array {
  return segment(
    0xe1,
    bytes(
      "Exif\0\0",
      "II",
      [0x2a, 0x00, 0x08, 0x00, 0x00, 0x00],
      [0x02, 0x00],
      [
        0x12,
        0x01,
        0x03,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        orientation,
        0x00,
        0x00,
        0x00,
      ],
      [0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00],
      [0x00, 0x00, 0x00, 0x00],
      [0x01, 0x00],
      [0x02, 0x00, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      "GPS-37.7749N",
    ),
  );
}

const app0 = segment(0xe0, bytes("JFIF\0", [1, 2, 0, 0, 1, 0, 1, 0, 0]));
const xmp = segment(0xe1, bytes("http://ns.adobe.com/xap/1.0/\0<x:gps/>"));
const icc = segment(0xe2, bytes("ICC_PROFILE\0", [1, 1, 9, 9]));
const mpf = segment(0xe2 + 1, bytes("MPF\0thumbnail"));
const photoshop = segment(0xed, bytes("Photoshop 3.0\0caption"));
const adobe = segment(0xee, bytes("Adobe", [0, 100, 0, 0, 0, 0, 1]));
const commentSegment = segment(0xfe, bytes("taken at home"));
const dqt = segment(0xdb, bytes([0x00], new Array(64).fill(1)));
const sof = segment(0xc0, bytes([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
const scan = bytes(
  [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0],
  [0x12, 0xff, 0x00, 0x34],
  [0xff, 0xd9],
);

function jpeg(...segments: readonly Uint8Array[]): Uint8Array {
  return bytes([0xff, 0xd8], ...segments.map((part) => [...part]), [...scan]);
}

const text = (value: Uint8Array) => String.fromCharCode(...value);

describe("sniffImageType", () => {
  it("recognizes the types file hosts accept by their magic bytes", () => {
    expect(sniffImageType(bytes([0x89], "PNG\r\n\x1a\n"))).toBe("png");
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImageType(bytes("GIF89a"))).toBe("gif");
    expect(sniffImageType(bytes("GIF87a"))).toBe("gif");
    expect(sniffImageType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe(
      "webp",
    );
  });

  it("leaves other formats for re-encoding", () => {
    expect(sniffImageType(bytes([0, 0, 0, 0x18], "ftypheic"))).toBeUndefined();
    expect(sniffImageType(bytes("II*\0"))).toBeUndefined();
    expect(sniffImageType(bytes("<svg"))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
  });
});

describe("stripJpegMetadata", () => {
  it("keeps only JFIF, ICC, Adobe and the image, plus the orientation", () => {
    const stripped = stripJpegMetadata(
      jpeg(
        app0,
        exifWithGps(6),
        xmp,
        icc,
        mpf,
        photoshop,
        adobe,
        commentSegment,
        dqt,
        sof,
      ),
    );
    expect(stripped).toEqual(
      jpeg(
        app0,
        segment(
          0xe1,
          bytes(
            "Exif\0\0",
            "MM",
            [0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01],
            [
              0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00,
              0x00,
            ],
            [0x00, 0x00, 0x00, 0x00],
          ),
        ),
        icc,
        adobe,
        dqt,
        sof,
      ),
    );
    const output = text(stripped ?? new Uint8Array());
    for (const leaked of ["GPS", "xap", "MPF", "Photoshop", "taken at home"])
      expect(output).not.toContain(leaked);
  });

  it("drops a default orientation and works without APP0", () => {
    expect(stripJpegMetadata(jpeg(exifWithGps(1), dqt, sof))).toEqual(
      jpeg(dqt, sof),
    );
    const rotated = stripJpegMetadata(jpeg(exifWithGps(8), sof));
    expect(rotated?.slice(2, 4)).toEqual(new Uint8Array([0xff, 0xe1]));
  });

  it("reads big-endian EXIF orientation", () => {
    const bigEndian = segment(
      0xe1,
      bytes(
        "Exif\0\0",
        "MM",
        [0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01],
        [
          0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x03, 0x00,
          0x00,
        ],
        [0x00, 0x00, 0x00, 0x00],
      ),
    );
    expect(stripJpegMetadata(jpeg(bigEndian, sof))).toEqual(
      jpeg(bigEndian, sof),
    );
  });

  it("returns undefined for streams it cannot parse", () => {
    expect(stripJpegMetadata(bytes("GIF89a"))).toBeUndefined();
    expect(
      stripJpegMetadata(bytes([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1])),
    ).toBeUndefined();
    expect(stripJpegMetadata(bytes([0xff, 0xd8, 0x00]))).toBeUndefined();
    expect(stripJpegMetadata(bytes([0xff, 0xd8], [...app0]))).toBeUndefined();
  });
});
