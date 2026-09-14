/**
 * Mes documents — vue par Rubrique. CDC V2.0 §4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROISIÈME PAGE DOCUMENTAIRE, ET LA DERNIÈRE
 *
 * Le dépôt en compte déjà deux : `/documents` (979 lignes, recherche, filtres,
 * téléversement) et `/documents/classement`, livrée en V1 pour comparer le
 * regroupement par catégorie sans risquer la page principale.
 *
 * Celle-ci applique le modèle V2 — un seul niveau de regroupement, la
 * Rubrique ; « Sans rubrique » comme zone temporaire et non comme catégorie ;
 * le Type comme information et non comme sous-dossier.
 *
 * Les trois ne cohabiteront pas longtemps : le lot 4 bascule `/documents` sur
 * ce modèle et retire les deux autres. Livrer côte à côte permet de comparer
 * sur des données réelles avant d'engager ce retrait, ce qu'aucune capture ne
 * remplace.
 *
 * ── CE QU'ELLE NE REPREND PAS ─────────────────────────────────────────────
 *
 * Téléversement, suppression et recherche restent sur `/documents`. Les
 * dupliquer ici créerait deux chemins pour la même action — exactement la
 * divergence que le §4.1 cherche à supprimer. Ils seront repris à la bascule,
 * une seule fois.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DocumentsByRubric } from '@/components/documents/v2/DocumentsByRubric';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Mes documents — Verebona',
};

export default function DocumentsRubriquesPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-xl font-semibold">Mes documents</h1>
      <DocumentsByRubric />
    </main>
  );
}
