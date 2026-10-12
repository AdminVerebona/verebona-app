/**
 * BO diagnostic des Opérations — vocabulaire, filtres et règles PURES
 * (lot 47A, O9 — CDC Opérations V1 ch. 21, B23, C21, C25, C26.1, C26.2, C27).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURE SEULE (INV-032, D28, F-182, décision PO Q9)
 *
 * Le BO explique une Opération ; il ne la répare jamais. Une anomalie se
 * corrige par une nouvelle version du code puis une reconsolidation (balayage
 * horaire T3, ou relance du travail T3 du compte depuis BO › File IA). Aucun
 * bouton, aucune route d'écriture, aucun interrupteur fonctionnel (Q8, F-196).
 *
 * Ce module ne touche pas la base : filtres d'URL bornés, libellés lisibles
 * des motifs (C26.1), définitions des 13 indicateurs (C26.2), anomalies
 * dures et masquage des données sensibles (C25 : rien au-delà de ce que le
 * BO montre déjà — pas d'IBAN, pas de nom de fichier).
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  BUSINESS_OPERATION_STATUSES, BUSINESS_OPERATION_TYPES, BUSINESS_OPERATION_TYPE_CODES, COMPONENT_SIGN,
  type BusinessOperationStatus, type BusinessOperationTypeCode, type FinancialComponentKind,
} from '../model';

// ── Pagination et filtres de la liste (C26.1) ───────────────────────────────

export const DIAG_PAGE_SIZE = 25;
export const DIAG_MAX_PAGE_SIZE = 100;
/** Période maximale d'un calcul d'indicateurs (requêtes bornées). */
export const DIAG_MAX_PERIOD_DAYS = 366;
export const DIAG_DEFAULT_PERIOD_DAYS = 30;
/** Échantillon d'identifiants rendu par anomalie dure. */
export const DIAG_ANOMALY_SAMPLE = 20;
/** Bornes des listes du détail (une Opération très sourcée reste lisible). */
export const DETAIL_LIMIT = 200;

export type OperationState = 'all' | 'active' | 'invalidated' | 'merged';
export const OPERATION_STATES: readonly OperationState[] = ['all', 'active', 'invalidated', 'merged'];

export interface OperationListFilters {
  accountId: number | null;
  /** Code de type, ou `NULL` pour « type non qualifié ». */
  type: BusinessOperationTypeCode | 'NULL' | null;
  status: BusinessOperationStatus | null;
  state: OperationState;
  /** Opérations actives sans bien actif (TARGET_UNRESOLVED dérivé, C10). */
  withoutAsset: boolean;
  /** Opérations sans source active. */
  withoutSource: boolean;
  /** Bornes de la date de CRÉATION (jour civil Europe/Paris, inclus). */
  from: string | null;
  to: string | null;
  page: number;
  pageSize: number;
}

export interface HoldListFilters {
  accountId: number | null;
  outcome: 'HOLD_UNRESOLVED' | 'ARBITRATION_REQUIRED' | null;
  /** Motif exact (`t3_reason`), ou préfixe `TECHNICAL_ERROR`. */
  reason: string | null;
  page: number;
  pageSize: number;
}

