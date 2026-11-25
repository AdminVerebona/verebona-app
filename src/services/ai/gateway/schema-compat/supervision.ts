/**
 * Lot 114 (carte #776, travail 10 — §6, AC17) — SUPERVISION DES SORTIES
 * STRUCTURÉES : ce que la passerelle a RÉELLEMENT transmis, mesuré sur les
 * traces d'appels déjà enregistrées (`ai_usage_event.metadata` :
 * `providerRequest`, `providerAttempts`, `runtimeContract` — lots 52B, 34D).
 *
 * Par période, opération, modèle et contrat :
 *   · appels portant le schéma imposé et ACCEPTÉS par le fournisseur ;
 *   · refus HTTP 400 de la requête portant le schéma ;
 *   · nouveaux essais du même modèle sans schéma (#437), et ceux qui ont abouti ;
 *   · appels partis sans schéma à cause d'un refus mémorisé ;
 *   · appels sans schéma pour motif statique, ou non demandé ;
 *   · réussite finale, requêtes fournisseur RÉELLES (essais internes compris),
 *     jetons, coût, latence P50 / P95, temps passé dans les requêtes refusées.
 *
 * Une réussite finale n'est PAS « zéro incident » : les refus et les essais
 * sans schéma sont comptés à part. Les traces sont HISTORIQUES : rien n'est
 * recalculé ni réécrit, la période choisie relit les appels tels qu'ils ont
 * eu lieu (y compris ceux d'anciennes versions de l'application).
 *
 * Coût par tentative : les jetons et le coût relevés sur l'appel sont ceux
 * que le fournisseur a RENDUS. Lot 115 (carte #784, §D1) : un refus HTTP 400
 * ne prouve PAS à lui seul une facturation nulle — une tentative dont la
 * consommation n'a pas été rendue a un coût INCONNU, jamais 0 € supposé, et
 * reste comptée comme requête fournisseur réelle. Les DURÉES sont relevées
 * par tentative.
 *
 * Lot 115 (carte #784, §D2) : les TOTAUX et les TAUX sont calculés sur
 * l'ENSEMBLE FILTRÉ, par une lecture d'agrégat sans regroupement, AVANT toute
 * pagination. La ventilation par couple reste paginée (`groups`), et
 * `groupsTruncated` dit qu'elle est incomplète : au-delà de la page, les
 * totaux restent exacts — ils ne sont plus la somme des groupes affichés.
 *
 * AUCUN CONTENU : compteurs, codes, identifiants, versions et empreintes.
 */

type Row = Record<string, unknown>;

export interface SchemaUsageFilters {
  /** Période en jours (1 à 90). */
  days: number;
  operationCode?: string | null;
  model?: string | null;
  contractVersion?: number | null;
}

export interface SchemaUsageCounts {
  /** Appels d'analyse ayant sollicité le fournisseur. */
  calls: number;
  /** Première requête portant le schéma imposé. */
  schemaSent: number;
  /** … et à laquelle le fournisseur a répondu. */
  schemaAccepted: number;
  /** … refusée en HTTP 400. */
  schemaRefused400: number;
  /** … en échec pour une autre raison (délai, quota, réseau…) : rien n'est conclu sur le schéma. */
  schemaFailedOther: number;
  /** Nouveaux essais du même modèle sans schéma (refus explicite ou essai diagnostique). */
  retriesWithoutSchema: number;
  /** Appels ayant abouti après un nouvel essai sans schéma. */
  answeredAfterRetry: number;
  /** Appels partis sans schéma : refus mémorisé pour le couple. */
  skippedKnownRejection: number;
  /** Appels sans schéma : motif statique (schéma non transmissible). */
  omittedStatic: number;
  /** Appels sans schéma : non demandé pour l'opération, ou sorties structurées coupées. */
  notRequested: number;
  /**
   * Carte #838 (A1) : appels partis en JSON sans schéma parce qu'une AUTRE
   * instance tenait le bail de qualification du couple (jamais un refus).
   * Facultatif pour les appelants antérieurs ; toujours renseigné par la lecture.
   */
  skippedQualificationInProgress?: number;
  /** Carte #838 (A2) : appels partis en JSON sans schéma, mémoire partagée illisible (mode dégradé). */
  skippedMemoryUnavailable?: number;
  /** Carte #863 (A3) : appels partis sans schéma pendant le REPORT d'une requalification incertaine (jamais un refus). */
  skippedRequalificationDeferred?: number;
  /** Appels de réexamen (essai réservé d'un couple refusé). */
  retests: number;
  /** Appels dont le résultat final est une réussite. */
  finalSuccess: number;
  /** Requêtes fournisseur réellement effectuées (essais internes compris). */
  providerRequests: number;
  inputTokens: number;
  outputTokens: number;
  /** Coût total en micro-unités ; `null` : au moins un appel sans tarif (non calculable). */
  costMicros: number | null;
  /**
   * Lot 115 (carte #784, §D1) — TENTATIVES fournisseur par nature de coût,
   * comptées à part du total : `attemptsCostObserved` chiffrées sur une
   * consommation rendue ; `attemptsCostZero` consommation explicitement NULLE
   * rendue (0 € justifié) ; `attemptsCostUnknown` aucune consommation rendue
   * ou tarif inconnu — un refus HTTP 400 ne prouve pas 0 €, et « non
   * mesurable » n'est jamais présenté comme zéro.
   *
   * Traces d'avant ce lot : ces compteurs valent 0 (la nature du coût n'y
   * était pas relevée) — absence de mesure, pas une mesure nulle.
   */
  attemptsCostObserved: number;
  attemptsCostZero: number;
  attemptsCostUnknown: number;
  /** Temps passé dans les requêtes refusées ou en échec avant la réponse (ms). */
  failedAttemptMs: number;
  /**
   * Carte #863 (C1) : appels SANS détail de tentatives (traces historiques) — leur nombre de requêtes est
   * INCONNU (jamais supposé 1) ; comptés ici, hors `providerRequests`.
   */
  callsWithoutRequestDetail?: number;
  /** Carte #863 (C1) : tentatives tracées mais NON parties (garde, construction, transfert sans génération). */
  attemptsNotSent?: number;
  /** Carte #863 (C2) : tentatives au coût PARTIEL (minimum compté, reste inconnu) — comprises dans `attemptsCostUnknown`. */
  attemptsCostPartial?: number;
}

