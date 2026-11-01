import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const appDirectory = resolve(import.meta.dirname, "..");
const [css, html, devices] = await Promise.all([
  readFile(resolve(appDirectory, "src/styles/splash.css"), "utf8"),
  readFile(resolve(appDirectory, "index.html"), "utf8"),
  readFile(resolve(appDirectory, "startup-images.json"), "utf8").then(
    JSON.parse,
  ),
]);
const outputDirectory = resolve(appDirectory, "public/startup");
const hashPath = resolve(appDirectory, ".startup-images-hash");
const darkCss = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
const themes = [
  {
    name: "light",
    background: cssVariable(css, "wl-splash-bg"),
    mark: cssVariable(css, "wl-splash-mark"),
  },
  {
    name: "dark",
    background: cssVariable(darkCss, "wl-splash-bg"),
    mark: cssVariable(darkCss, "wl-splash-mark"),
  },
];
const markSize = pixelVariable(css, "wl-splash-mark-size");
const gap = pixelVariable(css, "wl-splash-gap");
const statusHeight = pixelVariable(css, "wl-splash-status-height");
const mark = html.match(/<svg[^>]*data-splash-mark[\s\S]*?<\/svg>/u)?.[0];
if (mark === undefined) throw new Error("inline splash mark is missing");
const markContents = mark.slice(
  mark.indexOf(">") + 1,
  mark.lastIndexOf("</svg>"),
);
const sourceHash = createHash("sha256")
  .update(css)
  .update(html)
  .update(JSON.stringify(devices))
  .update(await readFile(import.meta.filename))
  .digest("hex");
const expectedFiles = devices.flatMap((device) =>
  ["portrait", "landscape"].flatMap((orientation) =>
    themes.map((theme) => `${device.name}-${orientation}-${theme.name}.png`),
  ),
);
if (await generatedFilesAreCurrent()) process.exit(0);

await mkdir(outputDirectory, { recursive: true });
const renderedMarks = new Map();
for (const device of devices) {
  for (const orientation of ["portrait", "landscape"]) {
    const cssWidth = orientation === "portrait" ? device.width : device.height;
    const cssHeight = orientation === "portrait" ? device.height : device.width;
    for (const theme of themes) {
      const filename = `${device.name}-${orientation}-${theme.name}.png`;
      const key = `${device.ratio}-${theme.name}`;
      let renderedMark = renderedMarks.get(key);
      if (renderedMark === undefined) {
        renderedMark = renderMark(device.ratio, theme.mark);
        renderedMarks.set(key, renderedMark);
      }
      await writeFile(
        resolve(outputDirectory, filename),
        startupPng(
          cssWidth,
          cssHeight,
          device.ratio,
          theme.background,
          renderedMark,
        ),
      );
    }
  }
}
await writeFile(hashPath, sourceHash);

async function generatedFilesAreCurrent() {
  try {
    const [storedHash, files] = await Promise.all([
      readFile(hashPath, "utf8"),
      readdir(outputDirectory),
    ]);
    return (
      storedHash === sourceHash &&
      expectedFiles.every((filename) => files.includes(filename))
    );
  } catch {
    return false;
  }
}

function renderMark(ratio, color) {
  const size = markSize * ratio;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="${color}">${markContents}</svg>`;
  const result = spawnSync(
    "rsvg-convert",
    ["--format", "png", "--width", String(size), "--height", String(size)],
    { encoding: null, input: svg },
  );
  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf8").trim();
    throw new Error(`rsvg-convert failed${detail ? `: ${detail}` : ""}`);
  }
  return decodeRgbaPng(result.stdout);
}

function startupPng(cssWidth, cssHeight, ratio, background, renderedMark) {
  const width = cssWidth * ratio;
  const height = cssHeight * ratio;
  const backgroundRgb = hexRgb(background);
  const pixels = Buffer.alloc(width * height * 3);
  pixels.fill(Buffer.from(backgroundRgb));
  const groupHeight = markSize + gap + statusHeight;
  const left = Math.round(((cssWidth - markSize) / 2) * ratio);
  const top = Math.round(((cssHeight - groupHeight) / 2) * ratio);
  composite(pixels, width, left, top, renderedMark);
  return encodeRgbPng(pixels, width, height);
}

function composite(target, targetWidth, left, top, source) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceOffset = (y * source.width + x) * 4;
      const alpha = source.pixels[sourceOffset + 3] ?? 0;
      if (alpha === 0) continue;
      const targetOffset = ((top + y) * targetWidth + left + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const foreground = source.pixels[sourceOffset + channel] ?? 0;
        const background = target[targetOffset + channel] ?? 0;
        target[targetOffset + channel] = Math.round(
          (foreground * alpha + background * (255 - alpha)) / 255,
        );
      }
    }
  }
}

function decodeRgbaPng(png) {
  const chunks = pngChunks(png);
  const header = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  if (header === undefined || header[9] !== 6 || header[8] !== 8) {
    throw new Error("rendered splash mark is not an 8-bit RGBA PNG");
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const compressed = Buffer.concat(
    chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
  );
  const filtered = inflateSync(compressed);
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[y * (stride + 1) + x + 1] ?? 0;
      const left = x >= 4 ? (pixels[y * stride + x - 4] ?? 0) : 0;
      const above = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upperLeft =
        y > 0 && x >= 4 ? (pixels[(y - 1) * stride + x - 4] ?? 0) : 0;
      pixels[y * stride + x] = unfilter(filter, raw, left, above, upperLeft);
    }
  }
  return { height, pixels, width };
}

function unfilter(filter, raw, left, above, upperLeft) {
  switch (filter) {
    case 0:
      return raw;
    case 1:
      return (raw + left) & 255;
    case 2:
      return (raw + above) & 255;
    case 3:
      return (raw + Math.floor((left + above) / 2)) & 255;
    case 4:
      return (raw + paeth(left, above, upperLeft)) & 255;
    default:
      throw new Error(`unsupported PNG filter ${filter}`);
  }
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function encodeRgbPng(pixels, width, height) {
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const outputOffset = y * (stride + 1);
    filtered[outputOffset] = 0;
    pixels.copy(filtered, outputOffset + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(filtered, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunks(png) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    chunks.push({
      data: png.subarray(offset + 8, offset + 8 + length),
      type,
    });
    offset += length + 12;
  }
  return chunks;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return chunk;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hexRgb(value) {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16),
  );
}

function cssVariable(source, name) {
  const value = source.match(
    new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu"),
  )?.[1];
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

function pixelVariable(source, name) {
  const value = source.match(new RegExp(`--${name}:\\s*([0-9.]+)px`, "u"))?.[1];
  if (value === undefined) throw new Error(`missing --${name}`);
  return Number(value);
}
