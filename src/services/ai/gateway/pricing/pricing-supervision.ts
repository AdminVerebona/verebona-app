/**
 * Supervision TARIFAIRE et cycle de vie des alertes — lot 113O (carte #713,
 * « alertes persistantes après le lot 109L », point C ; migration 1521).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS RISQUES DISTINCTS, JAMAIS CONFONDUS
 *
 *   1. ACTIVE      modèle d'une chaîne ACTIVE (principal / replis de la
 *                  configuration effective) sans tarif applicable : risque
 *                  d'appels FUTURS non chiffrés. « Appelé dans les 7 derniers
 *                  jours » n'est PAS « configuré » (ancienne règle 109L) ;
 *   2. CALLS       appels HISTORIQUES réellement non chiffrés (statut effectif
 *                  missing / insufficient_usage / legacy_undetermined, sans
 *                  correction active) : travail de RÉGULARISATION, prouvé par
 *                  les traces — jamais déduit d'un statut tarifaire ;
 *   3. STALE / SOURCE  tarifs non confirmés par la dernière lecture, ou page
 *                  officielle rejetée : contrôle de FIABILITÉ.
 * Un coût nul ou arrondi (`zero_or_rounded`) n'est jamais compté.
 *
 * UNE alerte par condition tant qu'elle dure (`raiseConditionAlert`, clé sans
 * date) ; RÉSOLUTION automatique et tracée quand la condition disparaît
 * (`resolveAlerts`, distincte de l'acquittement, historique conservé). Les
 * alertes héritées du lot 109L (une par modèle et par jour,
 * `ai_pricing_model_unpriced`) sont rattachées à la condition qui leur
 * survit (SUPERSEDED) ou résolues (CONDITION_CLEARED), motif écrit.
 *
 * Recontrôle : après chaque synchronisation tarifaire, au chargement de
 * Configuration IA (tableau de bord, au plus une fois par
 * `RECHECK_MIN_INTERVAL_MS` et par instance), après une saisie de tarif et
 * après une régularisation. Lecture seule hors `ai_alerts` ; aucun appel IA.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { activeCorrectionJoin, pricingStatusSql } from '../../telemetry/cost-status';

type Row = Record<string, unknown>;

export const PRICING_ALERT_CODES = {
  active: 'ai_pricing_active_unpriced',
  calls: 'ai_pricing_unpriced_calls',
  stale: 'ai_pricing_stale',
  source: 'ai_pricing_source_unreadable',
} as const;
/** Code des alertes du lot 109L (une par modèle et par jour). */
export const LEGACY_PRICING_ALERT_CODE = 'ai_pricing_model_unpriced';
export const ALL_PRICING_ALERT_CODES: readonly string[] = [...Object.values(PRICING_ALERT_CODES), LEGACY_PRICING_ALERT_CODE];

/** Fenêtre des appels historiques examinés (jours). */
export const PRICING_SUPERVISION_DAYS = 30;
/** Recontrôle au chargement du BO : au plus une fois par instance et par… */
export const RECHECK_MIN_INTERVAL_MS = 60_000;

export interface ActiveUnpriced {
  model: string;
  usages: Array<{ treatment: string; rank: string }>;
  pageStatus: string | null;
  reasonCode: string | null;
  reason: string | null;
  /** Modèles servis observés pour cet identifiant (alias résolu par l'API). */
  servedModels: string[];
}
export interface UnpricedCalls {
  model: string;
  calls: number;
  firstAt: string;
  lastAt: string;
  byStatus: Record<string, number>;
  /** Un tarif est-il applicable AUJOURD'HUI (régularisation à simuler) ? */
  priceNow: boolean;
  inActiveChain: boolean;
  /**
   * Lot 114 (#770) : appels non chiffrés POSTÉRIEURS à la bascule de politique tarifaire — une anomalie ACTUELLE
   * (la garde aurait dû empêcher l'appel). Le reste est de l'historique financier, sans alerte.
   */
  callsSincePolicy: number;
  lastSincePolicyAt: string | null;
}
export interface StalePrice { model: string; since: string | null; reasonCode: string | null; reason: string | null }
export interface SourceFailure { logId: number; at: string; code: string | null; reason: string | null }

