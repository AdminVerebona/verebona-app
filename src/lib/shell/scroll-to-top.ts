/**
 * « Retour en haut » — lot 34, point 8.
 *
 * Dans l'application, la page ne défile PAS sur `window` : la coquille
 * (`DashboardLayout`) fixe `h-screen overflow-hidden` et le contenu défile
 * dans `#main-scroll-container` (certaines pages ont en plus leur propre
 * conteneur). Sur iOS Safari / Capacitor, `window.scrollTo` ne fait donc
 * rien. On remonte ici TOUT élément réellement défilé, `window` compris
 * (pages publiques), sans dépendre d'une classe CSS.
 *
 * Logique pure sur des interfaces minimales : testable sans navigateur.
 */

export const MAIN_SCROLL_CONTAINER_ID = 'main-scroll-container';
/** Seuil d'apparition du bouton (px défilés). */
export const SCROLL_TOP_THRESHOLD = 300;
/** Conteneurs candidats (marqueur explicite, classes de défilement usuelles). */
export const SCROLL_CANDIDATES_SELECTOR =
  '[data-scroll-container], main, .overflow-y-auto, .overflow-auto, .overflow-y-scroll, .overflow-scroll';

export interface ScrollableLike {
  scrollTop: number;
  scrollTo?: (opts: { top: number; behavior?: 'auto' | 'smooth' }) => void;
}

export interface DocLike {
  scrollingElement: ScrollableLike | null;
  documentElement: ScrollableLike;
  getElementById(id: string): ScrollableLike | null;
  querySelectorAll(sel: string): ArrayLike<ScrollableLike>;
}

/** Éléments actuellement défilés (dédoublonnés), conteneur principal d'abord. */
export function scrolledTargets(doc: DocLike): ScrollableLike[] {
  const out: ScrollableLike[] = [];
  const add = (el: ScrollableLike | null | undefined) => {
    if (el && el.scrollTop > 0 && !out.includes(el)) out.push(el);
  };
  add(doc.getElementById(MAIN_SCROLL_CONTAINER_ID));
  add(doc.scrollingElement);
  add(doc.documentElement);
  Array.from(doc.querySelectorAll(SCROLL_CANDIDATES_SELECTOR)).forEach(add);
  return out;
}

/** Défilement le plus grand parmi les conteneurs (visibilité du bouton). */
export function maxScrollTop(doc: DocLike, windowScrollY = 0): number {
  return Math.max(windowScrollY, 0, ...scrolledTargets(doc).map((el) => el.scrollTop));
}

/**
 * Remonte chaque élément défilé. `scrollTo` lissé quand il existe ; sinon
 * (anciens WebKit) affectation directe. Mouvement réduit : saut immédiat.
 */
export function scrollAllToTop(
  doc: DocLike,
  win: { scrollTo?: (opts: { top: number; behavior?: 'auto' | 'smooth' }) => void } | null,
  smooth = true,
): number {
  const behavior = smooth ? 'smooth' : 'auto';
  const targets = scrolledTargets(doc);
  for (const el of targets) {
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior });
    else el.scrollTop = 0;
  }
  win?.scrollTo?.({ top: 0, behavior });
  return targets.length;
}
