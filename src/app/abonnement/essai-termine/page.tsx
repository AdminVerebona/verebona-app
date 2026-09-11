/**
 * `/abonnement/essai-termine` — redirection vers `/mon-compte/offres`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX PAGES POUR LE MÊME CHOIX
 *
 * Cet écran présentait les mêmes offres que `/mon-compte/offres`, avec sa
 * propre grille tarifaire et son propre appel à Stripe. Les deux avaient déjà
 * divergé :
 *
 *   · `/mon-compte/offres` gère le code de parrainage et la programmation
 *     d'un changement d'offre ; cette page-ci ne les connaissait pas ;
 *   · les listes de fonctionnalités étaient maintenues séparément, et
 *     ajouter une offre imposait deux modifications.
 *
 * Le contenu propre à l'essai terminé — titre et trois rassurances — a été
 * repris dans `/mon-compte/offres`, où il s'affiche quand l'essai est
 * effectivement expiré.
 *
 * ── POURQUOI UNE REDIRECTION PLUTÔT QU'UNE SUPPRESSION ────────────────────
 *
 * L'URL a circulé : bandeau de l'application, onglets ouverts, favoris.
 * Supprimer la page répondrait 404 à des gens qui viennent précisément payer.
 *
 * `permanentRedirect` rend un 308 : navigateurs et moteurs retiennent que
 * l'adresse a changé pour de bon, là où un 307 les ferait repasser ici
 * indéfiniment.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { permanentRedirect } from 'next/navigation';

export default function EssaiTerminePage() {
  permanentRedirect('/mon-compte/offres');
}
