import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: Number(process.env.MAXX_RENDERER_PORT || 1420),
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
