/**
 * Diagnostic des appels IA non chiffrés — lot 109L (ticket P1 « Tarifs Gemini
 * non reconnus, 948 appels signalés sans tarif », point D).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRODUIT PAR L'APPLICATION, SUR LA BASE RÉELLE, EN LECTURE SEULE
 *
 * Aucun accès direct à la base de préproduction n'est nécessaire : ce module
 * est appelé par la route BO `GET /api/admin/ai/costs/unpriced` (écran Coûts
 * IA › « Appels non chiffrés ») ET par le diagnostic durable 107G
 * (`ia/couts-ia-non-chiffres.json` / `.txt`, même instantané). Il ne modifie
 * rien, n'appelle aucun modèle.
 *
 * Il rapproche le compteur de l'ANCIENNE règle SQL (`cost_micros IS NULL OR
 * (cost_micros = 0 AND input_tokens > 0)`, celle du bandeau « 948 appels »)
 * du statut tarifaire effectif, puis CLASSE chaque appel concerné selon les
 * causes du ticket, à partir de l'historique des tarifs (`ai_model_pricing` :
 * validité, retrait ; `ai_model_price_changes` : motif ; `ai_model_price_status`) :
 *
 *   TARIFF_NOT_IN_GRID   aucun tarif dans la grille à la date de l'appel ;
 *   CACHE_NOT_LOADED     un tarif valide EXISTAIT avant l'appel : cache non
 *                        chargé, dégradé ou périmé sur l'instance ;
 *   WRONGLY_INVALIDATED  tarif retiré avant l'appel sur une lecture ambiguë /
 *                        un format non reconnu (ou republié à l'identique) ;
 *   MODEL_NOT_COVERED    modèle jamais soumis à la synchronisation tarifaire,
 *                        ou identifiant différent d'un modèle tarifé ;
 *   ZERO_OR_ROUNDED      coût connu nul ou arrondi à zéro (faux positif de
 *                        l'ancienne règle) ;
 *   USAGE_MISSING        consommation non mesurée (aucun jeton remonté) ;
 *   LEGACY_NO_PROOF      trace ancienne sans référence tarifaire ni coût NULL.
 *
 * Identifiants internes de compte seulement ; aucun contenu.
 *
 * Lot 113O (carte #713) :
 *   · ALIAS : un appel dont l'identifiant demandé n'a AUCUNE ligne tarifaire
 *     mais dont l'API a renvoyé le modèle servi (`providerMeta.modelVersion`)
 *     est rapproché du tarif de CE modèle servi (identifiant exact, preuve
 *     de l'API — jamais par ressemblance de nom) ; `pricedModel` le dit ;
 *   · PRIX PAR MODALITÉ : un tarif qui exige la consommation par modalité
 *     n'est appliqué que si la trace la porte (`providerMeta.tokensByModality`),
 *     sinon l'appel reste non reconstituable, motif précis.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { modalityAwareCost, requiresModalityUsage, type ModalityUsage } from '../gateway/cost-catalog';
import type { PriceTier } from '../gateway/pricing/google-pricing-page.adapter';
import { pricingStatusSql, type PricingStatus } from './cost-status';

export type Query = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

export const UNPRICED_CAUSES = [
  'TARIFF_NOT_IN_GRID', 'CACHE_NOT_LOADED', 'WRONGLY_INVALIDATED', 'MODEL_NOT_COVERED',
  'ZERO_OR_ROUNDED', 'USAGE_MISSING', 'LEGACY_NO_PROOF',
] as const;
export type UnpricedCause = (typeof UNPRICED_CAUSES)[number];

export const UNPRICED_CAUSE_LABELS: Readonly<Record<UnpricedCause, string>> = {
  TARIFF_NOT_IN_GRID: 'Tarif réellement absent de la grille à la date de l’appel',
  CACHE_NOT_LOADED: 'Tarif alors présent, mais cache non chargé ou dégradé',
  WRONGLY_INVALIDATED: 'Tarif invalidé à tort par la synchronisation',
  MODEL_NOT_COVERED: 'Modèle hors couverture ou identifiant différent',
  ZERO_OR_ROUNDED: 'Coût nul ou arrondi à zéro, tarif connu',
  USAGE_MISSING: 'Données de consommation manquantes',
  LEGACY_NO_PROOF: 'Historique sans preuve suffisante',
};

/** Version de la méthode (figée avec chaque correction). */
export const COST_METHOD_VERSION = 'l109l-v1';

