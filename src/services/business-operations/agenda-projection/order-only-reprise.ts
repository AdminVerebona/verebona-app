/**
 * Carte #813 (critère 9) — REPRISE DU STOCK : achats dont la seule preuve est
 * un bon de commande, déjà projetés à tort dans l'Agenda (événement « Achat »,
 * daté ou non) avec, parfois, une carte « À quelle date… » ouverte.
 *
 * AUCUNE règle nouvelle : la reprise rejoue les moteurs de production —
 *   1. consolidation T3 de ces opérations (`reconsolidateOperations`) : le
 *      statut redevient cohérent avec les preuves (commande seule ≠
 *      réalisation), le nom est dérivé de la désignation ;
 *   2. projection T4 (`projectAccountOperations`) : la projection INTACTE est
 *      retirée avec sa trace restaurable (`agenda_item_removals`, 0223) ; un
 *      élément touché par l'utilisateur reste, lié ;
 *   3. producteur « À traiter » (`produceAgendaActions`) : la carte de date
 *      d'un élément retiré est fermée (obsolète).
 * Rien d'autre n'est écrit : ni document, ni opération, ni relation, ni
 * correction de l'utilisateur ne sont supprimés.
 *
 * À BLANC par défaut (`apply` absent) : rapport seul, aucune écriture.
 * Idempotent : un second passage ne trouve plus rien à retirer et n'écrit
 * rien. Le contrôle de cohérence quotidien COH-AGENDA-OPERATION-PROJECTION
 * rejoue la même projection : il converge vers le même état sans ce script
 * (qui sert à produire le rapport et à ne pas attendre la campagne).
 */
import { ORDER_ONLY_EVIDENCE_RAW } from './service';

type Row = Record<string, unknown>;

export interface OrderOnlyRepriseItem {
  itemId: number; title: string; date: string | null;
  /** Projection intacte : retirée (trace restaurable). Sinon : conservée (saisie ou modifiée par l'utilisateur). */
  action: 'REMOVE' | 'KEEP_USER_TOUCHED';
  /** Cartes « À traiter » de date ouvertes sur cet élément. */
  openDateCards: number[];
}
export interface OrderOnlyRepriseOperation {
  operationId: number; label: string | null; status: string; realizedDate: string | null;
  documentFileIds: number[];
  items: OrderOnlyRepriseItem[];
}
export interface OrderOnlyRepriseReport {
  accountId: number; applied: boolean;
  operations: OrderOnlyRepriseOperation[];
  /** Totaux du constat (à blanc comme en réel). */
  toRemove: number; keptUserTouched: number; openCards: number;
  /** Écritures effectives (0 à blanc). */
  reconsolidationChanges: number; removed: number; cardsClosed: number;
  skipped?: string;
}

