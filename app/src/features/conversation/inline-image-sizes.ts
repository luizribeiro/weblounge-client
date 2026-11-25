export interface NaturalSize {
  readonly height: number;
  readonly width: number;
}

export interface ImageSizeMemory {
  readonly recall: (url: string) => NaturalSize | undefined;
  readonly remember: (url: string, size: NaturalSize) => void;
}

type StoredSize = readonly [url: string, width: number, height: number];

interface StoredSizes {
  readonly version: typeof formatVersion;
  readonly sizes: readonly StoredSize[];
}

const storageKey = "weblounge.inline-image-sizes";
const formatVersion = 1;
const defaultLimit = 500;

/**
 * Remembers each shown image's natural size across row remounts and page
 * loads, so a seen image takes its final slot at once instead of fading in
 * from the 4:3 placeholder while the browser serves it from cache.
 */
export function imageSizeMemory(
  storage: () => Storage,
  limit = defaultLimit,
): ImageSizeMemory {
  let sizes: Map<string, NaturalSize> | undefined;
  const known = () => {
    sizes ??= readSizes(storage);
    return sizes;
  };
  return {
    recall: (url) => {
      const current = known();
      const size = current.get(url);
      if (size !== undefined) {
        current.delete(url);
        current.set(url, size);
      }
      return size;
    },
    remember: (url, size) => {
      const current = known();
      const previous = current.get(url);
      if (previous?.width === size.width && previous.height === size.height)
        return;
      current.delete(url);
      current.set(url, size);
      for (const oldest of current.keys()) {
        if (current.size <= limit) break;
        current.delete(oldest);
      }
      writeSizes(storage, current);
    },
  };
}

export const inlineImageSizes = imageSizeMemory(() => localStorage);

function decodeImageSizes(text: string | null): Map<string, NaturalSize> {
  if (text === null) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  if (!isStoredSizes(parsed)) return new Map();
  return new Map(
    parsed.sizes
      .filter(isStoredSize)
      .map(([url, width, height]) => [url, { height, width }]),
  );
}

function readSizes(storage: () => Storage): Map<string, NaturalSize> {
  try {
    return decodeImageSizes(storage().getItem(storageKey));
  } catch {
    return new Map();
  }
}

function writeSizes(
  storage: () => Storage,
  sizes: ReadonlyMap<string, NaturalSize>,
): void {
  const stored: StoredSizes = {
    version: formatVersion,
    sizes: [...sizes].map(([url, size]) => [url, size.width, size.height]),
  };
  try {
    storage().setItem(storageKey, JSON.stringify(stored));
  } catch {
    // Sizes still apply to this page when device storage is unavailable.
  }
}

function isStoredSizes(value: unknown): value is StoredSizes {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === formatVersion && Array.isArray(candidate.sizes);
}

function isStoredSize(value: unknown): value is StoredSize {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === "string" &&
    isDimension(value[1]) &&
    isDimension(value[2])
  );
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