/** Codes de motif d'une invalidation due au FORMAT (jamais une preuve de retrait). */
const FORMAT_CODES = new Set(['NO_PRICE_TABLE', 'NO_STANDARD_TIER', 'MULTIPLE_STANDARD_TIERS', 'MISSING_INPUT_ROW', 'MISSING_OUTPUT_ROW',
  'DUPLICATE_ROW', 'NO_PAID_COLUMN', 'UNSUPPORTED_CELL', 'AMBIGUOUS_SECTIONS', 'PAGE_EMPTY', 'PAGE_HTML', 'PAGE_UNRECOGNIZED', 'NO_DATED_PRICE_IN_FORCE']);
const FORMAT_REASON = /aucun tableau|aucun palier|plusieurs (lignes|paliers|sections)|ligne « (input|output) price » absente|colonne « paid »|structure|condition non reconnue|combinaison|aucun montant/i;

/** Ancienne règle SQL du bandeau (reconstituée à l'identique). */
export const LEGACY_UNPRICED_RULE = `(u.cost_micros IS NULL OR (u.cost_micros = 0 AND COALESCE(u.input_tokens, 0) > 0))`;

const RANK_SQL = (p: string) => `CASE WHEN ${p}.source = 'manual' AND ${p}.verified THEN 0 WHEN ${p}.source = 'billing_api' AND ${p}.verified THEN 1
  WHEN ${p}.source = 'public_catalog' THEN 2 WHEN ${p}.source = 'manual' THEN 3 ELSE 4 END`;

/** Normalisation d'identifiant (préfixe `models/`, suffixe de version) — détection seulement, jamais un alias appliqué. */
const NORM_SQL = (x: string) => `regexp_replace(regexp_replace(${x}, '^models/', ''), '-(\\d{3}|latest|\\d{2}-\\d{4}|preview-\\d{2}-\\d{2,4})$', '')`;

export interface PriceCandidate {
  id: number; source: string; verified: boolean; inputMicros: number; outputMicros: number;
  tiers: PriceTier[] | null; effectiveFrom: string; createdAt: string | null; invalidatedAt?: string | null;
}

export interface DiagnosedCall {
  kind: 'event';
  id: number;
  at: string;
  provider: string | null;
  model: string | null;
  useCaseCode: string | null;
  accountId: number | null;
  status: string;
  billable: boolean;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number | null;
  costMicros: number | null;
  pricingStatus: PricingStatus;
  legacyRule: boolean;
  traceId: string | null;
  cause: UnpricedCause;
  causeDetail: string;
  /** Tarif applicable documenté (régularisation), sinon raison. */
  price: PriceCandidate | null;
  priceMethod: 'valid_at_call' | 'documented_backdated' | 'continuity' | null;
  notReconstitutable: string | null;
  corrected: boolean;
  /** Lot 113O : identifiant dont le tarif est rapproché (modèle servi pour un alias). */
  pricedModel?: string | null;
  /** Lot 113O : consommation par modalité relevée à la trace. */
  modality?: ModalityUsage | null;
}

interface Raw extends Record<string, unknown> {}

const n = (v: unknown) => (v == null ? null : Number(v));
const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

function candidate(r: Raw, p: string): PriceCandidate | null {
  if (r[`${p}_id`] == null) return null;
  return {
    id: Number(r[`${p}_id`]), source: String(r[`${p}_source`] ?? ''), verified: Boolean(r[`${p}_verified`]),
    inputMicros: Number(r[`${p}_in`]), outputMicros: Number(r[`${p}_out`]),
    tiers: Array.isArray(r[`${p}_tiers`]) ? (r[`${p}_tiers`] as PriceTier[]) : null,
    effectiveFrom: iso(r[`${p}_from`]) ?? '', createdAt: iso(r[`${p}_created`]), invalidatedAt: iso(r[`${p}_inv`]),
  };
}

/** Un tarif est-il DOCUMENTÉ pour une régularisation ? (pur) — jamais la grille du compte non validée ni une saisie non vérifiée. */
export function isDocumentedPrice(p: PriceCandidate | null): boolean {
  if (!p) return false;
  return p.source === 'public_catalog' || (p.source === 'manual' && p.verified);
}

function sameAmounts(a: PriceCandidate, b: PriceCandidate): boolean {
  return a.inputMicros === b.inputMicros && a.outputMicros === b.outputMicros && JSON.stringify(a.tiers ?? []) === JSON.stringify(b.tiers ?? []);
}

/**
 * Classe un appel (pur, testé). `r` : ligne de la requête de diagnostic.
 */
