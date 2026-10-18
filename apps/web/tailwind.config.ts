import type { Config } from 'tailwindcss';
import { foresitePreset } from '@foresite/ui/tailwind-preset';

// All colour and type values come from the theme's CSS variables via the
// preset. Nothing in this file names a colour.
const config: Config = {
  presets: [foresitePreset],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};

export default config;
