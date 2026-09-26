/**
 * KPI du Dashboard back-office — CDC Back-Office V1 §4.1 à §4.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES COMMUNES (§4.1)
 *
 *  - DASH-004 : chaque KPI porte sa valeur ET celle de la période précédente
 *    de même nature (voir `lib/admin/periods.ts` pour la période en cours).
 *  - DASH-005 : un KPI de STOCK (comptes, abonnements actifs, MRR…) se lit à
 *    la fin de la période et se compare au stock à la fin de la période
 *    précédente. Un KPI de FLUX (inscriptions, CA…) se somme sur la période.
 *  - DASH-006 : stagnation = égalité STRICTE (`===`), sans tolérance.
 *  - DASH-007 : le SENS (hausse / baisse / stagnation) est distinct du
 *    CARACTÈRE (favorable / défavorable / neutre), qui dépend de la polarité
 *    du KPI : une hausse d'anomalies ou de résiliations est défavorable.
 *
 * Les fonctions pures (tendance, MRR, taux, médiane, stockage) sont exportées
 * et testées sans base. Les requêtes utilisent `pgClient.unsafe` avec des
 * fenêtres passées en JSON : une seule requête calcule la période, la période
 * précédente et toutes les périodes des graphiques.
 *
 * Aucun fragment SQL n'est construit à partir d'une entrée utilisateur : les
 * seuls paramètres variables sont des dates, transmises en paramètres liés.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RECONSTITUTION DES ABONNEMENTS À UNE DATE PASSÉE
 *
 * `account_subscriptions` ne garde que l'état COURANT (une ligne par compte).
 * Un abonnement payant est considéré actif à l'instant t si :
 *   début = 1re facturation (à défaut conclusion du contrat, début de période,
 *           création) < t
 *   fin   = résiliation effective (`subscription_history`, événement Stripe
 *           `customer.subscription.deleted`), à défaut dernière mise à jour
 *           d'une ligne `canceled`/`readonly` ; NULL si toujours active ;
 *   et fin IS NULL OU fin >= t.
 * L'offre et la périodicité retenues sont les ACTUELLES : un upgrade réécrit
 * donc la ventilation par offre des périodes passées. Les prix sont ceux du
 * catalogue actuel (`subscription_plans`). Limites connues, documentées dans
 * le rendu du lot.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  seriesBuckets,
  type ResolvedPeriod,
} from '@/lib/admin/periods';
import { DEFAULT_STORAGE_LIMIT_BYTES } from '@/lib/storage-quota';
import { mapLegacyPlanTypeToCommercialCode } from '@/services/commercial-model.service';

// ─── Tendance (DASH-004 à DASH-007) ─────────────────────────────────────────

/** Polarité : ce qu'une HAUSSE signifie pour le pilotage. */
export type KpiPolarity = 'up_good' | 'up_bad' | 'neutral';
export type KpiDirection = 'up' | 'down' | 'flat';
export type KpiTone = 'favorable' | 'unfavorable' | 'neutral';
export type KpiUnit = 'count' | 'cents' | 'bytes' | 'ratio';
/** Stock (lu en fin de période) ou flux (sommé sur la période) — DASH-005. */
export type KpiNature = 'stock' | 'flow';

export interface KpiValue {
  value: number | null;
  previous: number | null;
  /** null si l'une des deux valeurs est indisponible (taux sans dénominateur). */
  direction: KpiDirection | null;
  /** Évolution relative en %, null si la valeur précédente est nulle ou absente. */
  changePct: number | null;
  /** Pour un taux : écart en points de pourcentage. */
  deltaPoints: number | null;
  tone: KpiTone;
  unit: KpiUnit;
  nature: KpiNature;
  polarity: KpiPolarity;
}

/** DASH-006 : stagnation = égalité stricte, aucune bande de tolérance. */
export function trendDirection(value: number | null, previous: number | null): KpiDirection | null {
  if (value === null || previous === null) return null;
  if (value === previous) return 'flat';
  return value > previous ? 'up' : 'down';
}

/** DASH-007 : caractère favorable / défavorable, distinct du sens. */
export function trendTone(direction: KpiDirection | null, polarity: KpiPolarity): KpiTone {
  if (direction === null || direction === 'flat' || polarity === 'neutral') return 'neutral';
  const good = polarity === 'up_good' ? 'up' : 'down';
  return direction === good ? 'favorable' : 'unfavorable';
}

/** Évolution relative en % ; indéfinie depuis zéro (pas de « +∞ % »). */
export function changePercent(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return ((value - previous) / Math.abs(previous)) * 100;
}

export function buildKpi(
  value: number | null,
  previous: number | null,
  opts: { polarity: KpiPolarity; unit?: KpiUnit; nature: KpiNature },
): KpiValue {
  const direction = trendDirection(value, previous);
  const unit = opts.unit ?? 'count';
  return {
    value,
    previous,
    direction,
    changePct: changePercent(value, previous),
    deltaPoints: unit === 'ratio' && value !== null && previous !== null ? (value - previous) * 100 : null,
    tone: trendTone(direction, opts.polarity),
    unit,
    nature: opts.nature,
    polarity: opts.polarity,
  };
}

// ─── Calculs purs ───────────────────────────────────────────────────────────

/**
 * Taux à dénominateur explicite (DACT-002, conversion, churn). Dénominateur
 * nul → null (« non calculable »), jamais 0 % : 0 sur 0 n'est pas un échec.
 */
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Médiane (moyenne des deux valeurs centrales si effectif pair). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

