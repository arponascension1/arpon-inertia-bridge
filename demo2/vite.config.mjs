import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: "public",
    emptyOutDir: true,
    manifest: ".vite/manifest.json",
    rollupOptions: {
      input: path.resolve(process.cwd(), "resources", "js", "app.ts")
    }
  }
});
