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

const catering = defineCollection({
  loader: glob({ pattern: 'catering.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    intro: z.string(),
    features: z.array(z.string()),
    form: z.object({
      submit_endpoint: z.string(),
      pax_min: z.number().default(50),
      pax_max: z.number().default(500),
      gates: z.array(z.object({
        value: z.string(),
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
      zones: z.array(z.object({
        value: z.string(),
        label: z.string(),
      })),
      occasions: z.array(z.string()).default([]),
    }),
  }),
});

const dusk = defineCollection({
  loader: glob({ pattern: 'dusk.md', base: './src/content' }),
  schema: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    headline_accent: z.string().optional(),
    clock_pill: z.string(),
    intro: z.string(),
    honesty_note: z.string(),
    honesty_cta_label: z.string().default('Newsletter abonnieren →'),
    honesty_cta_href: z.string().default('#newsletter'),
    tonight: z.object({
      label: z.string(),
      headline: z.string(),
      sub: z.string(),
      cta_label: z.string().optional(),
      cta_href: z.string().optional(),
    }).optional(),
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
    status: z.enum(['coming-soon', 'live', 'paused']).default('coming-soon'),
    launch_target: z.string(),
    headline: z.string(),
    sub: z.string().optional(),
    lead: z.string(),
    waitlist_endpoint: z.string().optional(),
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

const liveNotes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/live-notes' }),
  schema: z.object({
    title: z.string(),
    tag: z.string(),
    category: z.enum(['hot', 'fresh', 'event', 'normal']).default('normal'),
    body: z.string(),
    stamps: z.array(z.string()).default([]),
    publish_at: z.coerce.date(),
    expires_at: z.coerce.date(),
    draft: z.boolean().default(false),
    order: z.number().int().min(1).max(4).default(1),
  }),
});

// Cutouts: KEIN Collection-Schema. PNGs liegen als statische Assets in
// public/cutouts/. Mascot-Positionen werden explizit pro Sektion in der
// <FloatingMascot>-Komponente platziert — kuratiertes Sprinkling, kein
// Daten-Driven-Grid. Begründung: Joschka 2026-05-15 — "Wall of Fries"
// verworfen, Cutouts sollen zwischen Texten/Informationen aufploppen
// und bei Mauszeiger-Annäherung wegflappern. Siehe Spec §4.7.1.

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

const duskPrograms = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/dusk-programs' }),
  schema: z.object({
    num: z.string(),
    slug: z.string(),
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()).default([]),
    status: z.enum(['live', 'soon']).default('soon'),
    order: z.number().int().default(99),
  }),
});

const kinderPakete = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/kinder-pakete' }),
  schema: z.object({
    slug: z.string(),
    crew_name: z.string(),
    crew_size: z.string(),
    age_range: z.string().optional(),
    duration: z.string().optional(),
    location: z.string().optional(),
    price_from_eur: z.number(),
    price_label: z.string().default('Gesamt-Paket'),
    badge: z.string().optional(),
    cta_label: z.string().optional(),
    image: z.string().optional(),
    featured: z.boolean().default(false),
    includes: z.array(z.string()).default([]),
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
  catering,
  tisch,
  dusk,
  kinder,
  pantry,
  story,
  'live-notes': liveNotes,
  standorte,
  crew,
  'dusk-programs': duskPrograms,
  'kinder-pakete': kinderPakete,
  'pantry-skus': pantrySkus,
};