export interface PlanPrice {
  code: string;
  label: string;
  monthlyPriceCents: number | null;
  yearlyPriceCents: number | null;
  displayOrder: number;
  /** Offre commercialisée (visible ou souscriptible) : affichée même à zéro. */
  offered: boolean;
}

export interface ActiveSubscriptionGroup {
  planCode: string;
  billingPeriod: string | null;
  count: number;
}

/**
 * Revenu mensuel d'UN abonnement, en centimes : prix mensuel pour un
 * abonnement mensuel, prix annuel / 12 pour un annuel (règle de
 * normalisation standard du MRR). Offre ou prix inconnus → 0.
 */
export function monthlyRevenueCents(
  planCode: string,
  billingPeriod: string | null,
  plans: Map<string, PlanPrice>,
): number {
  const plan = plans.get(planCode);
  if (!plan) return 0;
  if (billingPeriod === 'yearly') return (plan.yearlyPriceCents ?? 0) / 12;
  if (billingPeriod === 'monthly') return plan.monthlyPriceCents ?? 0;
  return 0;
}

/** MRR (centimes, arrondi) des abonnements actifs — MRR global (§4.4). */
export function computeMrrCents(groups: ActiveSubscriptionGroup[], plans: Map<string, PlanPrice>): number {
  const total = groups.reduce((s, g) => s + g.count * monthlyRevenueCents(g.planCode, g.billingPeriod, plans), 0);
  return Math.round(total);
}

/** ARR = annualisation du MRR. */
export function computeArrCents(mrrCents: number): number {
  return mrrCents * 12;
}

/** Rang d'offre, pour distinguer montée et baisse (§4.4 Upgrades/Downgrades). */
export const PLAN_RANK: Record<string, number> = {
  STANDARD: 1, standard: 1,
  PREMIUM: 2, premium: 2,
  PREMIUM_DUO: 3, premium_duo: 3,
  PREMIUM_PRO: 4, premium_pro: 4,
};

export function classifyPlanChange(oldTier: string | null, newTier: string): 'upgrade' | 'downgrade' | null {
  const a = oldTier ? PLAN_RANK[oldTier] : undefined;
  const b = PLAN_RANK[newTier];
  if (!a || !b || a === b) return null;
  return b > a ? 'upgrade' : 'downgrade';
}

export interface StorageAccountRow {
  usedBytes: number;
  limitBytes: number;
}

export interface StorageStats {
  totalBytes: number;
  meanBytes: number | null;
  medianBytes: number | null;
  maxBytes: number;
  /** Taux moyen d'utilisation du quota (0-1). */
  meanQuotaRate: number | null;
  /** Comptes à 80 % ou plus (100 % inclus). */
  accountsAtLeast80: number;
  /** Comptes ayant atteint le plafond. */
  accountsAt100: number;
}

/**
 * Bloc Stockage (§4.3, DACT-007). Les seuils 80 % / 100 % sont des
 * indicateurs, jamais des anomalies (DACT-008, STO-004).
 */
export function computeStorageStats(rows: StorageAccountRow[]): StorageStats {
  const used = rows.map((r) => r.usedBytes);
  const rates = rows.filter((r) => r.limitBytes > 0).map((r) => r.usedBytes / r.limitBytes);
  return {
    totalBytes: used.reduce((s, v) => s + v, 0),
    meanBytes: mean(used),
    medianBytes: median(used),
    maxBytes: used.length ? Math.max(...used) : 0,
    meanQuotaRate: mean(rates),
    accountsAtLeast80: rates.filter((r) => r >= 0.8).length,
    accountsAt100: rates.filter((r) => r >= 1).length,
  };
}

// ─── Accès base ─────────────────────────────────────────────────────────────

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const rows = await pgClient.unsafe(sql, params as never[]);
  return rows as unknown as T[];
}

const iso = (d: Date) => d.toISOString();

interface Window { i: number; s: string; e: string }
interface Point { i: number; e: string }

/** Fenêtres de flux passées en JSON : `jsonb_to_recordset($1)`. */
const W = `jsonb_to_recordset($1::jsonb) AS w(i int, s timestamptz, e timestamptz)`;
/** Instants de stock : `jsonb_to_recordset($1)`. */
const P = `jsonb_to_recordset($1::jsonb) AS p(i int, e timestamptz)`;

/** Début d'un abonnement payant (voir en-tête). */
const SUB_START = `COALESCE(s.first_billed_at, s.contract_concluded_at, s.current_period_start_at, s.created_at)`;
/** Fin effective d'un abonnement payant (voir en-tête). */
const SUB_END = `CASE WHEN s.status IN ('canceled', 'readonly') THEN COALESCE(
    (SELECT min(sh.created_at) FROM subscription_history sh
      WHERE sh.account_id = s.account_id
        AND sh.source LIKE 'webhook:customer.subscription.deleted%'
        AND sh.created_at >= ${SUB_START}),
    s.updated_at) END`;
/**
 * Abonnements PAYANTS : périodicité connue (NULL pendant l'essai) et hors
 * essai. Intervalle [started_at, ended_at).
 */
const PAID_CTE = `paid AS (
  SELECT s.account_id, s.plan_code, s.billing_period,
         ${SUB_START} AS started_at, ${SUB_END} AS ended_at
    FROM account_subscriptions s
   WHERE s.billing_period IS NOT NULL AND s.status <> 'trialing'
)`;

/** Fichiers documentaires comptés (dépôt confirmé, hors liens web). */
const DOC_FILTER = `x.is_web_link = false AND (x.upload_status = 'COMPLETED' OR x.upload_status IS NULL)`;

