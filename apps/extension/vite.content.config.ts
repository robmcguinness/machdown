import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: 'build',
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
    target: 'esnext',
  },
  publicDir: false,
});
