import { defineConfig, devices } from "@playwright/test";

const builtApp = process.env.WEBLOUNGE_APP_DIR;
const outDir = builtApp === undefined ? "" : ` --outDir ${builtApp}`;
const devServer = process.env.WEBLOUNGE_E2E_DEV === "1";
const appOnly = process.env.WEBLOUNGE_E2E_APP_ONLY === "1";
const externalServer = process.env.WEBLOUNGE_E2E_EXTERNAL_SERVER === "1";
const defaultPort = devServer ? 5173 : 4173;
const port = Number(process.env.WEBLOUNGE_E2E_PORT ?? defaultPort);
const serverCommand = devServer
  ? `pnpm assets && WEBLOUNGE_IRC_ENDPOINT=ws://127.0.0.1:${port}/socket WEBLOUNGE_E2E_APP_CONFIG=1 WEBLOUNGE_E2E_CSP=1 vite --host 127.0.0.1 --port ${port}`
  : `WEBLOUNGE_E2E_APP_CONFIG=1 WEBLOUNGE_E2E_CSP=1 vite preview --host 127.0.0.1 --port ${port}${outDir}`;

export default defineConfig({
  reporter: [["line"], ["./e2e/failure-diagnostics-reporter.ts"]],
  projects: [
    {
      name: "chromium",
      testIgnore: [
        "**/slow-buffer-load.spec.ts",
        "**/push-notifications.spec.ts",
        "**/mobile-input-zoom.spec.ts",
        "**/mobile-page-zoom.spec.ts",
        "**/mobile-read-state.spec.ts",
        "**/connection-resilience.spec.ts",
      ],
      use: { browserName: "chromium" },
    },
    {
      name: "chromium-push",
      testMatch: "**/push-notifications.spec.ts",
      use: { browserName: "chromium", channel: "chromium" },
    },
    {
      name: "chromium-push-full",
      testMatch: "**/push-full-chain.spec.ts",
      use: { browserName: "chromium", channel: "chromium" },
    },
    {
      name: "firefox-push-controls-full",
      grep: /keeps portable control messages silent/,
      testMatch: "**/push-full-chain.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-bot-reply-read-full",
      grep: /marks a bot reply read after sending in a reconnected SharedWorker DM/,
      testMatch: "**/push-full-chain.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "webkit-push-badge-full",
      grep: /corrects a stale Apple badge when the app opens/,
      testMatch: "**/push-full-chain.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "firefox-push-controls",
      grep: /MARKREAD silently closes a direct-message notification/,
      testMatch: "**/push-notifications.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "webkit-push-taps",
      grep: /routes a tapped DM/,
      testMatch: "**/push-notifications.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "firefox-timestamps",
      testMatch: "**/timestamps.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-desktop-composer",
      grep: /aligns desktop Send/u,
      testMatch: "**/phone-composer.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-console",
      testMatch: "**/console-clean.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-service-worker",
      grep: /launches the shell and engine from cache|uses network HTML online and the cached shell offline/,
      testMatch: "**/service-worker.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-routing",
      testMatch: "**/routing.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-stale-snapshot",
      grep: /overwrites stale SharedWorker badges before relaunch|keeps a newly read DM clear after a failed Firefox snapshot commit/,
      testMatch: "**/stale-snapshot.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-shimmer",
      testMatch: [
        "**/conversation-title-shimmer.spec.ts",
        "**/logo-fill-shimmer.spec.ts",
      ],
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-startup",
      grep: /survives focus while the engine handshake is pending/,
      testMatch: "**/startup.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-notification-prompt",
      grep: /fresh Firefox and Chromium profiles show notification setup/,
      testMatch: "**/hosted-mode.spec.ts",
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
      name: "webkit-hosted",
      grep: /deployment config error|member session through|real (?:shared|dedicated) worker|fresh session request is aborted|recovers from a (?:rate limit|network) failure|shows an unrecoverable token failure|mobile webkit notification prompt|converges an Apple badge/,
      testMatch: "**/hosted-mode.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-startup-desktop",
      testMatch: "**/startup.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-mobile-back",
      testMatch: [
        "**/mobile-back-swipe.spec.ts",
        "**/mobile-member-drawer-gesture.spec.ts",
        "**/mobile-member-drawer-motion.spec.ts",
        "**/mobile-push-motion.spec.ts",
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
      testMatch: ["**/launch-images.spec.ts", "**/splash.spec.ts"],
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-startup-mobile",
      testMatch: "**/startup.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-typing",
      grep: /typing line/u,
      testMatch: "**/typing.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-phone-composer",
      testMatch: "**/phone-composer.spec.ts",
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-phone-layout",
      testMatch: [
        "**/highlight-row.spec.ts",
        "**/phone-layout.spec.ts",
        "**/history-loading-row.spec.ts",
        "**/notices.spec.ts",
        "**/short-history.spec.ts",
        "**/spacing-audit.spec.ts",
        "**/spacing-audit-screenshot.spec.ts",
      ],
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "android-phone-layout",
      testMatch: [
        "**/highlight-row.spec.ts",
        "**/phone-layout.spec.ts",
        "**/spacing-audit.spec.ts",
        "**/spacing-audit-screenshot.spec.ts",
      ],
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      name: "webkit-conversation",
      testMatch: ["**/composer-anchor.spec.ts", "**/transcript-paint.spec.ts"],
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-shimmer",
      testMatch: [
        "**/conversation-title-shimmer.spec.ts",
        "**/logo-fill-shimmer.spec.ts",
      ],
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-mobile-history",
      testMatch: "**/mobile-history.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-members",
      testMatch: "**/mobile-member-drawer-follow.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "chromium-mobile-members",
      testMatch: "**/mobile-member-drawer-follow.spec.ts",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      name: "webkit-mobile-opening",
      grep: /opens a mobile channel at the live edge/,
      testMatch: "**/mobile-opening-scroll.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-read-state",
      testMatch: "**/mobile-read-state.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-bots-unread",
      testMatch: "**/bots-unread.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-stale-snapshot",
      testMatch: "**/stale-snapshot.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-chat-list",
      testMatch: "**/mobile-chat-list.spec.ts",
      grep: /reaction-only TARGETS activity/u,
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "webkit-mobile-new-divider",
      testMatch: "**/new-divider-focused.spec.ts",
      use: { ...devices["iPhone 16 Pro"], browserName: "webkit" },
    },
    {
      name: "android-mobile-history",
      testMatch: "**/mobile-history.spec.ts",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      name: "android-mobile-read-state",
      testMatch: "**/mobile-read-state.spec.ts",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      name: "chromium-slow-buffer",
      dependencies: ["chromium"],
      testMatch: "**/slow-buffer-load.spec.ts",
      use: { browserName: "chromium" },
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
    baseURL: process.env.WEBLOUNGE_E2E_BASE_URL ?? `http://127.0.0.1:${port}`,
    ignoreHTTPSErrors: process.env.WEBLOUNGE_E2E_SECURE_ERGO === "1",
    trace: "retain-on-failure",
  },
  webServer: externalServer
    ? []
    : [
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
