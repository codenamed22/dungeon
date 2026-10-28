import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web director's front end. In development, Vite serves it and forwards
// /api to the director server (npm run web); in production the server serves
// the built files itself.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Keep the browser's Host header: the director server checks it.
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: false } },
  },
});
