import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  appType: 'mpa',
  build: {
    cssCodeSplit: false,
    emptyOutDir: false,
    modulePreload: false,
    outDir: 'build',
    rollupOptions: {
      input: {
        options: 'src/options/index.html',
        popup: 'src/popup/index.html',
        search: 'src/search/index.html',
        tabs: 'src/tabs/index.html',
      },
    },
    target: 'esnext',
  },
  plugins: [tailwindcss(), react()],
  // The manifest, icons and favicon land at the build root, where Chrome expects them.
  publicDir: 'assets',
});
