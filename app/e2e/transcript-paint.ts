import { expect, type Locator } from "@playwright/test";

export async function expectTranscriptHitTarget(
  list: Locator,
  position: "center" | "last" = "center",
): Promise<void> {
  await expect
    .poll(() =>
      list.evaluate((element, rowPosition) => {
        const listRect = element.getBoundingClientRect();
        const rows = [
          ...element.querySelectorAll<HTMLElement>("[data-message-row]"),
        ].filter((row) => {
          const rect = row.getBoundingClientRect();
          const center = (rect.top + rect.bottom) / 2;
          return center > listRect.top && center < listRect.bottom;
        });
        const row =
          rowPosition === "last"
            ? rows.at(-1)
            : rows.sort((left, right) => {
                const center = listRect.top + listRect.height / 2;
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return (
                  Math.abs((leftRect.top + leftRect.bottom) / 2 - center) -
                  Math.abs((rightRect.top + rightRect.bottom) / 2 - center)
                );
              })[0];
        if (row === undefined) return false;
        const rect = row.getBoundingClientRect();
        const target = document.elementFromPoint(
          (rect.left + rect.right) / 2,
          (rect.top + rect.bottom) / 2,
        );
        return target !== null && row.contains(target);
      }, position),
    )
    .toBe(true);
}

export async function expectTranscriptPixelVariance(
  list: Locator,
): Promise<void> {
  const screenshot = await list.screenshot({ scale: "css" });
  const variance = await list.page().evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D canvas is unavailable");
    context.drawImage(bitmap, 0, 0);
    const inset = Math.floor(bitmap.width / 10);
    const pixels = context.getImageData(
      inset,
      0,
      bitmap.width - inset * 2,
      bitmap.height,
    ).data;
    let count = 0;
    let mean = 0;
    let sumSquares = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const luminance =
        0.2126 * (pixels[offset] ?? 0) +
        0.7152 * (pixels[offset + 1] ?? 0) +
        0.0722 * (pixels[offset + 2] ?? 0);
      count += 1;
      const delta = luminance - mean;
      mean += delta / count;
      sumSquares += delta * (luminance - mean);
    }
    return sumSquares / count;
  }, screenshot.toString("base64"));
  expect(variance).toBeGreaterThan(1);
}
