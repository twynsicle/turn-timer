import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  // `npm run dev:web` expects `turn-timer serve --no-open` (npm run dev -- serve --no-open) on 4317.
  server: { proxy: { "/api": "http://127.0.0.1:4317" } },
});
