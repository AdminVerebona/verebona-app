/**
 * Élément principal d'une Opération : unicité et propagation des documents
 * (lot 82D, CDC v5 §7.1, §7.2, §11.9, P4 ; invariants INV-O1-PRINCIPAL-UNIQUE
 * et INV-O1-PRINCIPAL-DOCS).
 *
 * `recomputePrincipal` NE CHOISIT PAS de principal (décision T4 ou
 * utilisateur, V-Q5) : il maintient la conséquence structurelle de la
 * décision prise —
 *   · au plus un principal (un excédent, impossible sous l'index 0652, est
 *     rétrogradé par rang d'autorité puis ancienneté) ;
 *   · tout document membre de l'Opération est lié au principal
 *     (OPERATION_PRINCIPAL), sauf refus mémorisé de l'utilisateur (lien
 *     propagé refusé — PRINCIPAL_LINK —, ou, lot 86D, lien détaché de
 *     l'élément principal — AGENDA_FILE_LINK) ;
 *   · la provenance OPERATION_PRINCIPAL quitte un élément qui n'est plus
 *     principal (transfert vers le nouveau principal, liens précis conservés) ;
 *   · Opération inactive ou fusionnée : plus aucune propagation.
 * Idempotent : un état conforme ne produit aucune écriture.
 */
import { rejectedLinkFileIds, rejectedSubjects } from './decisions';
import { ROLE_ORIGIN_RANK, planPrincipalLinks, type RoleOrigin } from './model';
import { addFileLinkProvenance, removeFileLinkProvenance } from './provenance';
import { intArray, type GroupingRunner } from './runner';

export interface PrincipalRecompute {
  operationId: number;
  principalItemId: number | null;
  added: number;
  removed: number;
  demoted: number[];
}

/** Principal actuel d'une Opération (après rétrogradation d'un excédent éventuel). */
export async function currentPrincipal(r: GroupingRunner, accountId: number, operationId: number): Promise<{ itemId: number; origin: RoleOrigin | null } | null> {
  const x = await r.q<{ id: number; origin: RoleOrigin | null }>(
    `SELECT id, operation_role_origin AS origin FROM agenda_items
      WHERE account_id = $1 AND business_operation_id = $2 AND operation_role = 'PRINCIPAL' ORDER BY id`,
    [accountId, operationId],
  );
  if (!x.length) return null;
  const [best] = [...x].sort((a, b) => ROLE_ORIGIN_RANK[(b.origin ?? 'SYSTEM') as RoleOrigin] - ROLE_ORIGIN_RANK[(a.origin ?? 'SYSTEM') as RoleOrigin] || a.id - b.id);
  return { itemId: Number(best.id), origin: best.origin ?? null };
}

/** Retire la propagation de tous les liens d'éléments (élément détaché, rétrogradé). */
export async function stripPrincipalLinks(r: GroupingRunner, itemIds: readonly number[]): Promise<number> {
  return removeFileLinkProvenance(r, itemIds, null, 'OPERATION_PRINCIPAL');
}

export async function recomputePrincipal(r: GroupingRunner, accountId: number, operationId: number): Promise<PrincipalRecompute> {
  const res: PrincipalRecompute = { operationId, principalItemId: null, added: 0, removed: 0, demoted: [] };
  const [op] = await r.q<{ active: boolean }>(
    `SELECT (invalidated_at IS NULL AND merged_into_operation_id IS NULL) AS active FROM business_operations WHERE id = $1 AND account_id = $2`,
    [operationId, accountId],
  );
  const items = await r.q<{ id: number; role: string | null; origin: RoleOrigin | null }>(
    `SELECT id, operation_role AS role, operation_role_origin AS origin FROM agenda_items
      WHERE account_id = $1 AND business_operation_id = $2 ORDER BY id`,
    [accountId, operationId],
  );
  const itemIds = items.map((i) => Number(i.id));
  if (!op || !op.active) {
    res.removed = await stripPrincipalLinks(r, itemIds);
    return res;
  }
  // Unicité (filet : l'index 0652 l'impose déjà).
  const principaux = items.filter((i) => i.role === 'PRINCIPAL');
  const garde = await currentPrincipal(r, accountId, operationId);
  if (principaux.length > 1 && garde) {
    res.demoted = principaux.map((p) => Number(p.id)).filter((id) => id !== garde.itemId);
    await r.q(`UPDATE agenda_items SET operation_role = 'RELATED', updated_at = now() WHERE id = ANY($1::int[]) AND account_id = $2`, [intArray(res.demoted), accountId]);
  }
  res.principalItemId = garde?.itemId ?? null;

  const membres = await r.q<{ file_id: number }>(
    `SELECT d.file_id FROM business_operation_documents d JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
      WHERE d.account_id = $1 AND d.operation_id = $2 AND d.active ORDER BY d.file_id`,
    [accountId, operationId],
  );
  const links = itemIds.length ? await r.q<{ item_id: number; file_id: number; provenances: string[] }>(
    `SELECT agenda_item_id AS item_id, asset_file_id AS file_id, provenances FROM agenda_file_links WHERE agenda_item_id = ANY($1::int[])`,
    [intArray(itemIds)],
  ) : [];
  const plan = planPrincipalLinks({
    principalItemId: res.principalItemId,
    memberItemIds: itemIds,
    memberFileIds: membres.map((m) => Number(m.file_id)),
    // Lot 86D : lien détaché par l'utilisateur sur l'élément principal (décision portée par le lien) — jamais repropagé.
    rejectedFileIds: [...new Set([
      ...await rejectedSubjects(r, accountId, operationId, 'PRINCIPAL_LINK'),
      ...(res.principalItemId !== null ? await rejectedLinkFileIds(r, res.principalItemId) : []),
    ])],
    links: links.map((l) => ({ itemId: Number(l.item_id), fileId: Number(l.file_id), provenances: l.provenances ?? [] })),
  });
  for (const x of plan.remove) res.removed += await removeFileLinkProvenance(r, [x.itemId], [x.fileId], 'OPERATION_PRINCIPAL');
  if (plan.add.length && res.principalItemId !== null) {
    res.added = await addFileLinkProvenance(r, res.principalItemId, plan.add.map((x) => x.fileId), 'OPERATION_PRINCIPAL');
  }
  return res;
}
