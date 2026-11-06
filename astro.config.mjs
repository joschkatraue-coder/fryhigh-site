// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://fryhigh.de',
  // CSS direkt ins HTML: spart drei blockierende Anfragen vor dem ersten Bild (Lighthouse 2026-11-06: ~0,8 s mobil).
  build: { inlineStylesheets: 'always' },
  integrations: [
    sitemap({
      filter: (page) =>
        !page.includes('/impressum') &&
        !page.includes('/datenschutz') &&
        !page.includes('/spiel/teilnahmebedingungen') &&
        !page.includes('/crew/'),
    }),
    mdx(),
  ],
});
