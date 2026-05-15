// Floating Mascot — reveal-on-scroll + mouse-proximity-flutter-away.
// Globales Script, einmal pro Page geladen. Liest [data-mascot] live aus DOM,
// keine Komponenten-spezifische Logik nötig.

const mascots = () => document.querySelectorAll<HTMLElement>('[data-mascot]');

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasFinePointer = matchMedia('(pointer: fine)').matches;

// 1. Reveal: IntersectionObserver toggelt .in-view ab 12 % Sichtbarkeit.
const revealer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      entry.target.classList.toggle('in-view', entry.isIntersecting);
    }
  },
  { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
);
mascots().forEach((m) => revealer.observe(m));

// 2. Maus-Flucht: nur auf fine pointer + nicht im Reduced-Motion-Modus.
if (hasFinePointer && !reduceMotion) {
  const RADIUS = 160;        // px, Aktivierungs-Radius
  const MAX_PUSH = 64;       // px, maximale Flucht-Distanz
  const FLEE_ROTATE = 14;    // deg, zusätzliche Rotation beim Flüchten

  let frame = 0;
  let lastX = 0;
  let lastY = 0;

  const update = () => {
    frame = 0;
    const list = mascots();
    for (const m of list) {
      const rect = m.getBoundingClientRect();
      // Skip offscreen mascots — no need to compute.
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = lastX - cx;
      const dy = lastY - cy;
      const dist = Math.hypot(dx, dy);

      if (dist < RADIUS && dist > 0) {
        const t = 1 - dist / RADIUS;
        const push = MAX_PUSH * t * t;       // ease-out feel
        const angle = Math.atan2(dy, dx);
        m.style.setProperty('--evasion-x', `${-Math.cos(angle) * push}px`);
        m.style.setProperty('--evasion-y', `${-Math.sin(angle) * push}px`);
        m.style.setProperty('--evasion-rotate', `${dx > 0 ? -FLEE_ROTATE : FLEE_ROTATE}deg`);
        m.classList.add('fleeing');
      } else if (m.classList.contains('fleeing')) {
        m.style.setProperty('--evasion-x', '0px');
        m.style.setProperty('--evasion-y', '0px');
        m.style.setProperty('--evasion-rotate', '0deg');
        m.classList.remove('fleeing');
      }
    }
  };

  window.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });

  // Re-baseline on scroll/resize so positions stay accurate.
  let scrollFrame = 0;
  const scheduleScrollUpdate = () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      update();
    });
  };
  window.addEventListener('scroll', scheduleScrollUpdate, { passive: true });
  window.addEventListener('resize', scheduleScrollUpdate);
}

// 3. Mascots, die später ins DOM kommen (z.B. via View Transitions), nachregistrieren.
const mo = new MutationObserver(() => {
  mascots().forEach((m) => {
    if (!(m as HTMLElement & { __mascotObserved?: boolean }).__mascotObserved) {
      (m as HTMLElement & { __mascotObserved?: boolean }).__mascotObserved = true;
      revealer.observe(m);
    }
  });
});
mo.observe(document.body, { childList: true, subtree: true });