export function classifyCall(r: Raw): DiagnosedCall {
  const st = String(r.st) as PricingStatus;
  const tokens = (n(r.input_tokens) ?? 0) + (n(r.output_tokens) ?? 0);
  const base: DiagnosedCall = {
    kind: 'event', id: Number(r.id), at: iso(r.created_at)!, provider: r.provider == null ? null : String(r.provider),
    model: r.model == null ? null : String(r.model), useCaseCode: r.use_case_code == null ? null : String(r.use_case_code),
    accountId: n(r.account_id), status: String(r.status ?? ''), billable: Boolean(r.is_billable),
    inputTokens: n(r.input_tokens) ?? 0, outputTokens: n(r.output_tokens) ?? 0, thoughtsTokens: n(r.thoughts),
    costMicros: n(r.cost_micros), pricingStatus: st, legacyRule: Boolean(r.legacy_rule), traceId: r.trace_id == null ? null : String(r.trace_id),
    cause: 'LEGACY_NO_PROOF', causeDetail: '', price: null, priceMethod: null, notReconstitutable: null, corrected: r.corr_id != null,
    pricedModel: r.priced_model == null ? null : String(r.priced_model),
    modality: modalityOf(r.tbm),
  };
  const c = classifyCore(r, base, st, tokens);
  // Lot 113O : alias rapproché du modèle servi — dit explicitement.
  const alias = base.pricedModel && base.model && base.pricedModel !== base.model ? ` ; tarif du modèle servi ${base.pricedModel} (alias résolu par l’API)` : '';
  // Lot 113O : tarif par modalité sans consommation par modalité mesurée → non reconstituable.
  if (c.price && requiresModalityUsage(c.price)) {
    const essai = modalityAwareCost(c.price, c.inputTokens, c.outputTokens, c.thoughtsTokens ?? 0, new Date(c.at), c.modality);
    if (!essai.ok) return { ...c, causeDetail: `${c.causeDetail}${alias}`, price: null, priceMethod: null, notReconstitutable: `${essai.reason} : coût non reconstituable` };
  }
  return alias ? { ...c, causeDetail: `${c.causeDetail}${alias}` } : c;
}

function modalityOf(v: unknown): ModalityUsage | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const lire = (x: unknown) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, n]) => typeof n === 'number')) as Record<string, number> : null);
  return { input: lire(o.input), output: lire(o.output) };
}

function classifyCore(r: Raw, base: DiagnosedCall, st: PricingStatus, tokens: number): DiagnosedCall {
  const valid = candidate(r, 'pv');
  const invalidated = candidate(r, 'pi');
  const after = candidate(r, 'pa');
  const chCode = r.ch_code == null ? null : String(r.ch_code);
  const chReason = r.ch_reason == null ? null : String(r.ch_reason);

  if (st === 'zero_or_rounded' && tokens > 0) {
    return { ...base, cause: 'ZERO_OR_ROUNDED', causeDetail: 'tarif connu au moment de l’appel ; coût arrondi au micro-dollar (coût exact conservé pour les nouveaux appels)' };
  }
  if (st === 'insufficient_usage' || tokens === 0) {
    return { ...base, cause: 'USAGE_MISSING', causeDetail: 'aucun jeton remonté par le fournisseur', notReconstitutable: 'consommation inconnue : aucun coût calculable' };
  }
  // Un tarif VALIDE à la date de l'appel existe.
  if (valid) {
    const inscritAvant = valid.createdAt === null || valid.createdAt <= base.at;
    const documented = isDocumentedPrice(valid);
    const nr = documented ? null : `tarif à cette date non documenté (source ${valid.source}${valid.verified ? '' : ', non vérifié'})`;
    if (!inscritAvant) {
      return {
        ...base, cause: 'TARIFF_NOT_IN_GRID', causeDetail: `tarif inscrit après l’appel avec une validité rétroactive documentée (ligne ${valid.id})`,
        price: documented ? valid : null, priceMethod: documented ? 'documented_backdated' : null, notReconstitutable: nr,
      };
    }
    if (st === 'legacy_undetermined') {
      return {
        ...base, cause: 'LEGACY_NO_PROOF', causeDetail: `trace sans référence tarifaire ; un tarif valide existait (ligne ${valid.id}, ${valid.source})`,
        price: documented ? valid : null, priceMethod: documented ? 'valid_at_call' : null, notReconstitutable: nr,
      };
    }
    return {
      ...base, cause: 'CACHE_NOT_LOADED', causeDetail: `tarif valide en base (ligne ${valid.id}, ${valid.source}, depuis ${valid.effectiveFrom.slice(0, 10)}) mais absent du cache de l’instance`,
      price: documented ? valid : null, priceMethod: documented ? 'valid_at_call' : null, notReconstitutable: nr,
    };
  }
  // Tarif retiré AVANT l'appel.
  if (invalidated) {
    const continuity = after !== null && sameAmounts(invalidated, after) && isDocumentedPrice(invalidated);
    const format = (chCode !== null && FORMAT_CODES.has(chCode)) || (chReason !== null && FORMAT_REASON.test(chReason));
    const detail = `tarif retiré le ${(invalidated.invalidatedAt ?? '').slice(0, 10)} (${chCode ?? '—'} : ${(chReason ?? 'motif non historisé').slice(0, 120)})`;
    if (format || continuity) {
      return {
        ...base, cause: 'WRONGLY_INVALIDATED', causeDetail: `${detail}${continuity ? ` ; republié à l’identique le ${after!.effectiveFrom.slice(0, 10)}` : ''}`,
        price: continuity ? invalidated : null, priceMethod: continuity ? 'continuity' : null,
        notReconstitutable: continuity ? null : 'tarif retiré à tort mais montant à la date de l’appel non prouvé (pas de republication à l’identique)',
      };
    }
    return {
      ...base, cause: 'TARIFF_NOT_IN_GRID', causeDetail: detail,
      notReconstitutable: 'tarif retiré avant l’appel (modèle absent de la page) : aucun tarif documenté à cette date',
    };
  }
  // Aucun tarif inscrit avant l'appel.
  if (Boolean(r.similar_priced) || r.status_now == null) {
    return {
      ...base, cause: 'MODEL_NOT_COVERED',
      causeDetail: r.similar_priced ? `identifiant différent d’un modèle tarifé (${String(r.similar_model ?? '')}) — aucun alias automatique` : 'modèle jamais soumis à la synchronisation tarifaire',
      notReconstitutable: 'aucun tarif documenté pour cet identifiant exact',
    };
  }
  if (st === 'legacy_undetermined') {
    return { ...base, cause: 'LEGACY_NO_PROOF', causeDetail: 'trace ancienne sans référence tarifaire ; aucun tarif en base à cette date', notReconstitutable: 'aucun tarif documenté à cette date' };
  }
  return {
    ...base, cause: 'TARIFF_NOT_IN_GRID',
    causeDetail: `aucun tarif en base à cette date ; statut actuel ${String(r.status_now)}${r.status_reason ? ` (${String(r.status_reason).slice(0, 100)})` : ''}`,
    notReconstitutable: 'aucun tarif documenté à cette date (saisie manuelle sourcée possible)',
  };
}

