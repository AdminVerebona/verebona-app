/**
 * Rapport de RÉCONCILIATION tarifaire — lot 113O (carte #713, « diagnostic
 * exigé avant correction », §2 du ticket).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRODUIT PAR L'APPLICATION, SANS ACCÈS À LA BASE, SANS SECRET
 *
 * Le PO n'a aucun accès SQL : ce rapport rassemble, pour CHAQUE identifiant
 * signalé (alertes tarifaires ouvertes ou résolues, chaînes actives, appels
 * non chiffrés, tarifs non confirmés, liste saisie), les preuves que le ticket
 * demande de confronter :
 *   · catalogue Google accessible à la clé (`ai_model_catalog`) ;
 *   · page tarifaire RÉELLEMENT reçue (dernier contenu intégral conservé,
 *     relu par le parseur COURANT) : identifiant présent ou non (recherche
 *     exacte), section, montants Standard payant, motif de refus ;
 *   · statut enregistré (`ai_model_price_status`), ligne réellement applicable
 *     (`ai_model_pricing`, priorité des sources), cache de CETTE instance et
 *     état déclaré des autres instances (migration 1522) ;
 *   · rôle dans les chaînes actives, appels 30 jours (réussis / en échec,
 *     jetons, statut tarifaire effectif, modèles servis, corrections), causes
 *     des appels non chiffrés (classement 109L) ;
 *   · alertes ouvertes / résolues ;
 * et en déduit UNE cause principale parmi les catégories du ticket, avec
 * l'action de résolution. Export JSON et CSV (aucun contenu d'appel, aucun
 * identifiant de compte, aucun secret).
 *
 * Lecture seule ; aucun appel IA ; aucune écriture.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  detectPricingFormat, mentionsModelId, parseGooglePricingMarkdown, resolveModelPrice, type ParsedPricingPage, type ResolvedPrice,
} from './google-pricing-page.adapter';
import { ALL_PRICING_ALERT_CODES, PRICING_SUPERVISION_DAYS } from './pricing-supervision';

type Row = Record<string, unknown>;

export const RECONCILIATION_CAUSES = [
  'ABSENT_VERIFIED', 'ALIAS_UNRESOLVED', 'ALIAS_RESOLVED', 'NOT_COVERED_BY_PARSER', 'CACHE_MISSING', 'STALE',
  'USAGE_INSUFFICIENT', 'ZERO_OR_ROUNDED', 'ALERT_RESOLVED', 'SOURCE_NOT_CAPTURED', 'PRICED_OK',
] as const;
export type ReconciliationCause = (typeof RECONCILIATION_CAUSES)[number];

export const RECONCILIATION_CAUSE_LABELS: Readonly<Record<ReconciliationCause, string>> = {
  ABSENT_VERIFIED: 'Tarif publiquement absent (identifiant exact introuvable sur la page reçue)',
  ALIAS_UNRESOLVED: 'Alias non résolu : modèle servi inconnu ou sans tarif',
  ALIAS_RESOLVED: 'Alias résolu par l’API : appels chiffrés au modèle servi',
  NOT_COVERED_BY_PARSER: 'Modèle présent sur la page mais non couvert par le parseur (ou forme de prix non prise en charge)',
  CACHE_MISSING: 'Tarif connu mais absent du cache de l’instance au moment des appels',
  STALE: 'Tarif non confirmé (STALE) : dernier montant documenté appliqué',
  USAGE_INSUFFICIENT: 'Consommation insuffisante ou non mesurée (jetons, modalités)',
  ZERO_OR_ROUNDED: 'Coût nul ou arrondi à zéro (tarif connu) : pas un tarif manquant',
  ALERT_RESOLVED: 'Alerte historique déjà résolue : plus aucune condition ouverte',
  SOURCE_NOT_CAPTURED: 'Page tarifaire non capturée ou illisible : relancer la synchronisation',
  PRICED_OK: 'Tarif applicable et appliqué',
};

export const RECONCILIATION_ACTIONS: Readonly<Record<ReconciliationCause, string>> = {
  ABSENT_VERIFIED: 'Aucun tarif publié : retirer le modèle des chaînes actives, ou saisir un tarif documenté (source officielle) si Google le facture ; historique : reste non chiffré (motif tracé).',
  ALIAS_UNRESOLVED: 'Préférer l’identifiant exact dans la configuration ; sinon vérifier que l’API renvoie le modèle servi et que celui-ci a un tarif.',
  ALIAS_RESOLVED: 'Aucune : le tarif du modèle servi est appliqué ; simuler la régularisation des anciens appels de l’alias.',
  NOT_COVERED_BY_PARSER: 'Relancer « Synchroniser les tarifs » (parseur 113O) ; si le motif persiste, transmettre le contenu reçu (snapshot) et saisir un tarif documenté.',
  CACHE_MISSING: 'Vérifier la version du cache de chaque instance ; simuler puis appliquer la régularisation (tarif valide à la date des appels).',
  STALE: 'Relancer la synchronisation ; si la page ne confirme toujours pas, vérifier sur la page officielle et saisir un tarif documenté.',
  USAGE_INSUFFICIENT: 'Aucun coût calculable sans consommation mesurée : reste inconnu, motif tracé (jamais converti en zéro).',
  ZERO_OR_ROUNDED: 'Aucune : coût connu (nul ou arrondi au micro-dollar).',
  ALERT_RESOLVED: 'Aucune : historique consultable.',
  SOURCE_NOT_CAPTURED: 'Relancer « Synchroniser les tarifs », puis relire ce rapport.',
  PRICED_OK: 'Aucune.',
};

export interface PageVerdict {
  verdict: 'KNOWN' | 'ABSENT' | 'NOT_PARSED' | 'UNSUPPORTED' | 'NO_SNAPSHOT' | 'PAGE_FAILED';
  code: string | null;
  reason: string | null;
  mentioned: boolean;
  section: string | null;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  modalityDependent: boolean;
}

export interface ModelEvidence {
  model: string;
  flaggedBy: string[];
  catalog: { available: boolean; version: string | null; displayName: string | null; lifecycle: string | null } | null;
  page: PageVerdict;
  status: { status: string; reasonCode: string | null; reason: string | null; fetchedAt: string | null; staleSince: string | null; absentReads: number } | null;
  applied: { rowId: number | null; source: string; verified: boolean; inputPerMillion: number; outputPerMillion: number; effectiveFrom: string | null; stale: boolean; reference: string | null } | null;
  cacheThisInstance: { present: boolean; rowId: number | null };
  activeUsages: string[];
  calls: {
    total: number; success: number; error: number; inputTokens: number; outputTokens: number; lastAt: string | null;
    byStatus: Record<string, number>; corrected: number; unknownCost: number; servedModels: Record<string, number>;
  };
  unpricedCauses: Record<string, number>;
  regularizable: number;
  alerts: { open: number; resolved: number; codes: string[] };
}

export interface ModelReconciliation extends ModelEvidence {
  primaryCause: ReconciliationCause;
  /** État actuel des alertes du modèle (cause sous-jacente ≠ état de l'alerte). */
  alertState: 'open' | 'resolved' | 'none';
  causeLabel: string;
  causes: ReconciliationCause[];
  action: string;
  /** Prix réellement applicable, ou motif documenté du non-calcul. */
  pricing: string;
}

