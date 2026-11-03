"use client";

/**
 * Conteneur UNIQUE des messages flottants (sonner) — lot 107B, recette iOS du
 * 02/11/2026 (toast « Vous recevrez nos actualités » sous l'heure, la
 * batterie et sur le champ « Demander à Verebona »).
 *
 * Cause (lecture du code) : sonner place son conteneur `position: fixed` à
 * `top: var(--offset-top)` = 24 px (16 px sous 600 px) du HAUT DE LA VUE, sans
 * aucun encart. Or l'application s'étend volontairement sous la barre d'état
 * (`viewport-fit=cover`, `black-translucent`, WebView Capacitor iOS
 * `contentInset: 'never'`) : le haut de la vue EST la barre d'état. Le toast
 * s'y posait, puis débordait sur la barre haute mobile.
 *
 * Correctif : les décalages de sonner reprennent les jetons partagés de
 * globals.css (`--vb-toast-*`, dérivés des encarts `--vb-safe-*` et du bas de
 * l'en-tête `--vb-header-bottom`) : aucun pixel propre à un modèle, aucun
 * encart compté deux fois, mêmes règles en portrait, en paysage, après retour
 * d'arrière-plan (les encarts sont relus par le navigateur à chaque mise en
 * page) et quel que soit le défilement (conteneur fixe).
 */
import { Toaster, type ToasterProps } from 'sonner';

/** Décalages de sonner : une seule source, ordinateur et mobile identiques. */
export const TOASTER_OFFSET = {
  top: 'var(--vb-toast-top)',
  bottom: 'var(--vb-toast-bottom)',
  left: 'var(--vb-toast-inline)',
  right: 'var(--vb-toast-inline)',
} as const satisfies NonNullable<ToasterProps['offset']>;

export function AppToaster() {
  return (
    <Toaster
      closeButton
      position="top-center"
      richColors
      offset={TOASTER_OFFSET}
      mobileOffset={TOASTER_OFFSET}
    />
  );
}
