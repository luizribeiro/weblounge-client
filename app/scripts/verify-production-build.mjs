import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

const outputDirectory = resolve(import.meta.dirname, "../dist");

await verifyIcons(outputDirectory);
await verifyStartupImages(outputDirectory);
await verifyServiceWorker(outputDirectory);
await verifyCspAssets(outputDirectory);

if (process.env.WEBLOUNGE_E2E_HARNESS !== "1") {
  const files = await descendants(outputDirectory);
  const wasmFiles = files.filter(
    (file) =>
      file.startsWith(resolve(outputDirectory, "assets")) &&
      file.endsWith(".wasm"),
  );
  if (
    wasmFiles.length !== 1 ||
    !/^engine_bg-[A-Za-z0-9_-]+\.wasm$/u.test(
      wasmFiles[0]?.slice(resolve(outputDirectory, "assets").length + 1) ?? "",
    )
  ) {
    throw new Error(
      `expected one hashed engine wasm asset, found: ${wasmFiles.join(", ")}`,
    );
  }
  const pushParser = resolve(outputDirectory, "push-payload_bg.wasm");
  if (!files.includes(pushParser)) {
    throw new Error("production build is missing the push payload parser");
  }
  const sourceMaps = files.filter((file) => file.endsWith(".map"));
  if (sourceMaps.length > 0)
    throw new Error("production build contains source maps");
  const typeScriptAssets = files.filter((file) => file.endsWith(".ts"));
  if (typeScriptAssets.length > 0) {
    throw new Error(
      `production build contains TypeScript assets: ${typeScriptAssets.join(", ")}`,
    );
  }
  let workerConstructorCount = 0;
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
    if (/\/assets\/[^\s`'"]+\.ts(?:[\s`'"]|$)/u.test(text)) {
      throw new Error(
        `production bundle references a TypeScript asset: ${file}`,
      );
    }
    if (text.includes("URL.createObjectURL(")) {
      throw new Error(`production bundle creates a blob URL: ${file}`);
    }
  }
  const workerAssets = files.filter((file) =>
    /engine\.(?:shared|dedicated)-worker-[^/]+\.js$/u.test(file),
  );
  if (workerConstructorCount !== 2 || workerAssets.length !== 2) {
    throw new Error(
      `expected two statically emitted workers, found ${workerAssets.length} assets and ${workerConstructorCount} constructors`,
    );
  }
}

async function verifyCspAssets(directory) {
  const files = await descendants(directory);
  for (const file of files.filter((path) =>
    /\.(?:css|html|js|json|svg|webmanifest)$/u.test(path),
  )) {
    const content = await readFile(file, "utf8");
    if (/data:(?:font|image)\//iu.test(content)) {
      throw new Error(`production bundle contains an inline asset: ${file}`);
    }
  }
  const html = await readFile(resolve(directory, "index.html"), "utf8");
  const splashLink = html.match(
    /<link\s+[^>]*data-initial-splash-style[^>]*>/iu,
  )?.[0];
  if (
    splashLink === undefined ||
    !/href="\/assets\/[^"]+-[^"]+\.css"/u.test(splashLink)
  ) {
    throw new Error("startup splash is not a hashed stylesheet asset");
  }
  const script = html.match(/<script\s+[^>]*src=/u)?.[0];
  if (script !== undefined && html.indexOf(splashLink) > html.indexOf(script)) {
    throw new Error("startup stylesheet appears after an application script");
  }
  const fontPreload = html.match(
    /<link\s+[^>]*rel="preload"[^>]*as="font"[^>]*>/iu,
  )?.[0];
  if (
    fontPreload === undefined ||
    !/crossorigin="anonymous"/u.test(fontPreload) ||
    html.indexOf(fontPreload) > html.indexOf(splashLink)
  ) {
    throw new Error("startup font preload does not precede the stylesheet");
  }
}

