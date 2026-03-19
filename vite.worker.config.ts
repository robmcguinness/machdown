import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: {
        service_worker: 'src/background/service_worker.ts',
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
    sourcemap: false,
    outDir: 'build',
    emptyOutDir: false,
  },
});
