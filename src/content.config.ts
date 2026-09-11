import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'zod';

// ─── shared schema fragments ─────────────────────────────────────────────

const ctaSchema = z.object({
  label: z.string(),
  href: z.string(),
  style: z.enum(['primary', 'secondary']).default('primary'),
});

const headlineFragment = z.union([
  z.string(),
  z.object({ text: z.string(), accent: z.boolean().optional() }),
]);

const bgColorEnum = z.enum(['orange', 'pink', 'green', 'yellow', 'navy', 'cream']);

// ─── singletons ──────────────────────────────────────────────────────────

const home = defineCollection({
  loader: glob({ pattern: 'home.md', base: './src/content' }),
  schema: z.object({
    hero: z.object({
      eyebrow: z.string(),
      headline_lines: z.array(headlineFragment),
      lead: z.string(),
      location_line: z.string(),
      ctas: z.array(ctaSchema),
      image: z.string().optional(),
    }),
    stats: z.array(z.object({
      value: z.string(),
      label: z.string(),
    })),
    newsletter: z.object({
      headline: z.string(),
      lead: z.string(),
    }),
  }),
});

// Karte: Default-Modus "anker" zeigt drei datierte Preisanker; "kompakt" zeigt
// die fünf stabilen Gerichte mit Preis (F12). Kids ohne Preise bis F14.
const karte = defineCollection({
  loader: glob({ pattern: 'karte.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    headline_accent: z.string().optional(),
    stand: z.string(),
    mode: z.enum(['anker', 'kompakt']).default('anker'),
    anker: z.array(z.object({
      label: z.string(),
      price_from: z.string(),
    })),
    items: z.array(z.object({
      name: z.string(),
      desc: z.string(),
      price: z.string(),
      tags: z.array(z.string()).default([]),
    })),
    kids: z.object({
      intro: z.string(),
      items: z.array(z.object({
        name: z.string(),
        desc: z.string(),
        price: z.string().optional(),
      })),
    }),
    drinks: z.string(),
    vegan_note: z.string(),
    allergen_note: z.string(),
    instagram_note: z.string(),
    instagram_url: z.string(),
  }),
});

const catering = defineCollection({
  loader: glob({ pattern: 'catering.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    intro: z.string(),
    threshold_text: z.string(),
    features: z.array(z.string()),
    packages: z.array(z.object({
      name: z.string(),
      body: z.string(),
      recommended: z.boolean().default(false),
    })),
    references: z.array(z.object({
      text: z.string(),
    })),
    response_promise: z.string(),
    form: z.object({
      submit_endpoint: z.string(),
      pax_min: z.number().default(50),
      pax_max: z.number().default(500),
      gates: z.array(z.object({
        value: z.enum([
          'Hochzeit',
          'Firmenfeier',
          'Privat',
          'Festival',
          'Weihnachtsfeier',
          'Grünkohl',
          'Sonstiges',
        ]),
        label: z.string(),
      })),
    }),
  }),
});

const tisch = defineCollection({
  loader: glob({ pattern: 'tisch.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    intro: z.string(),
    features: z.array(z.string()),
    form: z.object({
      submit_endpoint: z.string(),
      pax_min: z.number().default(1),
      pax_max: z.number().default(12),
      booking_weeks: z.number().int().default(8),
      default_time: z.string().default('12:30'),
      zones: z.array(z.object({
        value: z.string(),
        label: z.string(),
      })),
      occasions: z.array(z.string()).default([]),
    }),
  }),
});

// Winter: Weihnachtsfeiern und Grünkohl als Teaser mit Anfrage über das
// Catering-Formular (cta_anlass = vorgewählter Anlass). Keine Preise, keine Termine (F26–F28).
const winter = defineCollection({
  loader: glob({ pattern: 'winter.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    headline_accent: z.string().optional(),
    intro: z.string(),
    cards: z.array(z.object({
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).default([]),
      cta_label: z.string(),
      cta_anlass: z.string(),
    })),
    note: z.string(),
    cta_label: z.string(),
    cta_href: z.string(),
  }),
});

