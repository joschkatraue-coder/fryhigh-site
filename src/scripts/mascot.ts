// Floating Mascot — viewport-fixed Cutouts.
// Mascots haben position:fixed → bleiben am Viewport-Anker beim Scrollen.
// Sichtbarkeit über parent .has-mascot Sektion (IntersectionObserver).
// Puck-Mechanik: Maus schubst Cutout, akkumulierter Offset, Viewport-Clamp.

const mascots = () => document.querySelectorAll<HTMLElement>('[data-mascot]');
const mascotSections = () => document.querySelectorAll<HTMLElement>('.has-mascot');

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasFinePointer = matchMedia('(pointer: fine)').matches;

// 1. Section-Visibility: parent .has-mascot in view → mascots .in-view.
const sectionRevealer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const visible = entry.isIntersecting;
      entry.target.querySelectorAll<HTMLElement>('[data-mascot]').forEach((m) => {
        m.classList.toggle('in-view', visible);
      });
    }
  },
  { threshold: 0.08, rootMargin: '0px 0px -4% 0px' },
);
mascotSections().forEach((s) => sectionRevealer.observe(s));

// 2. Puck-Mechanik: Maus schiebt Mascot weg, Position bleibt.
if (hasFinePointer && !reduceMotion) {
  const RADIUS = 180;          // px, Schub-Aktivierungs-Radius
  const IMPULSE_MAX = 7;       // px pro mousemove-tick (in Maus-Nähe)
  const SLIP_BACK = 0.012;     // px pro Frame Richtung Origin (sehr langsamer Drift)
  const ROTATE_MAX = 22;       // deg, max zusätzliche Rotation
  const ROTATE_DAMP = 0.92;    // Rotation-Damping pro Frame
  const CLAMP_PAD = 24;        // px Abstand zum Viewport-Rand beim Clampen

  type State = { x: number; y: number; rot: number };
  const state = new WeakMap<HTMLElement, State>();
  const getState = (el: HTMLElement): State => {
    let s = state.get(el);
    if (!s) {
      s = { x: 0, y: 0, rot: 0 };
      state.set(el, s);
    }
    return s;
  };

  let lastX = -9999;
  let lastY = -9999;
  let raf = 0;

  const tick = () => {
    raf = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let needsAnother = false;

    for (const m of mascots()) {
      const rect = m.getBoundingClientRect();
      if (rect.bottom < -100 || rect.top > vh + 100) continue;

      const s = getState(m);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = cx - lastX;
      const dy = cy - lastY;
      const dist = Math.hypot(dx, dy);

      // Schub anwenden wenn Maus nah genug
      if (dist < RADIUS && dist > 0.001) {
        const t = 1 - dist / RADIUS;
        const impulse = IMPULSE_MAX * t * t;
        const nx = dx / dist;
        const ny = dy / dist;
        s.x += nx * impulse;
        s.y += ny * impulse;
        s.rot += (dx > 0 ? -1 : 1) * impulse * 0.6;
        needsAnother = true;
      } else {
        // Sehr langsamer Drift zurück, nur damit es nicht ewig am Rand klebt
        if (Math.abs(s.x) > 0.5 || Math.abs(s.y) > 0.5) {
          s.x *= 1 - SLIP_BACK;
          s.y *= 1 - SLIP_BACK;
          needsAnother = true;
        } else {
          s.x = 0; s.y = 0;
        }
      }

      // Rotation immer dämpfen
      s.rot *= ROTATE_DAMP;
      if (Math.abs(s.rot) > ROTATE_MAX) s.rot = Math.sign(s.rot) * ROTATE_MAX;
      if (Math.abs(s.rot) < 0.05) s.rot = 0;

      // Viewport-Clamp — Mascot darf nicht durch den Bildschirmrand fliegen
      const maxLeft  = -(rect.left - CLAMP_PAD);
      const maxRight =  (vw - rect.right - CLAMP_PAD);
      const maxUp    = -(rect.top - CLAMP_PAD);
      const maxDown  =  (vh - rect.bottom - CLAMP_PAD);
      // rect ist bereits inkl. aktueller Translation → die Grenzen sind relativ zum aktuellen Offset
      const clampedX = Math.max(s.x + maxLeft, Math.min(s.x + maxRight, s.x));
      const clampedY = Math.max(s.y + maxUp,   Math.min(s.y + maxDown,  s.y));
      s.x = clampedX;
      s.y = clampedY;

      m.style.setProperty('--evasion-x', `${s.x}px`);
      m.style.setProperty('--evasion-y', `${s.y}px`);
      m.style.setProperty('--evasion-rotate', `${s.rot}deg`);
      m.classList.toggle('fleeing', dist < RADIUS || Math.abs(s.x) > 0.5 || Math.abs(s.y) > 0.5);
    }

    if (needsAnother) raf = requestAnimationFrame(tick);
  };

  const schedule = () => { if (!raf) raf = requestAnimationFrame(tick); };

  window.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    schedule();
  }, { passive: true });

  // Scroll/Resize feuern KEINEN tick — sonst rutschen Mascots beim Scrollen
  // mit stale Maus-Koords ungewollt. Bei der nächsten echten Mausbewegung
  // läuft die Puck-Logik wieder normal.
  const invalidate = () => { lastX = -9999; lastY = -9999; };
  window.addEventListener('scroll', invalidate, { passive: true });
  window.addEventListener('resize', invalidate);
}

// 3. Nachträgliche Sektionen (View Transitions etc.) registrieren.
const mo = new MutationObserver(() => {
  mascotSections().forEach((s) => {
    if (!(s as HTMLElement & { __mascotSection?: boolean }).__mascotSection) {
      (s as HTMLElement & { __mascotSection?: boolean }).__mascotSection = true;
      sectionRevealer.observe(s);
    }
  });
});
mo.observe(document.body, { childList: true, subtree: true });
