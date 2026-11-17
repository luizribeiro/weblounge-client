import {
  imageMimeTypes,
  imageSignatureLength,
  sniffImageType,
} from "../uploads/image-bytes";

/** Keeps decoding and re-encoding within memory bounds; the file host's own limit answers 413. */
export const maxImageBytes = 50_000_000;

export type ImageRejection = "not_image" | "too_large" | "unreadable";

export type AttachableImage =
  | { readonly kind: "image"; readonly file: File }
  | { readonly kind: "rejected"; readonly reason: ImageRejection };

/**
 * The one check every attached file passes (design 31, "Drag and drop"). Browsers type a file
 * from the system's MIME database by its extension, which can be missing or not know the name,
 * so an untyped or generic file is typed by its bytes.
 */
export async function attachableImage(file: File): Promise<AttachableImage> {
  const image = await typedImage(file);
  if (typeof image === "string") return { kind: "rejected", reason: image };
  if (image.size > maxImageBytes)
    return { kind: "rejected", reason: "too_large" };
  return { kind: "image", file: image };
}

async function typedImage(file: File): Promise<File | ImageRejection> {
  if (file.type.startsWith("image/")) return file;
  if (!isUntyped(file)) return "not_image";
  const signature = await fileSignature(file).catch(() => undefined);
  if (signature === undefined) return "unreadable";
  const type = sniffImageType(signature);
  return type === undefined
    ? "not_image"
    : new File([file], file.name, {
        type: imageMimeTypes[type],
        lastModified: file.lastModified,
      });
}

function isUntyped(file: File): boolean {
  return file.type === "" || file.type === "application/octet-stream";
}

async function fileSignature(file: File): Promise<Uint8Array> {
  return new Uint8Array(
    await file.slice(0, imageSignatureLength).arrayBuffer(),
  );
}
