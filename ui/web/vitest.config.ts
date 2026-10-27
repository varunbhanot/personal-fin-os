import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    // S8: every test runs with fetch and every non-loopback socket refused (test/no-network.ts).
    // setup.ts: Testing Library clean-up, ResizeObserver and a fixed chart width under jsdom.
    setupFiles: ["test/no-network.ts", "test/setup.ts"],
    testTimeout: 15_000,
  },
});