/** Cause(s) d'un modèle (pur, testé). `servedPriced` : chaque modèle servi a-t-il un tarif applicable ? */
export function decideCause(e: ModelEvidence, servedPriced: (m: string) => boolean): Pick<ModelReconciliation, 'primaryCause' | 'causes' | 'action' | 'causeLabel' | 'pricing' | 'alertState'> {
  const causes: ReconciliationCause[] = [];
  const served = Object.keys(e.calls.servedModels);
  if (served.length > 0) causes.push(served.every(servedPriced) ? 'ALIAS_RESOLVED' : 'ALIAS_UNRESOLVED');
  if (!e.applied) {
    if (e.page.verdict === 'NO_SNAPSHOT' || e.page.verdict === 'PAGE_FAILED') causes.push('SOURCE_NOT_CAPTURED');
    else if (e.page.verdict === 'NOT_PARSED' || e.page.verdict === 'UNSUPPORTED') causes.push('NOT_COVERED_BY_PARSER');
    else if (e.page.verdict === 'KNOWN') causes.push('NOT_COVERED_BY_PARSER'); // lisible par le parseur courant, pas encore synchronisé
    else if (e.page.verdict === 'ABSENT' && served.length === 0) causes.push('ABSENT_VERIFIED');
  } else {
    if (e.applied.stale || e.status?.status === 'STALE') causes.push('STALE');
    if (!e.cacheThisInstance.present || (e.unpricedCauses.CACHE_NOT_LOADED ?? 0) > 0) causes.push('CACHE_MISSING');
  }
  if ((e.unpricedCauses.USAGE_MISSING ?? 0) > 0 || (e.calls.byStatus.insufficient_usage ?? 0) > 0) causes.push('USAGE_INSUFFICIENT');
  if ((e.unpricedCauses.ZERO_OR_ROUNDED ?? 0) > 0 || (e.calls.byStatus.zero_or_rounded ?? 0) > 0) causes.push('ZERO_OR_ROUNDED');
  // Aucune cause restante : alerte historique déjà résolue, ou tarif simplement appliqué.
  if (causes.length === 0) causes.push(e.alerts.open === 0 && e.alerts.resolved > 0 ? 'ALERT_RESOLVED' : 'PRICED_OK');
  const alertState: ModelReconciliation['alertState'] = e.alerts.open > 0 ? 'open' : e.alerts.resolved > 0 ? 'resolved' : 'none';
  // Cause principale : la plus structurante (la cause SOUS-JACENTE, l'état de l'alerte est à part).
  const ordre: ReconciliationCause[] = ['SOURCE_NOT_CAPTURED', 'ALIAS_UNRESOLVED', 'ALIAS_RESOLVED', 'NOT_COVERED_BY_PARSER', 'ABSENT_VERIFIED',
    'CACHE_MISSING', 'STALE', 'USAGE_INSUFFICIENT', 'ZERO_OR_ROUNDED', 'ALERT_RESOLVED', 'PRICED_OK'];
  const primaryCause = ordre.find((c) => causes.includes(c)) ?? 'PRICED_OK';
  const pricing = e.applied
    ? `${e.applied.inputPerMillion} $ / ${e.applied.outputPerMillion} $ par million (${e.applied.source}${e.applied.verified ? ', vérifié' : ''}, ligne ${e.applied.rowId ?? '—'}${e.applied.stale ? ', non confirmé' : ''})`
    : served.length > 0 && served.every(servedPriced) ? `tarif du modèle servi (${served.join(', ')})`
      : `non calculable : ${e.page.reason ?? e.status?.reason ?? 'aucun tarif documenté'}`;
  return { primaryCause, alertState, causes: [...new Set(causes)], causeLabel: RECONCILIATION_CAUSE_LABELS[primaryCause], action: RECONCILIATION_ACTIONS[primaryCause], pricing };
}

