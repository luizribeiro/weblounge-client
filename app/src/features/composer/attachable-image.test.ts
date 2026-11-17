import { expect, it } from "vitest";
import { attachableImage, maxImageBytes } from "./attachable-image";

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

it("keeps a file the browser already typed as an image", async () => {
  const heic = new File([new Uint8Array([0, 0, 0, 24])], "IMG_0001.HEIC", {
    type: "image/heic",
  });
  expect(await attachableImage(heic)).toEqual({ kind: "image", file: heic });
});

it("types an untyped or generic file by its bytes, keeping name and date", async () => {
  const untyped = new File([png], "landscape.png", { lastModified: 1000 });
  const result = await attachableImage(untyped);
  const typed = result.kind === "image" ? result.file : undefined;
  expect(typed?.type).toBe("image/png");
  expect(typed?.name).toBe("landscape.png");
  expect(typed?.lastModified).toBe(1000);
  expect(typed?.size).toBe(png.length);

  const generic = new File([jpeg], "photo", {
    type: "application/octet-stream",
  });
  const sniffed = await attachableImage(generic);
  expect(sniffed.kind === "image" && sniffed.file.type).toBe("image/jpeg");
});

it("refuses a file typed as something other than an image", async () => {
  for (const [name, type] of [
    ["archive.zip", "application/zip"],
    ["notes.pdf", "application/pdf"],
    ["readme.txt", "text/plain"],
  ] as const)
    expect(await attachableImage(new File([png], name, { type }))).toEqual({
      kind: "rejected",
      reason: "not_image",
    });
});

it("refuses an untyped file whose bytes are not a known image", async () => {
  for (const file of [new File(["%PDF-1.7\n"], "notes"), new File([], "empty")])
    expect(await attachableImage(file)).toEqual({
      kind: "rejected",
      reason: "not_image",
    });
});

it("cannot read an untyped file that can no longer be read", async () => {
  const moved = new File([png], "landscape.png");
  moved.slice = () =>
    Object.assign(new Blob(), {
      arrayBuffer: () => Promise.reject(new Error("NotReadableError")),
    });
  expect(await attachableImage(moved)).toEqual({
    kind: "rejected",
    reason: "unreadable",
  });
});

it("refuses an image over the ceiling, typed or sniffed, and keeps one at it", async () => {
  const bytes = (size: number) => {
    const data = new Uint8Array(size);
    data.set(png);
    return data;
  };
  const atCeiling = new File([bytes(maxImageBytes)], "big.png", {
    type: "image/png",
  });
  expect((await attachableImage(atCeiling)).kind).toBe("image");
  for (const file of [
    new File([bytes(maxImageBytes + 1)], "huge.png", { type: "image/png" }),
    new File([bytes(maxImageBytes + 1)], "huge"),
  ])
    expect(await attachableImage(file)).toEqual({
      kind: "rejected",
      reason: "too_large",
    });
});
