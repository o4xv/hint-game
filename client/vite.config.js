import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Auto-generated build ID — changes every build, no manual bump needed
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA
  ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  : Date.now().toString(36);
const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
let buildOutput = resolve(ROOT_DIR, "dist");

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    {
      name: "version-service-worker",
      configResolved(config) {
        buildOutput = resolve(config.root, config.build.outDir);
      },
      closeBundle() {
        const serviceWorkerPath = resolve(buildOutput, "service-worker.js");
        const source = readFileSync(serviceWorkerPath, "utf8");
        writeFileSync(serviceWorkerPath, source.replaceAll("__BUILD_ID__", BUILD_ID));
      },
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
