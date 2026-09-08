import type { Config } from 'tailwindcss';
import iconify from '@iconify/tailwind4';
import typography from '@tailwindcss/typography';

/**
 * Tailwind v4's `Config` type dropped `safelist` along with JS-config-based
 * safelisting, but the compiler still honours it here. Extending the type
 * (rather than casting through `unknown`) keeps the rest of `config` checked
 * against the real `Config` shape.
 */
type ConfigWithSafelist = Config & {
  safelist?: readonly { pattern: RegExp }[];
};

const config = {
  content: ['./src/**/*.{html,js,ts,jsx,tsx}'],
  darkMode: 'class',
  plugins: [iconify(), typography],
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
} satisfies ConfigWithSafelist;

export default config;
