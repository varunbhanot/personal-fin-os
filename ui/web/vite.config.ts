// The build only. No server.proxy and no server.host: the app is served by ui/server on one
// origin (127.0.0.1:<port>), so there is no dev server, no proxy and no CORS. Frontend work
// uses Vitest and `vite build --watch` with the fake backend.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    // The server serves only files that match [A-Za-z0-9._-]+ under /assets/.
    assetsDir: "assets",
    sourcemap: false,
    // Recharts makes one chunk of about 640 kB; it loads from 127.0.0.1, so splitting gains nothing.
    chunkSizeWarningLimit: 800,
  },
});
