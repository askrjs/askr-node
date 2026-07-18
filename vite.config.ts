import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", mcp: "src/mcp.ts" },
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    dts: true,
    sourcemap: "hidden",
    deps: { neverBundle: [/^@askrjs\/(?:auth|server)(?:\/.*)?$/] },
  },
});
