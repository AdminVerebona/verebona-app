'use client';
/**
 * Emplacement des suggestions partagées sur l'ACCUEIL — lot 110C.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE DE BASCULE (une seule, documentée)
 *
 *   · application iOS / Android (coque Capacitor, `isNativeApp`) : AUCUNE
 *     zone de suggestions sur l'accueil, quelle que soit la largeur ;
 *   · sinon, fenêtre de moins de 768 px (point de rupture `md` de la charte,
 *     celui de toute la coquille et de l'accueil : mascotte 72 px, barre du
 *     bas…) : AUCUNE zone — navigateur mobile et PWA mobile ;
 *   · sinon (ordinateur, format large, PWA installée sur ordinateur) : UNE
 *     rangée horizontale compacte d'au plus trois questions.
 *
 * Tant que l'emplacement n'est pas connu (rendu serveur), rien n'est lu et la
 * zone n'est visible qu'en CSS ≥ 768 px : aucune place réservée sur mobile.
 * La zone masquée ne déclenche AUCUNE lecture de GET /api/suggestions (le
 * magasin partagé n'est pas « actif ») ; « Demander à Verebona » (T2) garde
 * ses suggestions sur tous les supports (lecture à son ouverture).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useSyncExternalStore } from 'react';
import { isNativeApp } from '@/lib/native/bridge';

/** Largeur minimale de la rangée (= `md` de Tailwind, coquille desktop). */
export const HOME_SUGGESTIONS_MIN_WIDTH_PX = 768;
export const HOME_SUGGESTIONS_WIDE_QUERY = `(min-width: ${HOME_SUGGESTIONS_MIN_WIDTH_PX}px)`;

/** `row` : rangée affichée ; `none` : zone absente ; `unknown` : rendu serveur. */
export type HomeSuggestionsPlacement = 'row' | 'none' | 'unknown';

/** Règle pure (testée). */
export function homeSuggestionsPlacement(env: { native: boolean; wide: boolean }): Exclude<HomeSuggestionsPlacement, 'unknown'> {
  if (env.native) return 'none';
  return env.wide ? 'row' : 'none';
}

function snapshot(): HomeSuggestionsPlacement {
  if (typeof window === 'undefined') return 'unknown';
  const wide = typeof window.matchMedia === 'function'
    ? window.matchMedia(HOME_SUGGESTIONS_WIDE_QUERY).matches
    : window.innerWidth >= HOME_SUGGESTIONS_MIN_WIDTH_PX;
  return homeSuggestionsPlacement({ native: isNativeApp(), wide });
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(HOME_SUGGESTIONS_WIDE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** Emplacement suivi en direct (redimensionnement, rotation). */
export function useHomeSuggestionsPlacement(): HomeSuggestionsPlacement {
  return useSyncExternalStore(subscribe, snapshot, () => 'unknown');
}
