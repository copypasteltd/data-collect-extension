import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "isolate-content-script",
      enforce: "post",
      renderChunk(code, chunk) {
        if (chunk.name !== "content") return null;
        if (
          chunk.imports.length ||
          chunk.dynamicImports.length ||
          chunk.exports.length
        )
          this.error("内容脚本必须是可重复注入的独立文件");
        return { code: `(() => {\n${code}\n})();`, map: null };
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve("sidepanel.html"),
        background: resolve("src/background.js"),
        content: resolve("src/content.js"),
      },
      output: {
        entryFileNames: (chunk) =>
          ["background", "content"].includes(chunk.name)
            ? "[name].js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