/** Coût reconstitué d'un appel au tarif documenté (pur). */
export function reconstitutedCost(c: Pick<DiagnosedCall, 'inputTokens' | 'outputTokens' | 'thoughtsTokens' | 'at'> & { modality?: ModalityUsage | null }, p: PriceCandidate): { costMicros: number; exactMicros: number } {
  // Lot 113O : prix par modalité appliqués avec la consommation par modalité (sinon `classifyCall` a déjà refusé).
  const r = modalityAwareCost({ inputMicros: p.inputMicros, outputMicros: p.outputMicros, tiers: p.tiers }, c.inputTokens, c.outputTokens, c.thoughtsTokens ?? 0, new Date(c.at), c.modality);
  const exact = r.ok ? r.exact : 0;
  return { costMicros: Math.round(exact), exactMicros: exact };
}

function priceLateral(alias: string, cond: string, order: string): string {
  return `LEFT JOIN LATERAL (
      SELECT p.id AS ${alias}_id, p.source AS ${alias}_source, p.verified AS ${alias}_verified, p.input_micros AS ${alias}_in,
             p.output_micros AS ${alias}_out, p.tiers AS ${alias}_tiers, p.effective_from AS ${alias}_from,
             p.created_at AS ${alias}_created, p.invalidated_at AS ${alias}_inv
        FROM ai_model_pricing p
       WHERE p.provider = u.provider AND p.model = pk.priced_model AND ${cond}
       ORDER BY ${order} LIMIT 1) ${alias} ON TRUE`;
}

