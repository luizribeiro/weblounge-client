export interface ClipboardImage {
  readonly file: File;
  readonly hasText: boolean;
}

type ClipboardData = Pick<DataTransfer, "files" | "getData" | "items">;

export function imageFromClipboard(
  data: ClipboardData | null,
): ClipboardImage | undefined {
  if (data === null) return undefined;
  const file = firstImage(data);
  if (file === undefined) return undefined;
  return { file, hasText: data.getData("text/plain").trim() !== "" };
}

function firstImage(data: ClipboardData): File | undefined {
  const file = Array.from(data.files).find(isImage);
  if (file !== undefined) return file;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const pasted = item.getAsFile();
    if (pasted !== null) return pasted;
  }
  return undefined;
}

function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}