type Params = { get(name: string): string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string | null): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function positiveInt(v: string | null | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

function pageOf(p: Params): { page: number; pageSize: number } {
  const page = Math.min(10_000, positiveInt(p.get('page')) ?? 1);
  const pageSize = Math.min(DIAG_MAX_PAGE_SIZE, positiveInt(p.get('pageSize')) ?? DIAG_PAGE_SIZE);
  return { page, pageSize };
}

const truthy = (v: string | null) => v === '1' || v === 'true';

/** Filtres de la liste lus depuis l'URL — liste blanche, toute autre valeur ignorée. */
export function parseOperationListFilters(p: Params): OperationListFilters {
  const type = p.get('type');
  const status = p.get('status');
  const state = p.get('state');
  const from = p.get('from');
  const to = p.get('to');
  return {
    accountId: positiveInt(p.get('accountId')),
    type: type === 'NULL' ? 'NULL' : (BUSINESS_OPERATION_TYPE_CODES as readonly string[]).includes(type ?? '') ? (type as BusinessOperationTypeCode) : null,
    status: (BUSINESS_OPERATION_STATUSES as readonly string[]).includes(status ?? '') ? (status as BusinessOperationStatus) : null,
    state: (OPERATION_STATES as readonly string[]).includes(state ?? '') ? (state as OperationState) : 'all',
    withoutAsset: truthy(p.get('withoutAsset')),
    withoutSource: truthy(p.get('withoutSource')),
    from: isDay(from) ? from : null,
    to: isDay(to) ? to : null,
    ...pageOf(p),
  };
}

const REASON_TOKEN = /^[A-Z0-9_:]{1,80}$/;

export function parseHoldFilters(p: Params): HoldListFilters {
  const outcome = p.get('outcome');
  const reason = p.get('reason');
  return {
    accountId: positiveInt(p.get('accountId')),
    outcome: outcome === 'HOLD_UNRESOLVED' || outcome === 'ARBITRATION_REQUIRED' ? outcome : null,
    reason: reason && REASON_TOKEN.test(reason) ? reason : null,
    ...pageOf(p),
  };
}

// ── Période des indicateurs ─────────────────────────────────────────────────

export interface DiagPeriod { from: string; to: string; days: number }

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Jour civil courant à Paris (AAAA-MM-JJ). */
export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Période [from, to] (jours inclus, Paris) — défaut : les 30 derniers jours ;
 * bornes inversées remises dans l'ordre ; au plus 366 jours (le début est
 * rapproché de la fin).
 */
export function resolveDiagPeriod(fromRaw: string | null, toRaw: string | null, now: Date = new Date()): DiagPeriod {
  const today = todayParis(now);
  let to = isDay(toRaw) ? toRaw : today;
  let from = isDay(fromRaw) ? fromRaw : iso(new Date(Date.parse(`${to}T00:00:00Z`) - (DIAG_DEFAULT_PERIOD_DAYS - 1) * 86_400_000));
  if (from > to) [from, to] = [to, from];
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (span > DIAG_MAX_PERIOD_DAYS) {
    from = iso(new Date(Date.parse(`${to}T00:00:00Z`) - (DIAG_MAX_PERIOD_DAYS - 1) * 86_400_000));
    return { from, to, days: DIAG_MAX_PERIOD_DAYS };
  }
  return { from, to, days: span };
}

// ── Libellés (C26.1 : raisons lisibles) ─────────────────────────────────────

export const TYPE_LABELS: Readonly<Record<BusinessOperationTypeCode, string>> = Object.fromEntries(
  BUSINESS_OPERATION_TYPES.map((t) => [t.code, t.label]),
) as Record<BusinessOperationTypeCode, string>;

export const STATUS_LABELS: Readonly<Record<BusinessOperationStatus, string>> = {
  ENVISAGED: 'Envisagée', REALIZED: 'Réalisée', CANCELLED: 'Annulée',
};

export function typeLabel(code: string | null): string {
  if (!code) return 'Type non qualifié';
  return TYPE_LABELS[code as BusinessOperationTypeCode] ?? code;
}

export const T3_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  NO_OPERATION: 'Aucune Opération (existence non établie)',
  MATCH_AND_ENRICH: 'Rattachée à une Opération existante',
  CREATE_NEW: 'Nouvelle Opération créée',
  HOLD_UNRESOLVED: 'En attente (HOLD)',
  ARBITRATION_REQUIRED: 'Arbitrage utilisateur demandé (À traiter)',
};

/**
 * Motifs stables de T3 (`t3_reason`, `match_reason`, `reason_code` de
 * l'historique) → phrase lisible (C26.1 : « référence de devis identique »,
 * « arbitrage utilisateur », « comparaison sémantique certaine »).
 */