/** Requête des appels concernés, par lots (curseur sur l'identifiant). */
export function diagnosticSql(accounts: boolean): string {
  const st = pricingStatusSql('u');
  return `SELECT u.id, u.created_at, u.provider, u.model, u.use_case_code, u.account_id, u.status, u.is_billable,
           u.input_tokens, u.output_tokens, u.cost_micros, u.metadata->>'traceId' AS trace_id,
           CASE WHEN jsonb_typeof(u.metadata->'providerMeta'->'thoughtsTokens') = 'number'
                THEN (u.metadata->'providerMeta'->>'thoughtsTokens')::numeric END AS thoughts,
           ${st} AS st, ${LEGACY_UNPRICED_RULE} AS legacy_rule, pk.priced_model, u.metadata->'providerMeta'->'tokensByModality' AS tbm,
           pv.*, pi.*, pa.*, ch.reason AS ch_reason, ch.reason_code AS ch_code,
           s.status AS status_now, s.reason AS status_reason,
           sim.model AS similar_model, (sim.model IS NOT NULL) AS similar_priced,
           c.id AS corr_id
      FROM ai_usage_event u
      -- Lot 113O : identifiant tarifé = demandé s'il a une ligne, sinon modèle SERVI renvoyé par l'API.
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN EXISTS (SELECT 1 FROM ai_model_pricing x WHERE x.provider = u.provider AND x.model = u.model) THEN u.model
                 WHEN NULLIF(regexp_replace(COALESCE(u.metadata->'providerMeta'->>'modelVersion', ''), '^models/', ''), '') IS NOT NULL
                   THEN regexp_replace(u.metadata->'providerMeta'->>'modelVersion', '^models/', '')
                 ELSE u.model END AS priced_model) pk ON TRUE
      ${priceLateral('pv', 'p.effective_from <= u.created_at AND (p.invalidated_at IS NULL OR p.invalidated_at > u.created_at)', `${RANK_SQL('p')}, p.effective_from DESC`)}
      ${priceLateral('pi', 'p.effective_from <= u.created_at AND p.invalidated_at IS NOT NULL AND p.invalidated_at <= u.created_at', 'p.effective_from DESC')}
      ${priceLateral('pa', `p.effective_from > u.created_at AND p.source IN ('public_catalog', 'manual')`, 'p.effective_from ASC')}
      LEFT JOIN LATERAL (
        SELECT reason, reason_code FROM ai_model_price_changes h
         WHERE h.provider = u.provider AND h.model = u.model AND h.detected_at <= u.created_at AND h.new_status <> 'KNOWN'
         ORDER BY h.detected_at DESC LIMIT 1) ch ON TRUE
      LEFT JOIN ai_model_price_status s ON s.provider = u.provider AND s.model = u.model
      LEFT JOIN LATERAL (
        SELECT p2.model FROM ai_model_pricing p2
         WHERE p2.provider = u.provider AND p2.model <> u.model AND ${NORM_SQL('p2.model')} = ${NORM_SQL('u.model')} LIMIT 1) sim ON TRUE
      LEFT JOIN ai_cost_corrections c ON c.target_kind = 'event' AND c.target_id = u.id AND c.reverted_at IS NULL
     WHERE u.created_at >= $1::timestamptz AND u.created_at <= $2::timestamptz AND u.id > $3
       ${accounts ? 'AND u.account_id = ANY($5::int[])' : ''}
       AND (${LEGACY_UNPRICED_RULE}
            OR ${st} IN ('missing', 'insufficient_usage', 'legacy_undetermined')
            OR (${st} = 'zero_or_rounded' AND COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0) > 0))
     ORDER BY u.id
     LIMIT $4`;
}

/** Parcourt les appels concernés par lots ; `visit` reçoit chaque appel classé. */
export async function forEachDiagnosedCall(
  q: Query, f: { since: Date; until: Date; accounts: number[] | null; batch?: number },
  visit: (c: DiagnosedCall) => void | Promise<void>,
): Promise<number> {
  const batch = Math.max(50, f.batch ?? 1000);
  const sql = diagnosticSql(f.accounts !== null);
  let last = 0;
  let total = 0;
  for (;;) {
    const params: unknown[] = [f.since.toISOString(), f.until.toISOString(), last, batch];
    if (f.accounts !== null) params.push(f.accounts);
    const rows = await q(sql, params);
    for (const r of rows) { await visit(classifyCall(r)); total++; }
    if (rows.length < batch) break;
    last = Number(rows[rows.length - 1].id);
  }
  return total;
}

// ── Rapport ────────────────────────────────────────────────────────────────

interface Bucket { calls: number; legacyRule: number; inputTokens: number; outputTokens: number; regularizable: number; corrected: number; reconstitutedMicros: number }
const bucket = (): Bucket => ({ calls: 0, legacyRule: 0, inputTokens: 0, outputTokens: 0, regularizable: 0, corrected: 0, reconstitutedMicros: 0 });
function add(b: Bucket, c: DiagnosedCall, rec: number | null) {
  b.calls++; if (c.legacyRule) b.legacyRule++;
  b.inputTokens += c.inputTokens; b.outputTokens += c.outputTokens;
  if (c.corrected) b.corrected++;
  else if (rec !== null) { b.regularizable++; b.reconstitutedMicros += rec; }
}

