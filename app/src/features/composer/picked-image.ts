import {
  imageMimeTypes,
  imageSignatureLength,
  sniffImageType,
} from "../uploads/image-bytes";

/**
 * The picked file typed as an image, or undefined when it is not one or cannot be read. Browsers
 * type a picked file from the system's MIME database by its extension, which can be missing or
 * not know the name, so an untyped file is typed by its bytes.
 */
export async function pickedImage(file: File): Promise<File | undefined> {
  if (file.type.startsWith("image/")) return file;
  const type = await fileSignature(file).then(sniffImageType, () => undefined);
  return type === undefined
    ? undefined
    : new File([file], file.name, {
        type: imageMimeTypes[type],
        lastModified: file.lastModified,
      });
}

async function fileSignature(file: File): Promise<Uint8Array> {
  return new Uint8Array(
    await file.slice(0, imageSignatureLength).arrayBuffer(),
  );
}
