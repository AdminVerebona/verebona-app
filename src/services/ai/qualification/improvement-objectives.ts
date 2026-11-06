/**
 * Lot 113I — OBJECTIFS D'AMÉLIORATION (CDC V2 §4.1, §6, §27 : EVT-03/05/06/08/09,
 * LIF-004/006/009/010, DATA-04, SQL-001).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Un objectif est un PROBLÈME ou une OPPORTUNITÉ constatés (pas une campagne) :
 * environnement, traitement, type, source, empreinte d'événement, empreinte de
 * la référence du traitement. Il référence les campagnes et candidates du
 * dispositif EXISTANT (`ai_qualification_campaigns.objective_id`,
 * `candidate_promotion.delta.objectiveId`) ; le statut de campagne reste
 * dans `ai_qualification_campaigns` (LIF-004) — l'objectif n'en est pas une
 * copie.
 *
 *   · unicité des objectifs OUVERTS (environnement, traitement, événement,
 *     référence) par index unique partiel : deux workers qui reçoivent le même
 *     événement obtiennent le MÊME objectif (LIF-009, REC-020) ;
 *   · file FIFO par date de création ; seule exception : remplacement d'un
 *     modèle dont le retrait est officiellement annoncé (RETIREMENT) (EVT-05) ;
 *   · au plus N variantes par objectif (politique administrée, 3 par défaut),
 *     compteur incrémenté atomiquement (EVT-08) ;
 *   · transitions validées contre le statut attendu, en une requête
 *     conditionnelle : une transition impossible rend un code métier
 *     (`TRANSITION_REFUSED`), jamais une exception silencieuse (LIF-004) ;
 *   · un objectif terminal n'est jamais rejoué ; un événement matériellement
 *     nouveau a une autre empreinte, donc un autre objectif (EVT-09, INV-10).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getAiEnvironment } from '../config/environment';
import type { Treatment } from '../config/treatments';

export const OBJECTIVE_KINDS = ['PROVEN_DEFECT', 'STABLE_MODEL_AVAILABLE', 'PROVIDER_DEPRECATION', 'CERTIFIED_CORPUS_CHANGE', 'COST_OPPORTUNITY', 'NEW_RELEVANT_EVIDENCE'] as const;
export type ObjectiveKind = typeof OBJECTIVE_KINDS[number];

export const OBJECTIVE_STATUSES = [
  'DETECTED', 'SCREENING', 'ELIGIBLE', 'QUEUED', 'WAITING_BUDGET', 'WAITING_PREREQUISITE', 'EXPERIMENTING', 'QUALIFYING', 'BLOCKED',
  'COMPLETED_WITH_PROMOTION', 'COMPLETED_NO_GAIN', 'INCONCLUSIVE', 'ABANDONED', 'SUPERSEDED',
] as const;
export type ObjectiveStatus = typeof OBJECTIVE_STATUSES[number];

export const TERMINAL_STATUSES: readonly ObjectiveStatus[] = ['COMPLETED_WITH_PROMOTION', 'COMPLETED_NO_GAIN', 'INCONCLUSIVE', 'ABANDONED', 'SUPERSEDED'];

/** Transitions autorisées (CDC §27.2). ABANDONED / SUPERSEDED possibles depuis tout état non terminal. */
export const OBJECTIVE_TRANSITIONS: Readonly<Record<ObjectiveStatus, readonly ObjectiveStatus[]>> = {
  DETECTED: ['SCREENING', 'ABANDONED', 'SUPERSEDED'],
  SCREENING: ['ELIGIBLE', 'WAITING_PREREQUISITE', 'ABANDONED', 'SUPERSEDED'],
  ELIGIBLE: ['QUEUED', 'WAITING_BUDGET', 'SUPERSEDED', 'ABANDONED'],
  QUEUED: ['EXPERIMENTING', 'WAITING_BUDGET', 'WAITING_PREREQUISITE', 'SUPERSEDED', 'ABANDONED'],
  WAITING_BUDGET: ['QUEUED', 'SUPERSEDED', 'ABANDONED'],
  WAITING_PREREQUISITE: ['SCREENING', 'SUPERSEDED', 'ABANDONED'],
  EXPERIMENTING: ['QUALIFYING', 'COMPLETED_NO_GAIN', 'INCONCLUSIVE', 'BLOCKED', 'WAITING_BUDGET', 'QUEUED', 'SUPERSEDED', 'ABANDONED'],
  QUALIFYING: ['COMPLETED_WITH_PROMOTION', 'INCONCLUSIVE', 'COMPLETED_NO_GAIN', 'BLOCKED', 'QUEUED', 'SUPERSEDED', 'ABANDONED'],
  BLOCKED: ['QUEUED', 'SUPERSEDED', 'ABANDONED'],
  COMPLETED_WITH_PROMOTION: [],
  COMPLETED_NO_GAIN: [],
  INCONCLUSIVE: [],
  ABANDONED: [],
  SUPERSEDED: [],
};

