import { expect, it } from "vitest";
import { pickedImage } from "./picked-image";

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

it("keeps a file the browser already typed as an image", async () => {
  const heic = new File([new Uint8Array([0, 0, 0, 24])], "IMG_0001.HEIC", {
    type: "image/heic",
  });
  expect(await pickedImage(heic)).toBe(heic);
});

it("types an untyped or generic file by its bytes, keeping name and date", async () => {
  const untyped = new File([png], "landscape.png", { lastModified: 1000 });
  const typed = await pickedImage(untyped);
  expect(typed?.type).toBe("image/png");
  expect(typed?.name).toBe("landscape.png");
  expect(typed?.lastModified).toBe(1000);
  expect(typed?.size).toBe(png.length);

  const generic = new File([jpeg], "photo", {
    type: "application/octet-stream",
  });
  expect((await pickedImage(generic))?.type).toBe("image/jpeg");
});

it("refuses a file that is not an image", async () => {
  const pdf = new File(["%PDF-1.7\n"], "notes.pdf", {
    type: "application/pdf",
  });
  expect(await pickedImage(pdf)).toBeUndefined();
  expect(await pickedImage(new File(["%PDF-1.7\n"], "notes"))).toBeUndefined();
  expect(await pickedImage(new File([], "empty"))).toBeUndefined();
});

it("refuses an untyped file that can no longer be read", async () => {
  const moved = new File([png], "landscape.png");
  moved.slice = () =>
    Object.assign(new Blob(), {
      arrayBuffer: () => Promise.reject(new Error("NotReadableError")),
    });
  expect(await pickedImage(moved)).toBeUndefined();
});
