import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { BETA_CONTENT_SECURITY_POLICY } from "./csp.ts";
import { buildDebugIrcConfig } from "./src/debug-irc-config.ts";

export default defineConfig(({ mode }) => {
  const performanceHarness = process.env.WEBLOUNGE_E2E_HARNESS === "1";
  const appConfigHarness = process.env.WEBLOUNGE_E2E_APP_CONFIG === "1";
  const maxWorkers = process.env.WEBLOUNGE_VITEST_MAX_WORKERS;
  const testTimeout = process.env.WEBLOUNGE_VITEST_TEST_TIMEOUT;
  const cspEnabled = process.env.WEBLOUNGE_E2E_CSP === "1";
  const wasmDirectory =
    process.env.WEBLOUNGE_ENGINE_WASM_DIR ??
    resolve(import.meta.dirname, "../result/dist");
  const wasmPath = resolve(wasmDirectory, "engine_bg.wasm");
  const wasmModulePath =
    mode === "test"
      ? resolve(import.meta.dirname, "src/engine/wasm-test-stub.ts")
      : resolve(wasmDirectory, "engine.js");
  const wasmAssetPath =
    mode === "test"
      ? resolve(import.meta.dirname, "src/engine/wasm-test-stub.ts")
      : wasmPath;
  if (mode !== "test" && !existsSync(wasmPath)) {
    throw new Error("engine wasm is missing; run `nix build .#engine-wasm`");
  }

  return {
    define: {
      __BUILD_ID__: JSON.stringify(buildId(wasmPath)),
      __DEBUG_IRC_CONFIG__: JSON.stringify(
        buildDebugIrcConfig(mode, process.env, performanceHarness),
      ),
    },
    base: "/",
    build: {
      assetsInlineLimit: 0,
      sourcemap: false,
      ...(performanceHarness
        ? {
            rollupOptions: {
              input: {
                app: resolve(import.meta.dirname, "index.html"),
                "message-list-performance": resolve(
                  import.meta.dirname,
                  "e2e/message-list-performance.html",
                ),
                "message-list-overlap": resolve(
                  import.meta.dirname,
                  "e2e/message-list-overlap.html",
                ),
                "member-list-performance": resolve(
                  import.meta.dirname,
                  "e2e/member-list-performance.html",
                ),
                "prefix-column": resolve(
                  import.meta.dirname,
                  "e2e/prefix-column.html",
                ),
                "member-window-live": resolve(
                  import.meta.dirname,
                  "e2e/member-window-live.html",
                ),
                "draft-key-migration": resolve(
                  import.meta.dirname,
                  "e2e/draft-key-migration.html",
                ),
              },
            },
          }
        : {}),
    },
    plugins: [
      ...(cspEnabled ? [cspDevStyles()] : []),
      solid(),
      injectStartupImageLinks(),
      prioritizeSplashStylesheet(),
      ...(appConfigHarness ? [testAppConfig()] : []),
    ],
    ...(!cspEnabled
      ? {}
      : {
          server: {
            headers: {
              "Content-Security-Policy": BETA_CONTENT_SECURITY_POLICY,
            },
            proxy: testWebSocketProxy(),
          },
          preview: {
            headers: {
              "Content-Security-Policy": BETA_CONTENT_SECURITY_POLICY,
            },
            proxy: testWebSocketProxy(),
          },
        }),
    resolve: {
      alias: {
        "@weblounge-engine": wasmModulePath,
        "@weblounge-engine-wasm": `${wasmAssetPath}?url`,
      },
    },
    test: {
      environment: "jsdom",
      exclude: ["e2e/**", "node_modules/**"],
      setupFiles: ["./src/test-setup.ts"],
      ...(maxWorkers === undefined
        ? {}
        : { maxWorkers: Number.parseInt(maxWorkers, 10) }),
      ...(testTimeout === undefined
        ? {}
        : { testTimeout: Number.parseInt(testTimeout, 10) }),
    },
  };
});

