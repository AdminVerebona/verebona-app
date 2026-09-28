/**
 * Registre des adaptateurs de retrieval — CDC §13 / §25.6.
 *
 * Permet d'ajouter des niveaux de recherche (structuré, plein texte, sémantique)
 * sans switch dispersé. La recherche SÉMANTIQUE est FACULTATIVE en V1 (§13.6) et
 * reste désactivée derrière le flag `verebona_assistant_semantic_retrieval`.
 */
import type { RetrievedSource } from '../types/sources';
import { isAssistantFlagOn } from '../config/assistant-flags';

export interface RetrievalQuery {
  accountId: number;
  normalizedQuery: string;
  intent: string;
  entityFilters: Record<string, string | number | null>;
  limit: number;
  /**
   * Termes de la question (§11.2, §13.5) : racines, synonymes, fautes
   * tolérées. Absent ou vide : liste bornée sans critère textuel.
   */
  terms?: import('../core/query-terms').QueryTerm[];
  /**
   * Période demandée (§13.7), bornes ISO incluses : un élément daté dans la
   * période est favorisé, un élément daté hors période pénalisé. Absente :
   * aucune pondération par la date demandée.
   */
  period?: { from: string; to: string } | null;
  /**
   * Types de document demandés (§13.7), en racines normalisées
   * (« facture », « devis », « dpe »…) : bonus quand le type du document
   * les contient. Absent : aucun bonus de type.
   */
  documentTypes?: string[];
  /**
   * Recherche élargie (§11.4 « résultats proches ») : seuls les adaptateurs
   * qui savent tolérer davantage l'honorent (préfixe plus court).
   */
  tolerant?: boolean;
}

export interface RetrievalAdapter {
  code: 'structured' | 'full_text' | 'semantic';
  enabled: boolean;
  /** Retourne des candidats bornés au périmètre du compte (§13.2). */
  search(q: RetrievalQuery): Promise<RetrievedSource[]>;
}

const _adapters: RetrievalAdapter[] = [];

export function registerRetrievalAdapter(a: RetrievalAdapter): void {
  _adapters.push(a);
}
export function getEnabledAdapters(): RetrievalAdapter[] {
  // Recherche sémantique : facultative en V1 (§13.6), activée seulement par
  // le flag `verebona_assistant_semantic_retrieval` (§39) — lu à chaque appel.
  //
  // Décision produit V1 (2026-09-28) : RECHERCHE LEXICALE. Le niveau
  // sémantique de la cascade (CDC BO IA T2-008, « si utile et disponible »)
  // et la recherche sémantique du Centre d'aide (§4) ne sont pas livrés en
  // V1 : aucun adaptateur `semantic` n'est enregistré, aucun embedding n'est
  // calculé. La recherche lexicale est accélérée par les index trigrammes
  // (pg_trgm, migration 0208).
  const semantique = isAssistantFlagOn('semantic_retrieval');
  return _adapters.filter((a) => a.enabled && (a.code !== 'semantic' || semantique));
}
export function clearAdapters(): void {
  _adapters.length = 0;
}
