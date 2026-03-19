import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { syncVersion } from './build_scripts/syncVersion';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig(({ mode }) => ({
  publicDir: false,
  appType: 'mpa',
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    react(),
    viteStaticCopy({
      targets: [
        {
          src: 'assets/manifest.json',
          dest: '.',
          transform: (contents) => syncVersion(contents, mode),
        },
        { src: 'assets/icon/*', dest: 'icon' },
        { src: 'assets/favicon.ico.png', dest: '.' },
      ],
    }),
  ],
  build: {
    outDir: 'build',
    emptyOutDir: false,
    target: 'esnext',
    minify: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        options: 'src/options/index.html',
        tabs: 'src/tabs/index.html',
      },
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
}));
