/**
 * Lot 100B — persistance de la certification du corpus (migration 0870) :
 * approbations individuelles, décisions de rejet, journal du verrou A1.
 * Tables techniques sans compte. Table absente (migration non jouée) :
 * lecture VIDE — jamais une approbation implicite.
 */
import { pgClient } from '@/db';
import type { ApprovalRef, StatusDecisionRef } from './manifest';

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[] = []): Promise<Row[]> => (await pgClient.unsafe(text, params as never[])) as unknown as Row[];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface ApprovalRecord extends ApprovalRef {
  id: number;
  manifestVersion: number;
  oracleVersion: number | null;
  sources: string[];
  comment: string | null;
  channel: 'desktop' | 'mobile';
  adminUserId: number | null;
}

/** Approbations (toutes, plus récentes d'abord). */
export async function listApprovals(caseId?: string): Promise<ApprovalRecord[]> {
  try {
    const rows = await q(
      `SELECT * FROM ai_corpus_oracle_approvals ${caseId ? 'WHERE case_id = $1' : ''} ORDER BY created_at DESC, id DESC`,
      caseId ? [caseId] : [],
    );
    return rows.map((r) => ({
      id: Number(r.id), caseId: String(r.case_id), oracleFingerprint: String(r.oracle_fingerprint), decision: String(r.decision) as 'APPROVED' | 'REVOKED',
      at: iso(r.created_at), by: String(r.admin_label), manifestVersion: Number(r.manifest_version), oracleVersion: r.oracle_version == null ? null : Number(r.oracle_version),
      sources: (r.sources as string[] | null) ?? [], comment: r.comment == null ? null : String(r.comment), channel: String(r.channel) as 'desktop' | 'mobile',
      adminUserId: r.admin_user_id == null ? null : Number(r.admin_user_id),
    }));
  } catch {
    return [];
  }
}

export async function insertApproval(a: {
  caseId: string; manifestVersion: number; oracleVersion: number | null; oracleFingerprint: string; decision: 'APPROVED' | 'REVOKED';
  sources: string[]; comment: string | null; adminUserId: number | null; adminLabel: string; channel: 'desktop' | 'mobile';
}): Promise<number> {
  const [r] = await q(
    `INSERT INTO ai_corpus_oracle_approvals (case_id, manifest_version, oracle_version, oracle_fingerprint, decision, sources, comment, admin_user_id, admin_label, channel)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING id`,
    [a.caseId, a.manifestVersion, a.oracleVersion, a.oracleFingerprint, a.decision, JSON.stringify(a.sources), a.comment, a.adminUserId, a.adminLabel, a.channel],
  );
  return Number(r.id);
}

export async function listDecisions(): Promise<StatusDecisionRef[]> {
  try {
    return (await q(`SELECT * FROM ai_corpus_case_decisions ORDER BY created_at DESC, id DESC`)).map((r) => ({
      caseId: String(r.case_id), status: String(r.status) as 'REJETEE' | 'RETABLIE', reason: String(r.reason), at: iso(r.created_at), by: String(r.admin_label),
    }));
  } catch {
    return [];
  }
}

