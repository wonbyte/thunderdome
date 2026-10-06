// Vitest runs the unit tests in plain Node. Tests import only the pure modules, never cloudflare:workers.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
