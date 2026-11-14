import { afterEach, expect, it, vi } from "vitest";
import { createImagePreviewUrl } from "./object-url";

afterEach(() => vi.unstubAllGlobals());

it("previews images and refuses anything else", () => {
  const createObjectURL = vi.fn(() => "blob:preview");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));

  expect(
    createImagePreviewUrl(
      new Blob([new Uint8Array([0x89])], { type: "image/png" }),
    ),
  ).toBe("blob:preview");
  for (const type of ["text/javascript", "application/octet-stream", ""])
    expect(() => createImagePreviewUrl(new Blob(["x"], { type }))).toThrow(
      "weblounge:image-preview-only",
    );
  expect(createObjectURL).toHaveBeenCalledOnce();
});
