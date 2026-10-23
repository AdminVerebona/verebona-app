/**
 * Lot 83E — exécution du contrôle de cohérence dans un scénario e2e, par le
 * MÊME orchestrateur que la tâche planifiée `coherence-control` : campagne
 * manuelle BORNÉE aux comptes du scénario (`scopeAccountIds`), menée jusqu'à
 * sa clôture. Remplace, dans les scénarios des lots 61 / 72 / 76, l'ancienne
 * campagne de pertinence « À traiter » (retirée au lot 83E, C-Q9) et, dans
 * ceux des lots 46 / 54D, le balayage horaire de projection (retiré).
 */
import type postgres from 'postgres';

export interface CoherenceRun {
  campaignId: number;
  status: string;
  /** Résultats par contrôle (preuves ACHEVÉES pendant la campagne, comptes du périmètre). */
  results: Record<string, Record<string, number>>;
}

export async function runCoherenceFor(sql: postgres.Sql, accountIds: number[], o: { mode?: 'DRY_RUN' | 'CORRECTIVE'; now?: Date; today?: string } = {}): Promise<CoherenceRun> {
  const orch = await import('@/services/coherence/orchestrator');
  const now = o.now ?? new Date();
  const id = await orch.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode: o.mode ?? 'CORRECTIVE', scopeAccountIds: accountIds, now });
  for (let i = 0; i < 40; i++) {
    const r = await orch.runCampaignStep(id, { deadline: Date.now() + 120_000, now, today: o.today });
    if (r.done) break;
  }
  const c = (await orch.getCampaign(id))!;
  const rows = await sql<{ check_id: string; last_result: string; n: number }[]>`
    SELECT check_id, last_result, count(*)::int AS n FROM coherence_object_proofs
     WHERE account_id = ANY(${accountIds}::int[]) AND last_campaign_id = ${id} GROUP BY check_id, last_result`;
  const results: CoherenceRun['results'] = {};
  for (const r of rows) (results[r.check_id] ??= {})[r.last_result] = r.n;
  return { campaignId: id, status: c.status, results };
}

/** Preuve courante d'un objet pour un contrôle (résultat, constat). */
export async function proofOf(sql: postgres.Sql, accountId: number, checkId: string, objectId: number) {
  const [p] = await sql<{ last_result: string | null; finding: Record<string, unknown> | null; last_mode: string | null }[]>`
    SELECT last_result, finding, last_mode FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${checkId} AND object_id = ${objectId}`;
  return p ?? null;
}
