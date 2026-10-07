/**
 * Libellé d'un fil de conversation.
 *
 * Le sélecteur de fils du tiroir latéral est retiré (Direction D v2 §8), et
 * la vue « Toutes les demandes » (bouton horloge) l'est aussi (lot 32,
 * point 11) : les fils se reprennent par les « Recherches récentes » du
 * pop-up (`lib/verebona/space.ts`, `recentSearches`). Ce libellé court reste
 * disponible pour les écrans qui listent les fils.
 */
import type { VerebonaThread } from '@/lib/verebona/useVerebona';

const dateCourte = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '';

export function libelleFil(t: VerebonaThread): string {
  const titre = t.title?.trim() || 'Nouvelle conversation';
  const date = dateCourte(t.lastMessageAt ?? t.createdAt);
  return date ? `${titre} · ${date}` : titre;
}