/** Achats ACTIFS du compte dont toutes les preuves sont des pièces de commande, avec leurs éléments d'Agenda liés. */
async function constat(accountId: number): Promise<OrderOnlyRepriseOperation[]> {
  const { pgClient } = await import('@/db');
  const ops = (await pgClient.unsafe(
    `SELECT o.id, o.technical_label, o.status, o.realized_date::text AS realized_date,
            COALESCE((SELECT array_agg(DISTINCT f.id ORDER BY f.id) FROM business_operation_sources s
                        JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = o.account_id AND f.deleted_at IS NULL
                       WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'), '{}') AS file_ids
       FROM business_operations o
      WHERE o.account_id = $1 AND o.type_code = 'ACQUISITION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        AND ${ORDER_ONLY_EVIDENCE_RAW}
      ORDER BY o.id`, [accountId] as never[])) as unknown as Row[];
  if (!ops.length) return [];
  const ids = ops.map((o) => Number(o.id));
  const items = (await pgClient.unsafe(
    `SELECT i.id, i.business_operation_id AS op, i.title, i.start_date::text AS date,
            (i.projection_origin IS NOT DISTINCT FROM 'OPERATION' AND i.is_automatic AND NOT i.is_automatic_modified) AS intact,
            COALESCE((SELECT array_agg(a.id ORDER BY a.id) FROM to_process_actions a
                       WHERE a.account_id = i.account_id AND a.target_type = 'AGENDA_ITEM' AND a.target_id = i.id
                         AND COALESCE(a.field_key, a.relation_key) = 'date' AND a.resolved_at IS NULL), '{}') AS cards
       FROM agenda_items i
      WHERE i.account_id = $1 AND i.business_operation_id = ANY($2::bigint[])
        AND i.projection_origin IS NOT DISTINCT FROM 'OPERATION'
      ORDER BY i.id`, [accountId, `{${ids.join(',')}}`] as never[])) as unknown as Row[];
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x)) : []);
  return ops.map((o) => ({
    operationId: Number(o.id), label: (o.technical_label as string | null) ?? null, status: String(o.status),
    realizedDate: (o.realized_date as string | null) ?? null, documentFileIds: nums(o.file_ids),
    items: items.filter((i) => Number(i.op) === Number(o.id)).map((i) => ({
      itemId: Number(i.id), title: String(i.title ?? ''), date: (i.date as string | null) ?? null,
      action: i.intact === true ? 'REMOVE' as const : 'KEEP_USER_TOUCHED' as const, openDateCards: nums(i.cards),
    })),
  }));
}

/**
 * Reprise d'UN compte. `apply` absent ou faux : à blanc (rapport, aucune
 * écriture). Compte non éligible aux traitements : rien n'est écrit
 * (`skipped`), le constat reste rendu.
 */
export async function repriseOrderOnlyPurchases(accountId: number, o: { apply?: boolean; today?: string; correlationId?: string } = {}): Promise<OrderOnlyRepriseReport> {
  const operations = Number.isSafeInteger(accountId) && accountId > 0 ? await constat(accountId) : [];
  const tous = operations.flatMap((x) => x.items);
  const report: OrderOnlyRepriseReport = {
    accountId, applied: false, operations,
    toRemove: tous.filter((i) => i.action === 'REMOVE').length,
    keptUserTouched: tous.filter((i) => i.action === 'KEEP_USER_TOUCHED').length,
    openCards: tous.reduce((n, i) => n + i.openDateCards.length, 0),
    reconsolidationChanges: 0, removed: 0, cardsClosed: 0,
  };
  if (!o.apply || !operations.length) return report;
  const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
  if (!(await isAccountProcessingEligible(accountId))) return { ...report, skipped: 'ACCOUNT_INELIGIBLE' };

  const correlationId = o.correlationId ?? `reprise-813:${accountId}`;
  const ids = operations.map((x) => x.operationId);
  const { reconsolidateOperations } = await import('../consolidation/consolidator');
  report.reconsolidationChanges = await reconsolidateOperations(accountId, ids, { correlationId, ...(o.today ? { today: o.today } : {}) });
  const { projectAccountOperations } = await import('./service');
  const p = await projectAccountOperations(accountId, { operationIds: ids, correlationId, ...(o.today ? { today: o.today } : {}) });
  report.removed = p.removed;
  // Cartes de date des éléments retirés : fermées par le producteur existant (filet : son balayage horaire).
  const retires = tous.filter((i) => i.action === 'REMOVE').map((i) => i.itemId);
  if (retires.length) {
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await produceAgendaActions(accountId, { trigger: 'SWEEP', only: retires, runRef: correlationId });
  }
  // Cartes effectivement fermées (par la projection au retrait, ou par le producteur) : relues en base.
  const cartes = tous.flatMap((i) => i.openDateCards);
  if (cartes.length) {
    const { pgClient } = await import('@/db');
    const [x] = (await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = $1 AND id = ANY($2::bigint[]) AND resolved_at IS NOT NULL`,
      [accountId, `{${cartes.join(',')}}`] as never[])) as unknown as Array<{ n: number }>;
    report.cardsClosed = Number(x?.n ?? 0);
  }
  report.applied = true;
  return report;
}
