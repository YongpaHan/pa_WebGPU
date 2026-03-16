import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig(() => ({
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: process.env.VITE_MOBILE_TUNNEL
    ? {
        allowedHosts: [".trycloudflare.com"],
      }
    : undefined,
}));
