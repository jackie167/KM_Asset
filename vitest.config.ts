import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["api-server/src/**/*.test.ts", "lib/db/src/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
  },
});
