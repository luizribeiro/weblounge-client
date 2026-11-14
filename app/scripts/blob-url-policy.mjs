// The CSP keeps workers and scripts to 'self', so a blob URL must never feed a Worker,
// SharedWorker, script or importScripts. Image previews are allowed (img-src blob:) and all go
// through app/src/platform/object-url.ts, which rejects non-image blobs with this message right
// before creating the URL. Minifiers rename identifiers but keep string literals and property
// names, so a call counts as a preview only when the marker sits just before it.
export const imagePreviewMarker = "weblounge:image-preview-only";
const markerReach = 160;

/** Each `createObjectURL(` call in a built chunk that is not the guarded image preview. */
export function unguardedBlobUrls(text) {
  const violations = [];
  for (const match of text.matchAll(/createObjectURL\s*\(/gu)) {
    const before = text.slice(
      Math.max(0, match.index - markerReach),
      match.index,
    );
    if (!before.includes(imagePreviewMarker))
      violations.push(
        text.slice(Math.max(0, match.index - 60), match.index + 40),
      );
  }
  return violations;
}
