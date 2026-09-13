import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'build',
    rollupOptions: {
      input: {
        service_worker: 'src/background/service_worker.ts',
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
    sourcemap: false,
    target: 'esnext',
  },
  publicDir: false,
});