/** Verdict de la page reçue pour un modèle (pur). */
export function pageVerdict(page: ParsedPricingPage | null, raw: string | null, model: string, asOf: Date): PageVerdict {
  const vide: PageVerdict = { verdict: 'NO_SNAPSHOT', code: null, reason: 'aucun contenu de page conservé (synchronisation antérieure au lot 113O)', mentioned: false, section: null, inputPerMillion: null, outputPerMillion: null, modalityDependent: false };
  if (!page || raw === null) return vide;
  if (!page.ok) return { ...vide, verdict: 'PAGE_FAILED', code: page.code ?? null, reason: page.reason, mentioned: mentionsModelId(raw, model) };
  const r: ResolvedPrice = resolveModelPrice(page, model, asOf, raw);
  const section = page.sections.find((s) => s.modelIds.includes(model))?.heading ?? null;
  if (r.status === 'KNOWN') {
    return {
      verdict: 'KNOWN', code: null, reason: null, mentioned: true, section, inputPerMillion: r.inputPerMillion, outputPerMillion: r.outputPerMillion,
      modalityDependent: r.tiers.some((t) => t.kind === 'modality' && t.requiresBreakdown),
    };
  }
  const verdict: PageVerdict['verdict'] = r.code === 'ABSENT' ? 'ABSENT' : r.code === 'NOT_PARSED' ? 'NOT_PARSED' : 'UNSUPPORTED';
  return { verdict, code: r.code ?? null, reason: r.reason, mentioned: mentionsModelId(raw, model), section, inputPerMillion: null, outputPerMillion: null, modalityDependent: false };
}

