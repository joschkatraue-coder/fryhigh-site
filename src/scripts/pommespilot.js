// Pommespilot · Engine (Variante „Sammelflug“).
// Reines JS-Modul ohne DOM: createState(cfg) baut den Zustand, step(state, dtFrames, input)
// mutiert ihn (Physik, Spawn, Kollision, Punkte, Kreations-Sets, Schwierigkeit).
// Rendering, Sound und Netz liegen in src/components/PilotFlightGame.astro.
// Einheiten: logische Pixel bei Höhe 540; dt ist in Frames bei 60 Hz (1 = ein Frame).
//
// Balancing-Anker (siehe 50_threads/2026-09-11_fry-high-website-launch/spiel-sim/ergebnis.md):
// Punkte Zutat 10, überflogene Möwe 1, Set 50; Tempo steigt bis Score 300; Möwen-Dichte steigt,
// Zutaten-Dichte bleibt pro Strecke konstant; Spawn prüft immer einen freien Ausweichweg.

export const H = 540;
export const W_DEFAULT = 960;
export const W_MIN = 360;
export const CEIL_Y = 58;    // Unterkante Wolkendecke
export const WATER_Y = 476;  // Wasserlinie
export const GLYPH = 36;     // Durchmesser Zutaten-Badge (≥ 28 px, lesbar auf Telefon)
export const PLAYER_HIT = { w: 58, h: 24 };
export const GULL_SIZE = { w: 52, h: 20 };
export const BLOB_R = 12;
export const POINTS = { ingredient: 10, gull: 1, set: 50 };
export const SPEED = { base: 3.2, max: 5.6, rampScore: 300 };
export const GRAVITY = 0.4;
export const JUMP_V = -7.0;
export const MAX_FALL = 11;
export const CRASH_FRAMES = 48;
export const MIN_GAP = 150;  // kleinster garantierter Ausweichweg (vertikal, px)
export const DT_CAP = 2.5;

export const COLORS = {
  navy: '#1A2A4E',
  navyDeep: '#0E1825',
  cream: '#F5F0E1',
  creamWarm: '#EFE7D2',
  orange: '#E94F0E',
  orangeDeep: '#A53408',
  pink: '#E4326D',
  green: '#1B7E4B',
  yellow: '#F5C518',
};

export const CREATIONS = [
  { id: 'walross', name: 'Walross Fries Mexico', origin: 'Mexiko' },
  { id: 'koefte', name: 'Köfte Feta', origin: 'Türkei' },
  { id: 'karaage', name: 'Karaage Panko', origin: 'Japan' },
  { id: 'seehund', name: 'Seehund Fries Garnelen', origin: 'Nordsee' },
  { id: 'nordsee', name: 'Nordsee Fries Grünkohl', origin: 'Norddeutsch' },
  { id: 'eisbaer', name: 'Eisbär Fries Chili Cheese', origin: 'USA' },
];

