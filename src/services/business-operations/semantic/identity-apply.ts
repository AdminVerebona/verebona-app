/**
 * Lot 97A — APPLICATION d'une décision T3 d'identité multi-sources VALIDÉE
 * (contrat `t3-operation-identity-v1`). Aucune séparation ni fusion écrite
 * ici : la décision devient des DÉCISIONS DE RATTACHEMENT, posées par l'API
 * d'écriture unique des Opérations (`withBusinessOperationWrite` →
 * `repository.recordMatchDecision`, origine `AI_IDENTITY`, migration 0836),
 * que la consolidation T3 existante relit (`decideCandidate` : Opération
 * refusée exclue, Opération confirmée retenue) ; le document est remis en
 * consolidation (`t3_pending`) — la source quitte l'Opération par le chemin
 * habituel (désactivée, jamais supprimée ; Opération reconsolidée, Agenda
 * reprojeté). Tout ou rien, dans UNE transaction sous le verrou du compte,
 * avec des gardes d'état : une source qui a changé, une Opération devenue
 * inactive, ou une décision de l'utilisateur apparue entre-temps annulent
 * tout (`STATE_CHANGED`).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../lock';
import { IDENTITY_DECISION_ORIGIN } from './identity-contract';
import type { IdentityMutation, IdentityScope } from './identity-validate';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];

export class IdentityApplyRefused extends Error {
  constructor(readonly refused: Array<{ mutation: IdentityMutation; reason: string }>) {
    super(`décision T3 d'identité non appliquée : ${refused.map((r) => `${r.mutation.kind} ${r.mutation.sourceRef} (${r.reason})`).join(', ').slice(0, 300)}`);
    this.name = 'IdentityApplyRefused';
  }
}

const REASON_CODE: Record<IdentityMutation['kind'], string> = {
  REJECT: 'T3_SEMANTIC_IDENTITY_SEPARATED',
  CONFIRM: 'T3_SEMANTIC_IDENTITY_MOVED',
};

/** Applique les mutations ; rend les fichiers remis en consolidation. Lève `IdentityApplyRefused` sur une garde. */
export async function applyIdentityMutations(p: {
  scope: IdentityScope; mutations: readonly IdentityMutation[]; journalId: number; correlationId?: string | null;
  beforeWrite?: (what: string) => Promise<void> | void;
}): Promise<{ files: number[]; decisionIds: number[] }> {
  await p.beforeWrite?.('T3 identité multi-sources — décisions de rattachement');
  const { withBusinessOperationWrite } = await import('../write');
  const accountId = p.scope.accountId;
  return withBusinessOperationWrite(accountId, async (repo, session) => {
    const tx = session.tx;
    const refus: Array<{ mutation: IdentityMutation; reason: string }> = [];
    for (const m of p.mutations) {
      const [op] = await rows(tx, sql`
        SELECT 1 AS x FROM business_operations WHERE account_id = ${accountId} AND id = ${m.operationId}
           AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`);
      if (!op) { refus.push({ mutation: m, reason: 'OPERATION_INACTIVE' }); continue; }
      if (m.kind === 'REJECT') {
        const [s] = await rows(tx, sql`
          SELECT 1 AS x FROM business_operation_sources s
           WHERE s.account_id = ${accountId} AND s.operation_id = ${m.operationId} AND s.active AND s.source_kind = 'DOCUMENT'
             AND s.source_entity_key = ${String(m.fileId)} AND s.locator ->> 'candidateKey' = ${m.candidateKey}
             AND COALESCE(s.match_method, '') <> 'M0'`);
        if (!s) { refus.push({ mutation: m, reason: 'SOURCE_CHANGED' }); continue; }
      }
      const [u] = await rows(tx, sql`
        SELECT 1 AS x FROM business_operation_match_decisions
         WHERE account_id = ${accountId} AND active AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(m.fileId)}
           AND candidate_operation_id = ${m.operationId} AND origin IN ('USER_ARBITRATION', 'ADMIN_REVIEW')`);
      if (u) refus.push({ mutation: m, reason: 'USER_DECISION' });
    }
    if (refus.length) throw new IdentityApplyRefused(refus);

    const decisionIds: number[] = [];
    for (const m of p.mutations) {
      decisionIds.push(await repo.recordMatchDecision({
        sourceKind: 'DOCUMENT', entityKey: m.fileId, sourceVersion: m.candidateKey, operationId: m.operationId,
        decision: m.kind === 'REJECT' ? 'REJECTED' : 'CONFIRMED', origin: IDENTITY_DECISION_ORIGIN, reasonCode: REASON_CODE[m.kind],
      }));
    }
    const at = new Date().toISOString();
    for (const m of p.mutations.filter((x) => x.kind === 'REJECT')) {
      await tx.execute(sql`
        UPDATE document_operation_candidates c
           SET t3_pending = true,
               t3_detail = COALESCE(c.t3_detail, '{}'::jsonb)
                 || jsonb_build_object('identityReevaluation', jsonb_build_object('journalId', ${p.journalId}::bigint, 'at', ${at}::text, 'operationId', ${m.operationId}::bigint))
         WHERE c.account_id = ${accountId} AND c.file_id = ${m.fileId} AND c.candidate_key = ${m.candidateKey} AND c.status = 'ACTIVE'`);
    }
    return { files: [...new Set(p.mutations.map((m) => m.fileId))], decisionIds };
  }, { correlationId: p.correlationId ?? `t3-identity:${p.journalId}` });
}