export interface PricingReconciliationReport {
  schema: 'verebona.ai-pricing.reconciliation/1';
  generatedAt: string;
  windowDays: number;
  lastSync: Record<string, unknown> | null;
  snapshot: { id: number; fingerprint: string; bytes: number; format: string | null; finalUrl: string | null; httpStatus: number | null; firstSeenAt: string | null; lastSeenAt: string | null; truncated: boolean; redactions: number; reparsedFormat: string; sections: number; modelIds: number } | null;
  migrations: Array<{ migration: string; object: string; present: boolean }>;
  cache: { sharedVersion: number | null; thisInstance: Record<string, unknown>; instances: Array<Record<string, unknown>>; consistent: boolean | null };
  totals: Record<ReconciliationCause, number>;
  models: ModelReconciliation[];
}

const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
const num = (v: unknown) => (v == null ? 0 : Number(v));
type Q = (t: string, p?: unknown[]) => Promise<Row[]>;
const defaultQ: Q = async (t, p = []) => ((await pgClient.unsafe(t, p as never[])) as unknown as Row[]) ?? [];

const REQUIRED_OBJECTS: Array<{ migration: string; table: string; column?: string }> = [
  { migration: '1150', table: 'ai_usage_event', column: 'pricing_status' },
  { migration: '1150', table: 'ai_usage_event', column: 'cost_exact_micros' },
  { migration: '1150', table: 'ai_model_price_status', column: 'reason_code' },
  { migration: '1150', table: 'ai_model_pricing_refresh_log', column: 'page_fingerprint' },
  { migration: '1150', table: 'ai_cost_corrections' },
  { migration: '1520', table: 'ai_model_pricing_page_snapshots' },
  { migration: '1520', table: 'ai_model_pricing_refresh_log', column: 'snapshot_id' },
  { migration: '1521', table: 'ai_alerts', column: 'resolved_at' },
  { migration: '1521', table: 'ai_alerts', column: 'condition_key' },
  { migration: '1522', table: 'ai_pricing_cache_instances' },
];