export function canTransition(from: ObjectiveStatus, to: ObjectiveStatus): boolean {
  return OBJECTIVE_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface Objective {
  id: number;
  environment: string;
  treatment: Treatment;
  kind: ObjectiveKind;
  sourceRef: string;
  eventFingerprint: string;
  baselineFingerprint: string;
  priority: 'RETIREMENT' | 'FIFO';
  status: ObjectiveStatus;
  variantCount: number;
  nextEligibleMonth: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

type Row = Record<string, unknown>;
type Sql = { unsafe: (t: string, p?: never[]) => Promise<unknown> };
const rows = async (sql: Sql, t: string, p: unknown[] = []): Promise<Row[]> => (await sql.unsafe(t, p as never[])) as unknown as Row[];
const db = async (): Promise<Sql> => (await import('@/db')).pgClient as unknown as Sql;

function toObjective(r: Row): Objective {
  const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
  return {
    id: Number(r.id), environment: String(r.environment), treatment: String(r.treatment) as Treatment, kind: String(r.kind) as ObjectiveKind,
    sourceRef: String(r.source_ref), eventFingerprint: String(r.event_fingerprint), baselineFingerprint: String(r.baseline_fingerprint),
    priority: String(r.priority) === 'RETIREMENT' ? 'RETIREMENT' : 'FIFO', status: String(r.status) as ObjectiveStatus, variantCount: Number(r.variant_count ?? 0),
    nextEligibleMonth: r.next_eligible_month == null ? null : String(r.next_eligible_month), reason: r.reason == null ? null : String(r.reason),
    detail: (r.detail ?? {}) as Record<string, unknown>, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, resolvedAt: iso(r.resolved_at),
  };
}

/**
 * Enregistre (ou retrouve) l'objectif OUVERT d'un événement — idempotent et sûr en concurrence (index unique
 * partiel, aucune variable de processus). Rend `created: false` si un objectif ouvert identique existait.
 */
export async function registerObjective(p: {
  treatment: Treatment; kind: ObjectiveKind; sourceRef: string; eventFingerprint: string; baselineFingerprint: string;
  priority?: 'RETIREMENT' | 'FIFO'; detail?: Record<string, unknown>; environment?: string; status?: 'QUEUED' | 'DETECTED';
}, sql?: Sql): Promise<{ objective: Objective; created: boolean }> {
  const environment = p.environment ?? getAiEnvironment();
  if (environment === 'production') throw new Error('PREPROD_ONLY : aucun objectif d’amélioration automatique en production (PRD-01).');
  const s = sql ?? await db();
  const ins = await rows(s,
    `INSERT INTO ai_improvement_objectives (environment, treatment, kind, source_ref, event_fingerprint, baseline_fingerprint, priority, status, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (environment, treatment, event_fingerprint, baseline_fingerprint) WHERE is_open DO NOTHING
     RETURNING *`,
    [environment, p.treatment, p.kind, p.sourceRef.slice(0, 500), p.eventFingerprint, p.baselineFingerprint, p.priority ?? 'FIFO', p.status ?? 'QUEUED', JSON.stringify(p.detail ?? {})]);
  if (ins[0]) return { objective: toObjective(ins[0]), created: true };
  const [ex] = await rows(s,
    `SELECT * FROM ai_improvement_objectives WHERE environment = $1 AND treatment = $2 AND event_fingerprint = $3 AND baseline_fingerprint = $4 AND is_open LIMIT 1`,
    [environment, p.treatment, p.eventFingerprint, p.baselineFingerprint]);
  if (!ex) throw new Error('objectif concurrent clos entre l’insertion et la lecture : réessayer au passage suivant');
  return { objective: toObjective(ex), created: false };
}

/** Objectif terminal déjà traité pour cet événement et cette référence (anti-boucle, EVT-09). */
export async function findClosedObjective(p: { environment?: string; treatment: Treatment; eventFingerprint: string; baselineFingerprint: string }): Promise<Objective | null> {
  try {
    const [r] = await rows(await db(),
      `SELECT * FROM ai_improvement_objectives WHERE environment = $1 AND treatment = $2 AND event_fingerprint = $3 AND baseline_fingerprint = $4 AND NOT is_open ORDER BY id DESC LIMIT 1`,
      [p.environment ?? getAiEnvironment(), p.treatment, p.eventFingerprint, p.baselineFingerprint]);
    return r ? toObjective(r) : null;
  } catch (e) {
    if (String((e as { code?: string })?.code) === '42P01') return null;
    throw e;
  }
}

/** Transition conditionnelle (statut attendu vérifié dans la même requête). */
export async function transitionObjective(id: number, expected: readonly ObjectiveStatus[], next: ObjectiveStatus, patch: { reason?: string | null; nextEligibleMonth?: string | null; detail?: Record<string, unknown>; adminOverride?: { userId: number; reason: string } } = {}, sql?: Sql):
  Promise<{ ok: true; objective: Objective } | { ok: false; code: 'TRANSITION_REFUSED'; current: ObjectiveStatus | null; message: string }> {
  const permis = expected.filter((e) => canTransition(e, next));
  const s = sql ?? await db();
  if (!permis.length) {
    return { ok: false, code: 'TRANSITION_REFUSED', current: null, message: `transition ${expected.join('|')} → ${next} non autorisée` };
  }
  const terminal = TERMINAL_STATUSES.includes(next);
  const [r] = await rows(s,
    `UPDATE ai_improvement_objectives
        SET status = $3, is_open = $4, reason = COALESCE($5, reason), next_eligible_month = $6,
            detail = detail || $7::jsonb, resolved_at = CASE WHEN $4 THEN NULL ELSE now() END,
            admin_override = COALESCE($8::jsonb, admin_override), updated_at = now()
      WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
    [id, [...permis], next, !terminal, patch.reason ?? null, patch.nextEligibleMonth ?? null, JSON.stringify(patch.detail ?? {}),
      patch.adminOverride ? JSON.stringify({ ...patch.adminOverride, at: new Date().toISOString() }) : null]);
  if (r) return { ok: true, objective: toObjective(r) };
  const [cur] = await rows(s, `SELECT status FROM ai_improvement_objectives WHERE id = $1`, [id]);
  return { ok: false, code: 'TRANSITION_REFUSED', current: cur ? String(cur.status) as ObjectiveStatus : null, message: `objectif ${id} : statut courant ${cur ? String(cur.status) : 'introuvable'}, attendu ${permis.join('|')}` };
}

/** Réserve le numéro de la variante suivante (≤ maximum administré) ; null : quota épuisé (aucune quatrième candidate). */
export async function nextVariant(id: number, max: number, sql?: Sql): Promise<number | null> {
  const [r] = await rows(sql ?? await db(),
    `UPDATE ai_improvement_objectives SET variant_count = variant_count + 1, updated_at = now() WHERE id = $1 AND is_open AND variant_count < $2 RETURNING variant_count`, [id, max]);
  return r ? Number(r.variant_count) : null;
}

/** File d'attente (ordre FIFO, exception RETIREMENT en tête) — objectifs ouverts. */
export async function listQueue(environment: string = getAiEnvironment(), statuses: readonly ObjectiveStatus[] = ['QUEUED', 'WAITING_BUDGET']): Promise<Objective[]> {
  try {
    return (await rows(await db(),
      `SELECT * FROM ai_improvement_objectives WHERE environment = $1 AND is_open AND status = ANY($2::text[])
        ORDER BY (priority = 'RETIREMENT') DESC, created_at, id LIMIT 500`, [environment, [...statuses]])).map(toObjective);
  } catch (e) {
    if (String((e as { code?: string })?.code) === '42P01') return [];
    throw e;
  }
}

/** Ordre de la file (pur, EVT-05) : retrait officiel d'abord, puis date de création, puis identifiant. */
export function queueOrder<T extends Pick<Objective, 'priority' | 'createdAt' | 'id'>>(l: readonly T[]): T[] {
  return [...l].sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'RETIREMENT' ? -1 : 1)
    || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
}

/** Liste paginée (BO, API-02 : états exacts). */
export async function listObjectives(p: { environment?: string; treatment?: Treatment | null; status?: ObjectiveStatus | null; limit?: number; offset?: number } = {}): Promise<{ items: Objective[]; total: number }> {
  try {
    const s = await db();
    const env = p.environment ?? getAiEnvironment();
    const where = `environment = $1 AND ($2::text IS NULL OR treatment = $2) AND ($3::text IS NULL OR status = $3)`;
    const params = [env, p.treatment ?? null, p.status ?? null];
    const [n] = await rows(s, `SELECT count(*)::int AS n FROM ai_improvement_objectives WHERE ${where}`, params);
    const items = (await rows(s, `SELECT * FROM ai_improvement_objectives WHERE ${where} ORDER BY is_open DESC, (priority = 'RETIREMENT') DESC, created_at, id LIMIT $4 OFFSET $5`,
      [...params, Math.min(200, Math.max(1, p.limit ?? 50)), Math.max(0, p.offset ?? 0)])).map(toObjective);
    return { items, total: Number(n?.n ?? 0) };
  } catch (e) {
    if (String((e as { code?: string })?.code) === '42P01') return { items: [], total: 0 };
    throw e;
  }
}

/** Suspension par un administrateur (UI-002) : aucune nouvelle dépense, configuration active NON modifiée. */
export async function suspendObjective(p: { id: number; expectedStatus: ObjectiveStatus; userId: number; reason: string }) {
  if (!Number.isInteger(p.userId) || p.userId <= 0) throw new Error('administrateur requis');
  return transitionObjective(p.id, [p.expectedStatus], 'ABANDONED', { reason: `Suspendu par un administrateur : ${p.reason}`.slice(0, 1000), adminOverride: { userId: p.userId, reason: p.reason.slice(0, 500) } });
}
