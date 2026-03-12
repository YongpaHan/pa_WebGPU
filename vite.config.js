import { defineConfig } from "vite";

export default defineConfig(() => ({
  base: "./",
  server: process.env.VITE_MOBILE_TUNNEL
    ? {
        allowedHosts: [".trycloudflare.com"],
      }
    : undefined,
}));