export interface CostDiagnosticReport {
  schema: 'verebona.ai-costs.unpriced/1';
  generatedAt: string;
  methodVersion: string;
  period: { since: string; until: string };
  scope: { accounts: number[] | null };
  /** Rapprochement avec l'ancienne règle du bandeau (ex. « 948 appels »). */
  reconciliation: {
    legacyRuleCalls: number;
    legacyRuleByCause: Record<string, number>;
    effectiveUnknownCalls: number;
    zeroOrRoundedCalls: number;
    alreadyCorrected: number;
  };
  byCause: Array<{ cause: UnpricedCause; label: string } & Bucket>;
  byDay: Array<{ day: string; byCause: Record<string, number>; calls: number }>;
  byTreatment: Array<{ useCaseCode: string; byCause: Record<string, number>; calls: number }>;
  byModel: Array<{ provider: string; model: string; cause: UnpricedCause; label: string; firstAt: string; lastAt: string; statusNow: string | null } & Bucket>;
  byAccount: Array<{ accountId: number | null; calls: number; byCause: Record<string, number> }>;
  byStatus: Record<string, number>;
  rollups: { rows: number; unpricedCalls: number; regularizableRows: number; regularizableCalls: number; detail: Array<{ id: number; day: string; model: string | null; calls: number; unpricedCalls: number; regularizable: boolean; reason: string }> };
  /** Exemples par cause (identifiants d'appel et de trace : liens vers Exécutions IA). */
  samples: Record<string, Array<{ id: number; at: string; model: string | null; traceId: string | null; detail: string; notReconstitutable: string | null }>>;
  pricingNow: Array<{ model: string; status: string; reason: string | null; reasonCode: string | null; fetchedAt: string | null }>;
  lastPricingSync: Record<string, unknown> | null;
}

const SAMPLE_PER_CAUSE = 25;

