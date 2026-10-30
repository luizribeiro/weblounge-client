import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const appDirectory = resolve(import.meta.dirname, "..");
const faviconPath = resolve(appDirectory, "assets/favicon.svg");
const favicon = await readFile(faviconPath, "utf8");
const iconDirectory = resolve(appDirectory, "public/icons");
const mark = favicon.slice(
  favicon.indexOf('<g id="mark">'),
  favicon.lastIndexOf("</g>") + "</g>".length,
);

export const brandColors = { felt: "#1B2A22", paper: "#EFE8D8" };

// Platform icons are full-bleed and opaque because iOS and Android apply
// their own corner masks; maskable icons keep the mark inside the 80% safe zone.
await mkdir(iconDirectory, { recursive: true });
await Promise.all([
  copyFile(faviconPath, resolve(iconDirectory, "favicon.svg")),
  renderPng("favicon-32.png", 32, favicon),
  renderPng("apple-touch-icon.png", 180, appIconSvg(180, 0.78)),
  renderPng("icon-192.png", 192, appIconSvg(192, 0.78)),
  renderPng("icon-512.png", 512, appIconSvg(512, 0.78)),
  renderPng("icon-maskable-192.png", 192, appIconSvg(192, 0.6)),
  renderPng("icon-maskable-512.png", 512, appIconSvg(512, 0.6)),
]);

function appIconSvg(size, markScale) {
  const markSize = size * markScale;
  const offset = (size - markSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${brandColors.felt}"/>
  <svg x="${offset}" y="${offset}" width="${markSize}" height="${markSize}" viewBox="0 0 16 16" color="${brandColors.paper}">
    ${mark}
  </svg>
</svg>
`;
}

async function renderPng(filename, size, svg) {
  const result = spawnSync(
    "rsvg-convert",
    ["--format", "png", "--width", String(size), "--height", String(size)],
    { encoding: null, input: svg },
  );
  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf8").trim();
    throw new Error(
      `rsvg-convert failed for ${filename}${detail ? `: ${detail}` : ""}`,
    );
  }
  await writeFile(resolve(iconDirectory, filename), result.stdout);
}
