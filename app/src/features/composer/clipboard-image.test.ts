import { describe, expect, it } from "vitest";
import { imageFromClipboard } from "./clipboard-image";

interface FakeItem {
  readonly kind: string;
  readonly type: string;
  getAsFile(): File | null;
}

function clipboard({
  files = [],
  items = [],
  text = "",
}: {
  files?: File[];
  items?: FakeItem[];
  text?: string;
}) {
  return {
    files: files as unknown as FileList,
    items: items as unknown as DataTransferItemList,
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
}

const screenshot = new File([new Uint8Array([0x89, 0x50])], "image.png", {
  type: "image/png",
});

describe("imageFromClipboard", () => {
  it("takes a pasted screenshot from the clipboard files", () => {
    expect(imageFromClipboard(clipboard({ files: [screenshot] }))).toEqual({
      file: screenshot,
      hasText: false,
    });
  });

  it("falls back to file items, as Firefox exposes them", () => {
    const heic = new File([new Uint8Array([0])], "IMG_2041.HEIC", {
      type: "image/heic",
    });
    expect(
      imageFromClipboard(
        clipboard({
          items: [
            { kind: "string", type: "text/plain", getAsFile: () => null },
            { kind: "file", type: "image/heic", getAsFile: () => heic },
          ],
        }),
      ),
    ).toEqual({ file: heic, hasText: false });
  });

  it("reports text copied with the image so it can paste through", () => {
    expect(
      imageFromClipboard(clipboard({ files: [screenshot], text: "a caption" })),
    ).toEqual({ file: screenshot, hasText: true });
    expect(
      imageFromClipboard(clipboard({ files: [screenshot], text: "  \n" })),
    ).toEqual({ file: screenshot, hasText: false });
  });

  it("ignores pastes without an image", () => {
    const pdf = new File(["%PDF"], "notes.pdf", { type: "application/pdf" });
    expect(imageFromClipboard(null)).toBeUndefined();
    expect(
      imageFromClipboard(clipboard({ text: "just text" })),
    ).toBeUndefined();
    expect(
      imageFromClipboard(
        clipboard({
          files: [pdf],
          items: [{ kind: "file", type: "image/png", getAsFile: () => null }],
        }),
      ),
    ).toBeUndefined();
  });
});
