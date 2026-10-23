/**
 * HISTORIQUE des campagnes de pertinence « À traiter » (lots 61, 72, 76 —
 * `to_process_relevance_campaigns` / `_items`) — LECTURE SEULE depuis le lot
 * 83E.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 83E (arbitrages PO du 23/10/2026 C-Q9, §3.1) — UNE SEULE CHAÎNE
 *
 * Le moteur de campagne (`startRelevanceCampaign`, `runRelevanceCampaign`,
 * `retryCampaignErrors`, phases CARTES / DÉCISIONS / REPRISE) est RETIRÉ :
 * la même réévaluation, par le MÊME code métier (décision centrale du pont
 * documentaire `syncDocumentRulesFromState`, producteurs des familles
 * « état » `produce*Actions`), est faite par les contrôles du registre de
 * cohérence COH-TODO-RELEVANCE-CARDS et COH-TODO-STALE-DECISIONS
 * (`src/services/coherence/registry/checks/to-process-relevance.ts`), dans la
 * campagne exhaustive quotidienne `coherence-control` (preuve par objet,
 * version des règles, anti-boucle, réparations journalisées, échecs et
 * constats persistants en Supervision). La tâche planifiée
 * `to-process-relevance-reevaluation` ne lance plus de campagne (elle garde
 * la rétention des traces, la reprise des traces non écrites et le
 * rattrapage 81A des faux arbitrages).
 *
 * Les campagnes passées restent CONSULTABLES (BO › File d'attente IA ›
 * Pertinence « À traiter ») : aucune suppression ; une campagne encore en
 * cours au déploiement est close SUPERSEDED (migration 0676).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { getRule } from './rules-catalog';

/** Lot 76 (C7) : traitements au plus d'un élément en erreur (historique : seuil des reprises). */
export const CAMPAIGN_MAX_ATTEMPTS = 3;

type Raw = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []): Promise<Raw[]> => (await pgClient.unsafe(sql, params as never[])) as unknown as Raw[];

/** Famille d'une règle (type de cible). */
export const familyOfRule = (code: string) => getRule(code)?.targetType ?? 'DOCUMENT';

export async function campaignTablesReady(): Promise<boolean> {
  try {
    const [r] = await q(`SELECT to_regclass('to_process_relevance_campaigns') IS NOT NULL AND to_regclass('to_process_relevance_campaign_items') IS NOT NULL AS ok`);
    return r?.ok === true;
  } catch { return false; }
}

/** Colonnes de reprise du lot 76 (0581) présentes ? */
export async function campaignRetryReady(): Promise<boolean> {
  try {
    const [r] = await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                                          AND table_name = 'to_process_relevance_campaign_items' AND column_name = 'final_outcome') AS ok`);
    return r?.ok === true;
  } catch { return false; }
}

/** Colonnes multi-familles du lot 72 (0517) présentes ? */
export async function campaignMultiFamilyReady(): Promise<boolean> {
  try {
    const [r] = await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                                          AND table_name = 'to_process_relevance_campaigns' AND column_name = 'outcomes_by_rule') AS ok`);
    return r?.ok === true;
  } catch { return false; }
}

export interface CampaignView {
  id: number; code: string; status: string; trigger: string; engineVersion: string; startedAt: string; finishedAt: string | null;
  lastRunAt: string | null; runs: number; before: Record<string, number>; after: Record<string, number> | null;
  outcomes: Record<string, number>; errorSample: string | null;
  /** Lot 72 (C6) : issues par règle, familles, phase, cartes et documents restant à traiter. */
  outcomesByRule?: Record<string, Record<string, number>>;
  families?: Record<string, string>;
  phase?: string | null;
  remaining?: { cards: number; decisions: number } | null;
  errorItems?: number;
  /** Lot 76 (C7) : fin du parcours, périmètre, reprises ; erreurs en attente de reprise, bloquantes, reprises avec succès. */
  traversalFinishedAt?: string | null;
  scope?: Record<string, unknown> | null;
  retries?: number;
  errors?: { pending: number; blocking: number; recovered: number } | null;
}