export async function insertDecision(d: { caseId: string; status: 'REJETEE' | 'RETABLIE'; reason: string; adminUserId: number | null; adminLabel: string }): Promise<number> {
  const [r] = await q(
    `INSERT INTO ai_corpus_case_decisions (case_id, status, reason, admin_user_id, admin_label) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [d.caseId, d.status, d.reason, d.adminUserId, d.adminLabel],
  );
  return Number(r.id);
}

/** Empreinte courte de l'état des approbations / décisions (mémoire de l'empreinte du corpus). */
export async function certificationStamp(): Promise<string> {
  try {
    const [a] = await q(`SELECT count(*)::int AS n, coalesce(max(id), 0)::bigint AS m FROM ai_corpus_oracle_approvals`);
    const [d] = await q(`SELECT count(*)::int AS n, coalesce(max(id), 0)::bigint AS m FROM ai_corpus_case_decisions`);
    return `a${a.n}:${a.m}|d${d.n}:${d.m}`;
  } catch {
    return 'absent';
  }
}

export async function recordA1Assessment(a: {
  environment: string; context: 'AUTO_CANDIDATE' | 'PROMPT_CONFORMITY' | 'MANUAL_NOTICE' | 'REPORT'; campaignId: number | null; candidateVersionId: number | null;
  treatments: string[]; allowed: boolean; rulesVersion: string; manifestVersion: number; blockers: unknown[]; summary: Record<string, unknown>;
}): Promise<number | null> {
  try {
    const [r] = await q(
      `INSERT INTO ai_corpus_a1_assessments (environment, context, campaign_id, candidate_version_id, treatments, allowed, rules_version, manifest_version, blockers, summary)
       VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING id`,
      [a.environment, a.context, a.campaignId, a.candidateVersionId, a.treatments, a.allowed, a.rulesVersion, a.manifestVersion, JSON.stringify(a.blockers.slice(0, 200)), JSON.stringify(a.summary)],
    );
    return Number(r.id);
  } catch (e) {
    console.error('[corpus] journal du verrou A1 :', (e as Error).message);
    return null;
  }
}

export async function listA1Assessments(limit = 20): Promise<Array<{ id: number; context: string; campaignId: number | null; treatments: string[]; allowed: boolean; blockers: unknown[]; createdAt: string }>> {
  try {
    return (await q(`SELECT * FROM ai_corpus_a1_assessments ORDER BY created_at DESC, id DESC LIMIT $1`, [limit])).map((r) => ({
      id: Number(r.id), context: String(r.context), campaignId: r.campaign_id == null ? null : Number(r.campaign_id), treatments: (r.treatments as string[]) ?? [],
      allowed: Boolean(r.allowed), blockers: (r.blockers as unknown[]) ?? [], createdAt: iso(r.created_at),
    }));
  } catch {
    return [];
  }
}

/** Coûts mesurés par campagne × modèle × opération : fournisseur réel vs cache (A4 : aucun plafond mensuel, traçage complet). */
export async function costRows(limitCampaigns = 30): Promise<Array<{ campaignId: number; kind: string; operationCode: string; model: string; servedModel: string | null; calls: number; cacheHits: number; providerCostMicros: number | null; unknownCost: number; attempts: number }>> {
  try {
    const rows = await q(
      `SELECT e.campaign_id, c.kind, e.operation_code, e.model, k.served_model,
              count(*)::int AS calls,
              count(*) FILTER (WHERE k.from_cache IS TRUE OR k.inconclusive_reason LIKE 'réponse issue du cache%')::int AS cache_hits,
              sum(k.cost_micros) FILTER (WHERE NOT (k.from_cache IS TRUE OR coalesce(k.inconclusive_reason, '') LIKE 'réponse issue du cache%'))::bigint AS provider_cost,
              count(*) FILTER (WHERE k.cost_micros IS NULL AND k.duration_ms IS NOT NULL)::int AS unknown_cost,
              coalesce(sum(k.attempts), 0)::int AS attempts
         FROM ai_qualification_cases k
         JOIN ai_qualification_evidence e ON e.id = k.evidence_id
         JOIN ai_qualification_campaigns c ON c.id = e.campaign_id
        WHERE e.campaign_id IN (SELECT id FROM ai_qualification_campaigns ORDER BY id DESC LIMIT $1)
        GROUP BY e.campaign_id, c.kind, e.operation_code, e.model, k.served_model
        ORDER BY e.campaign_id DESC, e.operation_code, e.model`,
      [limitCampaigns],
    );
    return rows.map((r) => ({
      campaignId: Number(r.campaign_id), kind: String(r.kind), operationCode: String(r.operation_code), model: String(r.model),
      servedModel: r.served_model == null ? null : String(r.served_model), calls: Number(r.calls), cacheHits: Number(r.cache_hits),
      providerCostMicros: r.provider_cost == null ? null : Number(r.provider_cost), unknownCost: Number(r.unknown_cost), attempts: Number(r.attempts),
    }));
  } catch {
    return [];
  }
}

/**
 * Derniers résultats par cas du corpus pour les couples ACTIFS de rang 0
 * (preuve la plus récente de chaque opération dont la signature est
 * courante) : alimente la matrice et la vue T2 du BO.
 */
export async function latestCaseOutcomes(evidenceIds: readonly number[]): Promise<Array<{ evidenceId: number; operationCode: string; caseId: string; manifestCaseId: string | null; outcome: string; defects: unknown[]; inconclusiveReason: string | null }>> {
  if (!evidenceIds.length) return [];
  try {
    return (await q(
      `SELECT k.evidence_id, e.operation_code, k.case_id, k.manifest_case_id, k.outcome, k.defects, k.inconclusive_reason
         FROM ai_qualification_cases k JOIN ai_qualification_evidence e ON e.id = k.evidence_id
        WHERE k.evidence_id = ANY($1::bigint[]) ORDER BY k.case_id, k.observation`,
      [[...evidenceIds]],
    )).map((r) => ({
      evidenceId: Number(r.evidence_id), operationCode: String(r.operation_code), caseId: String(r.case_id), manifestCaseId: r.manifest_case_id == null ? null : String(r.manifest_case_id),
      outcome: String(r.outcome), defects: (r.defects as unknown[]) ?? [], inconclusiveReason: r.inconclusive_reason == null ? null : String(r.inconclusive_reason),
    }));
  } catch {
    return [];
  }
}
