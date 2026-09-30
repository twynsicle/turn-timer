import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import { INDEX_ELEMENT_ID, INDEX_PLACEHOLDER, SESSIONS_DIR } from "./src/core/report-data.js";

const OUT_DIR = fileURLToPath(new URL("./dist/report", import.meta.url));

const SCRIPT_TAG = /<script type="module" crossorigin src="\.\/([^"]+\.js)"><\/script>/g;
const STYLE_TAG = /<link rel="stylesheet" crossorigin href="\.\/([^"]+\.css)">/g;

/**
 * Folds the built JS and CSS into the page and deletes everything else, leaving one
 * `shell.html` that the CLI fills with session data and writes beside the session files.
 */
function inlineIntoHtml(): Plugin {
  return {
    name: "inline-into-html",
    apply: "build",
    closeBundle() {
      const read = (file: string) => readFileSync(join(OUT_DIR, file), "utf8");
      const html = read("index.html")
        .replace(SCRIPT_TAG, (_tag, file: string) => `<script type="module">${read(file).replaceAll("</script", "<\\/script")}</script>`)
        .replace(STYLE_TAG, (_tag, file: string) => `<style>${read(file)}</style>`);
      if (/(?:src|href)="\.\//.test(html)) throw new Error("report build: the page still references a separate file");
      if (!html.includes(INDEX_PLACEHOLDER)) throw new Error("report build: the index placeholder did not survive the build");
      for (const entry of readdirSync(OUT_DIR)) rmSync(join(OUT_DIR, entry), { recursive: true });
      writeFileSync(join(OUT_DIR, "shell.html"), html);
    },
  };
}

/**
 * `npm run dev:web` only: serves a report the CLI already generated (REPORT_DIR, default
 * .dev-report): its embedded index goes into the dev page, and its session files are served.
 * Make one with `npm run dev -- --out .dev-report --no-open`.
 */
function devReport(): Plugin {
  const dir = process.env.REPORT_DIR ?? ".dev-report";
  return {
    name: "dev-report",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(`/${SESSIONS_DIR}/`, (req, res, next) => {
        const file = join(dir, SESSIONS_DIR, decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\//, "")));
        if (!existsSync(file) || file.includes("..")) return next();
        res.setHeader("content-type", "text/javascript");
        res.end(readFileSync(file));
      });
    },
    transformIndexHtml(html) {
      const file = join(dir, "index.html");
      if (!existsSync(file)) return html;
      const m = new RegExp(`<script id="${INDEX_ELEMENT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(readFileSync(file, "utf8"));
      return m ? html.replace(INDEX_PLACEHOLDER, () => m[0]) : html;
    },
  };
}

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react(), devReport(), inlineIntoHtml()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 10_000,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
