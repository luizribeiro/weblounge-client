import { defineConfig } from "@playwright/test";

const builtApp = process.env.WEBLOUNGE_APP_DIR;
const outDir = builtApp === undefined ? "" : ` --outDir ${builtApp}`;
const devServer = process.env.WEBLOUNGE_E2E_DEV === "1";
const port = devServer ? 5173 : 4173;
const serverCommand = devServer
  ? `vite --host 127.0.0.1 --port ${port}`
  : `vite preview --host 127.0.0.1 --port ${port}${outDir}`;

export default defineConfig({
  testDir: "./e2e",
  workers: process.env.WEBLOUNGE_E2E_ERGO === "1" ? 1 : undefined,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: serverCommand,
    reuseExistingServer: false,
    url: `http://127.0.0.1:${port}`,
  },
});