type ByIndex<T> = Map<number, T>;

async function countAt(table: string, where: string, points: Point[]): Promise<ByIndex<number>> {
  const rows = await q<{ i: number; n: number }>(
    `SELECT p.i, (SELECT count(*) FROM ${table} x WHERE x.created_at < p.e ${where ? `AND ${where}` : ''})::int AS n FROM ${P}`,
    [JSON.stringify(points)],
  );
  return new Map(rows.map((r) => [Number(r.i), Number(r.n)]));
}

async function countIn(table: string, dateCol: string, where: string, windows: Window[]): Promise<ByIndex<number>> {
  const rows = await q<{ i: number; n: number }>(
    `SELECT w.i, (SELECT count(*) FROM ${table} x WHERE x.${dateCol} >= w.s AND x.${dateCol} < w.e ${where ? `AND ${where}` : ''})::int AS n FROM ${W}`,
    [JSON.stringify(windows)],
  );
  return new Map(rows.map((r) => [Number(r.i), Number(r.n)]));
}

export async function loadPlans(): Promise<Map<string, PlanPrice>> {
  const rows = await q<{ code: string; label: string; monthly: number | null; yearly: number | null; ord: number; offered: boolean }>(
    `SELECT code, label, monthly_price_cents AS monthly, yearly_price_cents AS yearly, display_order AS ord,
            (is_visible OR is_subscribable) AS offered
       FROM subscription_plans ORDER BY display_order, code`,
  );
  return new Map(rows.map((r) => [r.code, {
    code: r.code,
    label: r.label,
    monthlyPriceCents: r.monthly === null ? null : Number(r.monthly),
    yearlyPriceCents: r.yearly === null ? null : Number(r.yearly),
    displayOrder: Number(r.ord),
    offered: Boolean(r.offered),
  }]));
}

/** Abonnements payants actifs à chaque instant, par offre × périodicité. */
async function activeSubscriptionsAt(points: Point[]): Promise<ByIndex<ActiveSubscriptionGroup[]>> {
  const rows = await q<{ i: number; plan_code: string; billing_period: string | null; n: number }>(
    `WITH ${PAID_CTE}
     SELECT p.i, paid.plan_code, paid.billing_period, count(*)::int AS n
       FROM ${P}
       JOIN paid ON paid.started_at < p.e AND (paid.ended_at IS NULL OR paid.ended_at >= p.e)
      GROUP BY p.i, paid.plan_code, paid.billing_period`,
    [JSON.stringify(points)],
  );
  const out: ByIndex<ActiveSubscriptionGroup[]> = new Map(points.map((p) => [p.i, []]));
  for (const r of rows) {
    out.get(Number(r.i))?.push({ planCode: r.plan_code, billingPeriod: r.billing_period, count: Number(r.n) });
  }
  return out;
}

/** CA encaissé (factures payées), par devise — DOV-002 : avant frais Stripe. */
async function revenueIn(windows: Window[]): Promise<ByIndex<Record<string, number>>> {
  const rows = await q<{ i: number; currency: string; cents: string }>(
    `SELECT w.i, lower(inv.currency) AS currency, sum(inv.amount)::bigint AS cents
       FROM ${W}
       JOIN invoices inv ON inv.status = 'paid' AND inv.paid_at >= w.s AND inv.paid_at < w.e
      GROUP BY w.i, lower(inv.currency)`,
    [JSON.stringify(windows)],
  );
  const out: ByIndex<Record<string, number>> = new Map(windows.map((w) => [w.i, {}]));
  for (const r of rows) {
    const m = out.get(Number(r.i));
    if (m) m[r.currency] = Number(r.cents);
  }
  return out;
}

/** Devise principale des montants de pilotage (prix catalogue en euros). */
export const MAIN_CURRENCY = 'eur';

// ─── Fenêtres standard ──────────────────────────────────────────────────────

/** Indices réservés : 0 = période, 1 = période précédente, 2+ = séries. */
const CUR = 0;
const PREV = 1;

function mainWindows(p: ResolvedPeriod): Window[] {
  return [
    { i: CUR, s: iso(p.start), e: iso(p.asOf) },
    { i: PREV, s: iso(p.prevStart), e: iso(p.prevFlowEnd) },
  ];
}

function mainPoints(p: ResolvedPeriod): Point[] {
  return [
    { i: CUR, e: iso(p.asOf) },
    { i: PREV, e: iso(p.prevEnd) },
  ];
}

const n0 = (m: ByIndex<number>, i: number) => m.get(i) ?? 0;
const sumGroups = (g: ActiveSubscriptionGroup[] | undefined) => (g ?? []).reduce((s, x) => s + x.count, 0);

export interface PeriodInfo {
  kind: ResolvedPeriod['kind'];
  label: string;
  prevLabel: string;
  ref: string;
  prevRef: string;
  nextRef: string;
  start: string;
  end: string;
  asOf: string;
  inProgress: boolean;
}

export function periodInfo(p: ResolvedPeriod): PeriodInfo {
  return {
    kind: p.kind, label: p.label, prevLabel: p.prevLabel, ref: p.ref, prevRef: p.prevRef,
    nextRef: p.nextRef, start: iso(p.start), end: iso(p.end), asOf: iso(p.asOf), inProgress: p.inProgress,
  };
}

export interface PlanBreakdownRow {
  planCode: string;
  label: string;
  monthly: number;
  yearly: number;
  total: number;
}