async function verifyIcons(directory) {
  const expected = new Map([
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
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
    if (filename !== "favicon-32.png" && image.firstPixel !== "1b2a22") {
      throw new Error(
        `${filename} background is #${image.firstPixel}, expected the brand felt green #1b2a22`,
      );
    }
  }
  await readFile(resolve(directory, "icons/favicon.svg"), "utf8");
}

async function verifyStartupImages(directory) {
  const devices = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "../startup-images.json"),
      "utf8",
    ),
  );
  const expectedLinks = new Map();
  for (const device of devices) {
    for (const orientation of ["portrait", "landscape"]) {
      const cssWidth =
        orientation === "portrait" ? device.width : device.height;
      const cssHeight =
        orientation === "portrait" ? device.height : device.width;
      for (const appearance of ["light", "dark"]) {
        const filename = `${device.name}-${orientation}-${appearance}.png`;
        const href = `/startup/${filename}`;
        expectedLinks.set(
          href,
          [
            `(device-width: ${device.width}px)`,
            `(device-height: ${device.height}px)`,
            `(-webkit-device-pixel-ratio: ${device.ratio})`,
            `(orientation: ${orientation})`,
            `(prefers-color-scheme: ${appearance})`,
          ].join(" and "),
        );
        const png = await readFile(resolve(directory, `.${href}`));
        const image = pngMetadata(png);
        const expectedBackground = appearance === "light" ? "f3f1e9" : "18221e";
        if (
          image.width !== cssWidth * device.ratio ||
          image.height !== cssHeight * device.ratio ||
          image.firstPixel !== expectedBackground ||
          !image.opaque
        ) {
          throw new Error(
            `${filename} does not match its splash geometry and theme`,
          );
        }
      }
    }
  }
  const html = await readFile(resolve(directory, "index.html"), "utf8");
  const links = [
    ...html.matchAll(/<link\s+[^>]*rel="apple-touch-startup-image"[^>]*>/gu),
  ].map(([link]) => ({
    href: link.match(/href="([^"]+)"/u)?.[1],
    media: link.match(/media="([^"]+)"/u)?.[1]?.replaceAll("&amp;", "&"),
  }));
  if (links.length !== expectedLinks.size) {
    throw new Error(
      `expected ${expectedLinks.size} startup image links, found ${links.length}`,
    );
  }
  for (const link of links) {
    if (
      link.href === undefined ||
      link.media !== expectedLinks.get(link.href)
    ) {
      throw new Error(`unexpected startup image link: ${JSON.stringify(link)}`);
    }
    expectedLinks.delete(link.href);
  }
  if (expectedLinks.size !== 0) {
    throw new Error("production HTML is missing startup image links");
  }
}

async function verifyServiceWorker(directory) {
  const workerPath = resolve(directory, "service-worker.js");
  const worker = await readFile(workerPath, "utf8");
  const version = worker.match(/const SHELL_VERSION = "([0-9a-f]{16})";/u)?.[1];
  const manifest = worker.match(
    /const PRECACHE_URLS = Object\.freeze\((\[[^;]+\])\);/u,
  )?.[1];
  if (version === undefined || manifest === undefined) {
    throw new Error("service worker build metadata is missing");
  }
  const urls = JSON.parse(manifest);
  if (urls.some((url) => url.endsWith(".ts"))) {
    throw new Error("service worker precache manifest contains TypeScript");
  }
  const expectedUrls = (await descendants(directory))
    .filter((path) => path !== workerPath)
    .map((path) => `/${path.slice(directory.length + 1)}`)
    .filter(
      (url) =>
        url === "/index.html" ||
        url === "/manifest.webmanifest" ||
        url === "/push-payload.js" ||
        url === "/push-payload_bg.wasm" ||
        url.startsWith("/assets/") ||
        url.startsWith("/icons/"),
    )
    .sort();
  if (JSON.stringify(urls) !== JSON.stringify(expectedUrls)) {
    throw new Error(
      "service worker precache manifest does not match the build",
    );
  }
  const hash = createHash("sha256");
  for (const url of expectedUrls) {
    hash.update(url).update(await readFile(resolve(directory, `.${url}`)));
  }
  if (version !== hash.digest("hex").slice(0, 16)) {
    throw new Error(
      "service worker cache version does not match the build hash",
    );
  }
  if (
    urls.includes("/config.json") ||
    urls.some((url) => url.startsWith("/startup/")) ||
    worker.includes("skipWaiting") ||
    !worker.includes('priority: "low"') ||
    !worker.includes('name.startsWith("weblounge-shell-")')
  ) {
    throw new Error("service worker cache or update policy is unsafe");
  }
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
  const imageData = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === "tRNS") transparencyChunk = true;
    else if (type === "IDAT") imageData.push(chunk);
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(imageData));
  return {
    // Every PNG filter leaves the first pixel of the first row unchanged.
    firstPixel: pixels.subarray(1, 4).toString("hex"),
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