/** Diagnostic complet (lecture seule). `accounts = null` : tous les comptes. */
export async function aiCostDiagnostic(q: Query, f: { since: Date; until: Date; accounts: number[] | null }): Promise<CostDiagnosticReport> {
  const byCause = new Map<UnpricedCause, Bucket>();
  const byDay = new Map<string, Map<string, number>>();
  const byTreatment = new Map<string, Map<string, number>>();
  const byModel = new Map<string, { provider: string; model: string; cause: UnpricedCause; firstAt: string; lastAt: string; b: Bucket }>();
  const byAccount = new Map<string, Map<string, number>>();
  const byStatus: Record<string, number> = {};
  const legacyByCause: Record<string, number> = {};
  const samples: CostDiagnosticReport['samples'] = {};
  let legacy = 0; let unknown = 0; let zero = 0; let corrected = 0;
  const inc = (m: Map<string, Map<string, number>>, k: string, cause: string) => {
    const x = m.get(k) ?? new Map<string, number>(); x.set(cause, (x.get(cause) ?? 0) + 1); m.set(k, x);
  };

  await forEachDiagnosedCall(q, f, (c) => {
    const rec = c.price && !c.corrected ? reconstitutedCost(c, c.price).costMicros : null;
    add(byCause.get(c.cause) ?? (byCause.set(c.cause, bucket()), byCause.get(c.cause)!), c, rec);
    inc(byDay, c.at.slice(0, 10), c.cause);
    inc(byTreatment, c.useCaseCode ?? '—', c.cause);
    inc(byAccount, c.accountId === null ? '—' : String(c.accountId), c.cause);
    byStatus[c.pricingStatus] = (byStatus[c.pricingStatus] ?? 0) + 1;
    const mk = `${c.provider ?? '—'}|${c.model ?? '—'}|${c.cause}`;
    const m = byModel.get(mk) ?? { provider: c.provider ?? '—', model: c.model ?? '—', cause: c.cause, firstAt: c.at, lastAt: c.at, b: bucket() };
    if (c.at < m.firstAt) m.firstAt = c.at;
    if (c.at > m.lastAt) m.lastAt = c.at;
    add(m.b, c, rec);
    byModel.set(mk, m);
    if (c.legacyRule) { legacy++; legacyByCause[c.cause] = (legacyByCause[c.cause] ?? 0) + 1; }
    if (c.corrected) corrected++;
    else if (['missing', 'insufficient_usage', 'legacy_undetermined'].includes(c.pricingStatus)) unknown++;
    if (c.cause === 'ZERO_OR_ROUNDED') zero++;
    const s = (samples[c.cause] ??= []);
    if (s.length < SAMPLE_PER_CAUSE) s.push({ id: c.id, at: c.at, model: c.model, traceId: c.traceId, detail: c.causeDetail, notReconstitutable: c.notReconstitutable });
  });

  const rollups = await rollupDiagnostic(q, f);
  const statusRows = await q(`SELECT model, status, reason, reason_code, fetched_at FROM ai_model_price_status WHERE provider = 'gemini' ORDER BY model`, []).catch(() => []);
  const sync = await q(`SELECT id, started_at, finished_at, status, models_found, models_missing, error_message, failure_code, page_fingerprint, page_format,
                               final_url, http_status, content_type, page_bytes
                          FROM ai_model_pricing_refresh_log ORDER BY id DESC LIMIT 1`, []).catch(() => []);
  const obj = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort());

  return {
    schema: 'verebona.ai-costs.unpriced/1',
    generatedAt: new Date().toISOString(),
    methodVersion: COST_METHOD_VERSION,
    period: { since: f.since.toISOString(), until: f.until.toISOString() },
    scope: { accounts: f.accounts },
    reconciliation: { legacyRuleCalls: legacy, legacyRuleByCause: legacyByCause, effectiveUnknownCalls: unknown, zeroOrRoundedCalls: zero, alreadyCorrected: corrected },
    byCause: UNPRICED_CAUSES.filter((k) => byCause.has(k)).map((k) => ({ cause: k, label: UNPRICED_CAUSE_LABELS[k], ...byCause.get(k)! })),
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, m]) => ({ day, byCause: obj(m), calls: [...m.values()].reduce((a, b) => a + b, 0) })),
    byTreatment: [...byTreatment.entries()].map(([k, m]) => ({ useCaseCode: k, byCause: obj(m), calls: [...m.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => b.calls - a.calls),
    byModel: [...byModel.values()].map((m) => ({
      provider: m.provider, model: m.model, cause: m.cause, label: UNPRICED_CAUSE_LABELS[m.cause], firstAt: m.firstAt, lastAt: m.lastAt,
      statusNow: (statusRows as Raw[]).find((s) => String(s.model) === m.model)?.status as string ?? null, ...m.b,
    })).sort((a, b) => b.calls - a.calls),
    byAccount: [...byAccount.entries()].map(([k, m]) => ({ accountId: k === '—' ? null : Number(k), calls: [...m.values()].reduce((a, b) => a + b, 0), byCause: obj(m) })).sort((a, b) => b.calls - a.calls),
    byStatus,
    rollups,
    samples,
    pricingNow: (statusRows as Raw[]).map((s) => ({ model: String(s.model), status: String(s.status), reason: s.reason == null ? null : String(s.reason), reasonCode: s.reason_code == null ? null : String(s.reason_code), fetchedAt: iso(s.fetched_at) })),
    lastPricingSync: (sync as Raw[])[0] ?? null,
  };
}

/** Agrégats journaliers d'appels supprimés (avant 82C) : traités à part, jamais additionnés aux appels en base. */
export interface RollupCandidate { id: number; day: string; provider: string; model: string | null; useCaseCode: string | null; accountId: number | null; calls: number; unpricedCalls: number; inputTokens: number; outputTokens: number; costMicros: number; price: PriceCandidate | null; regularizable: boolean; reason: string; corrected: boolean }

export async function rollupCandidates(q: Query, f: { since: Date; until: Date; accounts: number[] | null }): Promise<RollupCandidate[]> {
  const rows = await q(
    `SELECT r.id, r.day, r.model, r.use_case_code, r.account_id, r.calls, r.unpriced_calls, r.input_tokens, r.output_tokens, r.cost_micros,
            pv.*, (c.id IS NOT NULL) AS corrected
       FROM ai_usage_daily_rollup r
       LEFT JOIN LATERAL (
         SELECT p.id AS pv_id, p.source AS pv_source, p.verified AS pv_verified, p.input_micros AS pv_in, p.output_micros AS pv_out,
                p.tiers AS pv_tiers, p.effective_from AS pv_from, p.created_at AS pv_created, p.invalidated_at AS pv_inv
           FROM ai_model_pricing p
          WHERE p.provider = 'gemini' AND p.model = r.model
            AND p.effective_from <= (r.day::timestamp AT TIME ZONE 'UTC')
            AND (p.invalidated_at IS NULL OR p.invalidated_at >= ((r.day + 1)::timestamp AT TIME ZONE 'UTC'))
          ORDER BY ${RANK_SQL('p')}, p.effective_from DESC LIMIT 1) pv ON TRUE
       LEFT JOIN ai_cost_corrections c ON c.target_kind = 'rollup' AND c.target_id = r.id AND c.reverted_at IS NULL
      WHERE r.unpriced_calls > 0 AND r.day >= ($1::timestamptz)::date AND r.day <= ($2::timestamptz)::date
        ${f.accounts !== null ? 'AND r.account_id = ANY($3::int[])' : ''}
      ORDER BY r.id`,
    f.accounts !== null ? [f.since.toISOString(), f.until.toISOString(), f.accounts] : [f.since.toISOString(), f.until.toISOString()],
  ).catch(() => [] as Raw[]);
  return rows.map((r) => {
    const price = candidate(r, 'pv');
    const calls = Number(r.calls); const unpriced = Number(r.unpriced_calls);
    const input = Number(r.input_tokens);
    const seuil = (price?.tiers ?? []).find((t) => t.kind === 'prompt_tokens_above') as Extract<PriceTier, { kind: 'prompt_tokens_above' }> | undefined;
    let reason = '';
    if (unpriced !== calls) reason = 'agrégat mêlant appels tarifés et non tarifés : jetons non séparables';
    else if (!price) reason = 'aucun tarif valide toute la journée';
    else if (!isDocumentedPrice(price)) reason = `tarif non documenté (source ${price.source})`;
    else if (seuil && input > seuil.thresholdTokens) reason = 'palier de taille d’invite possible : tailles par appel inconnues';
    else if ((price.tiers ?? []).some((t) => t.kind === 'dated')) reason = 'montants datés : vérification par appel impossible sur un agrégat';
    return {
      id: Number(r.id), day: String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10)), provider: 'gemini',
      model: r.model == null ? null : String(r.model), useCaseCode: r.use_case_code == null ? null : String(r.use_case_code),
      accountId: n(r.account_id), calls, unpricedCalls: unpriced, inputTokens: input, outputTokens: Number(r.output_tokens), costMicros: Number(r.cost_micros),
      price: reason === '' ? price : null, regularizable: reason === '', reason: reason || 'tarif documenté valide toute la journée, agrégat entièrement non tarifé', corrected: Boolean(r.corrected),
    };
  });
}