/** Ventilation offre × périodicité, dans l'ordre du catalogue. */
export function breakdownByPlan(groups: ActiveSubscriptionGroup[], plans: Map<string, PlanPrice>): PlanBreakdownRow[] {
  const rows = new Map<string, PlanBreakdownRow>();
  for (const plan of plans.values()) {
    rows.set(plan.code, { planCode: plan.code, label: plan.label, monthly: 0, yearly: 0, total: 0 });
  }
  for (const g of groups) {
    const row = rows.get(g.planCode)
      ?? { planCode: g.planCode, label: g.planCode, monthly: 0, yearly: 0, total: 0 };
    if (g.billingPeriod === 'yearly') row.yearly += g.count;
    else row.monthly += g.count;
    row.total += g.count;
    rows.set(g.planCode, row);
  }
  // Offres non commercialisées et sans abonné (premium_pro) : masquées.
  return [...rows.values()].filter((r) => r.total > 0 || plans.get(r.planCode)?.offered);
}

// ─── Vue d'ensemble (§4.2) ──────────────────────────────────────────────────

export interface OverviewData {
  period: PeriodInfo;
  kpis: {
    accounts: KpiValue;
    users: KpiValue;
    activeSubscriptions: KpiValue;
    signups: KpiValue;
    revenue: KpiValue;
    mrr: KpiValue;
    arr: KpiValue;
    openAnomalies: KpiValue;
  };
  /** Ventilation des abonnements actifs par offre (fin de période). */
  activeByPlan: PlanBreakdownRow[];
  /** CA encaissé dans d'autres devises que l'euro (UX-007), non additionné. */
  otherCurrencies: Record<string, number>;
  series: Array<{ label: string; revenueCents: number; mrrCents: number; signups: number; activeSubscriptions: number }>;
}

export async function getOverview(p: ResolvedPeriod): Promise<OverviewData> {
  const buckets = seriesBuckets(p);
  const points: Point[] = [...mainPoints(p), ...buckets.map((b, k) => ({ i: 2 + k, e: iso(b.end) }))];
  const windows: Window[] = [...mainWindows(p), ...buckets.map((b, k) => ({ i: 2 + k, s: iso(b.start), e: iso(b.end) }))];

  const [plans, accounts, users, signups, revenue, subs, anomalies] = await Promise.all([
    loadPlans(),
    countAt('accounts', '', points.slice(0, 2)),
    countAt('users', '', points.slice(0, 2)),
    countIn('accounts', 'created_at', '', windows),
    revenueIn(windows),
    activeSubscriptionsAt(points),
    openAnomaliesAt(points.slice(0, 2)),
  ]);

  const eur = (i: number) => revenue.get(i)?.[MAIN_CURRENCY] ?? 0;
  const mrr = (i: number) => computeMrrCents(subs.get(i) ?? [], plans);
  const otherCurrencies = Object.fromEntries(
    Object.entries(revenue.get(CUR) ?? {}).filter(([c]) => c !== MAIN_CURRENCY),
  );

  return {
    period: periodInfo(p),
    kpis: {
      accounts: buildKpi(n0(accounts, CUR), n0(accounts, PREV), { polarity: 'up_good', nature: 'stock' }),
      users: buildKpi(n0(users, CUR), n0(users, PREV), { polarity: 'up_good', nature: 'stock' }),
      activeSubscriptions: buildKpi(sumGroups(subs.get(CUR)), sumGroups(subs.get(PREV)), { polarity: 'up_good', nature: 'stock' }),
      signups: buildKpi(n0(signups, CUR), n0(signups, PREV), { polarity: 'up_good', nature: 'flow' }),
      revenue: buildKpi(eur(CUR), eur(PREV), { polarity: 'up_good', unit: 'cents', nature: 'flow' }),
      mrr: buildKpi(mrr(CUR), mrr(PREV), { polarity: 'up_good', unit: 'cents', nature: 'stock' }),
      arr: buildKpi(computeArrCents(mrr(CUR)), computeArrCents(mrr(PREV)), { polarity: 'up_good', unit: 'cents', nature: 'stock' }),
      // DASH-007 : une hausse d'anomalies est défavorable.
      openAnomalies: buildKpi(n0(anomalies, CUR), n0(anomalies, PREV), { polarity: 'up_bad', nature: 'stock' }),
    },
    activeByPlan: breakdownByPlan(subs.get(CUR) ?? [], plans),
    otherCurrencies,
    series: buckets.map((b, k) => ({
      label: b.label,
      revenueCents: eur(2 + k),
      mrrCents: mrr(2 + k),
      signups: n0(signups, 2 + k),
      activeSubscriptions: sumGroups(subs.get(2 + k)),
    })),
  };
}

/** Anomalies ouvertes à un instant (stock, DASH-005). */
async function openAnomaliesAt(points: Point[]): Promise<ByIndex<number>> {
  const rows = await q<{ i: number; n: number }>(
    `SELECT p.i, (SELECT count(*) FROM admin_anomalies an
                   WHERE an.first_seen_at < p.e
                     AND (an.resolved_at IS NULL OR an.resolved_at >= p.e))::int AS n
       FROM ${P}`,
    [JSON.stringify(points)],
  );
  return new Map(rows.map((r) => [Number(r.i), Number(r.n)]));
}

// ─── Activité (§4.3) ────────────────────────────────────────────────────────

export interface PerAccountStat {
  total: KpiValue;
  created: KpiValue;
  meanPerAccount: KpiValue;
  medianPerAccount: KpiValue;
}

