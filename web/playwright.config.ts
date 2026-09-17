import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    headless: true,
  },
  webServer: {
    command: "bun run dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
});
