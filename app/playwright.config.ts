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
  projects: [
    {
      name: "chromium",
      testIgnore: [
        "**/mobile-input-zoom.spec.ts",
        "**/mobile-page-zoom.spec.ts",
        "**/connection-resilience.spec.ts",
      ],
      use: { browserName: "chromium" },
    },
    {
      name: "firefox-timestamps",
      testMatch: "**/timestamps.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-console",
      testMatch: "**/console-clean.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "webkit-timestamps",
      testMatch: "**/timestamps.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-console",
      testMatch: "**/console-clean.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-mobile-back",
      testMatch: [
        "**/mobile-back-swipe.spec.ts",
        "**/mobile-member-drawer-gesture.spec.ts",
      ],
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-inputs",
      testMatch: [
        "**/mobile-input-zoom.spec.ts",
        "**/mobile-page-zoom.spec.ts",
      ],
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-splash-desktop",
      grep: /desktop/,
      testMatch: "**/splash.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-splash-mobile",
      grep: /mobile/,
      testMatch: "**/splash.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-history",
      testMatch: "**/mobile-history.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "android-mobile-history",
      testMatch: "**/mobile-history.spec.ts",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      name: "resilience-desktop-chromium",
      testMatch: "**/connection-resilience.spec.ts",
      use: { browserName: "chromium" },
    },
    {
      name: "resilience-desktop-webkit",
      testMatch: "**/connection-resilience.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "resilience-mobile-webkit",
      testMatch: "**/connection-resilience.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
  ],
  testDir: "./e2e",
  workers: process.env.WEBLOUNGE_E2E_ERGO === "1" ? 1 : undefined,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ignoreHTTPSErrors: process.env.WEBLOUNGE_E2E_SECURE_ERGO === "1",
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