function injectStartupImageLinks(): Plugin {
  const devices = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "startup-images.json"), "utf8"),
  ) as Array<{ height: number; name: string; ratio: number; width: number }>;
  return {
    name: "weblounge-startup-images",
    transformIndexHtml: {
      order: "pre",
      handler: () =>
        devices.flatMap((device) =>
          (["portrait", "landscape"] as const).flatMap((orientation) =>
            (["light", "dark"] as const).map((appearance) => ({
              tag: "link",
              attrs: {
                href: `/startup/${device.name}-${orientation}-${appearance}.png`,
                media: [
                  `(device-width: ${device.width}px)`,
                  `(device-height: ${device.height}px)`,
                  `(-webkit-device-pixel-ratio: ${device.ratio})`,
                  `(orientation: ${orientation})`,
                  `(prefers-color-scheme: ${appearance})`,
                ].join(" and "),
                rel: "apple-touch-startup-image",
              },
              injectTo: "head" as const,
            })),
          ),
        ),
    },
  };
}

function testWebSocketProxy() {
  return {
    "/socket": {
      target: "ws://127.0.0.1:8067",
      ws: true,
    },
  };
}

function cspDevStyles(): Plugin {
  const publicId = "virtual:weblounge-csp-dev-styles";
  const resolvedId = `\0${publicId}`;
  return {
    name: "weblounge-csp-dev-styles",
    enforce: "post",
    resolveId(id) {
      return id === publicId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      return `
const links = new Map();
let revision = 0;

export function updateStyle(id) {
  const current = links.get(id);
  const link = current ?? document.createElement("link");
  const loaded = new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = reject;
  });
  const href = new URL(\`/@fs\${id}\`, location.href);
  href.searchParams.set("direct", "");
  href.searchParams.set("v", String(revision++));
  link.rel = "stylesheet";
  link.href = href.href;
  if (current === undefined) {
    links.set(id, link);
    document.head.append(link);
  }
  return loaded;
}

export function removeStyle(id) {
  links.get(id)?.remove();
  links.delete(id);
}
`;
    },
    transform(code, id) {
      if (!/\.css(?:$|\?)/u.test(id) || !code.includes("__vite__updateStyle")) {
        return undefined;
      }
      const external = code.replace(
        /import \{ updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle \} from "\/@vite\/client"/u,
        `import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from "${publicId}"`,
      );
      if (external === code) return undefined;
      return external.replace(
        "__vite__updateStyle(__vite__id, __vite__css)",
        "await __vite__updateStyle(__vite__id, __vite__css)",
      );
    },
  };
}

function prioritizeSplashStylesheet(): Plugin {
  return {
    name: "weblounge-prioritize-splash-stylesheet",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (html?.type !== "asset" || typeof html.source !== "string") return;
      const stylesheet = html.source.match(
        /<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"[^>]*>/u,
      )?.[0];
      if (stylesheet === undefined) {
        throw new Error("production stylesheet link is missing");
      }
      const tagged = stylesheet.replace(
        "<link ",
        "<link data-initial-splash-style ",
      );
      html.source = html.source
        .replace(stylesheet, "")
        .replace(
          '<meta name="color-scheme" content="light dark" />',
          `<meta name="color-scheme" content="light dark" />\n    ${tagged}`,
        );
    },
  };
}

function testAppConfig(): Plugin {
  const serve = (_request: unknown, response: ServerResponse) => {
    response.setHeader("Content-Type", "application/json");
    response.end('{"mode":"app"}');
  };
  return {
    name: "weblounge-test-app-config",
    configureServer(server) {
      server.middlewares.use("/config.json", serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/config.json", serve);
    },
  };
}

function buildId(wasmPath: string): string {
  const hash = createHash("sha256");
  hashDirectory(hash, resolve(import.meta.dirname, "src"));
  if (existsSync(wasmPath)) hash.update(readFileSync(wasmPath));
  return hash.digest("hex").slice(0, 16);
}

function hashDirectory(
  hash: ReturnType<typeof createHash>,
  directory: string,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) hashDirectory(hash, path);
    else if (entry.isFile()) hash.update(entry.name).update(readFileSync(path));
  }
}
