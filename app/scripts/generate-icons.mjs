import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const loungeTheme = JSON.parse(
  await readFile(resolve(appDirectory, "themes/lounge.json"), "utf8"),
);
const faviconVariants = JSON.parse(
  await readFile(resolve(appDirectory, "assets/favicon-variants.json"), "utf8"),
);
const faviconTiles = {
  connected: brandColors.felt,
  unread: loungeTheme.colors.mentionBadge,
  disconnected: "#8C8F87",
};
// Local builds wear a yellow tile so they are never mistaken for the installed release.
const devColors = { tile: "#E8B530", mark: brandColors.felt };
const appIdentities = [
  { directory: resolve(appDirectory, "../apps/tauri/icons") },
  {
    directory: resolve(appDirectory, "../apps/tauri/icons-dev"),
    colors: devColors,
  },
];

// iOS and Android apply their own corner masks, so the platform icons are
// full-bleed and opaque; maskable icons keep the mark inside the 80% safe zone.
// macOS applies no mask, so its icon draws Apple's rounded tile on transparency.
const phoneGrid = { markScale: 0.78 };
const maskableGrid = { markScale: 0.6 };
const macosGrid = { tile: 824, radius: 185, markScale: 0.78 };
const appStoreCanvas = 1024;

await Promise.all(
  [iconDirectory, ...appIdentities.map(({ directory }) => directory)].map(
    (directory) => mkdir(directory, { recursive: true }),
  ),
);
await Promise.all([
  ...Object.entries(faviconVariants).flatMap(([state, files]) => {
    const svg = retiledFavicon(faviconTiles[state]);
    return [
      writeFile(resolve(iconDirectory, files.svg), svg),
      renderPng(files.png, 32, svg),
    ];
  }),
  renderPng("apple-touch-icon.png", 180, appIconSvg(180, phoneGrid)),
  renderPng("icon-192.png", 192, appIconSvg(192, phoneGrid)),
  renderPng("icon-512.png", 512, appIconSvg(512, phoneGrid)),
  renderPng("icon-maskable-192.png", 192, appIconSvg(192, maskableGrid)),
  renderPng("icon-maskable-512.png", 512, appIconSvg(512, maskableGrid)),
  ...appIdentities.flatMap(({ directory, colors }) => [
    renderAppSource("macos-source.png", { ...macosGrid, colors }, directory),
    renderAppSource("ios-source.png", { ...phoneGrid, colors }, directory),
  ]),
]);

function renderAppSource(filename, grid, directory) {
  return renderPng(
    filename,
    appStoreCanvas,
    appIconSvg(appStoreCanvas, grid),
    directory,
  );
}

function retiledFavicon(tile) {
  const brandTile = `fill="${brandColors.felt}"`;
  if (!favicon.includes(brandTile))
    throw new Error("favicon.svg no longer draws the brand felt tile");
  return favicon.replace(brandTile, `fill="${tile}"`);
}

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
