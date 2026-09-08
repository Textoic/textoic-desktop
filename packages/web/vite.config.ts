import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env.TEXTOIC_API ?? "http://127.0.0.1:4747";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/lsp": { target: backend.replace(/^http/u, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