// slot = Position innerhalb der Kreation (0..2); shape/color steuern die Canvas-Glyphe.
export const INGREDIENTS = [
  { id: 'jalapeno', label: 'Jalapeño', tag: 'JA', creation: 0, slot: 0, shape: 'chili', color: 'green' },
  { id: 'mais', label: 'Mais', tag: 'MA', creation: 0, slot: 1, shape: 'corn', color: 'yellow' },
  { id: 'nacho', label: 'Nacho', tag: 'NA', creation: 0, slot: 2, shape: 'triangle', color: 'yellow' },
  { id: 'koefte', label: 'Köfte', tag: 'KÖ', creation: 1, slot: 0, shape: 'oval', color: 'orangeDeep' },
  { id: 'feta', label: 'Feta', tag: 'FE', creation: 1, slot: 1, shape: 'cube', color: 'cream' },
  { id: 'granatapfel', label: 'Granatapfel', tag: 'GR', creation: 1, slot: 2, shape: 'seeds', color: 'pink' },
  { id: 'karaage', label: 'Karaage', tag: 'KA', creation: 2, slot: 0, shape: 'blob', color: 'orange' },
  { id: 'sesam', label: 'Sesam', tag: 'SE', creation: 2, slot: 1, shape: 'dots', color: 'creamWarm' },
  { id: 'lauch', label: 'Lauch', tag: 'LA', creation: 2, slot: 2, shape: 'ring', color: 'green' },
  { id: 'garnele', label: 'Garnele', tag: 'GA', creation: 3, slot: 0, shape: 'crescent', color: 'pink' },
  { id: 'dill', label: 'Dill', tag: 'DI', creation: 3, slot: 1, shape: 'leaf', color: 'green' },
  { id: 'zitrone', label: 'Zitrone', tag: 'ZI', creation: 3, slot: 2, shape: 'wedge', color: 'yellow' },
  { id: 'gruenkohl', label: 'Grünkohl', tag: 'GK', creation: 4, slot: 0, shape: 'leaf', color: 'green' },
  { id: 'pinkel', label: 'Pinkel', tag: 'PI', creation: 4, slot: 1, shape: 'sausage', color: 'orangeDeep' },
  { id: 'senf', label: 'Senf', tag: 'SF', creation: 4, slot: 2, shape: 'drop', color: 'yellow' },
  { id: 'kaesesauce', label: 'Käsesauce', tag: 'KS', creation: 5, slot: 0, shape: 'drop', color: 'yellow' },
  { id: 'chili', label: 'Chili', tag: 'CH', creation: 5, slot: 1, shape: 'chili', color: 'orange' },
  { id: 'roestzwiebel', label: 'Röstzwiebel', tag: 'RZ', creation: 5, slot: 2, shape: 'ring', color: 'creamWarm' },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function initFields(state) {
  state.phase = 'idle';
  state.frames = 0;
  state.score = 0;
  state.speed = SPEED.base;
  state.difficulty = 0;
  state.player = { x: Math.min(180, Math.round(state.w * 0.28)), y: H / 2, vy: 0, angle: 0 };
  state.gulls = [];
  state.blobs = [];
  state.ingredients = [];
  state.sets = CREATIONS.map(() => [false, false, false]);
  state.activeCreation = -1;
  state.setsDone = 0;
  state.collected = 0;
  state.gullsPassed = 0;
  state.lastIngredient = -1;
  state.dist = { gull: 0, ing: 0, blob: 0 };
  state.next = { gull: 380, ing: 220, blob: 900 };
  state.crashFrames = 0;
  state.crashAt = null;
  state.events = [];
  state.stats = { gulls: 0, ingredients: 0, blobs: 0, removed: 0 };
  return state;
}

/**
 * @param {{ width?: number, random?: () => number }} [cfg]
 */
export function createState(cfg = {}) {
  const state = {
    w: Math.round(clamp(cfg.width ?? W_DEFAULT, W_MIN, W_DEFAULT)),
    h: H,
    random: typeof cfg.random === 'function' ? cfg.random : Math.random,
  };
  return initFields(state);
}

/** Setzt alles außer Breite und Zufall zurück (neue Runde). */
export function reset(state) {
  return initFields(state);
}

/** Startet eine Runde aus 'idle' oder 'over'. */
export function startRun(state) {
  if (state.phase === 'playing' || state.phase === 'crashing') return state;
  initFields(state);
  state.phase = 'playing';
  state.player.vy = JUMP_V * 0.6; // erster Frame: leichter Auftrieb, kein Sofort-Absturz
  return state;
}

function pushEvent(state, ev) {
  state.events.push(ev);
  if (state.events.length > 64) state.events.splice(0, state.events.length - 64);
}

function rand(state, lo, hi) {
  return lo + state.random() * (hi - lo);
}

function updateDifficulty(state) {
  const d = clamp(state.score / SPEED.rampScore, 0, 1);
  state.difficulty = d;
  state.speed = SPEED.base + (SPEED.max - SPEED.base) * d;
}

function twoGullChance(state) {
  if (state.score < 80) return 0;
  return Math.min(0.55, (state.score - 80) / 400);
}

function moveWorld(state, dt) {
  const dx = state.speed * dt;
  const p = state.player;
  for (const g of state.gulls) {
    g.x -= dx;
    g.phase += 0.22 * dt;
    g.y = g.baseY + Math.sin(g.phase * 0.5) * g.bob;
    if (!g.passed && state.phase === 'playing' && g.x + GULL_SIZE.w / 2 < p.x - PLAYER_HIT.w / 2) {
      g.passed = true;
      state.score += POINTS.gull;
      state.gullsPassed += 1;
      pushEvent(state, { type: 'gull', x: g.x, y: g.y, points: POINTS.gull });
    }
  }
  for (const b of state.blobs) {
    b.x -= dx;
    b.y += b.vy * dt;
    b.wobble += 0.15 * dt;
  }
  for (const i of state.ingredients) {
    i.x -= dx;
    i.spin += 0.05 * dt;
  }
  const before = state.gulls.length + state.blobs.length + state.ingredients.length;
  state.gulls = state.gulls.filter((g) => g.x > -80);
  state.blobs = state.blobs.filter((b) => {
    if (b.y - BLOB_R > WATER_Y) {
      pushEvent(state, { type: 'plop', x: b.x, y: WATER_Y });
      return false;
    }
    return b.x > -80;
  });
  state.ingredients = state.ingredients.filter((i) => i.x > -80);
  state.stats.removed += before - (state.gulls.length + state.blobs.length + state.ingredients.length);
}

function nearColumn(list, x, span) {
  return list.some((e) => Math.abs(e.x - x) < span);
}

// Möwen-Spalte: 1 oder 2 Möwen; bei 2 muss der größte freie Korridor ≥ MIN_GAP bleiben.
function spawnGulls(state) {
  const x = state.w + 60;
  if (nearColumn(state.blobs, x, 110)) return; // Klecks in der Spalte: Spalte auslassen
  const lo = CEIL_Y + 50;
  const hi = WATER_Y - 50;
  const half = GULL_SIZE.h / 2;
  let ys = null;
  if (state.random() < twoGullChance(state)) {
    for (let t = 0; t < 12 && !ys; t++) {
      const a = rand(state, lo, hi);
      const b = rand(state, lo, hi);
      const y1 = Math.min(a, b);
      const y2 = Math.max(a, b);
      if (y2 - y1 < 90) continue;
      const gaps = [y1 - half - CEIL_Y, y2 - y1 - GULL_SIZE.h, WATER_Y - (y2 + half)];
      if (Math.max(...gaps) >= MIN_GAP) ys = [y1, y2];
    }
  }
  if (!ys) ys = [rand(state, lo, hi)];
  for (const y of ys) {
    state.gulls.push({ x, y, baseY: y, bob: rand(state, 4, 10), phase: rand(state, 0, 6.28), passed: false });
    state.stats.gulls += 1;
  }
}

function spawnBlob(state) {
  const x = state.w + rand(state, 40, 160);
  if (nearColumn(state.gulls, x, 110)) return; // keine Wand aus Möwe plus Klecks
  state.blobs.push({ x, y: CEIL_Y - 10, vy: rand(state, 1.1, 2.0), wobble: rand(state, 0, 6.28) });
  state.stats.blobs += 1;
}

function pickIngredient(state) {
  // Sammeln soll sich lohnen: mit 65 % eine fehlende Zutat der Kreation mit dem meisten Fortschritt.
  let best = -1;
  let bestCount = 0;
  for (let c = 0; c < CREATIONS.length; c++) {
    const count = state.sets[c].filter(Boolean).length;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  let candidates;
  if (best >= 0 && state.random() < 0.65) {
    candidates = INGREDIENTS.map((ing, idx) => ({ ing, idx })).filter(
      ({ ing }) => ing.creation === best && !state.sets[best][ing.slot],
    );
  } else {
    candidates = INGREDIENTS.map((ing, idx) => ({ ing, idx })).filter(
      ({ ing }) => !state.sets[ing.creation][ing.slot],
    );
  }
  if (candidates.length > 1) candidates = candidates.filter(({ idx }) => idx !== state.lastIngredient);
  const pick = candidates[Math.floor(state.random() * candidates.length)];
  return pick ? pick.idx : Math.floor(state.random() * INGREDIENTS.length);
}

function spawnIngredient(state) {
  const x = state.w + 50;
  const lo = CEIL_Y + 45;
  const hi = WATER_Y - 45;
  let y = rand(state, lo, hi);
  for (let t = 0; t < 10; t++) {
    const blocked = state.gulls.some((g) => Math.abs(g.x - x) < 100 && Math.abs(g.baseY - y) < 80);
    if (!blocked) break;
    y = rand(state, lo, hi);
  }
  const kind = pickIngredient(state);
  state.lastIngredient = kind;
  state.ingredients.push({ x, y, kind, spin: rand(state, 0, 6.28) });
  state.stats.ingredients += 1;
}

function spawn(state, dt) {
  const dx = state.speed * dt;
  const d = state.difficulty;
  state.dist.gull += dx;
  state.dist.ing += dx;
  state.dist.blob += dx;
  if (state.dist.gull >= state.next.gull) {
    state.dist.gull = 0;
    spawnGulls(state);
    state.next.gull = 440 - 160 * d + rand(state, -50, 60);
  }
  if (state.dist.ing >= state.next.ing) {
    state.dist.ing = 0;
    spawnIngredient(state);
    state.next.ing = 320 + rand(state, -40, 40); // konstant pro Strecke
  }
  if (state.score >= 30 && state.dist.blob >= state.next.blob) {
    state.dist.blob = 0;
    spawnBlob(state);
    state.next.blob = 1100 - 400 * d + rand(state, -150, 200);
  }
}

function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;
}

function circleRect(cx, cy, r, rx, ry, rw, rh) {
  const nx = clamp(cx, rx - rw / 2, rx + rw / 2);
  const ny = clamp(cy, ry - rh / 2, ry + rh / 2);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function crash(state) {
  if (state.phase !== 'playing') return;
  const p = state.player;
  state.phase = 'crashing';
  state.crashFrames = 0;
  state.crashAt = { x: p.x, y: p.y };
  p.vy = Math.max(p.vy, -2);
  pushEvent(state, { type: 'crash', x: p.x, y: p.y, score: state.score });
}

function collide(state) {
  const p = state.player;
  const pw = PLAYER_HIT.w;
  const ph = PLAYER_HIT.h;
  for (const g of state.gulls) {
    if (rectsOverlap(p.x, p.y, pw, ph, g.x, g.y, GULL_SIZE.w * 0.85, GULL_SIZE.h)) {
      crash(state);
      return;
    }
  }
  for (const b of state.blobs) {
    if (circleRect(b.x, b.y, BLOB_R * 0.9, p.x, p.y, pw, ph)) {
      crash(state);
      return;
    }
  }
  const reach = GLYPH / 2 + 26;
  const keep = [];
  for (const i of state.ingredients) {
    const dx = i.x - p.x;
    const dy = i.y - p.y;
    if (dx * dx + dy * dy < reach * reach) {
      collect(state, i);
    } else {
      keep.push(i);
    }
  }
  state.ingredients = keep;
}

function collect(state, item) {
  const ing = INGREDIENTS[item.kind];
  state.score += POINTS.ingredient;
  state.collected += 1;
  pushEvent(state, { type: 'pickup', x: item.x, y: item.y, points: POINTS.ingredient, kind: item.kind });
  const set = state.sets[ing.creation];
  set[ing.slot] = true;
  state.activeCreation = ing.creation;
  if (set[0] && set[1] && set[2]) {
    state.score += POINTS.set;
    state.setsDone += 1;
    state.sets[ing.creation] = [false, false, false];
    pushEvent(state, {
      type: 'set',
      creation: ing.creation,
      name: CREATIONS[ing.creation].name,
      points: POINTS.set,
      x: item.x,
      y: item.y,
    });
  }
}

/**
 * Ein Simulationsschritt.
 * @param {object} state  Zustand aus createState
 * @param {number} dt     Frames bei 60 Hz (wird auf 0..DT_CAP gekappt)
 * @param {{ tap?: boolean }} [input]  tap = Flanke (einmal pro Klick/Tap/Leertaste)
 */
export function step(state, dt = 1, input = {}) {
  dt = Number.isFinite(dt) ? clamp(dt, 0, DT_CAP) : 1;
  const tap = Boolean(input && input.tap);
  if (state.phase === 'idle' || state.phase === 'over') {
    if (tap) startRun(state);
    else return state;
  }
  const p = state.player;
  if (state.phase === 'playing') {
    if (tap) {
      p.vy = JUMP_V;
      pushEvent(state, { type: 'tap', x: p.x, y: p.y });
    }
    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);
    p.y += p.vy * dt;
    p.angle = clamp(p.vy * 0.06, -0.45, 0.7);
    if (p.y - PLAYER_HIT.h / 2 < CEIL_Y || p.y + PLAYER_HIT.h / 2 > WATER_Y) crash(state);
  }
  if (state.phase === 'playing') {
    updateDifficulty(state);
    moveWorld(state, dt);
    spawn(state, dt);
    collide(state);
  } else if (state.phase === 'crashing') {
    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);
    p.y = Math.min(p.y + p.vy * dt, WATER_Y + 26);
    p.angle = Math.min(p.angle + 0.035 * dt, 1.15);
    moveWorld(state, dt * 0.35);
    state.crashFrames += dt;
    if (state.crashFrames >= CRASH_FRAMES) state.phase = 'over';
  }
  state.frames += dt;
  return state;
}

/** Leert die Ereignisliste und gibt sie zurück (Renderer, Sound, Sim). */
export function drainEvents(state) {
  const ev = state.events;
  state.events = [];
  return ev;
}

/** Fortschritt der zuletzt berührten Kreation als drei Booleans (HUD-Kreise). */
export function activeProgress(state) {
  if (state.activeCreation < 0) return [false, false, false];
  return state.sets[state.activeCreation].slice();
}

/**
 * Vorläufiger Wochenrang aus den Top 10: Zahl 1..10 oder null (außerhalb der Top 10).
 * Gleichstand: frühere Einträge liegen vor dem neuen Score (so sortiert der Worker).
 * @param {{score:number}[]} top
 * @param {number} score
 */
export function provisionalRank(top, score) {
  const list = Array.isArray(top) ? top : [];
  let rank = 1;
  for (const e of list) {
    const s = Number(e && e.score);
    if (Number.isFinite(s) && s >= score) rank += 1;
  }
  if (rank > 10) return null;
  if (list.length >= 10 && rank > list.length) return null;
  return rank;
}
