import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const appDirectory = resolve(import.meta.dirname, "..");
const faviconPath = resolve(appDirectory, "assets/favicon.svg");
const favicon = await readFile(faviconPath, "utf8");
const iconDirectory = resolve(appDirectory, "public/icons");
const desktopIconDirectory = resolve(appDirectory, "../apps/tauri/icons");
const desktopDevIconDirectory = resolve(
  appDirectory,
  "../apps/tauri/icons-dev",
);
const mark = favicon.slice(
  favicon.indexOf('<g id="mark">'),
  favicon.lastIndexOf("</g>") + "</g>".length,
);

export const brandColors = { felt: "#1B2A22", paper: "#EFE8D8" };
// Local desktop builds wear a yellow tile so they are never mistaken for the installed release.
const devColors = { tile: "#E8B530", mark: brandColors.felt };

// iOS and Android apply their own corner masks, so the platform icons are
// full-bleed and opaque; maskable icons keep the mark inside the 80% safe zone.
// macOS applies no mask, so its icon draws Apple's rounded tile on transparency.
const macosGrid = { tile: 824, radius: 185, markScale: 0.78 };
const macosCanvas = 1024;

await Promise.all(
  [iconDirectory, desktopIconDirectory, desktopDevIconDirectory].map(
    (directory) => mkdir(directory, { recursive: true }),
  ),
);
await Promise.all([
  copyFile(faviconPath, resolve(iconDirectory, "favicon.svg")),
  renderPng("favicon-32.png", 32, favicon),
  renderPng("apple-touch-icon.png", 180, appIconSvg(180, { markScale: 0.78 })),
  renderPng("icon-192.png", 192, appIconSvg(192, { markScale: 0.78 })),
  renderPng("icon-512.png", 512, appIconSvg(512, { markScale: 0.78 })),
  renderPng("icon-maskable-192.png", 192, appIconSvg(192, { markScale: 0.6 })),
  renderPng("icon-maskable-512.png", 512, appIconSvg(512, { markScale: 0.6 })),
  renderPng(
    "macos-source.png",
    macosCanvas,
    appIconSvg(macosCanvas, macosGrid),
    desktopIconDirectory,
  ),
  renderPng(
    "macos-source.png",
    macosCanvas,
    appIconSvg(macosCanvas, { ...macosGrid, colors: devColors }),
    desktopDevIconDirectory,
  ),
]);

function appIconSvg(
  size,
  {
    markScale,
    tile = size,
    radius = 0,
    colors = { tile: brandColors.felt, mark: brandColors.paper },
  },
) {
  const tileOffset = (size - tile) / 2;
  const markSize = tile * markScale;
  const markOffset = (size - markSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${tileOffset}" y="${tileOffset}" width="${tile}" height="${tile}" rx="${radius}" fill="${colors.tile}"/>
  <svg x="${markOffset}" y="${markOffset}" width="${markSize}" height="${markSize}" viewBox="0 0 16 16" color="${colors.mark}">
    ${mark}
  </svg>
</svg>
`;
}

async function renderPng(filename, size, svg, directory = iconDirectory) {
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
  await writeFile(resolve(directory, filename), result.stdout);
}
