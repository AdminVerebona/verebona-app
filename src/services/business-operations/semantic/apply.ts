/**
 * Lot 87B (CODE-09) — APPLICATION atomique d'une décision T4 de
 * représentation Agenda.
 *
 * UNE transaction (verrou des consolidations d'agenda 39102, puis verrou des
 * Opérations 39101 pris par le service de regroupement — même ordre que la
 * consolidation 76H et sa restauration) : restaurations (journal 0591),
 * rattachements / rôles et détachements (service UNIQUE de regroupement,
 * origine T4 : un refus de l'utilisateur est respecté, un principal de
 * l'utilisateur n'est jamais remplacé), consolidations des doublons (moteur
 * 76H : preuves déplacées, liens ajoutés, cartes closes, image au journal,
 * retrait tracé et restaurable), retrait des projections techniques
 * redondantes (trace 0223), propagation recalculée. Une erreur technique
 * annule TOUT (aucun état intermédiaire) ; une mutation écartée par une garde
 * au moment de l'appliquer (état changé depuis la lecture) n'est jamais
 * forcée : la décision ENTIÈRE est annulée (`RepresentationApplyRefused`),
 * puis tracée comme refusée par l'orchestration.
 */
import type postgres from 'postgres';
import type { RefusedMutation, RepresentationMutation } from './contract';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;

interface ApplyInput {
  accountId: number;
  operationId: number;
  mutations: readonly RepresentationMutation[];
  correlationId: string | null;
  /** Identifiant (uuid) porté par les restaurations 0591 de cette décision. */
  restoreRunId: string;
  origin: 'PROJECTION' | 'REPRISE';
  runId?: string | null;
  /** Garde d'exécution (travail de file) appelée avant d'écrire. */
  beforeWrite?: (what: string) => Promise<void> | void;
}

export interface ApplyResult {
  applied: RepresentationMutation[];
  refused: RefusedMutation[];
}

/**
 * Une garde a écarté une mutation AU MOMENT de l'appliquer (état changé
 * depuis la lecture du contexte, objet devenu protégé) : la transaction est
 * ANNULÉE en entier — aucune décision appliquée à moitié (CODE-09, CODE-10).
 */
export class RepresentationApplyRefused extends Error {
  constructor(readonly refused: RefusedMutation[]) {
    super(`décision T4 non applicable telle quelle : ${refused.map((r) => `${r.mutation.kind}:${r.reason}`).join(', ').slice(0, 300)}`);
    this.name = 'RepresentationApplyRefused';
  }
}

const SKIP_REASON: Record<string, RefusedMutation['reason']> = {
  USER_REJECTED: 'USER_DETACHED', LINKED_ELSEWHERE: 'LINKED_ELSEWHERE', PRINCIPAL_PROTECTED: 'USER_PRINCIPAL',
};