const REASONS: Readonly<Record<string, string>> = {
  NOT_ESTABLISHED: 'existence non établie par la source',
  CONFLICTUAL: 'source conflictuelle',
  ARBITRATION_REQUIRED: 'plusieurs rapprochements certains incompatibles : arbitrage utilisateur',
  ARBITRATION_REQUIRED_NO_IMPACT: 'plusieurs rapprochements possibles, sans impact métier : en attente',
  CONTRADICTORY_REFERENCE: 'référence identique mais contredite par un autre élément',
  M3_REQUIRED: 'rapprochement plausible : comparaison sémantique attendue',
  M3_AMBIGUOUS: 'comparaison sémantique incertaine : arbitrage utilisateur',
  M3_AMBIGUOUS_NO_IMPACT: 'comparaison sémantique incertaine, sans impact métier : en attente',
  PROBABLE_WITHOUT_MATCH: 'source probable sans Opération correspondante : pas de création',
  TARGET_OUT_OF_PORTFOLIO: 'bien cible hors du portefeuille actif',
  MATCH_M0: 'arbitrage utilisateur',
  MATCH_M1: 'référence métier identique',
  MATCH_M2: 'même source documentaire ou même cycle de possession',
  MATCH_M3: 'comparaison sémantique certaine',
  MATCH_MERGE: 'références exactes de plusieurs Opérations : fusion',
  NO_MATCH_ESTABLISHED: 'aucune Opération correspondante, source certaine : création',
  USER_DISTINCT_OPERATION: 'déclarée distincte par l’utilisateur : création',
  M3_DISTINCT: 'comparaison sémantique certaine : réalité distincte, création',
  USER_CLAIM_FORM: 'formulaire Sinistre saisi par l’utilisateur',
  LEGACY_CLAIM_FORM_RESYNC: 'reprise de l’ancien formulaire Sinistre',
  T3_CREATE_NEW: 'création par la consolidation T3',
  ASSET_DATA_CREATE: 'création depuis les données du bien',
  ASSET_DATA_MIGRATION_CREATE: 'création par la migration des données du bien',
  CLAIM_MIGRATION_CREATE: 'création par la reprise des sinistres',
  CLAIM_FORM_CREATE: 'création depuis le formulaire Sinistre',
  CLAIM_FORM_REALIZED: 'sinistre réalisé (formulaire)',
  COMPLETION_PROVEN: 'réalisation prouvée',
  T3_STATUS_PROVEN: 'statut prouvé par les sources',
  T3_EFFECTIVE_DATE_FUTURE: 'date d’effet future',
  T3_REALIZATION_PROOF_WITHDRAWN: 'preuve de réalisation retirée',
  USER_REJECTED: 'rapprochement refusé par l’utilisateur',
  USER_CONFIRMED: 'rapprochement confirmé par l’utilisateur',
  SAME_SOURCE: 'même source documentaire',
  INVALIDATED: 'Opération invalidée',
};

const REFERENCE_KIND_LABELS: Readonly<Record<string, string>> = {
  INVOICE: 'facture', QUOTE: 'devis', ORDER: 'commande', WORK_ORDER: 'ordre de travail', CONTRACT: 'contrat',
  POLICY: 'police', CLAIM: 'sinistre', LOAN: 'prêt', CUSTOMER: 'numéro client', DELIVERY: 'bon de livraison', OTHER: 'référence',
};

/** Motif lisible ; le code reste affiché à côté (diagnostic). Inconnu → le code. */
export function explainReason(code: string | null | undefined): string {
  if (!code) return '—';
  if (REASONS[code]) return REASONS[code];
  if (code.startsWith('TECHNICAL_ERROR:')) return `erreur technique de consolidation (${code.slice('TECHNICAL_ERROR:'.length)})`;
  const ref = /^REFERENCE (.+)$/.exec(code);
  if (ref) {
    const kinds = ref[1].replace(/ \(INVALIDATED\)$/, '').split(',').map((r) => REFERENCE_KIND_LABELS[r.split(':')[0]] ?? r.split(':')[0]);
    return `référence de ${[...new Set(kinds)].join(', ')} identique${ref[1].endsWith('(INVALIDATED)') ? ' (Opération invalidée)' : ''}`;
  }
  const cycle = /^OWNERSHIP_CYCLE_(ACQUISITION|DISPOSAL)$/.exec(code);
  if (cycle) return `même cycle de possession (${cycle[1] === 'ACQUISITION' ? 'acquisition' : 'cession'})`;
  if (code.startsWith('MIGRATION_')) return 'migration des données existantes';
  return code;
}

// ── Montant net indicatif (B23) ─────────────────────────────────────────────

/**
 * Net indicatif d'une Opération en centimes d'euro (pure) : coûts réalisés
 * moins réductions, remboursements, indemnités et produits ; le prévisionnel
 * n'entre pas dans le net. Composantes hors EUR sans contre-valeur connue :
 * non comptées (`partial`). `null` sans composante réalisée.
 */
