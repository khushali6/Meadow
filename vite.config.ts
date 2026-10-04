import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules[\\/](react|react-dom|scheduler|wouter)[\\/]/.test(id)) return "react";
          if (/@trpc|@tanstack|superjson|zod/.test(id)) return "data";
          if (/gsap|animejs|motion|framer-motion/.test(id)) return "motion";
          return undefined;
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    fs: { strict: true, deny: ["**/.*"] },
  },
});
