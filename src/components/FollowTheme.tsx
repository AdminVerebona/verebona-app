"use client"

import { useLayoutEffect } from 'react';
import {
  applyThemeToDocument,
  readSavedTheme,
  resolveTheme,
  systemPrefersDark,
  type AppTheme,
} from '@/lib/theme';

/**
 * Pages publiques de l'application (connexion, inscription, mot de passe,
 * vérification d'e-mail, onboarding, paiement, invitation Duo, rétractation).
 *
 * Lot 67 (décision PO du 18/10) : ces pages ne forcent plus le thème sombre
 * (ancien composant de forçage, supprimé). Elles suivent la même règle que le
 * reste de l'application : choix enregistré dans le menu, sinon préférence
 * du système — suivie en direct tant qu'aucun choix n'est enregistré.
 *
 * Le premier rendu est déjà juste : le script bloquant du layout racine
 * (`themeBootScript`, src/app/layout.tsx) pose `data-theme` avant toute
 * peinture, sur TOUTES les pages. Ce composant ne fait que (re)synchroniser
 * la classe du <body> et `theme-color`, et rétablit le thème de l'utilisateur
 * si une page précédente l'avait modifié pendant la navigation client.
 * Il n'écrit jamais dans `localStorage`.
 */
export function FollowTheme() {
  useLayoutEffect(() => {
    applyThemeToDocument(resolveTheme(readSavedTheme(), systemPrefersDark()));
    const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      if (readSavedTheme()) return;
      const next: AppTheme = e.matches ? 'blue' : 'beige';
      applyThemeToDocument(next);
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return null;
}
