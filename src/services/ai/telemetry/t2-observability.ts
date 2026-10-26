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

interface T2ObservabilityTrace {
  truthSource: T2TruthSource;
  /**
   * Lot 47A (O9, CDC Opérations V1 C26.2) : nature d'une réponse ÉCONOMIQUE
   * (coût, prix d'achat, contrats, dépenses, règlements) — absente sinon.
   */
  economicMode?: T2EconomicMode;
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
  // Lot 34 : demandes d'actions (échéances actives et « À traiter » ouverts).
  'structured.actionable': 'agenda',
  // Exports.
  'structured.exports': 'export',
  // Lot 45 (O6) : lecture « Opération d'abord » — état métier consolidé.
  'structured.operation_history': 'canonique',
  'structured.claim_status': 'canonique',
  'structured.acquisition_price': 'canonique',
  'structured.payments': 'document',
  'structured.contracts': 'canonique',
  'structured.operation_cost': 'canonique',
  // Lot 54D : coût de possession (composantes consolidées, service TCO).
  'structured.ownership_cost': 'canonique',
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

// ── Lot 47A (O9) : réponses économiques Operation-only / mixtes / fallback-only ──

/**
 * C26.2 « T2 réponses économiques Operation-only / mixtes / fallback-only » :
 *   · `operation_only` : chiffres lus sur les Opérations consolidées seules ;
 *   · `mixed`          : Opérations + documents non représentés (C15.1) ;
 *   · `fallback_only`  : documents, fiche du bien ou preuves seuls.
 * Mesure d'adoption, jamais une contrainte (aucune exclusivité imposée).
 */
type T2EconomicMode = 'operation_only' | 'mixed' | 'fallback_only';

/** Stratégies dont la réponse est économique (montants). */
const ECONOMIC_STRATEGIES = new Set([
  'structured.operation_cost', 'structured.contracts', 'structured.acquisition_price',
  'structured.sum_qualified', 'structured.sum_amounts', 'structured.payments', 'structured.ownership_cost',
]);

type SourceLike = { type?: unknown; id?: unknown; meta?: unknown };
const metaOf = (s: SourceLike): Record<string, unknown> => (s.meta && typeof s.meta === 'object' ? s.meta as Record<string, unknown> : {});
const positif = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Nature économique d'une réponse (pure) — d'après la stratégie et les
 * MÉTADONNÉES de ses sources (jamais leur contenu) :
 *   · source d'Opération : `meta.operationKind` (lot 45, `operationSource`) ;
 *   · total de dépenses (`expenses:*`) : `operationCount` (part consolidée)
 *     et `documentFallbackCents` / `documentCount` (repli documentaire).
 * `null` : réponse non économique, ou sans aucun chiffre.
 */
export function economicModeOf(strategy: string | null | undefined, sources: ReadonlyArray<SourceLike> = []): T2EconomicMode | null {
  const s = strategy ?? '';
  if (!ECONOMIC_STRATEGIES.has(s)) return null;
  let operation = s === 'structured.operation_cost' || s === 'structured.contracts' || s === 'structured.ownership_cost';
  let fallback = s === 'structured.sum_amounts';
  for (const src of sources) {
    const m = metaOf(src);
    if (typeof m.operationKind === 'string' && m.operationKind) operation = true;
    if (typeof src.id === 'string' && src.id.startsWith('expenses:')) {
      if (positif(m.operationCount)) operation = true;
      if ('documentFallbackCents' in m ? positif(m.documentFallbackCents) : (!positif(m.operationCount) && positif(m.documentCount))) fallback = true;
    } else if (s === 'structured.payments' && src.type === 'document' && !m.operationKind) {
      fallback = true;
    } else if (s === 'structured.acquisition_price' && !m.operationKind && src.type === 'asset_field') {
      fallback = true;
    }
  }
  if (operation && fallback) return 'mixed';
  if (operation) return 'operation_only';
  if (fallback) return 'fallback_only';
  return null;
}

/**
 * Trace T2 d'une demande. `target` est la cible principale DÉJÀ résolue
 * (`targetsFromInput(...).primary`) : seuls son type et son origine sont
 * retenus.
 */
export function buildT2ObservabilityTrace(p: {
  strategy: string | null | undefined;
  sources: ReadonlyArray<SourceLike>;
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
    ...(() => { const m = economicModeOf(p.strategy, p.sources); return m ? { economicMode: m } : {}; })(),
  };
}
