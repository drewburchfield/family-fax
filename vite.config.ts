import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      configPath: process.env.FAMILY_FAX_WRANGLER_CONFIG_PATH,
      persistState: process.env.FAMILY_FAX_PERSIST_PATH
        ? { path: process.env.FAMILY_FAX_PERSIST_PATH }
        : true,
    }),
  ],
  build: {
    sourcemap: true,
  },
});