/** Construit le rapport (lecture seule). `extraModels` : identifiants saisis par l'administrateur. */
export async function buildPricingReconciliation(opts: { extraModels?: string[]; now?: Date; q?: Q } = {}): Promise<PricingReconciliationReport> {
  const q = opts.q ?? defaultQ;
  const now = opts.now ?? new Date();
  const safe = async (t: string, p: unknown[] = []) => q(t, p).catch(() => [] as Row[]);
  const days = PRICING_SUPERVISION_DAYS;

  // Migrations.
  const cols = await safe(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()
                             AND table_name = ANY($1::text[])`, [[...new Set(REQUIRED_OBJECTS.map((o) => o.table))]]);
  const has = (t: string, c?: string) => cols.some((r) => r.table_name === t && (!c || r.column_name === c));
  const migrations = REQUIRED_OBJECTS.map((o) => ({ migration: o.migration, object: o.column ? `${o.table}.${o.column}` : o.table, present: has(o.table, o.column) }));

  // Dernière synchronisation et contenu réellement reçu.
  const [last] = await safe(`SELECT id, started_at, finished_at, status, failure_code, error_message, source_url, final_url, http_status, content_type,
                                    page_bytes, page_fingerprint, page_format, models_found, models_missing, models_stale, causes, trigger_code,
                                    snapshot_id, page_sections, coverage
                               FROM ai_model_pricing_refresh_log WHERE status <> 'running' ORDER BY id DESC LIMIT 1`);
  const lastFallback = last ? null : (await safe(`SELECT * FROM ai_model_pricing_refresh_log ORDER BY id DESC LIMIT 1`))[0] ?? null;
  const snapRows = await safe(`SELECT id, fingerprint, page_bytes, page_format, final_url, http_status, first_seen_at, last_seen_at, truncated, redactions, body
                                 FROM ai_model_pricing_page_snapshots
                                WHERE ($1::bigint IS NULL OR id = $1) ORDER BY last_seen_at DESC LIMIT 1`, [last?.snapshot_id ?? null]);
  const snap = snapRows[0] ?? null;
  const raw = snap ? String(snap.body ?? '') : null;
  const page = raw !== null ? parseGooglePricingMarkdown(raw) : null;

  // Statuts, tarifs applicables, cache.
  const { loadPriceStatuses } = await import('./pricing-sync.service');
  const statuts = await loadPriceStatuses().catch(() => new Map());
  const P = await import('./pricing.repository');
  if (P.getCacheState().loadedAt === null) await P.loadPricingCache().catch(() => 0);
  const validRows = await safe(`SELECT p.id, p.provider, p.model, p.input_micros, p.output_micros, p.currency, p.source, p.source_reference, p.verified,
                                       p.fetched_at, p.effective_from, p.tiers, (s.status = 'STALE') AS stale
                                  FROM ai_model_pricing p LEFT JOIN ai_model_price_status s ON s.provider = p.provider AND s.model = p.model
                                 WHERE p.provider = 'gemini' AND p.effective_from <= NOW() AND p.invalidated_at IS NULL`);
  const applicables = new Map(P.selectApplicablePrices(validRows as never).map((p) => [p.model, p]));
  const [shared] = await safe(`SELECT version FROM verebona_cache_versions WHERE scope = $1`, [P.PRICING_CACHE_SCOPE]);
  const instances = await safe(`SELECT instance_id, version, loaded_at, prices, degraded, last_error, updated_at FROM ai_pricing_cache_instances ORDER BY updated_at DESC LIMIT 20`);

  // Catalogue, chaînes actives.
  const catalog = new Map((await safe(`SELECT model, display_name, available, version, lifecycle FROM ai_model_catalog WHERE provider = 'gemini'`)
    .then((r) => r.length ? r : safe(`SELECT model, display_name, available FROM ai_model_catalog WHERE provider = 'gemini'`))).map((r) => [String(r.model), r]));
  const actifs = new Map<string, string[]>();
  try {
    const { loadActiveChains } = await import('../../provider/active-model-anomalies');
    for (const c of await loadActiveChains()) actifs.set(c.model, [...(actifs.get(c.model) ?? []), `${c.treatment} ${c.rank}`]);
  } catch { /* configuration illisible */ }

  // Appels sur la fenêtre (statut effectif, corrections, modèles servis).
  const { pricingStatusSql, activeCorrectionJoin } = await import('../../telemetry/cost-status');
  const st = pricingStatusSql('u');
  const appels = await safe(`SELECT u.model, ${st} AS st, u.status, COUNT(*)::int AS n, SUM(COALESCE(u.input_tokens, 0))::bigint AS i,
                                    SUM(COALESCE(u.output_tokens, 0))::bigint AS o, MAX(u.created_at) AS last_at, COUNT(c.id)::int AS corr,
                                    NULLIF(regexp_replace(COALESCE(u.metadata->'providerMeta'->>'modelVersion', ''), '^models/', ''), '') AS served
                               FROM ai_usage_event u ${activeCorrectionJoin('u', 'c')}
                              WHERE u.provider = 'gemini' AND u.model IS NOT NULL AND u.created_at >= NOW() - ($1 || ' days')::interval
                              GROUP BY u.model, 2, u.status, served`, [String(days)]);

  // Causes des appels non chiffrés (classement 109L, lecture seule).
  const causes = new Map<string, Record<string, number>>();
  const regul = new Map<string, number>();
  try {
    const { forEachDiagnosedCall } = await import('../../telemetry/cost-diagnostic');
    await forEachDiagnosedCall(async (t, p) => q(t, p), { since: new Date(now.getTime() - days * 86_400_000), until: now, accounts: null }, (c) => {
      const k = c.model ?? '—';
      const m = causes.get(k) ?? {};
      m[c.cause] = (m[c.cause] ?? 0) + 1;
      causes.set(k, m);
      if (c.price && !c.corrected && c.cause !== 'ZERO_OR_ROUNDED') regul.set(k, (regul.get(k) ?? 0) + 1);
    });
  } catch { /* migration 1150 absente */ }

  // Alertes tarifaires (60 jours, ouvertes et résolues).
  let alertesHisto: Row[] | null = await q(`SELECT code, details->>'model' AS model, (resolved_at IS NULL AND acknowledged_at IS NULL) AS open, (resolved_at IS NOT NULL) AS resolved
                                FROM ai_alerts WHERE code = ANY($1::text[]) AND created_at >= NOW() - interval '60 days'`, [[...ALL_PRICING_ALERT_CODES]]).catch(() => null);
  // Migration 1521 absente : acquittement seul.
  alertesHisto ??= await safe(`SELECT code, details->>'model' AS model, (acknowledged_at IS NULL) AS open, FALSE AS resolved
                                FROM ai_alerts WHERE code = ANY($1::text[]) AND created_at >= NOW() - interval '60 days'`, [[...ALL_PRICING_ALERT_CODES]]);

  // Ensemble des identifiants à réconcilier.
  const flagged = new Map<string, Set<string>>();
  const flag = (m: string | null | undefined, why: string) => {
    if (!m) return;
    const s = flagged.get(m) ?? new Set<string>(); s.add(why); flagged.set(m, s);
  };
  for (const a of alertesHisto) flag(a.model == null ? null : String(a.model), 'alerte');
  for (const m of actifs.keys()) flag(m, 'chaîne active');
  for (const m of causes.keys()) if (m !== '—') flag(m, 'appels non chiffrés');
  for (const s of statuts.values()) if (s.status !== 'KNOWN') flag(s.model, `statut ${s.status}`);
  for (const m of opts.extraModels ?? []) flag(m.trim(), 'saisi');
  for (const r of appels) if (r.served && flagged.has(String(r.model))) flag(String(r.served), 'modèle servi');

  const servedPriced = (m: string) => applicables.has(m);
  const models: ModelReconciliation[] = [];
  for (const model of [...flagged.keys()].filter((m) => /^[a-z0-9][a-z0-9.\-]{1,120}$/i.test(m)).sort()) {
    const s = statuts.get(model);
    const ap = applicables.get(model) ?? null;
    const cached = P.getCachedPrice('gemini', model);
    const lignes = appels.filter((r) => String(r.model) === model);
    const byStatus: Record<string, number> = {};
    const servedModels: Record<string, number> = {};
    let total = 0; let success = 0; let error = 0; let it = 0; let ot = 0; let corrected = 0; let unknownCost = 0; let lastAt: string | null = null;
    for (const r of lignes) {
      const n = num(r.n);
      total += n; it += num(r.i); ot += num(r.o); corrected += num(r.corr);
      if (String(r.status) === 'success') success += n; else error += n;
      byStatus[String(r.st)] = (byStatus[String(r.st)] ?? 0) + n;
      if (['missing', 'insufficient_usage', 'legacy_undetermined'].includes(String(r.st))) unknownCost += n - num(r.corr);
      if (r.served && String(r.served) !== model) servedModels[String(r.served)] = (servedModels[String(r.served)] ?? 0) + n;
      const at = iso(r.last_at);
      if (at && (!lastAt || at > lastAt)) lastAt = at;
    }
    const cat = catalog.get(model);
    const al = alertesHisto.filter((a) => a.model === model);
    const e: ModelEvidence = {
      model, flaggedBy: [...flagged.get(model)!].sort(),
      catalog: cat ? { available: Boolean(cat.available), version: cat.version == null ? null : String(cat.version), displayName: cat.display_name == null ? null : String(cat.display_name), lifecycle: cat.lifecycle == null ? null : String(cat.lifecycle) } : null,
      page: pageVerdict(page, raw, model, now),
      status: s ? { status: s.status, reasonCode: s.reasonCode ?? null, reason: s.reason, fetchedAt: s.fetchedAt, staleSince: s.staleSince ?? null, absentReads: s.absentReads ?? 0 } : null,
      applied: ap ? { rowId: ap.id ?? null, source: ap.source, verified: ap.verified, inputPerMillion: ap.inputMicros, outputPerMillion: ap.outputMicros, effectiveFrom: ap.effectiveFrom?.toISOString() ?? null, stale: Boolean(ap.stale), reference: ap.sourceReference ?? null } : null,
      cacheThisInstance: { present: cached !== null, rowId: cached?.id ?? null },
      activeUsages: actifs.get(model) ?? [],
      calls: { total, success, error, inputTokens: it, outputTokens: ot, lastAt, byStatus, corrected, unknownCost: Math.max(0, unknownCost), servedModels },
      unpricedCauses: causes.get(model) ?? {},
      regularizable: regul.get(model) ?? 0,
      alerts: { open: al.filter((a) => a.open === true).length, resolved: al.filter((a) => a.resolved === true).length, codes: [...new Set(al.map((a) => String(a.code)))].sort() },
    };
    models.push({ ...e, ...decideCause(e, servedPriced) });
  }

  const totals = Object.fromEntries(RECONCILIATION_CAUSES.map((c) => [c, models.filter((m) => m.primaryCause === c).length])) as Record<ReconciliationCause, number>;
  const thisVersion = P.getCacheState().version ?? null;
  const sharedVersion = shared ? Number(shared.version) : null;
  const recentes = instances.filter((i) => Date.now() - new Date(String(i.updated_at)).getTime() < 20 * 60_000);
  return {
    schema: 'verebona.ai-pricing.reconciliation/1',
    generatedAt: now.toISOString(),
    windowDays: days,
    lastSync: last ?? lastFallback,
    snapshot: snap ? {
      id: Number(snap.id), fingerprint: String(snap.fingerprint), bytes: num(snap.page_bytes), format: snap.page_format == null ? null : String(snap.page_format),
      finalUrl: snap.final_url == null ? null : String(snap.final_url), httpStatus: snap.http_status == null ? null : Number(snap.http_status),
      firstSeenAt: iso(snap.first_seen_at), lastSeenAt: iso(snap.last_seen_at), truncated: Boolean(snap.truncated), redactions: num(snap.redactions),
      reparsedFormat: detectPricingFormat(raw ?? ''), sections: page?.ok ? page.sections.length : 0,
      modelIds: page?.ok ? new Set(page.sections.flatMap((x) => x.modelIds)).size : 0,
    } : null,
    migrations,
    cache: {
      sharedVersion,
      thisInstance: { instanceId: P.pricingInstanceId(), version: thisVersion, loadedAt: P.getCacheState().loadedAt?.toISOString() ?? null, prices: P.getCacheState().size, degraded: P.getCacheState().degraded },
      instances: instances.map((i) => ({ instanceId: String(i.instance_id), version: i.version == null ? null : Number(i.version), loadedAt: iso(i.loaded_at), prices: num(i.prices), degraded: Boolean(i.degraded), updatedAt: iso(i.updated_at) })),
      consistent: sharedVersion === null || recentes.length === 0 ? null : recentes.every((i) => i.version != null && Number(i.version) === sharedVersion),
    },
    totals,
    models,
  };
}

const CSV_COLUMNS = [
  'model', 'primary_cause', 'cause_label', 'causes', 'alert_state', 'flagged_by', 'in_catalog', 'catalog_available', 'catalog_version',
  'page_verdict', 'page_code', 'page_mentioned', 'page_section', 'page_input_usd_per_m', 'page_output_usd_per_m', 'page_modality_dependent',
  'status', 'status_code', 'status_reason', 'stale_since', 'absent_reads',
  'applied_source', 'applied_verified', 'applied_row', 'applied_input_usd_per_m', 'applied_output_usd_per_m', 'applied_from', 'applied_stale', 'cache_this_instance',
  'active_usages', 'calls_30d', 'calls_success', 'calls_error', 'input_tokens', 'output_tokens', 'last_call_at',
  'cost_unknown_calls', 'cost_zero_or_rounded_calls', 'corrected_calls', 'regularizable_calls', 'served_models', 'unpriced_causes',
  'alerts_open', 'alerts_resolved', 'pricing', 'action',
] as const;

const cell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Export CSV (séparateur « ; », une ligne par identifiant ; pur). */
export function reconciliationCsv(r: PricingReconciliationReport): string {
  const lignes = [CSV_COLUMNS.join(';')];
  for (const m of r.models) {
    const v: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      model: m.model, primary_cause: m.primaryCause, cause_label: m.causeLabel, causes: m.causes.join(' '), alert_state: m.alertState, flagged_by: m.flaggedBy.join(', '),
      in_catalog: m.catalog ? 'oui' : 'non', catalog_available: m.catalog ? (m.catalog.available ? 'oui' : 'non') : '', catalog_version: m.catalog?.version,
      page_verdict: m.page.verdict, page_code: m.page.code, page_mentioned: m.page.mentioned ? 'oui' : 'non', page_section: m.page.section,
      page_input_usd_per_m: m.page.inputPerMillion, page_output_usd_per_m: m.page.outputPerMillion, page_modality_dependent: m.page.modalityDependent ? 'oui' : 'non',
      status: m.status?.status ?? 'NON_ÉVALUÉ', status_code: m.status?.reasonCode, status_reason: m.status?.reason, stale_since: m.status?.staleSince, absent_reads: m.status?.absentReads,
      applied_source: m.applied?.source, applied_verified: m.applied ? (m.applied.verified ? 'oui' : 'non') : '', applied_row: m.applied?.rowId,
      applied_input_usd_per_m: m.applied?.inputPerMillion, applied_output_usd_per_m: m.applied?.outputPerMillion, applied_from: m.applied?.effectiveFrom,
      applied_stale: m.applied ? (m.applied.stale ? 'oui' : 'non') : '', cache_this_instance: m.cacheThisInstance.present ? 'oui' : 'non',
      active_usages: m.activeUsages.join(', '), calls_30d: m.calls.total, calls_success: m.calls.success, calls_error: m.calls.error,
      input_tokens: m.calls.inputTokens, output_tokens: m.calls.outputTokens, last_call_at: m.calls.lastAt,
      cost_unknown_calls: m.calls.unknownCost, cost_zero_or_rounded_calls: m.calls.byStatus.zero_or_rounded ?? 0, corrected_calls: m.calls.corrected,
      regularizable_calls: m.regularizable, served_models: Object.entries(m.calls.servedModels).map(([k, n]) => `${k}=${n}`).join(' '),
      unpriced_causes: Object.entries(m.unpricedCauses).map(([k, n]) => `${k}=${n}`).join(' '),
      alerts_open: m.alerts.open, alerts_resolved: m.alerts.resolved, pricing: m.pricing, action: m.action,
    };
    lignes.push(CSV_COLUMNS.map((c) => cell(v[c])).join(';'));
  }
  return `﻿${lignes.join('\r\n')}\r\n`;
}