export interface SchemaUsageGroup extends SchemaUsageCounts {
  operationCode: string;
  model: string;
  contractId: string | null;
  contractVersion: number | null;
  schemaHash: string | null;
  providerSchemaHash: string | null;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  rates: SchemaUsageRates;
}

export interface SchemaUsageRates {
  /** Part des appels où le schéma imposé a été accepté, parmi ceux où il était demandé. `null` : aucun. */
  acceptedRate: number | null;
  /** Part des requêtes portant le schéma refusées en HTTP 400. */
  refusal400Rate: number | null;
  /** Part des appels où le schéma était demandé et n'a PAS été accepté (refus, refus mémorisé, motif statique, autre échec). */
  jsonModeRate: number | null;
  /** Requêtes fournisseur par appel. */
  requestsPerCall: number | null;
}

export interface SchemaUsageDay extends Pick<SchemaUsageCounts, 'calls' | 'schemaSent' | 'schemaAccepted' | 'schemaRefused400' | 'skippedKnownRejection' | 'omittedStatic' | 'notRequested'> {
  day: string;
  acceptedRate: number | null;
}

export interface SchemaUsageReport {
  days: number;
  from: string;
  to: string;
  filters: { operationCode: string | null; model: string | null; contractVersion: number | null };
  /**
   * Lot 115 (carte #784, §D2) : totaux et taux EXACTS sur l'ensemble filtré,
   * lus sans regroupement et AVANT pagination — jamais la somme des groupes
   * affichés. `durationP50Ms` / `durationP95Ms` : latence de l'ensemble.
   */
  totals: SchemaUsageCounts & { rates: SchemaUsageRates; durationP50Ms: number | null; durationP95Ms: number | null };
  /** Ventilation PAGINÉE (la plus sollicitée d'abord). */
  groups: SchemaUsageGroup[];
  /**
   * Lot 115 (carte #784, §D2) : nombre TOTAL de couples de l'ensemble filtré
   * (`null` : non mesurable). `groupsTruncated` : la ventilation affichée est
   * incomplète — les totaux restent exacts.
   */
  groupCount: number | null;
  groupsTruncated: boolean;
  trend: SchemaUsageDay[];
  /** Lecture impossible (délai, base) : indicateurs absents — jamais zéro. */
  unavailable: string | null;
}

/**
 * Carte #838 (C2) — requêtes fournisseur et coût d'une famille d'appels.
 * `costStatus` : `OBSERVED` (tout chiffré), `ZERO_REPORTED` (zéro prouvé par
 * le fournisseur), `PARTIAL` (montant MINIMUM, part inconnue comptée),
 * `UNKNOWN` (rien de chiffrable), `NONE` (aucune requête).
 */
export interface SchemaCostView {
  /** Appels (lignes d'usage) de la famille. */
  calls: number;
  /** Requêtes fournisseur RÉELLEMENT envoyées (tentatives internes comprises). */
  providerRequests: number;
  finalSuccess: number;
  attemptsCostObserved: number;
  attemptsCostZero: number;
  /** Tentatives au coût non chiffrable (inconnu, sans tarif, partiel, départ non prouvable). */
  attemptsCostUnknown: number;
  /** Somme des coûts chiffrés (micro-unités) — un minimum si `costStatus` vaut `PARTIAL`. */
  observedCostMicros: number;
  /** Carte #863 (C2) : `NO_PRICE` — consommation rendue, aucun tarif autorisé. */
  costStatus: 'OBSERVED' | 'ZERO_REPORTED' | 'PARTIAL' | 'NO_PRICE' | 'UNKNOWN' | 'NONE';
  /** Part des requêtes au coût inconnu (0 à 1) ; `null` : aucune requête. */
  unknownShare: number | null;
  /** Carte #863 (C2) : sous-ensembles de la part inconnue — partielles (minimum compté), sans tarif. */
  attemptsCostPartial?: number;
  attemptsNoPrice?: number;
  /** Carte #863 (C1) : tentatives tracées mais NON parties (garde, construction, transfert) — hors requêtes et coûts. */
  attemptsNotSent?: number;
  /** Carte #863 (C1) : départs non prouvables (part inconnue, hors requêtes réelles). */
  attemptsUnproven?: number;
  /** Carte #863 (C1) : tentatives tracées avant la carte (départ non établi par la trace, comptées comme requêtes tracées). */
  attemptsDispatchUndetermined?: number;
  /** Carte #863 (C1) : appels historiques SANS détail de tentatives — nombre de requêtes INCONNU (jamais « 1 »). */
  callsWithoutDetail?: number;
}

