import { describe, expect, it } from "vitest";
import type { ImageCodec } from "./image-codec";
import { prepareImage, shrinkImage } from "./prepare-image";

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1]);
const jpegWithComment = new Uint8Array([
  0xff, 0xd8, 0xff, 0xfe, 0x00, 0x06, 0x68, 0x6f, 0x6d, 0x65, 0xff, 0xda, 0x00,
  0x02, 0x11, 0xff, 0xd9,
]);
const heic = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);

class FakeCodec implements ImageCodec {
  readonly calls: { readonly size: number; readonly scale: number }[] = [];
  constructor(private readonly output: Uint8Array<ArrayBuffer> | undefined) {}
  async reencode(image: Blob, scale: number) {
    this.calls.push({ size: image.size, scale });
    return this.output === undefined ? undefined : new Blob([this.output]);
  }
}

const file = (bytes: Uint8Array<ArrayBuffer>, name: string, type = "") =>
  new File([bytes], name, { type });
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("prepareImage", () => {
  it("sends accepted types as they are, named by their sniffed type", async () => {
    const codec = new FakeCodec(undefined);
    const image = await prepareImage(file(png, "Screenshot 1.PNG.tiff"), codec);
    expect(image?.filename).toBe("Screenshot 1.PNG.png");
    expect(image?.type).toBe("png");
    expect(image?.body.type).toBe("image/png");
    expect(await bytesOf(image?.body ?? new Blob())).toEqual(png);
    expect(codec.calls).toEqual([]);
  });

  it("strips JPEG metadata before sending", async () => {
    const image = await prepareImage(
      file(jpegWithComment, "IMG_2041.jpeg", "image/jpeg"),
      new FakeCodec(undefined),
    );
    expect(image?.filename).toBe("IMG_2041.jpg");
    expect(await bytesOf(image?.body ?? new Blob())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9]),
    );
  });

  it("re-encodes other formats and unparseable JPEGs at full size", async () => {
    const codec = new FakeCodec(png);
    const image = await prepareImage(
      file(heic, "IMG_2042.HEIC", "image/heic"),
      codec,
    );
    expect(image?.filename).toBe("IMG_2042.png");
    expect(codec.calls).toEqual([{ size: heic.length, scale: 1 }]);

    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00]);
    expect((await prepareImage(file(truncated, "a.jpg"), codec))?.type).toBe(
      "png",
    );
  });

  it("gives up on an image the browser cannot decode", async () => {
    expect(
      await prepareImage(file(heic, "IMG_2042.HEIC"), new FakeCodec(undefined)),
    ).toBeUndefined();
    expect(
      await prepareImage(
        file(heic, "x.heic"),
        new FakeCodec(new Uint8Array([1, 2])),
      ),
    ).toBeUndefined();
  });
});

describe("shrinkImage", () => {
  it("scales the area to fit nine tenths of the limit", async () => {
    const big = await prepareImage(
      file(new Uint8Array([...png, ...new Uint8Array(990)]), "shot.png"),
      new FakeCodec(undefined),
    );
    if (big === undefined) throw new Error("prepared");
    const codec = new FakeCodec(png);
    const small = await shrinkImage(big, 250, codec);
    expect(codec.calls).toEqual([{ size: 1000, scale: Math.sqrt(225 / 1000) }]);
    expect(small?.filename).toBe("shot.png");
  });

  it("never enlarges, and never shrinks a GIF", async () => {
    const codec = new FakeCodec(png);
    const small = await prepareImage(file(png, "a.png"), codec);
    const animated = await prepareImage(file(gif, "dance.gif"), codec);
    if (small === undefined || animated === undefined)
      throw new Error("prepared");
    await shrinkImage(small, 1_000_000, codec);
    expect(codec.calls).toEqual([{ size: png.length, scale: 1 }]);
    expect(await shrinkImage(animated, 3, codec)).toBeUndefined();
  });
});