async function rollupDiagnostic(q: Query, f: { since: Date; until: Date; accounts: number[] | null }): Promise<CostDiagnosticReport['rollups']> {
  const c = await rollupCandidates(q, f);
  return {
    rows: c.length, unpricedCalls: c.reduce((a, x) => a + x.unpricedCalls, 0),
    regularizableRows: c.filter((x) => x.regularizable && !x.corrected).length,
    regularizableCalls: c.filter((x) => x.regularizable && !x.corrected).reduce((a, x) => a + x.unpricedCalls, 0),
    detail: c.slice(0, 200).map((x) => ({ id: x.id, day: x.day, model: x.model, calls: x.calls, unpricedCalls: x.unpricedCalls, regularizable: x.regularizable && !x.corrected, reason: x.corrected ? 'déjà régularisé' : x.reason })),
  };
}

/** Rendu texte lisible (diagnostic durable, recette). */
export function costDiagnosticText(r: CostDiagnosticReport): string {
  const L: string[] = [];
  L.push(`Coûts IA — appels non chiffrés (méthode ${r.methodVersion})`);
  L.push(`Période : ${r.period.since} → ${r.period.until} · généré le ${r.generatedAt}`);
  L.push('');
  L.push(`Ancienne règle du bandeau : ${r.reconciliation.legacyRuleCalls} appel(s)`);
  for (const [k, v] of Object.entries(r.reconciliation.legacyRuleByCause)) L.push(`  · ${k.padEnd(20)} ${String(v).padStart(6)}  ${UNPRICED_CAUSE_LABELS[k as UnpricedCause]}`);
  L.push(`Coût réellement inconnu (nouveau statut) : ${r.reconciliation.effectiveUnknownCalls} · coût nul/arrondi (tarif connu) : ${r.reconciliation.zeroOrRoundedCalls} · déjà régularisés : ${r.reconciliation.alreadyCorrected}`);
  L.push('');
  L.push('Par cause : appels · régularisables · coût reconstituable (µ$)');
  for (const c of r.byCause) L.push(`  ${c.cause.padEnd(20)} ${String(c.calls).padStart(6)} ${String(c.regularizable).padStart(6)} ${String(c.reconstitutedMicros).padStart(12)}  ${c.label}`);
  L.push('');
  L.push('Par jour :');
  for (const d of r.byDay) L.push(`  ${d.day} ${String(d.calls).padStart(6)}  ${Object.entries(d.byCause).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  L.push('');
  L.push('Par modèle et cause :');
  for (const m of r.byModel) L.push(`  ${m.model.padEnd(28)} ${m.cause.padEnd(20)} ${String(m.calls).padStart(6)} (régularisables ${m.regularizable}) statut actuel ${m.statusNow ?? '—'} · ${m.firstAt.slice(0, 10)} → ${m.lastAt.slice(0, 10)}`);
  L.push('');
  L.push('Par traitement :');
  for (const t of r.byTreatment) L.push(`  ${t.useCaseCode.padEnd(24)} ${String(t.calls).padStart(6)}  ${Object.entries(t.byCause).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  L.push('');
  L.push(`Agrégats journaliers (appels supprimés avant le lot 82C) : ${r.rollups.rows} ligne(s), ${r.rollups.unpricedCalls} appel(s) « sans tarif » (ancienne règle), régularisables : ${r.rollups.regularizableRows} ligne(s) / ${r.rollups.regularizableCalls} appel(s).`);
  L.push('');
  const s = r.lastPricingSync;
  L.push(`Dernière synchronisation tarifaire : ${s ? `${String(s.status)} · format ${String(s.page_format ?? '—')} · empreinte ${String(s.page_fingerprint ?? '—').slice(0, 16)} · URL finale ${String(s.final_url ?? '—')} · HTTP ${String(s.http_status ?? '—')}${s.failure_code ? ` · échec ${String(s.failure_code)}` : ''}` : 'aucune'}`);
  return `${L.join('\n')}\n`;
}
