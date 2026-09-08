import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: 'build',
    rollupOptions: {
      input: {
        service_worker: 'src/background/service_worker.ts',
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
    sourcemap: false,
    target: 'esnext',
  },
  publicDir: false,
});
