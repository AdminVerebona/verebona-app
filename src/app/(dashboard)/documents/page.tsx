/**
 * Mes documents — regroupement par Rubrique. CDC V2.0 §4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA V1 A ÉTÉ RETIRÉE, PAS MISE DE CÔTÉ
 *
 * Cette page comptait un millier de lignes : recherche locale, filtres
 * multiples, sélection groupée, arborescence catégorie puis type.
 *
 * Le §4.2 en supprime deux piliers. « Un seul niveau de regroupement visible :
 * la Rubrique. Le Type ne crée jamais de sous-groupe. » Et surtout : « Aucun
 * champ de recherche local. La recherche reste centralisée au niveau général
 * de Verebona. »
 *
 * ── L'ABSENCE DE RECHERCHE EST UNE EXIGENCE, PAS UN MANQUE ────────────────
 *
 * C'est le point qui sera « corrigé » de bonne foi par la première personne
 * qui comparera cette page à l'ancienne. Le critère UX-01 est explicite :
 * « Aucun champ de recherche local n'est ajouté. » Un test le verrouille
 * (`rubric-pagination.test.ts`).
 *
 * Téléversement, suppression, tri, filtres et pagination sont portés par
 * `DocumentsByRubric`, qui réutilise le dialogue d'ajout commun plutôt que
 * d'en refaire une version — le §4.1 veut des composants partagés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DocumentsByRubric } from '@/components/documents/v2/DocumentsByRubric';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Mes documents — Verebona',
};

export default function DocumentsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-xl font-semibold">Mes documents</h1>
      <DocumentsByRubric />
    </main>
  );
}