export interface ActivityData {
  period: PeriodInfo;
  kpis: {
    activeAccounts: KpiValue;
    activeAccountsRate: KpiValue;
    /** Dénominateur du taux (DACT-002) : comptes accessibles sur la période. */
    accessibleAccounts: number;
    assets: PerAccountStat;
    documents: PerAccountStat;
    storage: {
      total: KpiValue;
      added: KpiValue;
      meanPerAccount: KpiValue;
      medianPerAccount: KpiValue;
      maxPerAccount: KpiValue;
      meanQuotaRate: KpiValue;
      accountsAtLeast80: KpiValue;
      accountsAt100: KpiValue;
    };
    exports: KpiValue;
    transmissions: KpiValue;
    deadlinesManual: KpiValue;
    deadlinesAi: KpiValue;
  };
  series: Array<{ label: string; activeAccounts: number; activeRate: number | null; assetsCreated: number; documentsAdded: number }>;
}

/**
 * DACT-001 : compte actif = au moins une connexion (LOGIN_SUCCESS) d'un
 * utilisateur rattaché pendant la période. Rattachement : titulaire du compte
 * ou membre actif (rattachement actuel — l'historique des adhésions n'est pas
 * conservé).
 * DACT-002 : dénominateur STABLE = comptes créés avant la fin de la fenêtre,
 * c'est-à-dire accessibles à un moment de la période (les comptes supprimés
 * disparaissent de la base et ne peuvent être comptés, ni au numérateur ni au
 * dénominateur). Le numérateur est borné à ce même ensemble : taux ≤ 100 %.
 */
async function activeAccountsIn(windows: Window[]): Promise<ByIndex<{ active: number; accessible: number }>> {
  const rows = await q<{ i: number; active: number; accessible: number }>(
    `SELECT w.i,
       (SELECT count(DISTINCT a.id) FROM accounts a
          WHERE a.created_at < w.e
            AND EXISTS (
              SELECT 1 FROM user_activity_log l
               WHERE l.activity_type = 'LOGIN_SUCCESS'
                 AND l.timestamp >= w.s AND l.timestamp < w.e
                 AND (l.user_id = a.owner_user_id OR EXISTS (
                       SELECT 1 FROM account_memberships m
                        WHERE m.account_id = a.id AND m.user_id = l.user_id AND m.status = 'active'))
            ))::int AS active,
       (SELECT count(*) FROM accounts a WHERE a.created_at < w.e)::int AS accessible
     FROM ${W}`,
    [JSON.stringify(windows)],
  );
  return new Map(rows.map((r) => [Number(r.i), { active: Number(r.active), accessible: Number(r.accessible) }]));
}

/**
 * Stock par compte à chaque instant (biens ou documents) : un élément par
 * compte existant, zéro compris — la moyenne et la médiane « par compte »
 * portent sur tous les comptes, pas seulement ceux qui en ont.
 */
async function perAccountCountsAt(table: string, extra: string, points: Point[]): Promise<ByIndex<number[]>> {
  const rows = await q<{ i: number; n: number }>(
    `SELECT p.i, (SELECT count(*) FROM ${table} x
                   WHERE x.account_id = a.id AND x.created_at < p.e
                     AND (x.deleted_at IS NULL OR x.deleted_at >= p.e) ${extra ? `AND ${extra}` : ''})::int AS n
       FROM ${P} JOIN accounts a ON a.created_at < p.e`,
    [JSON.stringify(points)],
  );
  const out: ByIndex<number[]> = new Map(points.map((pt) => [pt.i, []]));
  for (const r of rows) out.get(Number(r.i))?.push(Number(r.n));
  return out;
}

async function storageRowsAt(points: Point[]): Promise<ByIndex<StorageAccountRow[]>> {
  const [rows, limits] = await Promise.all([
    q<{ i: number; used: string; plan_code: string | null; plan_type: string }>(
      `SELECT p.i,
         (SELECT coalesce(sum(x.size), 0) FROM asset_files x
           WHERE x.account_id = a.id AND ${DOC_FILTER}
             AND x.created_at < p.e AND (x.deleted_at IS NULL OR x.deleted_at >= p.e))::bigint AS used,
         s.plan_code, a.plan_type
       FROM ${P}
       JOIN accounts a ON a.created_at < p.e
       LEFT JOIN account_subscriptions s ON s.account_id = a.id`,
      [JSON.stringify(points)],
    ),
    q<{ plan_code: string; max: string | null }>(`SELECT plan_code, max_storage_bytes AS max FROM plan_limits`),
  ]);
  // Plafond : `plan_limits`, repli sur les constantes du §13.1 (STO-001).
  const limitOf = (code: string) => {
    const fromDb = limits.find((l) => l.plan_code === code)?.max;
    const n = fromDb === null || fromDb === undefined ? 0 : Number(fromDb);
    return n > 0 ? n : DEFAULT_STORAGE_LIMIT_BYTES[code as keyof typeof DEFAULT_STORAGE_LIMIT_BYTES] ?? 0;
  };
  const out: ByIndex<StorageAccountRow[]> = new Map(points.map((pt) => [pt.i, []]));
  for (const r of rows) {
    const code = r.plan_code ?? mapLegacyPlanTypeToCommercialCode(r.plan_type);
    out.get(Number(r.i))?.push({ usedBytes: Number(r.used), limitBytes: limitOf(code) });
  }
  return out;
}

async function sumSizeIn(windows: Window[]): Promise<ByIndex<number>> {
  const rows = await q<{ i: number; n: string }>(
    `SELECT w.i, (SELECT coalesce(sum(x.size), 0) FROM asset_files x
                   WHERE ${DOC_FILTER} AND x.created_at >= w.s AND x.created_at < w.e)::bigint AS n
       FROM ${W}`,
    [JSON.stringify(windows)],
  );
  return new Map(rows.map((r) => [Number(r.i), Number(r.n)]));
}

