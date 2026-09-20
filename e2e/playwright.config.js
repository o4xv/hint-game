import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [
    { name: "mobile-chromium", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: [
    {
      command: "npm start",
      cwd: "../server",
      port: 3001,
      reuseExistingServer: !process.env.CI,
      env: { ALLOWED_ORIGINS: "http://127.0.0.1:5173", NODE_ENV: "test" },
    },
    {
      command: "npm run dev -- --host 127.0.0.1",
      cwd: "../client",
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
