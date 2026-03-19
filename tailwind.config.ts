import type { Config } from 'tailwindcss';
import iconify from '@iconify/tailwind4';
import typography from '@tailwindcss/typography';

const config = {
  content: ['./src/**/*.{html,js,ts,jsx,tsx}'],
  safelist: [
    {
      pattern: /text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)/,
    },
    {
      pattern: /text-(black|white|inherit|transparent)/,
    },
    {
      pattern:
        /text-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)/,
    },
    {
      pattern: /text-\[.*\]/,
    },
  ],
  plugins: [iconify(), typography],
  darkMode: 'class',
} as unknown as Config;

export default config;