/** Campagnes récentes et issues d'une campagne (BO). */
export async function listRelevanceCampaigns(limit = 10): Promise<CampaignView[]> {
  if (!(await campaignTablesReady())) return [];
  const multi = await campaignMultiFamilyReady();
  const reprise = multi && await campaignRetryReady();
  const rows = await q(`SELECT * FROM to_process_relevance_campaigns ORDER BY id DESC LIMIT $1`, [Math.max(1, Math.min(50, limit))]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const obj = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  const out: CampaignView[] = [];
  for (const r of rows) {
    const before = obj<Record<string, number>>(r.before_counts) ?? {};
    const byRule = multi ? obj<Record<string, Record<string, number>>>(r.outcomes_by_rule) ?? {} : undefined;
    // Lot 83E : plus aucune campagne en cours (moteur retiré) — aucun « reste à traiter ».
    const remaining: CampaignView['remaining'] = null;
    const [e] = reprise
      ? await q(`SELECT count(*) FILTER (WHERE last_error IS NOT NULL)::int AS n,
                        count(*) FILTER (WHERE last_error IS NOT NULL AND attempts < $2)::int AS pending,
                        count(*) FILTER (WHERE last_error IS NOT NULL AND attempts >= $2)::int AS blocking,
                        count(*) FILTER (WHERE first_error IS NOT NULL AND last_error IS NULL)::int AS recovered
                   FROM to_process_relevance_campaign_items WHERE campaign_id = $1`, [Number(r.id), CAMPAIGN_MAX_ATTEMPTS])
      : await q(`SELECT count(*)::int AS n FROM to_process_relevance_campaign_items WHERE campaign_id = $1 AND outcome = 'ERROR'`, [Number(r.id)]);
    const regles = [...new Set([...Object.keys(before), ...Object.keys(byRule ?? {})])];
    out.push({
      id: Number(r.id), code: String(r.code), status: String(r.status), trigger: String(r.trigger_code), engineVersion: String(r.engine_version),
      startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), lastRunAt: iso(r.last_run_at), runs: Number(r.runs),
      before, after: r.after_counts ? obj<Record<string, number>>(r.after_counts) : null,
      outcomes: obj<Record<string, number>>(r.outcomes) ?? {}, errorSample: (r.error_sample as string | null) ?? null,
      outcomesByRule: byRule, families: Object.fromEntries(regles.map((x) => [x, familyOfRule(x)])), phase: multi ? (r.phase as string) ?? null : null,
      remaining, errorItems: Number(e?.n ?? 0),
      ...(reprise ? {
        traversalFinishedAt: iso(r.traversal_finished_at), scope: r.scope ? obj<Record<string, unknown>>(r.scope) : null, retries: Number(r.retries ?? 0),
        errors: { pending: Number(e?.pending ?? 0), blocking: Number(e?.blocking ?? 0), recovered: Number(e?.recovered ?? 0) },
      } : {}),
    });
  }
  return out;
}

export async function listCampaignItems(campaignId: number, f: { accountId?: number | null; outcome?: string | null; limit?: number } = {}) {
  if (!(await campaignTablesReady())) return [];
  const multi = await campaignMultiFamilyReady();
  const reprise = multi && await campaignRetryReady();
  // Lot 76 (C7) : issue EFFECTIVE (après reprise) ; « ERROR » = éléments encore en erreur.
  const issue = reprise ? 'COALESCE(final_outcome, outcome)' : 'outcome';
  const rows = await q(
    `SELECT action_id, account_id, file_id, rule_code, kind_before, outcome, reason, created_at${multi ? ', target_type, target_id, phase' : ''}
            ${reprise ? ', final_outcome, attempts, first_error, last_error, retried_at' : ''}
       FROM to_process_relevance_campaign_items
      WHERE campaign_id = $1 AND ($2::int IS NULL OR account_id = $2) AND ($3::text IS NULL OR ${issue} = $3)
      ORDER BY id DESC LIMIT $4`,
    [campaignId, f.accountId ?? null, f.outcome ?? null, Math.max(1, Math.min(200, f.limit ?? 50))],
  );
  return rows.map((r) => ({
    actionId: r.action_id == null ? null : Number(r.action_id), accountId: Number(r.account_id), fileId: r.file_id == null ? null : Number(r.file_id),
    ruleCode: String(r.rule_code), kindBefore: (r.kind_before as string) ?? null, outcome: String(r.outcome), reason: (r.reason as string) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    targetType: (r.target_type as string) ?? 'DOCUMENT', targetId: r.target_id == null ? Number(r.file_id) : Number(r.target_id), phase: (r.phase as string) ?? 'CARDS',
    ...(reprise ? {
      finalOutcome: (r.final_outcome as string) ?? null, attempts: Number(r.attempts ?? 1), firstError: (r.first_error as string) ?? null,
      lastError: (r.last_error as string) ?? null, retriedAt: r.retried_at ? new Date(r.retried_at as string).toISOString() : null,
    } : {}),
  }));
}
