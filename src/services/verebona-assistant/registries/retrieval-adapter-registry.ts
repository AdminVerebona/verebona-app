/**
 * Registre des adaptateurs de retrieval — CDC §13 / §25.6.
 *
 * Permet d'ajouter des niveaux de recherche (structuré, plein texte, sémantique)
 * sans switch dispersé. La recherche SÉMANTIQUE est FACULTATIVE en V1 (§13.6) et
 * reste désactivée derrière le flag `verebona_assistant_semantic_retrieval`.
 */
import type { RetrievedSource } from '../types/sources';

export interface RetrievalQuery {
  accountId: number;
  normalizedQuery: string;
  intent: string;
  entityFilters: Record<string, string | number | null>;
  limit: number;
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
  return _adapters.filter((a) => a.enabled);
}
export function clearAdapters(): void {
  _adapters.length = 0;
}
