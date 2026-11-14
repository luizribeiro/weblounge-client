/** The only way the app makes a blob URL: a preview of an image the user pasted. */
export function createImagePreviewUrl(image: Blob): string {
  // The production build verifier (scripts/blob-url-policy.mjs) accepts a blob URL only right
  // after this message, so the image check cannot be dropped without the build failing.
  if (!image.type.startsWith("image/"))
    throw new TypeError("weblounge:image-preview-only");
  return URL.createObjectURL(image);
}

export function revokeImagePreviewUrl(url: string): void {
  URL.revokeObjectURL(url);
}
