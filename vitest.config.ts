import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 89,
        branches: 82,
        functions: 82,
        lines: 93,
        "src/diagnostics.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/stream-writer.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/response.ts": { statements: 89, branches: 84, functions: 68, lines: 96 },
        "src/listen.ts": { statements: 97, branches: 93, functions: 91, lines: 97 },
      },
    },
  },
});
