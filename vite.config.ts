import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import { DATA_END, INDEX_ELEMENT_ID, INDEX_PLACEHOLDER } from "./src/core/report-data.js";

const OUT_DIR = fileURLToPath(new URL("./dist/report", import.meta.url));

const SCRIPT_TAG = /<script type="module" crossorigin src="\.\/([^"]+\.js)"><\/script>/g;
const STYLE_TAG = /<link rel="stylesheet" crossorigin href="\.\/([^"]+\.css)">/g;

/**
 * Folds the built JS and CSS into the page and deletes everything else, leaving one
 * `shell.html` that the CLI fills with session data.
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
 * `npm run dev:web` only: shows a report the CLI already generated (REPORT_FILE, default
 * claude-sessions-report.html): its embedded data goes into the dev page. Nothing is written.
 */
function devReport(): Plugin {
  const file = process.env.REPORT_FILE ?? "claude-sessions-report.html";
  return {
    name: "dev-report",
    apply: "serve",
    transformIndexHtml(html) {
      if (!existsSync(file)) return html;
      const report = readFileSync(file, "utf8");
      const start = report.indexOf(`<script id="${INDEX_ELEMENT_ID}"`);
      const end = report.indexOf(DATA_END);
      return start === -1 || end === -1 ? html : html.replace(INDEX_PLACEHOLDER, () => report.slice(start, end + DATA_END.length));
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
