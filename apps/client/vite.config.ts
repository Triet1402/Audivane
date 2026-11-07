import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, searchForWorkspaceRoot } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

// Set only by website/scripts/build-demo.mjs on its own Vite child process,
// which compiles this same source tree for static hosting under a subpath.
// Without these variables the default client/desktop build is unchanged:
// base "/" and outDir "dist".
const demoBase = process.env.CODEC_ABX_WEBSITE_DEMO_BASE;
const demoOutDir = process.env.CODEC_ABX_WEBSITE_DEMO_OUT_DIR;

export default defineConfig({
  root: "apps/client",
  base: demoBase ?? "/",
  publicDir: "public",
  optimizeDeps: {
    // The wrapper resolves its dedicated worker with new URL(..., import.meta.url).
    // Pre-bundling breaks that module-worker lookup and can fall back to a CDN.
    exclude: ["@ffmpeg/ffmpeg"],
  },
  worker: {
    format: "es",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      // Worktrees can share an installed dependency tree. FFmpeg's module
      // worker resolves to that real path and must be served by the dev host.
      allow: [
        searchForWorkspaceRoot(workspaceRoot),
        realpathSync(new URL("../../node_modules", import.meta.url)),
      ],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    // Set only for a deliberately exposed local preview behind a trusted proxy.
    allowedHosts: (process.env.CODEC_ABX_PREVIEW_ALLOWED_HOSTS ?? "")
      .split(",").map((host) => host.trim()).filter(Boolean),
  },
  build: {
    outDir: demoOutDir ?? "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
