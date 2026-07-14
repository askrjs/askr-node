import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: 'src/index.ts',
    format: ['esm'],
    outDir: 'dist',
    platform: 'node',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    dts: true,
    sourcemap: true,
    deps: { neverBundle: [/^@askrjs\/server(?:\/.*)?$/] },
  },
});
