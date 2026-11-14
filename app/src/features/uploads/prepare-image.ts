import {
  imageMimeTypes,
  type SendableImageType,
  sniffImageType,
  stripJpegMetadata,
} from "./image-bytes";
import type { ImageCodec } from "./image-codec";

export interface PreparedImage {
  readonly body: Blob;
  readonly filename: string;
  readonly type: SendableImageType;
}

const extensions: Readonly<Record<SendableImageType, string>> = {
  gif: "gif",
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

/** The bytes to upload: accepted types as they are (JPEG without metadata), others re-encoded. */
export async function prepareImage(
  file: File,
  codec: ImageCodec,
): Promise<PreparedImage | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (type === "jpeg") {
    const stripped = stripJpegMetadata(bytes);
    if (stripped !== undefined) return prepared(stripped, type, file.name);
  } else if (type !== undefined) {
    return prepared(bytes, type, file.name);
  }
  return reencoded(await codec.reencode(file, 1), file.name);
}

/** A smaller copy that should fit `limit` bytes; GIFs are never shrunk (it drops animation). */
export async function shrinkImage(
  image: PreparedImage,
  limit: number,
  codec: ImageCodec,
): Promise<PreparedImage | undefined> {
  if (image.type === "gif") return undefined;
  const scale = Math.min(1, Math.sqrt((0.9 * limit) / image.body.size));
  return reencoded(await codec.reencode(image.body, scale), image.filename);
}

async function reencoded(
  blob: Blob | undefined,
  filename: string,
): Promise<PreparedImage | undefined> {
  if (blob === undefined) return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const type = sniffImageType(bytes);
  return type === undefined ? undefined : prepared(bytes, type, filename);
}

function prepared(
  bytes: Uint8Array<ArrayBuffer>,
  type: SendableImageType,
  filename: string,
): PreparedImage {
  return {
    body: new Blob([bytes], { type: imageMimeTypes[type] }),
    filename: `${baseName(filename)}.${extensions[type]}`,
    type,
  };
}

function baseName(filename: string): string {
  const name = filename.split(/[\\/]/u).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem === "" ? "image" : stem;
}
