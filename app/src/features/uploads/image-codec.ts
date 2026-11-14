export interface ImageCodec {
  /**
   * Decodes the image and encodes it at `scale` as JPEG, or as PNG when any pixel is
   * translucent. Resolves undefined when this browser cannot decode it.
   */
  reencode(image: Blob, scale: number): Promise<Blob | undefined>;
}

const jpegQuality = 0.9;

export class CanvasImageCodec implements ImageCodec {
  async reencode(image: Blob, scale: number): Promise<Blob | undefined> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(image);
    } catch {
      return undefined;
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context === null) {
      bitmap.close();
      return undefined;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const translucent = hasTranslucentPixel(
      context.getImageData(0, 0, width, height).data,
    );
    return canvas.convertToBlob(
      translucent
        ? { type: "image/png" }
        : { type: "image/jpeg", quality: jpegQuality },
    );
  }
}

export function hasTranslucentPixel(rgba: Uint8ClampedArray): boolean {
  for (let alpha = 3; alpha < rgba.length; alpha += 4)
    if (rgba[alpha] !== 255) return true;
  return false;
}