export interface PricingConditions {
  evaluatedAt: string;
  activeUnpriced: ActiveUnpriced[];
  unpricedCalls: UnpricedCalls[];
  stale: StalePrice[];
  source: SourceFailure | null;
  /** Dernière lecture : contenu intégral conservé (lot 113O) — une absence est-elle vérifiable ? */
  absenceVerifiable: boolean;
  /**
   * Lot 114 (#770) : date de la bascule « tarif officiel vérifié obligatoire » (migration 1691). `null` : bascule
   * non enregistrée — tout appel non chiffré est alors traité comme actuel (jamais masqué).
   */
  policyRebaseAt: string | null;
}

const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => ((await pgClient.unsafe(sql, params as never[])) as unknown as Row[]) ?? [];

/** Politique enregistrée par la migration 1691 (#770). */
export const PRICING_POLICY_REBASE = 'REBASE_PRICING_POLICY_PRE_MEP';

/** Date de la bascule de politique tarifaire (#770), ou `null` (migration 1691 absente). Ne lève jamais. */
export async function pricingPolicyRebaseAt(): Promise<string | null> {
  try {
    const [r] = await q(`SELECT applied_at FROM ai_pricing_policy_rebase WHERE policy = $1`, [PRICING_POLICY_REBASE]);
    return r ? iso(r.applied_at) : null;
  } catch { return null; }
}

/** Modèles servis distincts par identifiant demandé (alias résolus par l'API), sur `days` jours. */
export async function servedModelsObserved(days: number): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const rows = await q(
    `SELECT u.model, regexp_replace(u.metadata->'providerMeta'->>'modelVersion', '^models/', '') AS served, COUNT(*)::int AS n
       FROM ai_usage_event u
      WHERE u.provider = 'gemini' AND u.model IS NOT NULL AND u.created_at >= NOW() - ($1 || ' days')::interval
        AND COALESCE(u.metadata->'providerMeta'->>'modelVersion', '') <> ''
        AND regexp_replace(u.metadata->'providerMeta'->>'modelVersion', '^models/', '') <> u.model
      GROUP BY 1, 2`,
    [String(days)],
  ).catch(() => []);
  for (const r of rows) {
    const m = out.get(String(r.model)) ?? new Map<string, number>();
    m.set(String(r.served), Number(r.n));
    out.set(String(r.model), m);
  }
  return out;
}

