import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

/**
 * KaTeX's stylesheet lists each font as woff2, woff and ttf. The app's web
 * view reads woff2, so the other two are dropped before Vite bundles the
 * fonts: they would only add about a megabyte to the app.
 */
function katexWoff2Only(): Plugin {
  return {
    name: "nexq-katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id.split("?")[0])) return null;
      return { code: code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, ""), map: null };
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), katexWoff2Only()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    globals: true,
    // Agent worktrees (Claude's and Codex's) hold full copies of the repo.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", ".worktrees/**"],
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: false,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
