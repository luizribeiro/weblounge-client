import { expect, it } from "vitest";
import { imageSizeMemory } from "./inline-image-sizes";

const photo = "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.jpg";
const banner = "https://files.weblounge.org/ZyXwVuTsRqPoNmLkJiHgFe.png";
const sticker = "https://files.weblounge.org/QqWwEeRrTtYyUuIiOoPpAa.gif";

function memoryStorage(): Storage & { readonly writes: () => number } {
  const items = new Map<string, string>();
  let writes = 0;
  return {
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
    removeItem: (key) => items.delete(key),
    setItem: (key, value) => {
      writes += 1;
      items.set(key, value);
    },
    writes: () => writes,
  };
}

function storageWith(text: string): Storage {
  const storage = memoryStorage();
  storage.setItem("weblounge.inline-image-sizes", text);
  return storage;
}

function failingStorage(): Storage {
  const fail = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  return {
    clear: fail,
    getItem: fail,
    key: fail,
    length: 0,
    removeItem: fail,
    setItem: fail,
  };
}

it("recalls a remembered size on a later page load", () => {
  const storage = memoryStorage();
  imageSizeMemory(() => storage).remember(photo, { height: 3024, width: 4032 });

  const reloaded = imageSizeMemory(() => storage);

  expect(reloaded.recall(photo)).toEqual({ height: 3024, width: 4032 });
  expect(reloaded.recall(banner)).toBeUndefined();
});

it("forgets the least recently shown images past its limit", () => {
  const storage = memoryStorage();
  const memory = imageSizeMemory(() => storage, 2);
  memory.remember(photo, { height: 3024, width: 4032 });
  memory.remember(banner, { height: 200, width: 1600 });
  memory.recall(photo);
  memory.remember(sticker, { height: 120, width: 160 });

  const reloaded = imageSizeMemory(() => storage, 2);

  expect(reloaded.recall(banner)).toBeUndefined();
  expect(reloaded.recall(photo)).toEqual({ height: 3024, width: 4032 });
  expect(reloaded.recall(sticker)).toEqual({ height: 120, width: 160 });
});

it("keeps the newer size when an image is remembered again", () => {
  const storage = memoryStorage();
  const memory = imageSizeMemory(() => storage);
  memory.remember(photo, { height: 3024, width: 4032 });
  memory.remember(photo, { height: 1512, width: 2016 });

  expect(imageSizeMemory(() => storage).recall(photo)).toEqual({
    height: 1512,
    width: 2016,
  });
});

it("skips the storage write when a remount reports the same size", () => {
  const storage = memoryStorage();
  const memory = imageSizeMemory(() => storage);
  memory.remember(photo, { height: 3024, width: 4032 });
  memory.remember(photo, { height: 3024, width: 4032 });

  expect(storage.writes()).toBe(1);
});

it("keeps sizes for the page when device storage is blocked", () => {
  const memory = imageSizeMemory(failingStorage);
  memory.remember(banner, { height: 200, width: 1600 });

  expect(memory.recall(banner)).toEqual({ height: 200, width: 1600 });
});

it.each([
  ["malformed JSON", "{"],
  ["a non-object", "[1]"],
  ["a future format", '{"version":2,"sizes":[]}'],
  ["sizes that are not a list", '{"version":1,"sizes":{}}'],
])("starts empty for %s", (_label, text) => {
  expect(imageSizeMemory(() => storageWith(text)).recall(photo)).toBe(
    undefined,
  );
});

it("drops stored entries without a usable size", () => {
  const memory = imageSizeMemory(() =>
    storageWith(
      JSON.stringify({
        version: 1,
        sizes: [
          [photo, 4032, 3024],
          [banner, 0, 200],
          [sticker, "160", 120],
          [42, 10, 10],
        ],
      }),
    ),
  );

  expect(memory.recall(photo)).toEqual({ height: 3024, width: 4032 });
  expect(memory.recall(banner)).toBeUndefined();
  expect(memory.recall(sticker)).toBeUndefined();
});