export function indicativeNetCents(
  components: ReadonlyArray<{ kind: FinancialComponentKind; amountMinor: number; currency: string; amountEurCents: number | null; active: boolean }>,
): { cents: number | null; partial: boolean } {
  let cents: number | null = null;
  let partial = false;
  for (const c of components) {
    if (!c.active || c.kind === 'FORECAST_COST') continue;
    const eur = c.currency === 'EUR' ? c.amountMinor : c.amountEurCents;
    if (eur === null || eur === undefined) { partial = true; continue; }
    cents = (cents ?? 0) + COMPONENT_SIGN[c.kind] * eur;
  }
  return { cents, partial };
}

/** Date principale (B23) : réalisation, sinon début, sinon prévue, sinon fin. */
export function principalDate(op: { realizedDate: string | null; startDate: string | null; plannedDate: string | null; endDate: string | null }): string | null {
  return op.realizedDate ?? op.startDate ?? op.plannedDate ?? op.endDate ?? null;
}

// ── Indicateurs C26.2 (exactement 13) ───────────────────────────────────────

export const INDICATOR_KEYS = [
  'createdPerDayBySourceKind',
  'documentsWithCertainCandidate',
  'certainCandidatesOutcome',
  'typeNull',
  'typeOther',
  'mergedWithin7Days',
  'invalidatedWithin7Days',
  'withoutTargetByAge',
  'ambiguousSources',
  'componentsWithoutActiveSource',
  'activeWithoutActiveSource',
  'crossAccountOrParentCycles',
  't2EconomicAnswers',
] as const;
export type IndicatorKey = (typeof INDICATOR_KEYS)[number];

export interface IndicatorDefinition {
  key: IndicatorKey;
  label: string;
  /** Lecture attendue (C26.2). */
  reading: string;
  /** `period` : flux de la période ; `stock` : état actuel. */
  scope: 'period' | 'stock';
  /** Anomalie dure : doit valoir 0 (C26.2, ACC-022). */
  hard: boolean;
}

export const INDICATORS: readonly IndicatorDefinition[] = [
  { key: 'createdPerDayBySourceKind', label: 'Opérations créées par jour / par source_kind', reading: 'Suivre le volume et détecter une explosion de créations documentaires.', scope: 'period', hard: false },
  { key: 'documentsWithCertainCandidate', label: '% documents T1 produisant ≥ 1 candidat certain', reading: 'Mesurer le gating T1, pas un objectif à maximiser.', scope: 'period', hard: false },
  { key: 'certainCandidatesOutcome', label: '% candidats certains aboutissant CREATE vs MATCH', reading: 'Suivre la consolidation.', scope: 'period', hard: false },
  { key: 'typeNull', label: '% type_code null', reading: 'Qualité de qualification ; pas d’auto-correction forcée.', scope: 'stock', hard: false },
  { key: 'typeOther', label: '% OTHER', reading: 'Doit rester un fallback réel ; surveiller dérive.', scope: 'stock', hard: false },
  { key: 'mergedWithin7Days', label: 'Fusions dans les 7 jours suivant création', reading: 'Signal de fragmentation excessive.', scope: 'period', hard: false },
  { key: 'invalidatedWithin7Days', label: 'Invalidations dans les 7 jours suivant création', reading: 'Signal de création trop permissive.', scope: 'period', hard: false },
  { key: 'withoutTargetByAge', label: 'Opérations sans cible : 0-24h / 1-7j / 8-30j / >30j', reading: 'Diagnostic ; aucune invalidation automatique par âge.', scope: 'stock', hard: false },
  { key: 'ambiguousSources', label: 'Sources en ambiguïté / À traiter', reading: 'Charge d’arbitrage.', scope: 'stock', hard: false },
  { key: 'componentsWithoutActiveSource', label: 'Composantes sans source active', reading: 'Anomalie dure : doit être 0 pour composante active.', scope: 'stock', hard: true },
  { key: 'activeWithoutActiveSource', label: 'Opérations actives sans source active', reading: 'Anomalie dure : doit être 0.', scope: 'stock', hard: true },
  { key: 'crossAccountOrParentCycles', label: 'Liens cross-account / cycles parent', reading: 'Anomalie dure : doit être 0.', scope: 'stock', hard: true },
  { key: 't2EconomicAnswers', label: 'T2 réponses économiques Operation-only / mixtes / fallback-only', reading: 'Mesurer adoption sans imposer l’exclusivité.', scope: 'period', hard: false },
];

