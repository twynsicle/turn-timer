import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  // `npm run dev:web` expects `turn-timer serve --no-open` (npm run dev -- serve --no-open) on 4317.
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        // Without the API server the viewer would only see a bare 502; say what's missing.
        configure: (proxy) =>
          proxy.on("error", (err, _req, res) => {
            if (!("writeHead" in res) || res.headersSent) return;
            const refused = (err as NodeJS.ErrnoException).code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(err));
            res.writeHead(502, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: refused
                  ? "The API server isn't running on 127.0.0.1:4317. Start it in another terminal with `npm run dev -- serve --no-open`."
                  : `API proxy error: ${err.message}`,
              }),
            );
          }),
      },
    },
  },
});
