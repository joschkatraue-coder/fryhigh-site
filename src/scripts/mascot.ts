// Floating Mascot — Cutouts am Sektionsrand (position:absolute in der .has-mascot-Sektion).
// Die Sichtbarkeit wird über die Sektion gesteuert: ist die Sektion im Viewport, bekommen
// ihre [data-mascot]-Elemente .in-view (Scroll-Awakening, CI v1 §8.1). Positionen und
// Größen stehen in der Komponente; hier passiert nur das Ein- und Ausblenden.

const mascotSections = () => document.querySelectorAll<HTMLElement>('.has-mascot');

const setInView = (section: Element, visible: boolean) => {
  section.querySelectorAll<HTMLElement>('[data-mascot]').forEach((m) => {
    m.classList.toggle('in-view', visible);
  });
};

if (!('IntersectionObserver' in window)) {
  // Kein Observer (sehr alte Browser): Mascots einfach zeigen.
  mascotSections().forEach((s) => setInView(s, true));
} else {
  // 1. Section-Visibility: parent .has-mascot in view → mascots .in-view.
  const sectionRevealer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) setInView(entry.target, entry.isIntersecting);
    },
    { threshold: 0.08, rootMargin: '0px 0px -4% 0px' },
  );

  const register = (s: HTMLElement) => {
    const el = s as HTMLElement & { __mascotSection?: boolean };
    if (el.__mascotSection) return;
    el.__mascotSection = true;
    sectionRevealer.observe(s);
  };

  mascotSections().forEach(register);

  // 2. Nachträgliche Sektionen (View Transitions etc.) registrieren.
  const mo = new MutationObserver(() => {
    mascotSections().forEach(register);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
