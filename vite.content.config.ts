import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: {
        clipper: 'src/content/clipper.ts',
      },
      output: {
        entryFileNames: '[name].js',
        format: 'iife',
      },
    },
    sourcemap: false,
    outDir: 'build',
    emptyOutDir: false,
  },
});
