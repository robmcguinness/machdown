import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { syncVersion } from './build_scripts/syncVersion.ts';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig(({ mode }) => ({
  appType: 'mpa',
  build: {
    emptyOutDir: false,
    minify: false,
    modulePreload: false,
    outDir: 'build',
    rollupOptions: {
      input: {
        options: 'src/options/index.html',
        popup: 'src/popup/index.html',
        search: 'src/search/index.html',
        tabs: 'src/tabs/index.html',
      },
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
    target: 'esnext',
  },
  plugins: [
    tailwindcss(),
    react(),
    viteStaticCopy({
      targets: [
        // stripBase drops the `assets/` prefix of each source path; without it the
        // manifest and icons land under build/assets/… and Chrome refuses the folder.
        {
          dest: '.',
          rename: { stripBase: true },
          src: 'assets/manifest.json',
          transform: (contents) => syncVersion(contents, mode),
        },
        { dest: 'icon', rename: { stripBase: true }, src: 'assets/icon/*' },
        { dest: '.', rename: { stripBase: true }, src: 'assets/favicon.ico.png' },
      ],
    }),
  ],
  publicDir: false,
}));