type CostCounters = Omit<SchemaCostView, 'costStatus' | 'unknownShare'>;

const EMPTY_COST_VIEW: SchemaCostView = {
  calls: 0, providerRequests: 0, finalSuccess: 0, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 0,
  observedCostMicros: 0, costStatus: 'NONE', unknownShare: null,
  attemptsCostPartial: 0, attemptsNoPrice: 0, attemptsNotSent: 0, attemptsUnproven: 0, attemptsDispatchUndetermined: 0, callsWithoutDetail: 0,
};

/**
 * Vue de coût à partir de compteurs (pure). Jamais 0 € « prouvé » quand une part est inconnue.
 * Carte #863 (C2) : un appel historique sans détail compte comme une part INCONNUE (son nombre de requêtes et
 * son coût exhaustif ne sont pas établis) ; `NO_PRICE` quand rien n'est chiffré faute de tarif seulement.
 */
export function schemaCostViewOf(c: CostCounters): SchemaCostView {
  const sansDetail = c.callsWithoutDetail ?? 0;
  const inconnues = c.attemptsCostUnknown + sansDetail;
  const tentatives = c.attemptsCostObserved + c.attemptsCostZero + inconnues;
  const partielles = c.attemptsCostPartial ?? 0;
  const sansTarif = c.attemptsNoPrice ?? 0;
  const costStatus: SchemaCostView['costStatus'] = tentatives === 0 ? 'NONE'
    : inconnues === tentatives && partielles === 0 ? (sansTarif > 0 && sansTarif === inconnues ? 'NO_PRICE' : 'UNKNOWN')
      : inconnues > 0 ? 'PARTIAL'
        : c.attemptsCostObserved === 0 ? 'ZERO_REPORTED' : 'OBSERVED';
  return {
    ...c, attemptsCostPartial: partielles, attemptsNoPrice: sansTarif, attemptsNotSent: c.attemptsNotSent ?? 0,
    attemptsUnproven: c.attemptsUnproven ?? 0, attemptsDispatchUndetermined: c.attemptsDispatchUndetermined ?? 0, callsWithoutDetail: sansDetail,
    costStatus, unknownShare: tentatives > 0 ? Math.round((inconnues / tentatives) * 10_000) / 10_000 : null,
  };
}

/** Somme de deux vues (pure) : le total « toutes tentatives ». */
export function addSchemaCostViews(a: SchemaCostView, b: SchemaCostView): SchemaCostView {
  const s = (k: keyof CostCounters): number => Number(a[k] ?? 0) + Number(b[k] ?? 0);
  return schemaCostViewOf({
    calls: s('calls'), providerRequests: s('providerRequests'), finalSuccess: s('finalSuccess'),
    attemptsCostObserved: s('attemptsCostObserved'), attemptsCostZero: s('attemptsCostZero'),
    attemptsCostUnknown: s('attemptsCostUnknown'), observedCostMicros: s('observedCostMicros'),
    attemptsCostPartial: s('attemptsCostPartial'), attemptsNoPrice: s('attemptsNoPrice'), attemptsNotSent: s('attemptsNotSent'),
    attemptsUnproven: s('attemptsUnproven'), attemptsDispatchUndetermined: s('attemptsDispatchUndetermined'), callsWithoutDetail: s('callsWithoutDetail'),
  });
}

const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);

/** Taux d'un ensemble de compteurs (pure). Dénominateur nul : `null`, jamais 0. */
export function schemaUsageRates(c: Pick<SchemaUsageCounts, 'calls' | 'schemaSent' | 'schemaAccepted' | 'schemaRefused400' | 'notRequested' | 'providerRequests'>): SchemaUsageRates {
  const demandes = c.calls - c.notRequested;
  return {
    acceptedRate: ratio(c.schemaAccepted, demandes),
    refusal400Rate: ratio(c.schemaRefused400, c.schemaSent),
    jsonModeRate: demandes > 0 ? ratio(demandes - c.schemaAccepted, demandes) : null,
    requestsPerCall: c.calls > 0 ? Math.round((c.providerRequests / c.calls) * 100) / 100 : null,
  };
}

const ZERO: SchemaUsageCounts = {
  calls: 0, schemaSent: 0, schemaAccepted: 0, schemaRefused400: 0, schemaFailedOther: 0, retriesWithoutSchema: 0, answeredAfterRetry: 0,
  skippedKnownRejection: 0, omittedStatic: 0, notRequested: 0, skippedQualificationInProgress: 0, skippedMemoryUnavailable: 0,
  skippedRequalificationDeferred: 0, retests: 0, finalSuccess: 0, providerRequests: 0, inputTokens: 0, outputTokens: 0,
  costMicros: 0, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 0, failedAttemptMs: 0,
  callsWithoutRequestDetail: 0, attemptsNotSent: 0, attemptsCostPartial: 0,
};

type NumericKey = Exclude<keyof SchemaUsageCounts, 'costMicros'>;
const NUMERIC_KEYS: readonly NumericKey[] = [
  'calls', 'schemaSent', 'schemaAccepted', 'schemaRefused400', 'schemaFailedOther', 'retriesWithoutSchema', 'answeredAfterRetry',
  'skippedKnownRejection', 'omittedStatic', 'notRequested', 'skippedQualificationInProgress', 'skippedMemoryUnavailable',
  'skippedRequalificationDeferred', 'retests', 'finalSuccess', 'providerRequests', 'inputTokens', 'outputTokens',
  'attemptsCostObserved', 'attemptsCostZero', 'attemptsCostUnknown', 'failedAttemptMs',
  'callsWithoutRequestDetail', 'attemptsNotSent', 'attemptsCostPartial',
];