function perAccountStat(
  totals: ByIndex<number>, created: ByIndex<number>, perAccount: ByIndex<number[]>,
): PerAccountStat {
  const avg = (i: number) => mean(perAccount.get(i) ?? []);
  const med = (i: number) => median(perAccount.get(i) ?? []);
  return {
    total: buildKpi(n0(totals, CUR), n0(totals, PREV), { polarity: 'up_good', nature: 'stock' }),
    created: buildKpi(n0(created, CUR), n0(created, PREV), { polarity: 'up_good', nature: 'flow' }),
    meanPerAccount: buildKpi(avg(CUR), avg(PREV), { polarity: 'up_good', nature: 'stock' }),
    medianPerAccount: buildKpi(med(CUR), med(PREV), { polarity: 'up_good', nature: 'stock' }),
  };
}

/**
 * Échéances créées par l'IA : issues d'un document qualifié par l'analyse
 * (`origin_type = 'qualified_document'`) ou tracées comme créées par un run
 * d'analyse (`agenda_item_sources.effect_type = 'created'`). Manuelles :
 * `origin_type = 'manual'`. Les échéances déduites de champs ou de règles et
 * les reprises legacy ne sont ni l'un ni l'autre.
 */
const AI_DEADLINE = `(x.origin_type = 'qualified_document' OR EXISTS (
  SELECT 1 FROM agenda_item_sources src WHERE src.agenda_item_id = x.id AND src.effect_type = 'created'))`;

export async function getActivity(p: ResolvedPeriod): Promise<ActivityData> {
  const buckets = seriesBuckets(p);
  const points = mainPoints(p);
  const windows = mainWindows(p);
  const seriesWindows: Window[] = [...windows, ...buckets.map((b, k) => ({ i: 2 + k, s: iso(b.start), e: iso(b.end) }))];
  const assetStock = `(x.deleted_at IS NULL OR x.deleted_at >= p.e)`;

  const [
    active, assetsTotal, assetsCreated, assetsPerAccount,
    docsTotal, docsCreated, docsPerAccount,
    storage, added, exportsN, transmissions, manual, ai,
  ] = await Promise.all([
    activeAccountsIn(seriesWindows),
    countAt('assets', assetStock, points),
    countIn('assets', 'created_at', '', seriesWindows),
    perAccountCountsAt('assets', '', points),
    countAt('asset_files', `${DOC_FILTER} AND ${assetStock}`, points),
    countIn('asset_files', 'created_at', DOC_FILTER, seriesWindows),
    perAccountCountsAt('asset_files', DOC_FILTER, points),
    storageRowsAt(points),
    sumSizeIn(windows),
    // DACT-006 : exports générés avec succès, tous modèles confondus.
    countIn('export_generation', 'completed_at', `x.status IN ('ready', 'deleted')`, windows),
    // Transmissions envoyées (un seul type, aucune ventilation).
    countIn('asset_transmissions', 'sent_at', '', windows),
    countIn('agenda_items', 'created_at', `x.origin_type = 'manual'`, windows),
    countIn('agenda_items', 'created_at', AI_DEADLINE, windows),
  ]);

  const st = (i: number) => computeStorageStats(storage.get(i) ?? []);
  const sCur = st(CUR);
  const sPrev = st(PREV);
  const act = (i: number) => active.get(i) ?? { active: 0, accessible: 0 };

  return {
    period: periodInfo(p),
    kpis: {
      activeAccounts: buildKpi(act(CUR).active, act(PREV).active, { polarity: 'up_good', nature: 'flow' }),
      activeAccountsRate: buildKpi(
        rate(act(CUR).active, act(CUR).accessible),
        rate(act(PREV).active, act(PREV).accessible),
        { polarity: 'up_good', unit: 'ratio', nature: 'flow' },
      ),
      accessibleAccounts: act(CUR).accessible,
      assets: perAccountStat(assetsTotal, assetsCreated, assetsPerAccount),
      documents: perAccountStat(docsTotal, docsCreated, docsPerAccount),
      // DACT-008 : aucun de ces indicateurs n'est une anomalie ; polarité neutre.
      storage: {
        total: buildKpi(sCur.totalBytes, sPrev.totalBytes, { polarity: 'neutral', unit: 'bytes', nature: 'stock' }),
        added: buildKpi(n0(added, CUR), n0(added, PREV), { polarity: 'neutral', unit: 'bytes', nature: 'flow' }),
        meanPerAccount: buildKpi(sCur.meanBytes, sPrev.meanBytes, { polarity: 'neutral', unit: 'bytes', nature: 'stock' }),
        medianPerAccount: buildKpi(sCur.medianBytes, sPrev.medianBytes, { polarity: 'neutral', unit: 'bytes', nature: 'stock' }),
        maxPerAccount: buildKpi(sCur.maxBytes, sPrev.maxBytes, { polarity: 'neutral', unit: 'bytes', nature: 'stock' }),
        meanQuotaRate: buildKpi(sCur.meanQuotaRate, sPrev.meanQuotaRate, { polarity: 'neutral', unit: 'ratio', nature: 'stock' }),
        accountsAtLeast80: buildKpi(sCur.accountsAtLeast80, sPrev.accountsAtLeast80, { polarity: 'neutral', nature: 'stock' }),
        accountsAt100: buildKpi(sCur.accountsAt100, sPrev.accountsAt100, { polarity: 'neutral', nature: 'stock' }),
      },
      exports: buildKpi(n0(exportsN, CUR), n0(exportsN, PREV), { polarity: 'up_good', nature: 'flow' }),
      transmissions: buildKpi(n0(transmissions, CUR), n0(transmissions, PREV), { polarity: 'up_good', nature: 'flow' }),
      deadlinesManual: buildKpi(n0(manual, CUR), n0(manual, PREV), { polarity: 'up_good', nature: 'flow' }),
      deadlinesAi: buildKpi(n0(ai, CUR), n0(ai, PREV), { polarity: 'up_good', nature: 'flow' }),
    },
    series: buckets.map((b, k) => ({
      label: b.label,
      activeAccounts: act(2 + k).active,
      activeRate: rate(act(2 + k).active, act(2 + k).accessible),
      assetsCreated: n0(assetsCreated, 2 + k),
      documentsAdded: n0(docsCreated, 2 + k),
    })),
  };
}

