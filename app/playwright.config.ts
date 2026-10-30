import { defineConfig, devices } from "@playwright/test";

const builtApp = process.env.WEBLOUNGE_APP_DIR;
const outDir = builtApp === undefined ? "" : ` --outDir ${builtApp}`;
const devServer = process.env.WEBLOUNGE_E2E_DEV === "1";
const appOnly = process.env.WEBLOUNGE_E2E_APP_ONLY === "1";
const defaultPort = devServer ? 5173 : 4173;
const port = Number(process.env.WEBLOUNGE_E2E_PORT ?? defaultPort);
const serverCommand = devServer
  ? `pnpm icons && WEBLOUNGE_E2E_APP_CONFIG=1 WEBLOUNGE_E2E_CSP=1 vite --host 127.0.0.1 --port ${port}`
  : `WEBLOUNGE_E2E_APP_CONFIG=1 WEBLOUNGE_E2E_CSP=1 vite preview --host 127.0.0.1 --port ${port}${outDir}`;

export default defineConfig({
  testDir: "./e2e",
  workers: process.env.WEBLOUNGE_E2E_ERGO === "1" ? 1 : undefined,
  projects: [
    {
      name: "chromium",
      testIgnore: /connection-resilience\.spec\.ts/,
      use: { browserName: "chromium" },
    },
    {
      name: "resilience-desktop-webkit",
      testMatch: /connection-resilience\.spec\.ts/,
      use: { browserName: "webkit" },
    },
    {
      name: "resilience-mobile-webkit",
      testMatch: /connection-resilience\.spec\.ts/,
      use: { ...devices["iPhone 16 Pro"] },
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: [
    {
      command: serverCommand,
      reuseExistingServer: false,
      url: `http://127.0.0.1:${port}`,
    },
    ...(appOnly
      ? []
      : [
          {
            command: "node e2e/fake-oauth-server.mjs",
            reuseExistingServer: false,
            url: "http://127.0.0.1:4174/health",
          },
        ]),
  ],
});
