import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Mongo integration tests open real connections; cap concurrent forks so the many
    // repo-backed suites don't storm a single mongod (connection starvation shows up as
    // hook/test timeouts under load, not logic failures). Generous timeouts cover a slow
    // first connect.
    pool: "forks",
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
