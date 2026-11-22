// Dev server of the preview harness (`npm run harness`): the real React UI in
// a plain browser, with Tauri mocked. The project root stays the repo root, so
// the `@` alias, Tailwind and PostCSS resolve exactly as in the app; only the
// page served at "/" differs. Nothing here is part of `npm run build`.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(harnessDir, "..");

/** Folders of the repo the harness never serves from: no need to watch them. */
const UNWATCHED = ["src-tauri", "dist", "website", ".claude", ".worktrees"].map((dir) => path.join(repoRoot, dir) + path.sep);

/** Serves harness/index.html at "/" (the repo's own index.html is the app). */
function harnessPage(): Plugin {
  return {
    name: "nexq-harness-page",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        const pathname = url.split("?")[0];
        if (req.method !== "GET" || (pathname !== "/" && pathname !== "/index.html")) return next();
        try {
          const html = await readFile(path.join(harnessDir, "index.html"), "utf8");
          // Through Vite's own HTML pipeline, or the React plugin's preamble is missing.
          const page = await server.transformIndexHtml(url, html);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(page);
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  root: repoRoot,
  plugins: [react(), harnessPage()],
  resolve: {
    alias: {
      "@": path.resolve(repoRoot, "src"),
    },
  },
  // Its own cache: the app's dev server (port 5173) keeps a different set of pre-bundled modules.
  cacheDir: path.resolve(repoRoot, "node_modules/.vite-harness"),
  optimizeDeps: {
    // Only the harness page; the repo holds other HTML files (the app, the website, agent worktrees).
    entries: ["harness/index.html"],
  },
  clearScreen: false,
  server: {
    port: 5199,
    strictPort: true,
    watch: {
      ignored: [(file: string) => UNWATCHED.some((dir) => file.startsWith(dir))],
    },
  },
});