// ─── Performance commerciale (§4.4) ─────────────────────────────────────────

export interface ConversionRow {
  planCode: string;
  label: string;
  /** Essais arrivés à terme sur la période (dénominateur). */
  ended: number;
  converted: number;
  convertedMonthly: number;
  convertedYearly: number;
  rate: number | null;
}

export interface CommercialData {
  period: PeriodInfo;
  kpis: {
    newTrials: KpiValue;
    newPaid: KpiValue;
    conversion: KpiValue;
    /** Dénominateur de la conversion : essais arrivés à terme sur la période. */
    trialsEnded: number;
    endedSubscriptions: KpiValue;
    churn: KpiValue;
    upgrades: KpiValue;
    downgrades: KpiValue;
    revenue: KpiValue;
    mrr: KpiValue;
    arr: KpiValue;
    arpa: KpiValue;
  };
  newPaidByPlan: Array<{ planCode: string; label: string; count: number }>;
  conversionByPlan: ConversionRow[];
  activeByPlan: PlanBreakdownRow[];
  revenueByPlan: Array<{ planCode: string; label: string; monthlyCents: number; yearlyCents: number; totalCents: number }>;
  otherCurrencies: Record<string, number>;
}

export async function getCommercial(p: ResolvedPeriod): Promise<CommercialData> {
  const windows = mainWindows(p);
  // Stock en DÉBUT de période : base du churn (fins / actifs au début).
  const points: Point[] = [...mainPoints(p), { i: 2, e: iso(p.start) }, { i: 3, e: iso(p.prevStart) }];
  const wj = JSON.stringify(windows);

  const [plans, trials, subs, newPaidRows, endedRows, conversionRows, changeRows, revenue, revenuePlanRows] = await Promise.all([
    loadPlans(),
    countIn('trial_grants', 'granted_at', '', windows),
    activeSubscriptionsAt(points),
    q<{ i: number; plan_code: string; n: number }>(
      `WITH ${PAID_CTE}
       SELECT w.i, paid.plan_code, count(*)::int AS n FROM ${W}
         JOIN paid ON paid.started_at >= w.s AND paid.started_at < w.e
        GROUP BY w.i, paid.plan_code`, [wj]),
    q<{ i: number; n: number }>(
      `WITH ${PAID_CTE}
       SELECT w.i, (SELECT count(*) FROM paid WHERE paid.ended_at >= w.s AND paid.ended_at < w.e)::int AS n
         FROM ${W}`, [wj]),
    // Conversion : dénominateur = essais ARRIVÉS À TERME pendant la période
    // (§4.4). Converti = conversion enregistrée avant la fin de la fenêtre,
    // pour qu'une période close garde un taux stable.
    q<{ i: number; plan_code: string | null; billing_period: string | null; converted: boolean; n: number }>(
      `SELECT w.i, s.plan_code, s.billing_period,
              (t.converted_at IS NOT NULL AND t.converted_at < w.e) AS converted, count(*)::int AS n
         FROM ${W}
         JOIN trial_grants t ON t.expires_at >= w.s AND t.expires_at < w.e
         LEFT JOIN account_subscriptions s ON s.account_id = t.account_id
        GROUP BY 1, 2, 3, 4`, [wj]),
    // Changements d'offre d'un compte DÉJÀ payant (hors fin d'abonnement,
    // hors activation depuis l'essai).
    q<{ i: number; old_tier: string | null; new_tier: string; n: number }>(
      `SELECT w.i, sh.old_tier, sh.new_tier, count(*)::int AS n
         FROM ${W}
         JOIN subscription_history sh ON sh.created_at >= w.s AND sh.created_at < w.e
         JOIN account_subscriptions s ON s.account_id = sh.account_id
        WHERE sh.source NOT LIKE 'webhook:customer.subscription.deleted%'
          AND COALESCE(s.first_billed_at, s.contract_concluded_at) < sh.created_at
        GROUP BY 1, 2, 3`, [wj]),
    revenueIn(windows),
    q<{ plan_code: string | null; billing_period: string | null; currency: string; cents: string }>(
      `SELECT s.plan_code, s.billing_period, lower(inv.currency) AS currency, sum(inv.amount)::bigint AS cents
         FROM invoices inv
         LEFT JOIN account_subscriptions s ON s.account_id = inv.account_id
        WHERE inv.status = 'paid' AND inv.paid_at >= $1 AND inv.paid_at < $2
        GROUP BY 1, 2, 3`, [iso(p.start), iso(p.asOf)]),
  ]);

  const labelOf = (code: string | null) => (code && plans.get(code)?.label) || code || 'Inconnue';

  // Nouveaux abonnements payants (+ ventilation par offre).
  const newPaid = (i: number) => newPaidRows.filter((r) => Number(r.i) === i).reduce((s, r) => s + Number(r.n), 0);
  const newPaidByPlan = [...plans.values()].map((pl) => ({
    planCode: pl.code,
    label: pl.label,
    count: newPaidRows.filter((r) => Number(r.i) === CUR && r.plan_code === pl.code).reduce((s, r) => s + Number(r.n), 0),
  })).filter((r) => r.count > 0 || plans.get(r.planCode)?.offered);

  // Conversion.
  const conv = (i: number) => {
    const rows = conversionRows.filter((r) => Number(r.i) === i);
    const ended = rows.reduce((s, r) => s + Number(r.n), 0);
    const converted = rows.filter((r) => r.converted).reduce((s, r) => s + Number(r.n), 0);
    return { ended, converted };
  };
  const byPlan = new Map<string, ConversionRow>();
  for (const r of conversionRows.filter((x) => Number(x.i) === CUR)) {
    const code = r.plan_code ?? 'inconnue';
    const row = byPlan.get(code) ?? {
      planCode: code, label: labelOf(r.plan_code), ended: 0, converted: 0, convertedMonthly: 0, convertedYearly: 0, rate: null,
    };
    row.ended += Number(r.n);
    if (r.converted) {
      row.converted += Number(r.n);
      if (r.billing_period === 'yearly') row.convertedYearly += Number(r.n);
      else row.convertedMonthly += Number(r.n);
    }
    byPlan.set(code, row);
  }
  const conversionByPlan = [...byPlan.values()].map((r) => ({ ...r, rate: rate(r.converted, r.ended) }));

  // Fins, churn (fins / actifs au début de la période).
  const ended = (i: number) => Number(endedRows.find((r) => Number(r.i) === i)?.n ?? 0);
  const churn = (i: number, startIdx: number) => rate(ended(i), sumGroups(subs.get(startIdx)));

  // Upgrades / downgrades.
  const changes = (i: number, kind: 'upgrade' | 'downgrade') => changeRows
    .filter((r) => Number(r.i) === i && classifyPlanChange(r.old_tier, r.new_tier) === kind)
    .reduce((s, r) => s + Number(r.n), 0);

  // MRR, ARR, revenu récurrent moyen par compte payant (un abonnement par compte).
  const mrr = (i: number) => computeMrrCents(subs.get(i) ?? [], plans);
  const arpa = (i: number) => {
    const paying = sumGroups(subs.get(i));
    return paying > 0 ? Math.round(mrr(i) / paying) : null;
  };
  const eur = (i: number) => revenue.get(i)?.[MAIN_CURRENCY] ?? 0;

  // CA offre × périodicité (euros ; autres devises signalées à part).
  const revMap = new Map<string, { planCode: string; label: string; monthlyCents: number; yearlyCents: number; totalCents: number }>();
  for (const r of revenuePlanRows.filter((x) => x.currency === MAIN_CURRENCY)) {
    const code = r.plan_code ?? 'inconnue';
    const row = revMap.get(code) ?? { planCode: code, label: labelOf(r.plan_code), monthlyCents: 0, yearlyCents: 0, totalCents: 0 };
    const cents = Number(r.cents);
    if (r.billing_period === 'yearly') row.yearlyCents += cents;
    else row.monthlyCents += cents;
    row.totalCents += cents;
    revMap.set(code, row);
  }

  const c = conv(CUR);
  const cp = conv(PREV);
  return {
    period: periodInfo(p),
    kpis: {
      newTrials: buildKpi(n0(trials, CUR), n0(trials, PREV), { polarity: 'up_good', nature: 'flow' }),
      newPaid: buildKpi(newPaid(CUR), newPaid(PREV), { polarity: 'up_good', nature: 'flow' }),
      conversion: buildKpi(rate(c.converted, c.ended), rate(cp.converted, cp.ended), { polarity: 'up_good', unit: 'ratio', nature: 'flow' }),
      trialsEnded: c.ended,
      endedSubscriptions: buildKpi(ended(CUR), ended(PREV), { polarity: 'up_bad', nature: 'flow' }),
      churn: buildKpi(churn(CUR, 2), churn(PREV, 3), { polarity: 'up_bad', unit: 'ratio', nature: 'flow' }),
      upgrades: buildKpi(changes(CUR, 'upgrade'), changes(PREV, 'upgrade'), { polarity: 'up_good', nature: 'flow' }),
      downgrades: buildKpi(changes(CUR, 'downgrade'), changes(PREV, 'downgrade'), { polarity: 'up_bad', nature: 'flow' }),
      revenue: buildKpi(eur(CUR), eur(PREV), { polarity: 'up_good', unit: 'cents', nature: 'flow' }),
      mrr: buildKpi(mrr(CUR), mrr(PREV), { polarity: 'up_good', unit: 'cents', nature: 'stock' }),
      arr: buildKpi(computeArrCents(mrr(CUR)), computeArrCents(mrr(PREV)), { polarity: 'up_good', unit: 'cents', nature: 'stock' }),
      arpa: buildKpi(arpa(CUR), arpa(PREV), { polarity: 'up_good', unit: 'cents', nature: 'stock' }),
    },
    newPaidByPlan,
    conversionByPlan,
    activeByPlan: breakdownByPlan(subs.get(CUR) ?? [], plans),
    revenueByPlan: [...revMap.values()],
    otherCurrencies: Object.fromEntries(Object.entries(revenue.get(CUR) ?? {}).filter(([k]) => k !== MAIN_CURRENCY)),
  };
}
