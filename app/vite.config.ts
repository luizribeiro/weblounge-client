import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { buildDebugIrcConfig } from "./src/debug-irc-config.ts";

export default defineConfig(({ mode }) => {
  const performanceHarness = process.env.WEBLOUNGE_E2E_HARNESS === "1";
  const wasmDirectory =
    process.env.WEBLOUNGE_ENGINE_WASM_DIR ??
    resolve(import.meta.dirname, "../result/dist");
  const wasmPath = resolve(wasmDirectory, "engine_bg.wasm");
  const wasmModulePath =
    mode === "test"
      ? resolve(import.meta.dirname, "src/engine/wasm-test-stub.ts")
      : resolve(wasmDirectory, "engine.js");

  if (mode !== "test" && !existsSync(wasmPath)) {
    throw new Error("engine wasm is missing; run `nix build .#engine-wasm`");
  }

  return {
    define: {
      __BUILD_ID__: JSON.stringify(buildId(wasmPath)),
      __DEBUG_IRC_CONFIG__: JSON.stringify(
        buildDebugIrcConfig(mode, process.env),
      ),
    },
    plugins: [solid(), engineWasmAsset(wasmPath)],
    ...(performanceHarness
      ? {
          build: {
            rollupOptions: {
              input: {
                app: resolve(import.meta.dirname, "index.html"),
                "message-list-performance": resolve(
                  import.meta.dirname,
                  "e2e/message-list-performance.html",
                ),
                "member-list-performance": resolve(
                  import.meta.dirname,
                  "e2e/member-list-performance.html",
                ),
              },
            },
          },
        }
      : {}),
    resolve: {
      alias: {
        "@weblounge-engine": wasmModulePath,
      },
    },
    test: {
      environment: "jsdom",
      exclude: ["e2e/**", "node_modules/**"],
      setupFiles: ["./src/test-setup.ts"],
    },
  };
});

function engineWasmAsset(wasmPath: string): Plugin {
  return {
    name: "weblounge-engine-wasm",
    configureServer(server) {
      server.middlewares.use("/engine_bg.wasm", (_request, response) => {
        response.setHeader("Content-Type", "application/wasm");
        response.end(readFileSync(wasmPath));
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "engine_bg.wasm",
        source: readFileSync(wasmPath),
      });
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
