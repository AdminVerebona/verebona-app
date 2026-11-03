/**
 * Bouton « Retour » vers le niveau PARENT d'une sous-page — lot 107B (recette
 * iOS du 02/11/2026 : Mon compte › Notifications n'offrait aucun retour, la
 * barre basse ne mène pas aux réglages du compte, et le fil d'Ariane n'est
 * affiché qu'à partir de la tablette).
 *
 * Composant STANDARD de retour des sous-pages connectées :
 *  - destination déterministe (un lien `href` fixe, jamais `history.back()`) :
 *    fonctionne en accès direct, après rechargement, depuis un lien profond
 *    (e-mail, notification) et avec le bouton « retour » système d'Android
 *    (qui garde son propre comportement d'historique) ;
 *  - placé en tête de page, AVANT le titre, visible sur mobile ET ordinateur ;
 *  - cible tactile 44 × 44 px minimum, chevron décoratif masqué aux lecteurs
 *    d'écran, nom accessible explicite (« Retour à Mon compte ») ;
 *  - jetons de la charte Sérénité uniquement (aucune couleur brute) ; anneau
 *    de focus : règle globale (globals.css).
 */
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

/** Destinations parentes connues (une seule source pour les sous-pages). */
export const PARENT_DESTINATIONS = {
  monCompte: { href: '/mon-compte', label: 'Mon compte' },
} as const;

export type ParentDestination = keyof typeof PARENT_DESTINATIONS;

/** Classes de la cible : 44 × 44 px minimum, jetons du thème. */
export const PARENT_BACK_LINK_CLASS =
  'inline-flex min-h-11 min-w-11 items-center gap-1 rounded-[12px] -ml-2 pl-1 pr-3 text-sm font-semibold text-[color:var(--accent)] transition-colors duration-[180ms] hover:bg-[color:var(--accent-soft)]';

export function ParentBackLink({ to, className }: { to: ParentDestination; className?: string }) {
  const { href, label } = PARENT_DESTINATIONS[to];
  return (
    <nav aria-label="Navigation de retour" className={className}>
      <Link
        href={href}
        data-testid="parent-back-link"
        aria-label={`Retour à ${label}`}
        className={PARENT_BACK_LINK_CLASS}
      >
        <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden />
        <span>{label}</span>
      </Link>
    </nav>
  );
}
