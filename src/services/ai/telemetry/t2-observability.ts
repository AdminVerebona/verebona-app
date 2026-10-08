/**
 * Trace d'observabilité T2 (CDC 15 §18, lot 17) — SANS CONTENU UTILISATEUR.
 *
 * Complète la trace de cascade (`verebona_request_runs.retrieval_methods_json`)
 * de trois informations que le tableau de bord §18 ne pouvait pas déduire :
 *
 *   · `truthSource` : la source de vérité qui a répondu (canonique, fait,
 *     tableau, document, agenda, règle d'offre…), dérivée de la stratégie ;
 *   · `sourceTypes` : le nombre de sources par TYPE (jamais leur titre,
 *     extrait ni identifiant) ;
 *   · `target` : le TYPE et l'ORIGINE de la cible principale (clarification,
 *     fil, page, indice) — jamais son libellé ni son identifiant.
 *
 * Pur, exporté pour les tests. Aucune valeur saisie par l'utilisateur, aucun
 * extrait, aucun nom n'y entre : seulement des codes issus d'énumérations
 * fermées et des compteurs.
 */

/** Source de vérité ayant produit la réponse. */
export type T2TruthSource =
  | 'canonique' | 'fait' | 'tableau' | 'document' | 'agenda' | 'export'
  | 'regle_offre' | 'centre_aide' | 'modele' | 'clarification' | 'aucune' | 'autre';

export const T2_TRUTH_SOURCES: readonly T2TruthSource[] = [
  'canonique', 'fait', 'tableau', 'document', 'agenda', 'export',
  'regle_offre', 'centre_aide', 'modele', 'clarification', 'aucune', 'autre',
];

export interface T2ObservabilityTrace {
  truthSource: T2TruthSource;
  /** Nombre de sources par type (`asset_field`, `document`…). */
  sourceTypes: Record<string, number>;
  /** Cible principale : type et origine seulement. */
  target: { type: string; origin: string } | null;
}

const PAR_STRATEGIE: Readonly<Record<string, T2TruthSource>> = {
  // Lecture canonique de l'état du bien.
  'structured.asset_field': 'canonique',
  'retrieval.canonical_field': 'canonique',
  'target.asset_field': 'canonique',
  // Lot 29 : plusieurs champs, équipement / pièce, champ non renseigné.
  'target.asset_fields': 'canonique',
  'target.entity_field': 'canonique',
  'target.entity_fields': 'canonique',
  'target.field_missing': 'canonique',
  'target.not_applicable': 'canonique',
  'target.field_document': 'fait',
  'structured.purchase_date': 'canonique',
  'structured.list_rented': 'canonique',
  'structured.list_assets': 'canonique',
  'structured.count_assets': 'canonique',
  'structured.missing_information': 'canonique',
  // Faits T1.
  'retrieval.t1_fact': 'fait',
  'structured.sum_qualified': 'fait',
  'retrieval.t1_table': 'tableau',
  // Documents.
  'retrieval.document': 'document',
  'retrieval.document_status': 'document',
  'retrieval.near': 'document',
  'retrieval.adapters': 'document',
  'structured.count_documents': 'document',
  'structured.list_documents': 'document',
  'structured.document_status': 'document',
  'structured.sum_amounts': 'document',
  'reference.document_date': 'document',
  // Agenda.
  'structured.next_deadline': 'agenda',
  'structured.deadline_of': 'agenda',
  'structured.count_agenda': 'agenda',
  'structured.upcoming_agenda': 'agenda',
  // Exports.
  'structured.exports': 'export',
};

/** Type de source → source de vérité (réponse générée sur sources). */
const PAR_TYPE_DE_SOURCE: Readonly<Record<string, T2TruthSource>> = {
  asset_field: 'canonique',
  document: 'document',
  document_extraction: 'fait',
  agenda_item: 'agenda',
  export_item: 'export',
  // Lot 33 : le Centre d'aide est une source de vérité à part entière.
  help_entry: 'centre_aide',
  product_rule: 'regle_offre',
};

/**
 * Source de vérité d'une réponse, d'après sa stratégie. Une réponse générée
 * par le modèle est rattachée au type de source majoritaire qu'il a reçu ;
 * sans source, « modele ».
 */
export function truthSourceOf(strategy: string | null | undefined, sourceTypes: Record<string, number> = {}): T2TruthSource {
  const s = strategy ?? '';
  if (PAR_STRATEGIE[s]) return PAR_STRATEGIE[s];
  if (s.startsWith('clarification.') || s === 'reference.clarification') return 'clarification';
  // Lot 33 : réponse tirée d'un article (`help.exact_article`,
  // `help.article_excerpt`, `help.contradiction`) → Centre d'aide.
  if (s.startsWith('help.')) return 'centre_aide';
  if (s.startsWith('template') || s.startsWith('flag.')) return 'regle_offre';
  if (s === 'llm' || s.startsWith('llm.')) {
    const dominant = Object.entries(sourceTypes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return (dominant && PAR_TYPE_DE_SOURCE[dominant[0]]) || 'modele';
  }
  if (s === '' || s === 'none' || s.startsWith('fallback') || s.startsWith('timeout.')
    || s === 'cancelled' || s === 'reference.unavailable' || s === 'revalidation.unconfirmed') return 'aucune';
  return 'autre';
}

/** Compte les sources par type — le type seulement. */
export function countSourceTypes(sources: ReadonlyArray<{ type?: unknown }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) {
    const t = typeof s?.type === 'string' && /^[a-z_]{1,40}$/.test(s.type) ? s.type : 'autre';
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

/**
 * Trace T2 d'une demande. `target` est la cible principale DÉJÀ résolue
 * (`targetsFromInput(...).primary`) : seuls son type et son origine sont
 * retenus.
 */
export function buildT2ObservabilityTrace(p: {
  strategy: string | null | undefined;
  sources: ReadonlyArray<{ type?: unknown }>;
  target?: { type?: unknown; origin?: unknown } | null;
}): T2ObservabilityTrace {
  const sourceTypes = countSourceTypes(p.sources);
  const code = (v: unknown): string | null => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : null);
  const type = code(p.target?.type);
  const origin = code(p.target?.origin);
  return {
    truthSource: truthSourceOf(p.strategy, sourceTypes),
    sourceTypes,
    target: type ? { type, origin: origin ?? 'inconnue' } : null,
  };
}