export async function applyRepresentationMutations(sql: Sql, p: ApplyInput): Promise<ApplyResult> {
  if (!p.mutations.length) return { applied: [], refused: [] };
  await p.beforeWrite?.('T4 représentation Agenda — application d’une décision');
  const [{ AGENDA_CONSOLIDATION_LOCK_SPACE, consolidateInTx, restoreConsolidationLineInTx, consolidationJournalReady }, grouping, { postgresRunner }, { removeAgendaItemsTraced }] = await Promise.all([
    import('../agenda-projection/consolidation'), import('../grouping/service'), import('../grouping/runner'), import('@/services/agenda/agenda-removal-trace'),
  ]);
  const journal = await consolidationJournalReady(sql);
  return sql.begin(async (tx: Tx) => {
    await tx`SELECT pg_advisory_xact_lock(${AGENDA_CONSOLIDATION_LOCK_SPACE}::int, ${p.accountId}::int)`;
    const ctx = grouping.runnerContext(postgresRunner(tx), p.accountId, { correlationId: p.correlationId });
    const applied: RepresentationMutation[] = [];
    const refused: RefusedMutation[] = [];
    const lie = async (itemId: number) => {
      const [r] = await tx.unsafe<Row[]>(`SELECT business_operation_id::text AS op FROM agenda_items WHERE id = $1 AND account_id = $2`, [itemId, p.accountId] as never[]);
      return r ? (r.op == null ? null : Number(r.op)) : undefined;
    };
    for (const m of p.mutations) {
      switch (m.kind) {
        case 'RESTORE': {
          if (!journal) { refused.push({ mutation: m, reason: 'NOT_RESTORABLE' }); break; }
          const [ligne] = await tx.unsafe<Row[]>(`
            SELECT id, account_id, kind, operation_id::text AS operation_id, principal_item_id, absorbed_item_id, detail
              FROM agenda_intervention_consolidations WHERE id = $1 AND account_id = $2 AND restored_at IS NULL AND kind = 'ABSORB' FOR UPDATE`,
          [m.journalId, p.accountId] as never[]);
          if (!ligne) { refused.push({ mutation: m, reason: 'NOT_RESTORABLE' }); break; }
          const conflits: string[] = [];
          const ok = await restoreConsolidationLineInTx(tx, ligne, p.restoreRunId, (c) => conflits.push(c.reason));
          if (!ok) { refused.push({ mutation: m, reason: 'NOT_RESTORABLE' }); break; }
          if (m.role) {
            const r = await grouping.attachAgendaItem(ctx, { operationId: p.operationId, itemId: m.absorbedItemId, role: m.role, origin: 'T4', reasonCode: 'T4_SEMANTIC_RESTORED' });
            if (r.skipped) refused.push({ mutation: { kind: 'ATTACH', itemId: m.absorbedItemId, role: m.role, reason: m.reason }, reason: SKIP_REASON[r.skipped] ?? 'USER_DETACHED' });
          } else if (await lie(m.absorbedItemId) === p.operationId) {
            await grouping.detachAgendaItem(ctx, { itemId: m.absorbedItemId, operationId: p.operationId, origin: 'T4', reasonCode: 'T4_SEMANTIC_INDEPENDENT' });
          }
          applied.push(m);
          break;
        }
        case 'ATTACH': {
          const r = await grouping.attachAgendaItem(ctx, { operationId: p.operationId, itemId: m.itemId, role: m.role, origin: 'T4', reasonCode: 'T4_SEMANTIC_REPRESENTATION' });
          if (r.skipped && !(r.skipped === 'PRINCIPAL_PROTECTED' && r.changed)) { refused.push({ mutation: m, reason: SKIP_REASON[r.skipped] ?? 'USER_DETACHED' }); break; }
          if (r.skipped === 'PRINCIPAL_PROTECTED') refused.push({ mutation: m, reason: 'USER_PRINCIPAL' });
          if (r.changed) applied.push(m);
          break;
        }
        case 'DETACH': {
          const r = await grouping.detachAgendaItem(ctx, { itemId: m.itemId, operationId: p.operationId, origin: 'T4', reasonCode: 'T4_SEMANTIC_INDEPENDENT' });
          if (r.changed) applied.push(m);
          break;
        }
        case 'CONSOLIDATE': {
          if (!journal) { refused.push({ mutation: m, reason: 'KEEP_NOT_ABSORBABLE' }); break; }
          if (await lie(m.keepId) !== p.operationId) { refused.push({ mutation: m, reason: 'KEEP_NOT_ABSORBABLE' }); break; }
          const r = await consolidateInTx(tx, {
            accountId: p.accountId, operationId: p.operationId, principalId: m.keepId, absorbedIds: m.absorbIds, linkPrincipal: false,
            reason: 'T4_SEMANTIC_SAME_OCCURRENCE', origin: p.origin, runId: p.runId ?? null, correlationId: p.correlationId,
          });
          if (r.absorbed.length) applied.push({ ...m, absorbIds: r.absorbed });
          for (const id of r.protectedIds) refused.push({ mutation: { ...m, absorbIds: [id] }, reason: 'STATE_CHANGED' });
          break;
        }
        case 'REMOVE_PROJECTION': {
          if (await lie(m.keepId) !== p.operationId) { refused.push({ mutation: m, reason: 'KEEP_NOT_ABSORBABLE' }); break; }
          const gone = await removeAgendaItemsTraced(tx as unknown as Sql, { accountId: p.accountId, ids: [m.itemId], reason: 'OPERATION_PROJECTION' });
          if (gone.includes(m.itemId)) applied.push(m);
          else refused.push({ mutation: m, reason: 'PROJECTION_TOUCHED' });
          break;
        }
      }
    }
    // Tout ou rien : une seule mutation écartée annule la décision entière (rien n'est validé).
    if (refused.length) throw new RepresentationApplyRefused(refused);
    await grouping.recomputePrincipal(ctx, p.operationId);
    if (applied.length) {
      const [principal] = await tx.unsafe<Row[]>(`SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2 AND operation_role = 'PRINCIPAL' LIMIT 1`, [p.accountId, p.operationId] as never[]);
      const cible = principal ? Number(principal.id) : null;
      const ids = [...new Set(applied.flatMap((m) => ('itemId' in m ? [m.itemId] : 'keepId' in m ? [m.keepId] : 'absorbedItemId' in m ? [m.absorbedItemId] : [])))];
      for (const id of [...new Set([...(cible ? [cible] : []), ...ids])].slice(0, 20)) {
        const [existe] = await tx.unsafe<Row[]>(`SELECT 1 FROM agenda_items WHERE id = $1 AND account_id = $2`, [id, p.accountId] as never[]);
        if (!existe) continue;
        await tx.unsafe(
          `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES ($1, $2, 'T4_SEMANTIC_REPRESENTATION', $3::text::jsonb)`,
          [id, p.accountId, JSON.stringify({ operationId: p.operationId, correlationId: p.correlationId, restoreRunId: p.restoreRunId, mutations: applied.length })] as never[],
        );
      }
    }
    return { applied, refused };
  }) as Promise<ApplyResult>;
}