/** Pourcentage arrondi au dixième ; `null` sans dénominateur. */
export function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

// ── Anomalies dures (C26.2, ACC-022) ────────────────────────────────────────

export const HARD_ANOMALY_CODES = [
  'ACTIVE_OPERATION_WITHOUT_SOURCE',
  'ACTIVE_COMPONENT_WITHOUT_SOURCE',
  'CROSS_ACCOUNT_LINK',
  'PARENT_CYCLE',
  'PARENT_DEPTH_EXCEEDED',
  'NEGATIVE_COMPONENT',
  'OTHER_AS_FALLBACK',
] as const;
export type HardAnomalyCode = (typeof HARD_ANOMALY_CODES)[number];

export const HARD_ANOMALY_LABELS: Readonly<Record<HardAnomalyCode, string>> = {
  ACTIVE_OPERATION_WITHOUT_SOURCE: 'Opération active sans source active',
  ACTIVE_COMPONENT_WITHOUT_SOURCE: 'Composante financière active sans source active',
  CROSS_ACCOUNT_LINK: 'Lien vers une donnée d’un autre compte',
  PARENT_CYCLE: 'Cycle parent / enfant',
  PARENT_DEPTH_EXCEEDED: 'Hiérarchie de plus de 3 niveaux',
  NEGATIVE_COMPONENT: 'Composante de montant négatif',
  OTHER_AS_FALLBACK: 'Type OTHER sans qualification explicite (repli)',
};

/** Indicateur C26.2 qui porte chaque anomalie dure. */
export const HARD_ANOMALY_INDICATOR: Readonly<Record<HardAnomalyCode, IndicatorKey | null>> = {
  ACTIVE_OPERATION_WITHOUT_SOURCE: 'activeWithoutActiveSource',
  ACTIVE_COMPONENT_WITHOUT_SOURCE: 'componentsWithoutActiveSource',
  CROSS_ACCOUNT_LINK: 'crossAccountOrParentCycles',
  PARENT_CYCLE: 'crossAccountOrParentCycles',
  // Contrôles complémentaires (C8.1 PARENT-002, C12, C7.7) : affichés avec
  // les anomalies dures, hors des 13 indicateurs.
  PARENT_DEPTH_EXCEEDED: null,
  NEGATIVE_COMPONENT: null,
  OTHER_AS_FALLBACK: null,
};

/** Rappel de la procédure (décision PO Q9) — affiché avec chaque alerte. */
export const CORRECTION_PROCEDURE =
  'Le back-office ne modifie jamais une Opération. Corriger la cause dans le code (nouvelle version), '
  + 'puis laisser la reconsolidation s’en charger : balayage T3 horaire, ou « Reconsolider ce compte » '
  + '(BO › Opérations du compte, motif journalisé), ou relance du travail T3 du compte depuis BO › File IA.';

export interface HardAnomalySample {
  accountId: number;
  operationId: number | null;
  detail: string;
}

export interface HardAnomalyResult {
  code: HardAnomalyCode;
  label: string;
  count: number;
  /** Comptes concernés (au plus `DIAG_ANOMALY_SAMPLE`). */
  accountIds: number[];
  samples: HardAnomalySample[];
}

// ── Masquage (C25 : rien au-delà de ce que le BO montre déjà) ───────────────

/** IBAN (avec ou sans espaces) : pays, clé, 11 à 30 caractères. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
/** Clés JSON dont la valeur n'est jamais rendue (fichier, coordonnées bancaires). */
const SENSITIVE_KEYS = /^(iban|bic|swift|rib|filename|original_?filename|file_?name|s3_?key|web_?link_?url|url)$/i;

export function maskSensitiveString(s: string): string {
  return s.replace(IBAN, (m) => `${m.slice(0, 4)} •••• (IBAN masqué)`);
}

/** Copie profonde d'une valeur JSON : IBAN masqués, clés sensibles retirées. */
export function maskSensitive<T>(value: T): T {
  if (typeof value === 'string') return maskSensitiveString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[masqué]' : maskSensitive(v);
    }
    return out as T;
  }
  return value;
}