// Spiel: contest_live false = spielbar, lokaler Bestwert, Wochenwertung angekündigt;
// true = Formular, Rangliste und Gewinnablauf sichtbar (F33).
const spiel = defineCollection({
  loader: glob({ pattern: 'spiel.md', base: './src/content' }),
  schema: z.object({
    name: z.string().default('Pommespilot'),
    contest_live: z.boolean().default(false),
    prize_label: z.string(),
    prize_cap_eur: z.number(),
    redeem_location: z.string(),
    min_age: z.number().int(),
    valid_days: z.number().int(),
    teaser_eyebrow: z.string(),
    teaser_headline: z.string(),
    teaser_body: z.string(),
    teaser_cta: z.string(),
  }),
});

const kinder = defineCollection({
  loader: glob({ pattern: 'kinder.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    headline_accent: z.string().optional(),
    intro: z.string(),
  }),
});

const pantry = defineCollection({
  loader: glob({ pattern: 'pantry.md', base: './src/content' }),
  schema: z.object({
    status: z.enum(['in-development', 'live', 'paused']).default('in-development'),
    launch_target: z.string(),
    headline: z.string(),
    sub: z.string().optional(),
    lead: z.string(),
  }),
});

const story = defineCollection({
  loader: glob({ pattern: 'story.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string().optional(),
    headline: z.string(),
    headline_accent: z.string().optional(),
    lead: z.array(z.string()).default([]),
    closer: z.string().optional(),
    hero_image: z.string().optional(),
    hero_caption: z.string().optional(),
    timeline: z.array(z.object({
      year: z.string(),
      title: z.string(),
      body: z.string(),
      future: z.boolean().optional(),
    })),
  }),
});

// ─── multi-entry collections ────────────────────────────────────────────

// Cutouts: KEIN Collection-Schema. PNGs liegen als statische Assets in
// public/cutouts/. Mascot-Positionen werden explizit pro Sektion in der
// <FloatingMascot>-Komponente platziert — kuratiertes Sprinkling, kein
// Daten-Driven-Grid. Begründung: Joschka 2026-05-15 — "Wall of Fries"
// verworfen, Cutouts sollen zwischen Texten/Informationen statisch aufploppen.
// Siehe Spec §4.7.1.

const standorte = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/standorte' }),
  schema: z.object({
    gate: z.string(),
    gate_subtitle: z.string().optional(),
    name: z.string(),
    slug: z.string(),
    address: z.string().optional(),
    geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
    opening: z.object({
      days: z.string(),
      hours: z.string(),
      season: z.string().optional(),
    }).optional(),
    hours_line: z.string().optional(),
    access_line: z.string().optional(),
    route_url: z.string().optional(),
    phone: z.string().optional(),
    photo: z.string().optional(),
    photo_alt: z.string().optional(),
    description: z.string(),
    image: z.string().optional(),
    modes: z.array(z.string()).default([]),
    status: z.enum(['open', 'seasonal', 'coming-soon', 'closed']).default('open'),
    order: z.number().int().default(99),
  }),
});

const crew = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/crew' }),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    bio: z.string(),
    quote: z.string().optional(),
    image: z.string().optional(),
    order: z.number().int().default(99),
  }),
});

const pantrySkus = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pantry-skus' }),
  schema: z.object({
    number: z.string(),
    name: z.string(),
    nickname: z.string().optional(),
    desc_short: z.string(),
    desc_long: z.string(),
    color: bgColorEnum.default('yellow'),
    order: z.number().int().default(99),
  }),
});

export const collections = {
  home,
  karte,
  catering,
  tisch,
  winter,
  spiel,
  kinder,
  pantry,
  story,
  standorte,
  crew,
  'pantry-skus': pantrySkus,
};
