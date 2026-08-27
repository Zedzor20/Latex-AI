import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: "src/renderer",
  publicDir: false,
  base: "./",
  resolve: {
    alias: {
      "@shared": path.resolve(projectRoot, "src/shared")
    }
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
});
