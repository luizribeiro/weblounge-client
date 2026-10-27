import { defineConfig } from "@playwright/test";

const builtApp = process.env.WEBLOUNGE_APP_DIR;
const outDir = builtApp === undefined ? "" : ` --outDir ${builtApp}`;

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: `vite preview --host 127.0.0.1 --port 4173${outDir}`,
    reuseExistingServer: false,
    url: "http://127.0.0.1:4173",
  },
});