/** Somme de groupes (pure) ; un coût non calculable dans un groupe rend le total non calculable. */
export function sumSchemaUsage(groups: readonly SchemaUsageCounts[]): SchemaUsageCounts {
  const t: SchemaUsageCounts = { ...ZERO };
  for (const g of groups) {
    for (const k of NUMERIC_KEYS) t[k] = (t[k] ?? 0) + (g[k] ?? 0);
    t.costMicros = t.costMicros === null || g.costMicros === null ? null : t.costMicros + g.costMicros;
  }
  return t;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const sn = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

function countsOf(r: Row): SchemaUsageCounts {
  return {
    calls: n(r.calls), schemaSent: n(r.schema_sent), schemaAccepted: n(r.schema_accepted), schemaRefused400: n(r.schema_refused_400),
    schemaFailedOther: n(r.schema_failed_other), retriesWithoutSchema: n(r.retries_without_schema), answeredAfterRetry: n(r.answered_after_retry),
    skippedKnownRejection: n(r.skipped_known_rejection), omittedStatic: n(r.omitted_static), notRequested: n(r.not_requested),
    skippedQualificationInProgress: n(r.skipped_qualification), skippedMemoryUnavailable: n(r.skipped_memory_unavailable),
    skippedRequalificationDeferred: n(r.skipped_requalification_deferred), retests: n(r.retests),
    finalSuccess: n(r.final_success), providerRequests: n(r.provider_requests), inputTokens: n(r.input_tokens), outputTokens: n(r.output_tokens),
    costMicros: n(r.cost_unknown) > 0 ? null : n(r.cost_micros),
    attemptsCostObserved: n(r.attempts_cost_observed), attemptsCostZero: n(r.attempts_cost_zero), attemptsCostUnknown: n(r.attempts_cost_unknown),
    failedAttemptMs: n(r.failed_attempt_ms),
    callsWithoutRequestDetail: n(r.calls_without_detail), attemptsNotSent: n(r.attempts_not_sent), attemptsCostPartial: n(r.attempts_cost_partial),
  };
}

/** Motifs STATIQUES d'absence de schéma (`provider-schema.ts`). */
export const STATIC_OMISSION_REASONS = ['too_complex', 'unrepresentable', 'provider_contract', 'projection_lossy'] as const;

/**
 * Carte #863 (C1) — tentative RÉELLEMENT partie (alias `a`) : départ établi `SENT`, ou trace antérieure à la
 * carte (sans `dispatch`) dont le coût n'est pas « non envoyé ». Une tentative non partie n'est jamais comptée.
 */
const SENT_ATTEMPT = `(COALESCE(a->>'dispatch', 'SENT') = 'SENT' AND COALESCE(a->>'costStatus', '') <> 'NOT_SENT')`;

/** Colonnes d'agrégat communes (par groupe et par jour). `e` : ligne d'appel ; `pr` : requête ; `a0` : première tentative. */
const AGG = `
  COUNT(*)::int AS calls,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true')::int AS schema_sent,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true' AND a0->>'outcome' = 'SUCCESS')::int AS schema_accepted,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true' AND a0->>'outcome' = 'FAILED' AND a0->>'httpStatus' = '400')::int AS schema_refused_400,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' = 'true' AND a0->>'outcome' = 'FAILED' AND COALESCE(a0->>'httpStatus', '') <> '400')::int AS schema_failed_other,
  COUNT(*) FILTER (WHERE pr->>'schemaOmittedReason' = 'recent_rejection')::int AS skipped_known_rejection,
  COUNT(*) FILTER (WHERE pr->>'schemaOmittedReason' = ANY($5::text[]))::int AS omitted_static,
  COUNT(*) FILTER (WHERE pr->>'schemaOmittedReason' IN ('qualification_in_progress', 'qualification_lease_expired'))::int AS skipped_qualification,
  COUNT(*) FILTER (WHERE pr->>'schemaOmittedReason' = 'memory_unavailable')::int AS skipped_memory_unavailable,
  COUNT(*) FILTER (WHERE pr->>'schemaOmittedReason' = 'requalification_deferred')::int AS skipped_requalification_deferred,
  COUNT(*) FILTER (WHERE pr->>'responseSchemaSent' <> 'true'
                     AND COALESCE(pr->>'schemaOmittedReason', 'not_requested') NOT IN ('recent_rejection', 'qualification_in_progress', 'memory_unavailable',
                                                                                     'requalification_deferred', 'qualification_lease_expired')
                     AND NOT (COALESCE(pr->>'schemaOmittedReason', '') = ANY($5::text[])))::int AS not_requested`;

/**
 * Lot 115 (carte #784, §D2) — agrégats COMMUNS à la ventilation paginée et aux
 * totaux exacts. Une seule expression pour les deux : un total ne peut plus
 * diverger de la somme des groupes autrement que par la pagination elle-même.
 */
const AGG_CALL = `
  COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE a->>'kind' IN ('schema_rejected_retry', 'diagnostic_retry'))), 0)::int AS retries_without_schema,
  COUNT(*) FILTER (WHERE so = 'schema_rejected_retried_without')::int AS answered_after_retry,
  COUNT(*) FILTER (WHERE pr->'schemaCompat'->>'retest' = 'true')::int AS retests,
  COUNT(*) FILTER (WHERE status = 'success')::int AS final_success,
  -- Carte #863 (C1) : requêtes RÉELLEMENT parties — une tentative non partie (garde, construction, transfert sans
  -- génération) n'est pas une requête ; un appel SANS détail de tentatives n'est jamais compté « 1 » (inconnu, à part).
  COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE ${SENT_ATTEMPT})), 0)::int AS provider_requests,
  COUNT(*) FILTER (WHERE jsonb_typeof(attempts) IS DISTINCT FROM 'array' OR jsonb_array_length(attempts) = 0)::int AS calls_without_detail,
  COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE NOT (${SENT_ATTEMPT}) AND COALESCE(a->>'dispatch', '') <> 'DEPARTURE_UNPROVEN')), 0)::int AS attempts_not_sent,
  COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens, COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
  COALESCE(SUM(cost_micros), 0)::bigint AS cost_micros,
  COUNT(*) FILTER (WHERE cost_micros IS NULL AND (input_tokens > 0 OR output_tokens > 0))::int AS cost_unknown,
  -- Lot 115 (carte #784, §D1) — TENTATIVES dont le coût n'est pas établi : le fournisseur n'a rendu
  -- aucune consommation (refus, délai), ou son tarif est inconnu. Comptées À PART du coût confirmé :
  -- le total observé reste lisible, et ce compteur dit ce qui pourrait avoir été facturé en plus.
  -- Un HTTP 400 ne prouve pas 0 € ; « non mesurable » n'est jamais présenté comme 0.
  COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE a->>'costStatus' IN ('UNKNOWN', 'NO_PRICE', 'PARTIAL') AND COALESCE(a->>'dispatch', 'SENT') IN ('SENT', 'DEPARTURE_UNPROVEN'))), 0)::int AS attempts_cost_unknown,
  COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE a->>'costStatus' = 'PARTIAL')), 0)::int AS attempts_cost_partial,
  -- Tentatives dont le fournisseur a explicitement rendu une consommation NULLE (0 € justifié).
  COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE a->>'costStatus' = 'ZERO_REPORTED')), 0)::int AS attempts_cost_zero,
  -- Tentatives chiffrées sur une consommation réellement rendue (coût OBSERVÉ).
  COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE a->>'costStatus' = 'OBSERVED')), 0)::int AS attempts_cost_observed,
  COALESCE(SUM((SELECT SUM((a->>'durationMs')::numeric) FROM jsonb_array_elements(COALESCE(attempts, '[]'::jsonb)) a
                 WHERE a->>'outcome' = 'FAILED')), 0)::bigint AS failed_attempt_ms,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS duration_p50,
  (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS duration_p95`;

/** Taille d'une page de ventilation (les totaux n'en dépendent pas). */
export const SCHEMA_USAGE_GROUP_PAGE = 200;

/**
 * Rapport d'usage du schéma imposé. `run` : exécuteur de lecture (par défaut
 * la session en lecture seule de l'observabilité, délai borné côté base).
 * Lecture impossible : `unavailable` renseigné, aucun compteur inventé.
 */
export async function getSchemaUsageReport(
  f: SchemaUsageFilters, now: Date = new Date(),
  run?: (sql: string, params: unknown[]) => Promise<Row[]>,
): Promise<SchemaUsageReport> {
  const days = Math.min(Math.max(Math.floor(f.days) || 7, 1), 90);
  const to = now;
  const from = new Date(now.getTime() - days * 86_400_000);
  const filters = { operationCode: f.operationCode || null, model: f.model || null, contractVersion: f.contractVersion ?? null };
  const base: SchemaUsageReport = {
    days, from: from.toISOString(), to: to.toISOString(), filters,
    totals: { ...ZERO, rates: schemaUsageRates(ZERO), durationP50Ms: null, durationP95Ms: null },
    groups: [], groupCount: null, groupsTruncated: false, trend: [], unavailable: null,
  };
  const exec = run ?? (async (sql: string, params: unknown[]) => (await import('../../telemetry/observability.repository')).readOnlyObservabilityQuery(sql, params));
  const params = [from.toISOString(), to.toISOString(), filters.operationCode, filters.model, [...STATIC_OMISSION_REASONS], filters.contractVersion === null ? null : String(filters.contractVersion)];
  const source = `
    FROM (
      SELECT COALESCE(e.operation_code, e.operation_type) AS operation_code, e.model, e.status, e.input_tokens, e.output_tokens, e.cost_micros, e.duration_ms, e.created_at,
             e.metadata->'providerRequest' AS pr, e.metadata->'providerAttempts' AS attempts, e.metadata->'providerAttempts'->0 AS a0,
             e.metadata->'runtimeContract' AS rc, e.metadata->'providerMeta'->>'structuredOutput' AS so
        FROM ai_usage_event e
       WHERE e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
         AND e.metadata ? 'providerRequest'
         AND COALESCE(e.metadata->>'callKind', 'analysis') = 'analysis'
         AND ($3::text IS NULL OR COALESCE(e.operation_code, e.operation_type) = $3)
         AND ($4::text IS NULL OR e.model = $4)
         AND ($6::text IS NULL OR e.metadata->'runtimeContract'->>'contractVersion' = $6)
    ) x`;
  try {
    const groups = await exec(
      `SELECT operation_code, model, rc->>'contractId' AS contract_id, rc->>'contractVersion' AS contract_version,
              rc->>'schemaHash' AS schema_hash, pr->>'providerSchemaHash' AS provider_schema_hash,
              ${AGG},
              ${AGG_CALL}
         ${source}
        GROUP BY 1, 2, 3, 4, 5, 6
        ORDER BY calls DESC, operation_code, model
        LIMIT ${SCHEMA_USAGE_GROUP_PAGE + 1}`,
      params,
    );
    // Lot 115 (carte #784, §D2) — TOTAUX EXACTS : agrégat de l'ENSEMBLE FILTRÉ, sans regroupement et
    // sans borne, lu AVANT toute pagination. Les totaux ne sont donc plus la somme des groupes
    // affichés : au-delà d'une page de ventilation, ils restent justes. Lecture distincte et bornée
    // par le délai de la session d'observabilité, comme les autres.
    const [totalRow] = await exec(`SELECT ${AGG}, ${AGG_CALL}, COUNT(DISTINCT (operation_code, model, rc->>'contractId', rc->>'contractVersion',
              rc->>'schemaHash', pr->>'providerSchemaHash'))::int AS group_count ${source}`, params);
    const trend = await exec(
      `SELECT to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS day, ${AGG}
         ${source}
        GROUP BY 1 ORDER BY 1`,
      params,
    );
    base.groupsTruncated = groups.length > SCHEMA_USAGE_GROUP_PAGE;
    base.groups = groups.slice(0, SCHEMA_USAGE_GROUP_PAGE).map((r) => {
      const c = countsOf(r);
      return {
        operationCode: String(r.operation_code), model: String(r.model), contractId: sn(r.contract_id), contractVersion: nn(r.contract_version),
        schemaHash: sn(r.schema_hash), providerSchemaHash: sn(r.provider_schema_hash), ...c,
        durationP50Ms: nn(r.duration_p50), durationP95Ms: nn(r.duration_p95), rates: schemaUsageRates(c),
      };
    });
    // Totaux lus sur l'ensemble filtré (jamais `sumSchemaUsage(base.groups)` : la page tronquerait).
    // Ensemble vide : la lecture d'agrégat rend une ligne de zéros — aucun compteur inventé.
    const totals = totalRow ? countsOf(totalRow) : { ...ZERO };
    base.totals = {
      ...totals, rates: schemaUsageRates(totals),
      durationP50Ms: totalRow ? nn(totalRow.duration_p50) : null, durationP95Ms: totalRow ? nn(totalRow.duration_p95) : null,
    };
    base.groupCount = totalRow ? n(totalRow.group_count) : null;
    base.trend = trend.map((r) => {
      const c = { calls: n(r.calls), schemaSent: n(r.schema_sent), schemaAccepted: n(r.schema_accepted), schemaRefused400: n(r.schema_refused_400),
        skippedKnownRejection: n(r.skipped_known_rejection), omittedStatic: n(r.omitted_static), notRequested: n(r.not_requested) };
      return { day: String(r.day), ...c, acceptedRate: ratio(c.schemaAccepted, c.calls - c.notRequested) };
    });
  } catch (e) {
    base.unavailable = String((e as Error)?.message ?? e).slice(0, 200);
  }
  return base;
}

/**
 * Carte #838 (C2, AC17/AC19) — vues SÉPARÉES « analyse seule »,
 * « réparation » et « total toutes tentatives », sur les mêmes filtres que le
 * rapport d'usage. Les réparations ne sont jamais cachées (le rapport
 * d'usage historique reste « analyse seule », ses compteurs sont inchangés) ;
 * chaque vue porte la nature de son coût : part chiffrée, part INCONNUE
 * (un refus HTTP 400 sans consommation rendue n'est jamais 0 €). Lecture
 * impossible : `views: null` et la raison — jamais des zéros.
 *
 * Carte #863 (C1, C2) : seules les tentatives RÉELLEMENT parties sont des
 * requêtes ; un appel historique sans détail de tentatives a un nombre de
 * requêtes INCONNU (compté à part, jamais « 1 ») ; coûts partiels, sans
 * tarif, non-envois et départs non prouvables comptés distinctement.
 */
export interface SchemaCostViews {
  views: { analysis: SchemaCostView; repair: SchemaCostView; total: SchemaCostView } | null;
  unavailable: string | null;
}

/** Filtres SQL communs des vues de coût (ligne `e` d'`ai_usage_event`). */
const COST_SOURCE_WHERE = `e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
                  AND (e.metadata ? 'providerRequest' OR e.metadata->>'callKind' = 'repair')
                  AND COALESCE(e.metadata->>'callKind', 'analysis') IN ('analysis', 'repair')
                  AND ($3::text IS NULL OR COALESCE(e.operation_code, e.operation_type) = $3)
                  AND ($4::text IS NULL OR e.model = $4)
                  AND ($5::text IS NULL OR e.metadata->'runtimeContract'->>'contractVersion' = $5)`;

export async function getSchemaCostViews(
  f: SchemaUsageFilters, now: Date = new Date(),
  run?: (sql: string, params: unknown[]) => Promise<Row[]>,
): Promise<SchemaCostViews> {
  const days = Math.min(Math.max(Math.floor(f.days) || 7, 1), 90);
  const from = new Date(now.getTime() - days * 86_400_000);
  const exec = run ?? (async (sql: string, params: unknown[]) => (await import('../../telemetry/observability.repository')).readOnlyObservabilityQuery(sql, params));
  const params = [from.toISOString(), now.toISOString(), f.operationCode || null, f.model || null, f.contractVersion == null ? null : String(f.contractVersion)];
  try {
    // Carte #838 (C2) — vues « analyse » / « réparation » / « total » sur les MÊMES filtres, réparations comprises.
    // Carte #863 (C1, C2) — par TENTATIVE : partie ou non, nature du coût ; appels sans détail comptés à part.
    const vues = await exec(
      `SELECT call_kind, COUNT(*)::int AS calls, COALESCE(SUM(n_req), 0)::int AS provider_requests,
              COUNT(*) FILTER (WHERE status = 'success')::int AS final_success,
              COALESCE(SUM(n_obs), 0)::int AS attempts_observed, COALESCE(SUM(n_zero), 0)::int AS attempts_zero,
              COALESCE(SUM(n_unk), 0)::int AS attempts_unknown, COALESCE(SUM(n_part), 0)::int AS attempts_partial,
              COALESCE(SUM(n_noprice), 0)::int AS attempts_no_price, COALESCE(SUM(n_notsent), 0)::int AS attempts_not_sent,
              COALESCE(SUM(n_unproven), 0)::int AS attempts_unproven, COALESCE(SUM(n_legacy), 0)::int AS attempts_legacy,
              COUNT(*) FILTER (WHERE n_att = 0)::int AS calls_without_detail,
              COALESCE(SUM(obs_micros), 0)::bigint AS observed_micros
         FROM (
           SELECT y.call_kind, y.status, y.n_att,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE ${SENT_ATTEMPT}) AS n_req,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE ${SENT_ATTEMPT} AND a->>'costStatus' = 'OBSERVED') AS n_obs,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE ${SENT_ATTEMPT} AND a->>'costStatus' = 'ZERO_REPORTED') AS n_zero,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a
                    WHERE (${SENT_ATTEMPT} AND COALESCE(a->>'costStatus', 'UNKNOWN') NOT IN ('OBSERVED', 'ZERO_REPORTED'))
                       OR a->>'dispatch' = 'DEPARTURE_UNPROVEN') AS n_unk,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE ${SENT_ATTEMPT} AND a->>'costStatus' = 'PARTIAL') AS n_part,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE ${SENT_ATTEMPT} AND a->>'costStatus' = 'NO_PRICE') AS n_noprice,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE NOT (${SENT_ATTEMPT}) AND COALESCE(a->>'dispatch', '') <> 'DEPARTURE_UNPROVEN') AS n_notsent,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE a->>'dispatch' = 'DEPARTURE_UNPROVEN') AS n_unproven,
                  (SELECT COUNT(*) FROM jsonb_array_elements(y.att) a WHERE ${SENT_ATTEMPT} AND a->>'dispatch' IS NULL) AS n_legacy,
                  CASE WHEN y.n_att > 0 THEN (SELECT COALESCE(SUM((a->>'costMicros')::numeric), 0) FROM jsonb_array_elements(y.att) a
                                                WHERE ${SENT_ATTEMPT} AND a->>'costStatus' IN ('OBSERVED', 'ZERO_REPORTED', 'PARTIAL') AND a->>'costMicros' IS NOT NULL)
                       WHEN (y.input_tokens > 0 OR y.output_tokens > 0) AND y.cost_micros IS NOT NULL THEN y.cost_micros ELSE 0 END AS obs_micros
             FROM (
               SELECT COALESCE(e.metadata->>'callKind', 'analysis') AS call_kind, e.status, e.input_tokens, e.output_tokens, e.cost_micros,
                      CASE WHEN jsonb_typeof(e.metadata->'providerAttempts') = 'array' THEN e.metadata->'providerAttempts' ELSE '[]'::jsonb END AS att,
                      CASE WHEN jsonb_typeof(e.metadata->'providerAttempts') = 'array' THEN jsonb_array_length(e.metadata->'providerAttempts') ELSE 0 END AS n_att
                 FROM ai_usage_event e
                WHERE ${COST_SOURCE_WHERE}
             ) y
         ) z
        GROUP BY call_kind`,
      params,
    );
    const vue = (kind: string): SchemaCostView => {
      const r = vues.find((v) => String(v.call_kind) === kind);
      if (!r) return { ...EMPTY_COST_VIEW };
      return schemaCostViewOf({
        calls: n(r.calls), providerRequests: n(r.provider_requests), finalSuccess: n(r.final_success),
        attemptsCostObserved: n(r.attempts_observed), attemptsCostZero: n(r.attempts_zero), attemptsCostUnknown: n(r.attempts_unknown),
        observedCostMicros: n(r.observed_micros), attemptsCostPartial: n(r.attempts_partial), attemptsNoPrice: n(r.attempts_no_price),
        attemptsNotSent: n(r.attempts_not_sent), attemptsUnproven: n(r.attempts_unproven), attemptsDispatchUndetermined: n(r.attempts_legacy),
        callsWithoutDetail: n(r.calls_without_detail),
      });
    };
    const analyse = vue('analysis');
    const reparation = vue('repair');
    return { views: { analysis: analyse, repair: reparation, total: addSchemaCostViews(analyse, reparation) }, unavailable: null };
  } catch (e) {
    return { views: null, unavailable: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/**
 * Carte #863 (C2) — DÉTAIL parent / enfant des exécutions (BO) : par
 * exécution, les appels logiques (analyse, réparation rattachée à son parent)
 * et leurs tentatives, chacune avec sa phase, son départ, son HTTP, ses jetons
 * et son coût individuel (ou sa nature inconnue). PAGINÉ : les totaux des vues
 * (`getSchemaCostViews`) n'en dépendent pas. Aucun contenu.
 */
export interface SchemaCostDetailAttempt {
  attemptId: string | null; step: number; kind: string; phase: string | null; parentAttemptId: string | null; dispatch: string | null;
  outcome: string; httpStatus: number | null; durationMs: number | null;
  inputTokens: number | null; outputTokens: number | null; thoughtsTokens: number | null; totalTokens: number | null;
  costMicros: number | null; costStatus: string | null; responseSchemaSent: boolean;
}
export interface SchemaCostDetailCall {
  usageEventId: number; callKind: 'analysis' | 'repair'; parentCallIndex: number | null; model: string; status: string;
  costMicros: number | null; attempts: SchemaCostDetailAttempt[];
}
export interface SchemaCostDetailExecution { traceId: string; operationCode: string; createdAt: string; calls: SchemaCostDetailCall[] }
export interface SchemaCostDetails {
  executions: SchemaCostDetailExecution[]; page: number; pageSize: number; hasMore: boolean; unavailable: string | null;
}

export async function getSchemaCostDetails(
  f: SchemaUsageFilters & { page?: number; pageSize?: number }, now: Date = new Date(),
  run?: (sql: string, params: unknown[]) => Promise<Row[]>,
): Promise<SchemaCostDetails> {
  const days = Math.min(Math.max(Math.floor(f.days) || 7, 1), 90);
  const from = new Date(now.getTime() - days * 86_400_000);
  const page = Math.max(0, Math.floor(f.page ?? 0));
  const pageSize = Math.min(Math.max(Math.floor(f.pageSize ?? 20), 1), 100);
  const exec = run ?? (async (sql: string, params: unknown[]) => (await import('../../telemetry/observability.repository')).readOnlyObservabilityQuery(sql, params));
  const params = [from.toISOString(), now.toISOString(), f.operationCode || null, f.model || null, f.contractVersion == null ? null : String(f.contractVersion), pageSize + 1, page * pageSize];
  try {
    const traces = await exec(
      `SELECT e.metadata->>'traceId' AS trace_id, MIN(COALESCE(e.operation_code, e.operation_type)) AS operation_code, MIN(e.created_at) AS created_at
         FROM ai_usage_event e
        WHERE ${COST_SOURCE_WHERE} AND e.metadata ? 'traceId'
        GROUP BY 1 ORDER BY MIN(e.created_at) DESC, 1 LIMIT $6 OFFSET $7`,
      params,
    );
    const ids = traces.slice(0, pageSize).map((t) => String(t.trace_id));
    if (ids.length === 0) return { executions: [], page, pageSize, hasMore: false, unavailable: null };
    const lignes = await exec(
      `SELECT e.id, e.metadata->>'traceId' AS trace_id, COALESCE(e.metadata->>'callKind', 'analysis') AS call_kind,
              e.metadata->>'parentCallIndex' AS parent_call_index, e.model, e.status, e.cost_micros, e.metadata->'providerAttempts' AS attempts
         FROM ai_usage_event e
        WHERE e.metadata->>'traceId' = ANY($1::text[]) AND COALESCE(e.metadata->>'callKind', 'analysis') IN ('analysis', 'repair')
        ORDER BY e.id`,
      [ids],
    );
    const nnum = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
    const executions = traces.slice(0, pageSize).map((t): SchemaCostDetailExecution => ({
      traceId: String(t.trace_id), operationCode: String(t.operation_code), createdAt: new Date(String(t.created_at)).toISOString(),
      calls: lignes.filter((l) => String(l.trace_id) === String(t.trace_id)).map((l): SchemaCostDetailCall => ({
        usageEventId: Number(l.id), callKind: String(l.call_kind) === 'repair' ? 'repair' : 'analysis', parentCallIndex: nnum(l.parent_call_index),
        model: String(l.model), status: String(l.status), costMicros: nnum(l.cost_micros),
        attempts: (Array.isArray(l.attempts) ? (l.attempts as Array<Record<string, unknown>>) : []).map((a): SchemaCostDetailAttempt => ({
          attemptId: a.attemptId == null ? null : String(a.attemptId), step: Number(a.step ?? 0), kind: String(a.kind ?? 'initial'),
          phase: a.phase == null ? null : String(a.phase), parentAttemptId: a.parentAttemptId == null ? null : String(a.parentAttemptId),
          dispatch: a.dispatch == null ? null : String(a.dispatch), outcome: String(a.outcome ?? ''), httpStatus: nnum(a.httpStatus),
          durationMs: nnum(a.durationMs), inputTokens: nnum(a.inputTokens), outputTokens: nnum(a.outputTokens), thoughtsTokens: nnum(a.thoughtsTokens),
          totalTokens: nnum(a.totalTokens), costMicros: nnum(a.costMicros), costStatus: a.costStatus == null ? null : String(a.costStatus),
          responseSchemaSent: a.responseSchemaSent === true,
        })),
      })),
    }));
    return { executions, page, pageSize, hasMore: traces.length > pageSize, unavailable: null };
  } catch (e) {
    return { executions: [], page, pageSize, hasMore: false, unavailable: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
