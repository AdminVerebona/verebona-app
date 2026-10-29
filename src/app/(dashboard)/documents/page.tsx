/**
 * Mes documents — regroupement par Rubrique. CDC V2.0 §4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA V1 A ÉTÉ RETIRÉE, PAS MISE DE CÔTÉ
 *
 * Cette page comptait un millier de lignes : recherche locale, filtres
 * multiples, sélection groupée, arborescence catégorie puis type. Le §4.2 du
 * CDC V2 en supprimait deux piliers : un seul niveau de regroupement (la
 * Rubrique) et « aucun champ de recherche local ».
 *
 * ── LOT 97C : LA RECHERCHE LOCALE REVIENT, PAR DÉCISION PO ────────────────
 *
 * Décision PO du 26/10/2026 (ticket P1 « recherche locale réactive »,
 * arbitrages Q1-B, Q2-A) : l'interdiction UX-01 est ANNULÉE. Le champ commun
 * (`components/search/LocalSearchField`) ne réintroduit pas l'ancienne
 * recherche dans le navigateur : la saisie (`?q=`) est appliquée par le
 * serveur, avec les règles de la barre de recherche, AVANT pagination et
 * compteurs. Le Type ne crée toujours pas de sous-groupe.
 *
 * Téléversement, suppression, tri, filtres, recherche et pagination sont
 * portés par `DocumentsByRubric`, partagé avec l'onglet Documents d'un bien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DocumentsByRubric } from '@/components/documents/v2/DocumentsByRubric';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Mes documents — Verebona',
};

export default function DocumentsPage() {
  // Pas de conteneur ni de titre ici : `DashboardLayout` fournit le cadre, et
  // l'en-tête (titre, décompte, commandes) appartient au composant, qui est
  // partagé avec l'onglet « Documents » d'un bien (§4.1).
  return <DocumentsByRubric />;
}
