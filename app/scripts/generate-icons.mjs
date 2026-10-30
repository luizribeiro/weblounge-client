import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const appDirectory = resolve(import.meta.dirname, "..");
const source = await readFile(
  resolve(appDirectory, "assets/chair.svg"),
  "utf8",
);
const iconDirectory = resolve(appDirectory, "public/icons");
const artwork = source.slice(
  source.indexOf(">") + 1,
  source.lastIndexOf("</svg>"),
);

const colors = {
  dark: "#15231c",
  ink: "#1b2a22",
  paper: "#efe8d8",
  signal: "#e3b778",
};

await mkdir(iconDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(iconDirectory, "favicon.svg"), adaptiveSvg()),
  renderPng("favicon-32.png", 32, colors.paper, colors.ink, 3),
  renderPng("apple-touch-icon.png", 180, colors.paper, colors.ink, 18),
  renderPng("icon-192.png", 192, colors.paper, colors.ink, 19),
  renderPng("icon-512.png", 512, colors.paper, colors.ink, 51),
  renderPng("icon-dark-512.png", 512, colors.dark, colors.signal, 51),
  renderPng("icon-maskable-192.png", 192, colors.dark, colors.signal, 38),
  renderPng("icon-maskable-512.png", 512, colors.dark, colors.signal, 102),
]);

function adaptiveSvg() {
  return iconSvg({
    background: colors.paper,
    foreground: colors.ink,
    padding: 48,
    size: 512,
    style: `
      @media (prefers-color-scheme: dark) {
        .background { fill: ${colors.dark}; }
        .artwork { color: ${colors.signal}; }
      }
    `,
  });
}

async function renderPng(filename, size, background, foreground, padding) {
  const svg = iconSvg({ background, foreground, padding, size });
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

function iconSvg({ background, foreground, padding, size, style = "" }) {
  const artworkSize = size - 2 * padding;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <style>${style}</style>
  <rect class="background" width="${size}" height="${size}" fill="${background}"/>
  <svg class="artwork" x="${padding}" y="${padding}" width="${artworkSize}" height="${artworkSize}" viewBox="-21.5 -28 675 653" color="${foreground}">
    ${artwork}
  </svg>
</svg>
`;
}
