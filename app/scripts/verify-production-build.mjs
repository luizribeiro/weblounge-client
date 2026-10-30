import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(import.meta.dirname, "../dist");

await verifyIcons(outputDirectory);

if (process.env.WEBLOUNGE_E2E_HARNESS !== "1") {
  const files = await descendants(outputDirectory);
  const sourceMaps = files.filter((file) => file.endsWith(".map"));
  if (sourceMaps.length > 0)
    throw new Error("production build contains source maps");
  let workerConstructorCount = 0;
  const workerUrls = [];
  for (const file of files) {
    const content = await readFile(file);
    const text = content.toString("utf8");
    if (text.includes("irc-password") || text.includes("WEBLOUNGE_IRC_")) {
      throw new Error(
        `production build contains debug IRC configuration: ${file}`,
      );
    }
    if (!file.endsWith(".js")) continue;
    workerConstructorCount += [
      ...text.matchAll(/new\s+(?:SharedWorker|Worker)\s*\(/gu),
    ].length;
    for (const match of text.matchAll(
      /new\s+(?:SharedWorker|Worker)\s*\(\s*new\s+URL\(\s*([`'"])([^`'"]+)\1/gu,
    )) {
      workerUrls.push(match[2]);
    }
    if (text.includes("URL.createObjectURL(")) {
      throw new Error(`production bundle creates a blob URL: ${file}`);
    }
  }
  if (workerConstructorCount !== 2 || workerUrls.length !== 2) {
    throw new Error(
      `expected two statically emitted worker URLs, found ${workerUrls.length} of ${workerConstructorCount} constructors`,
    );
  }
  for (const workerUrl of workerUrls) {
    if (!/^\/assets\/[^/]+\.js$/u.test(workerUrl)) {
      throw new Error(
        `production bundle contains an unsafe worker URL: ${workerUrl}`,
      );
    }
  }
}

async function verifyIcons(directory) {
  const expected = new Map([
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-dark-512.png", 512],
    ["icon-maskable-192.png", 192],
    ["icon-maskable-512.png", 512],
  ]);
  for (const [filename, size] of expected) {
    const png = await readFile(resolve(directory, "icons", filename));
    const image = pngMetadata(png);
    if (image.width !== size || image.height !== size) {
      throw new Error(
        `${filename} is ${image.width}x${image.height}, expected ${size}x${size}`,
      );
    }
    if (filename === "apple-touch-icon.png" && !image.opaque) {
      throw new Error("apple-touch-icon.png contains transparent pixels");
    }
  }
  await readFile(resolve(directory, "icons/favicon.svg"), "utf8");
}

function pngMetadata(png) {
  const signature = png.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a")
    throw new Error("invalid PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let transparencyChunk = false;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === "tRNS") transparencyChunk = true;
    offset += length + 12;
  }
  return {
    height,
    opaque: ![4, 6].includes(colorType) && !transparencyChunk,
    width,
  };
}

async function descendants(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await descendants(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
