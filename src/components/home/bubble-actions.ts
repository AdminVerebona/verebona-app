/**
 * Lot 68 — commandes d'un bloc de sujet de la bulle (« Voir », « C’est
 * fait », « Rappels »). Jetons de la charte « Sérénité » uniquement ; même
 * rendu desktop et mobile, zones tactiles de 44 px sur mobile (36 px sur
 * ordinateur). Focus clavier : règle globale de la charte (lot 66).
 */
const BASE = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors duration-150 '
  + 'md:min-h-[36px]';

/** Action principale du sujet (« Voir » : accès au détail). */
export const BLOCK_ACTION_PRIMARY = `${BASE} border border-[color:var(--bubble-edge)] bg-[color:var(--bg-card)] text-[color:var(--accent)] hover:border-[color:var(--accent)]`;

/** Commande secondaire (« Rappels ») : discrète, même hauteur. */
export const BLOCK_ACTION_SECONDARY = `${BASE} text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--accent)] data-[state=open]:bg-[color:var(--accent-soft)] data-[state=open]:text-[color:var(--accent)]`;
