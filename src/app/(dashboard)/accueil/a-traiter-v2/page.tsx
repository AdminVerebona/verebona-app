/**
 * À traiter — file unique. CDC V2.0 §7 et §8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIVRÉE À CÔTÉ DE L'EXISTANT, PAS À SA PLACE
 *
 * `/accueil/a-traiter` fait 1 183 lignes et sert quatre onglets — documents,
 * agenda, équipements, fournisseurs — chacun avec ses actions propres. Le
 * remplacer avant d'avoir vu cette page fonctionner reviendrait à parier sur
 * un écran que personne n'a encore ouvert.
 *
 * Cette page est donc accessible en parallèle, à `/accueil/a-traiter-v2`, et
 * lit la file V2 alimentée par le lot 2. La bascule — redirection de l'ancien
 * chemin, retrait des onglets, reprise du compteur de navigation — relève du
 * lot 4, une fois la comparaison faite.
 *
 * ── CE QU'ELLE APPORTE ────────────────────────────────────────────────────
 *
 * Une carte = une action et non un objet (§7.1), deux natures au lieu de
 * quatre familles, trois priorités calculées par Verebona, arbitrage en un
 * clic avec annulation, et aucune section (ATP-01).
 *
 * ── CE QU'ELLE NE REPREND PAS ENCORE ──────────────────────────────────────
 *
 * Le drawer « Tri & filtres » du §8.8 et la résolution « Non applicable » dans
 * le drawer du §7.4. L'API les expose déjà ; les brancher demande le drawer
 * document V2, qui relève de la tranche suivante.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { ToProcessQueue } from '@/components/to-process/ToProcessQueue';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'À traiter — Verebona',
};

export default function AtraiterV2Page() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <ToProcessQueue />
    </main>
  );
}