/** Appels réellement non chiffrés (sans correction active), par modèle. Lecture seule. */
export async function unpricedCallsByModel(days: number, policyRebaseAt: string | null = null): Promise<Array<Omit<UnpricedCalls, 'priceNow' | 'inActiveChain'>>> {
  const st = pricingStatusSql('u');
  const rows = await q(
    `SELECT u.model, ${st} AS st, COUNT(*)::int AS n, MIN(u.created_at) AS first_at, MAX(u.created_at) AS last_at,
            COUNT(*) FILTER (WHERE $2::timestamptz IS NULL OR u.created_at > $2::timestamptz)::int AS n_since,
            MAX(u.created_at) FILTER (WHERE $2::timestamptz IS NULL OR u.created_at > $2::timestamptz) AS last_since
       FROM ai_usage_event u
       ${activeCorrectionJoin('u', 'c')}
      WHERE u.provider = 'gemini' AND u.model IS NOT NULL AND u.created_at >= NOW() - ($1 || ' days')::interval
        AND c.id IS NULL AND ${st} IN ('missing', 'insufficient_usage', 'legacy_undetermined')
      GROUP BY 1, 2`,
    [String(days), policyRebaseAt],
  );
  const par = new Map<string, { calls: number; firstAt: string; lastAt: string; byStatus: Record<string, number>; callsSincePolicy: number; lastSincePolicyAt: string | null }>();
  for (const r of rows) {
    const k = String(r.model);
    const e = par.get(k) ?? { calls: 0, firstAt: iso(r.first_at)!, lastAt: iso(r.last_at)!, byStatus: {}, callsSincePolicy: 0, lastSincePolicyAt: null };
    e.calls += Number(r.n);
    e.callsSincePolicy += Number(r.n_since ?? 0);
    const depuis = iso(r.last_since);
    if (depuis && (!e.lastSincePolicyAt || depuis > e.lastSincePolicyAt)) e.lastSincePolicyAt = depuis;
    e.byStatus[String(r.st)] = (e.byStatus[String(r.st)] ?? 0) + Number(r.n);
    if (iso(r.first_at)! < e.firstAt) e.firstAt = iso(r.first_at)!;
    if (iso(r.last_at)! > e.lastAt) e.lastAt = iso(r.last_at)!;
    par.set(k, e);
  }
  return [...par.entries()].map(([model, e]) => ({ model, ...e })).sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

/** Cache local à jour (rechargé si une autre instance a écrit). Ne lève jamais. */
async function freshCache(): Promise<typeof import('./pricing.repository')> {
  const P = await import('./pricing.repository');
  try {
    if (P.getCacheState().loadedAt === null) await P.loadPricingCache();
    else await P.refreshPricingCacheIfStale();
  } catch { /* cache illisible : état courant */ }
  return P;
}

/** Évalue les trois risques (lecture seule). */
export async function evaluatePricingConditions(now: Date = new Date()): Promise<PricingConditions> {
  await freshCache();
  // Lot 114 (#770) : « tarifé » = tarif officiel VÉRIFIÉ et applicable (un tarif connu mais non admissible ne suffit plus).
  const { evaluatePricing } = await import('./pricing-guard');
  const priced = (m: string) => evaluatePricing(m, 'gemini', now).ok;
  const policyRebaseAt = await pricingPolicyRebaseAt();
  const { loadPriceStatuses } = await import('./pricing-sync.service');
  const statuts = await loadPriceStatuses().catch(() => new Map());
  const servis = await servedModelsObserved(PRICING_SUPERVISION_DAYS).catch(() => new Map<string, Map<string, number>>());

  // 1. Chaînes actives.
  let chains: Array<{ treatment: string; rank: string; model: string }> = [];
  try {
    const { loadActiveChains } = await import('../../provider/active-model-anomalies');
    chains = await loadActiveChains();
  } catch { chains = []; }
  const actifs = new Map<string, Array<{ treatment: string; rank: string }>>();
  for (const c of chains) actifs.set(c.model, [...(actifs.get(c.model) ?? []), { treatment: c.treatment, rank: c.rank }]);
  const activeUnpriced: ActiveUnpriced[] = [];
  for (const [model, usages] of [...actifs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (priced(model)) continue;
    const served = [...(servis.get(model)?.keys() ?? [])].sort();
    // Alias résolu par l'API et TOUS les modèles servis tarifés : appels chiffrés au modèle servi.
    if (served.length > 0 && served.every(priced)) continue;
    const s = statuts.get(model);
    activeUnpriced.push({ model, usages, pageStatus: s?.status ?? null, reasonCode: s?.reasonCode ?? null, reason: s?.reason ?? null, servedModels: served });
  }

  // 2. Appels historiques réellement non chiffrés.
  const appels = await unpricedCallsByModel(PRICING_SUPERVISION_DAYS, policyRebaseAt).catch(() => []);
  const unpricedCalls: UnpricedCalls[] = appels.map((a) => ({ ...a, priceNow: priced(a.model) || [...(servis.get(a.model)?.keys() ?? [])].some(priced), inActiveChain: actifs.has(a.model) }));

  // 3. STALE et source rejetée. Lot 114 (#770) : seuls les modèles des chaînes ACTIVES comptent — une preuve non
  // reconfirmée y annonce un blocage à l'échéance du délai de validité ; un modèle seulement utilisé par le passé
  // (ou découvert, exclu du routage) n'ouvre plus d'alerte.
  const utilises = new Set<string>(actifs.keys());
  const stale: StalePrice[] = [...statuts.values()]
    .filter((s) => s.status === 'STALE' && utilises.has(s.model))
    .map((s) => ({ model: s.model, since: s.staleSince ?? null, reasonCode: s.reasonCode ?? null, reason: s.reason ?? null }))
    .sort((a, b) => a.model.localeCompare(b.model));
  const [last] = await q(`SELECT * FROM ai_model_pricing_refresh_log WHERE status <> 'running' ORDER BY id DESC LIMIT 1`).catch(() => []);
  const source: SourceFailure | null = last && String(last.status) === 'failed'
    ? { logId: Number(last.id), at: iso(last.started_at)!, code: last.failure_code == null ? null : String(last.failure_code), reason: last.error_message == null ? null : String(last.error_message) }
    : null;

  return {
    evaluatedAt: now.toISOString(), activeUnpriced, unpricedCalls, stale, source, policyRebaseAt,
    absenceVerifiable: Boolean(last && last.snapshot_id != null),
  };
}

// ── Libellés factuels (BO, alertes) ─────────────────────────────────────────

const fr = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
const RANG: Record<string, string> = { primaryModel: 'principal', fallback1: 'repli 1', fallback2: 'repli 2' };

/** Motif lisible d'un modèle sans tarif (pur) — `ABSENT` seulement si l'absence est VÉRIFIÉE. */
export function unpricedCauseText(a: Pick<ActiveUnpriced, 'reasonCode' | 'reason' | 'pageStatus' | 'servedModels'>, absenceVerifiable: boolean): string {
  if (a.servedModels.length > 0) return `alias servi par ${a.servedModels.join(', ')} — modèle servi sans tarif établi`;
  if (!a.pageStatus) return 'tarif non confirmé : modèle jamais évalué par la synchronisation tarifaire';
  if (a.reasonCode === 'ABSENT') {
    return absenceVerifiable
      ? 'absent de la page tarifaire officielle (absence vérifiée sur la page reçue)'
      : 'tarif non confirmé : modèle à vérifier (absence non vérifiée, relancer la synchronisation)';
  }
  if (a.reasonCode === 'NOT_PARSED') return 'présent sur la page reçue mais non lu (défaut d’extraction, pas une absence)';
  return `tarif non confirmé (${a.reasonCode ?? '—'}${a.reason ? ` : ${a.reason.slice(0, 120)}` : ''})`;
}

interface AlertSpec {
  conditionKey: string;
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
  drilldownHref: string;
  model: string | null;
  category: 'active' | 'calls' | 'stale' | 'source';
}

/** Alertes attendues pour un état (pur, testé). */
export function expectedPricingAlerts(c: PricingConditions): AlertSpec[] {
  const out: AlertSpec[] = [];
  for (const a of c.activeUnpriced) {
    out.push({
      conditionKey: `pricing:active:${a.model}`, code: PRICING_ALERT_CODES.active, severity: 'warning', model: a.model, category: 'active',
      message: `Chaîne active sans tarif officiel vérifié : ${a.model} (${a.usages.map((u) => `${u.treatment} ${RANG[u.rank] ?? u.rank}`).join(', ')}) — ce rang n’est plus appelé, le rang configuré suivant est essayé (${unpricedCauseText(a, c.absenceVerifiable)}).`,
      details: { model: a.model, usages: a.usages, pageStatus: a.pageStatus, reasonCode: a.reasonCode, servedModels: a.servedModels },
      drilldownHref: '/admin/ai-provider#tarifs',
    });
  }
  // Lot 114 (Trello #770) — règle remplacée : « une alerte par modèle ayant des appels historiques non chiffrés ».
  // L'historique seul n'ouvre plus d'alerte (il reste visible, avec son vrai nombre, dans Coûts IA). Seul un appel
  // non chiffré POSTÉRIEUR à la bascule est une anomalie actuelle : la garde aurait dû empêcher cet appel.
  for (const u of c.unpricedCalls) {
    if (!(u.callsSincePolicy > 0)) continue;
    out.push({
      conditionKey: `pricing:calls:${u.model}`, code: PRICING_ALERT_CODES.calls, severity: 'warning', model: u.model, category: 'calls',
      message: `Appel IA exécuté sans tarif vérifié : ${u.callsSincePolicy} appel(s) de ${u.model} sans coût calculable depuis la bascule tarifaire (dernier le ${fr(u.lastSincePolicyAt)}) — `
        + 'la garde tarifaire n’a pas empêché cet appel : voie d’appel à vérifier.',
      details: { model: u.model, calls: u.callsSincePolicy, historicalCalls: u.calls - u.callsSincePolicy, byStatus: u.byStatus, lastAt: u.lastSincePolicyAt, priceNow: u.priceNow, inActiveChain: u.inActiveChain, policyRebaseAt: c.policyRebaseAt },
      drilldownHref: `/admin/ai-costs?unpriced=1&model=${encodeURIComponent(u.model)}`,
    });
  }
  if (c.stale.length > 0) {
    out.push({
      conditionKey: 'pricing:stale', code: PRICING_ALERT_CODES.stale, severity: 'info', model: null, category: 'stale',
      message: `Tarifs non confirmés (STALE) : ${c.stale.length} modèle(s) de chaînes actives — dernier montant documenté appliqué pendant le délai de validité de la preuve, puis le modèle ne sera plus appelé (${c.stale.slice(0, 8).map((s) => s.model).join(', ')}${c.stale.length > 8 ? '…' : ''}).`,
      details: { models: c.stale.map((s) => s.model), stale: c.stale.slice(0, 50) },
      drilldownHref: '/admin/ai-provider#tarifs',
    });
  }
  if (c.source) {
    out.push({
      conditionKey: 'pricing:source', code: PRICING_ALERT_CODES.source, severity: 'warning', model: null, category: 'source',
      message: `Tarifs IA : source officielle Google rejetée (${c.source.code ?? '—'} — ${(c.source.reason ?? '').slice(0, 200)}) — tarifs connus conservés (non confirmés), aucun retrait.`,
      details: { code: c.source.code, reason: c.source.reason, logId: c.source.logId, at: c.source.at },
      drilldownHref: '/admin/ai-provider#tarifs',
    });
  }
  return out;
}

export interface ReconcileResult {
  trigger: string;
  conditions: PricingConditions;
  raised: number;
  refreshed: number;
  resolved: number;
  superseded: number;
}

type Deps = {
  raise?: typeof import('../../alerts/alerts.repository').raiseConditionAlert;
  now?: Date;
};

/**
 * Recontrôle : lève / met à jour les alertes des conditions présentes, RÉSOUT
 * celles dont la condition a disparu, rattache les alertes héritées. Ne lève
 * jamais (rend `null` si l'évaluation est impossible).
 */
export async function reconcilePricingAlerts(trigger: string, deps: Deps = {}): Promise<ReconcileResult | null> {
  try {
    const now = deps.now ?? new Date();
    const conditions = await evaluatePricingConditions(now);
    const A = await import('../../alerts/alerts.repository');
    const raise = deps.raise ?? A.raiseConditionAlert;
    const specs = expectedPricingAlerts(conditions);
    const ids = new Map<string, number | null>();
    let raised = 0; let refreshed = 0;
    for (const s of specs) {
      const r = await raise({
        kind: 'anomaly', code: s.code, severity: s.severity, message: s.message, details: { ...s.details, category: s.category, trigger },
        drilldownHref: s.drilldownHref, conditionKey: s.conditionKey,
        fallbackDedupeKey: `ai:${s.conditionKey}:${now.toISOString().slice(0, 10)}`,
      });
      ids.set(s.conditionKey, r.id);
      if (r.created) raised++; else refreshed++;
    }
    const voulues = new Set(specs.map((s) => s.conditionKey));
    let resolved = 0; let superseded = 0;
    for (const a of await A.listUnresolvedAlerts(ALL_PRICING_ALERT_CODES)) {
      if (a.conditionKey && voulues.has(a.conditionKey)) continue;
      const model = typeof a.details?.model === 'string' ? a.details.model : null;
      // Alerte héritée (109L, datée) : rattachée à la condition qui lui survit.
      const survivante = a.conditionKey === null
        ? (a.code === PRICING_ALERT_CODES.source ? 'pricing:source'
          : model && voulues.has(`pricing:active:${model}`) ? `pricing:active:${model}`
            : model && voulues.has(`pricing:calls:${model}`) ? `pricing:calls:${model}` : null)
        : null;
      if (survivante && voulues.has(survivante)) {
        superseded += await A.resolveAlerts([a.id], {
          code: 'SUPERSEDED', supersededBy: ids.get(survivante) ?? null,
          reason: `regroupée dans l’alerte unique de la condition « ${survivante} » (lot 113O : une alerte par condition, plus une par jour)`,
        });
        continue;
      }
      resolved += await A.resolveAlerts([a.id], { code: 'CONDITION_CLEARED', reason: clearedReason(a.code, model, conditions) });
    }
    return { trigger, conditions, raised, refreshed, resolved, superseded };
  } catch (e) {
    console.warn('[pricing-supervision] recontrôle impossible (non bloquant) :', (e as Error).message);
    return null;
  }
}

/** Motif de résolution (pur). */
export function clearedReason(code: string, model: string | null, c: PricingConditions): string {
  if (code === PRICING_ALERT_CODES.source) return 'source officielle relue avec succès';
  if (code === PRICING_ALERT_CODES.stale) return 'plus aucun tarif utilisé en STALE : tarifs reconfirmés par la page';
  if (!model) return 'condition disparue au recontrôle';
  const appels = c.unpricedCalls.find((u) => u.model === model);
  const parts: string[] = [];
  if (!c.activeUnpriced.some((a) => a.model === model)) parts.push('tarif applicable ou modèle absent des chaînes actives');
  if (!appels) parts.push(`aucun appel non chiffré restant sur ${PRICING_SUPERVISION_DAYS} jours (régularisés, coût connu ou hors fenêtre)`);
  return `condition disparue au recontrôle : ${parts.join(' ; ') || 'condition remplacée'}`;
}

let dernierRecontrole = 0;
let enCours: Promise<ReconcileResult | null> | null = null;

/** Recontrôle au chargement du BO : au plus une fois par `RECHECK_MIN_INTERVAL_MS` et par instance. */
export async function reconcilePricingAlertsIfDue(trigger: string, force = false): Promise<ReconcileResult | null> {
  if (enCours) return enCours;
  if (!force && Date.now() - dernierRecontrole < RECHECK_MIN_INTERVAL_MS) return null;
  dernierRecontrole = Date.now();
  enCours = reconcilePricingAlerts(trigger).finally(() => { enCours = null; });
  return enCours;
}

/** Réservé aux tests. */
export function __resetPricingSupervisionForTests(): void { dernierRecontrole = 0; enCours = null; }

/**
 * Appel non chiffré constaté à la trace : met à jour (ou ouvre) l'alerte
 * unique « appels non chiffrés » du modèle — le compte exact est recalculé au
 * prochain recontrôle. Ne lève jamais.
 */
export async function noteUnpricedCalls(provider: string, model: string, now: Date = new Date()): Promise<void> {
  if (provider !== 'gemini') return;
  try {
    const { raiseConditionAlert } = await import('../../alerts/alerts.repository');
    await raiseConditionAlert({
      kind: 'anomaly', code: PRICING_ALERT_CODES.calls, severity: 'warning',
      // Lot 114 (#770) : un appel RÉELLEMENT exécuté sans tarif applicable est une anomalie actuelle (la garde
      // tarifaire ne l'a pas empêché) — jamais un simple rappel d'historique.
      message: `Appel IA exécuté sans tarif vérifié : aucun tarif applicable pour ${provider}/${model} (coût non calculable, jamais estimé) — voie d’appel à vérifier.`,
      details: { provider, model, source: 'trace', category: 'calls' },
      drilldownHref: `/admin/ai-costs?unpriced=1&model=${encodeURIComponent(model)}`,
      conditionKey: `pricing:calls:${model}`,
      fallbackDedupeKey: `ai:pricing-model:${model}:UNKNOWN:${now.toISOString().slice(0, 10)}`,
    });
  } catch { /* alerte best effort */ }
}

// ── Synthèse groupée (tableau de bord Configuration IA) ─────────────────────

export interface PricingSummary {
  severity: 'ok' | 'info' | 'warning' | 'critical';
  title: string;
  /** Lot 114 (#770) : rappel des appels HISTORIQUES non chiffrés (information, jamais une alerte) ; `null` s'il n'y en a pas. */
  historicalNote: string | null;
  evaluatedAt: string;
  counters: { activeUnpriced: number; unpricedCalls: number; currentUnpricedCalls: number; unpricedCallModels: number; stale: number; sourceFailed: boolean; openAlerts: number; resolvedRecently: number };
  active: Array<{ model: string; usages: string; cause: string }>;
  calls: Array<{ model: string; calls: number; lastAt: string; priceNow: boolean; inActiveChain: boolean }>;
  stale: string[];
  source: SourceFailure | null;
  recentlyResolved: Array<{ id: number; code: string; message: string; resolvedAt: string | null; resolutionCode: string | null; resolutionReason: string | null }>;
  links: { pricing: string; costs: string; regularization: string };
}

/** Synthèse groupée (pur, testé) : un bloc au lieu d'un bandeau par alerte. */
export function summarizePricing(c: PricingConditions, openAlerts: number, resolved: PricingSummary['recentlyResolved']): PricingSummary {
  const totalCalls = c.unpricedCalls.reduce((n, u) => n + u.calls, 0);
  const actuels = c.unpricedCalls.reduce((n, u) => n + u.callsSincePolicy, 0);
  // Lot 114 (#770) : les appels HISTORIQUES non chiffrés restent comptés et affichés (information financière), mais
  // ne colorent plus la synthèse : seul un incident présent (chaîne active non conforme, appel exécuté sans tarif
  // depuis la bascule, source rejetée) est un risque ouvert.
  const severity: PricingSummary['severity'] = c.activeUnpriced.length > 0 || c.source || actuels > 0 ? 'warning'
    : c.stale.length > 0 ? 'info' : 'ok';
  const parts: string[] = [];
  if (c.activeUnpriced.length) parts.push(`${c.activeUnpriced.length} modèle(s) de chaînes actives sans tarif vérifié (non appelés)`);
  if (actuels) parts.push(`${actuels} appel(s) exécuté(s) sans tarif vérifié depuis la bascule`);
  if (c.stale.length) parts.push(`${c.stale.length} tarif(s) non confirmé(s)`);
  if (c.source) parts.push('source officielle rejetée');
  return {
    severity,
    title: parts.length ? `Tarification IA : ${parts.join(' · ')}` : 'Tarification IA : aucun risque ouvert',
    historicalNote: totalCalls - actuels > 0
      ? `${totalCalls - actuels} appel(s) historique(s) non chiffré(s) sur ${PRICING_SUPERVISION_DAYS} jours (${c.unpricedCalls.filter((u) => u.calls > u.callsSincePolicy).length} modèle(s)) — information financière, consultable dans Coûts IA ; aucune alerte.`
      : null,
    evaluatedAt: c.evaluatedAt,
    counters: {
      activeUnpriced: c.activeUnpriced.length, unpricedCalls: totalCalls, currentUnpricedCalls: actuels, unpricedCallModels: c.unpricedCalls.length,
      stale: c.stale.length, sourceFailed: Boolean(c.source), openAlerts, resolvedRecently: resolved.length,
    },
    active: c.activeUnpriced.map((a) => ({ model: a.model, usages: a.usages.map((u) => `${u.treatment} ${RANG[u.rank] ?? u.rank}`).join(', '), cause: unpricedCauseText(a, c.absenceVerifiable) })),
    calls: c.unpricedCalls.slice(0, 30).map((u) => ({ model: u.model, calls: u.calls, lastAt: u.lastAt, priceNow: u.priceNow, inActiveChain: u.inActiveChain })),
    stale: c.stale.map((s) => s.model),
    source: c.source,
    recentlyResolved: resolved,
    links: { pricing: '/admin/ai-provider#tarifs', costs: '/admin/ai-costs?unpriced=1', regularization: '/admin/ai-costs?unpriced=1#regularisation' },
  };
}

/** Synthèse pour le tableau de bord (recontrôle si dû). Ne lève jamais : `null` si indisponible. */
export async function pricingSummaryForDashboard(force = false): Promise<PricingSummary | null> {
  try {
    const r = await reconcilePricingAlertsIfDue('dashboard', force);
    const conditions = r?.conditions ?? await evaluatePricingConditions();
    const { listAlerts } = await import('../../alerts/alerts.repository');
    const [open, resolved] = await Promise.all([
      listAlerts({ status: 'open', codes: ALL_PRICING_ALERT_CODES, limit: 200 }).catch(() => []),
      listAlerts({ status: 'resolved', codes: ALL_PRICING_ALERT_CODES, limit: 20 }).catch(() => []),
    ]);
    return summarizePricing(conditions, open.length, resolved.map((a) => ({
      id: a.id, code: a.code, message: a.message, resolvedAt: a.resolvedAt ?? null, resolutionCode: a.resolutionCode ?? null, resolutionReason: a.resolutionReason ?? null,
    })));
  } catch (e) {
    console.warn('[pricing-supervision] synthèse indisponible :', (e as Error).message);
    return null;
  }
}
