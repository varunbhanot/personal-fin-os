import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // S8: every test runs with fetch and the Neon driver's fetch refused (test/no-network.ts).
    setupFiles: ["test/no-network.ts"],
    // A throwaway Postgres 16 with the migrations and the golden seed, or a skip on the laptop.
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
