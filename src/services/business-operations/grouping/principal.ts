/**
 * Élément qui PORTE un fait d'un événement de référence : unicité du porteur
 * par fait et propagation des documents (lot 82D, CDC v5 §7.1, §7.2, §11.9,
 * P4 ; invariants INV-O1-PRINCIPAL-UNIQUE et INV-O1-PRINCIPAL-DOCS).
 *
 * Lot 114O (carte #744, CDC « Opérations / Agenda V2.0 » §4, §16, AC40,
 * migration 1721) — le rôle « principal » (`agenda_items.operation_role`) n'est
 * plus ni écrit ni lu : le porteur est celui dont le LIEN N↔N porte le fait
 * (`business_operation_agenda_links.fact_key`). Aucune hiérarchie : au plus un
 * porteur par fait, tous les autres liens sont des membres de plein droit.
 *
 * `recomputePrincipal` NE CHOISIT PAS de porteur (décision T4 ou utilisateur,
 * V-Q5) : il maintient la conséquence structurelle de la décision prise —
 *   · au plus un porteur par fait (un excédent est retiré par rang d'autorité
 *     puis ancienneté — le lien reste, seul le fait porté est retiré) ;
 *   · tout document membre de l'Opération est lié au porteur
 *     (OPERATION_PRINCIPAL, nom de valeur historique du §7.4), sauf refus
 *     mémorisé de l'utilisateur (lien propagé refusé — PRINCIPAL_LINK —, ou,
 *     lot 86D, lien détaché de l'élément porteur — AGENDA_FILE_LINK) ;
 *   · la provenance OPERATION_PRINCIPAL quitte un élément qui ne porte plus le
 *     fait (transfert vers le nouveau porteur, liens précis conservés) ;
 *   · Opération inactive ou fusionnée : plus aucune propagation.
 * Idempotent : un état conforme ne produit aucune écriture.
 */
import { clearAgendaLinkFacts, readAgendaFactCarriers } from '../graph/store';
import { rejectedLinkFileIds, rejectedSubjects } from './decisions';
import { ROLE_ORIGIN_RANK, planPrincipalLinks, roleOriginOfGraphOrigin, type RoleOrigin } from './model';
import { addFileLinkProvenance, removeFileLinkProvenance } from './provenance';
import { intArray, type GroupingRunner } from './runner';

export interface PrincipalRecompute {
  operationId: number;
  /** Élément qui porte un fait de cet événement de référence (null : aucun). */
  principalItemId: number | null;
  added: number;
  removed: number;
  /** Éléments dont le fait porté a été retiré (l'élément et son lien restent). */
  demoted: number[];
}

/** Rang d'autorité d'un porteur, lu sur l'origine de son lien (utilisateur > IA > reprise). */
const rang = (origin: string | null): number => ROLE_ORIGIN_RANK[(roleOriginOfGraphOrigin(origin) ?? 'SYSTEM')];

/**
 * Porteur d'un fait de cette Opération (le plus autorisé, puis le plus ancien).
 * `factKey` : restreint à ce fait ; sinon, le porteur de n'importe quel fait
 * (une Opération n'a qu'une clé de projection à la fois).
 */
export async function currentFactCarrier(
  r: GroupingRunner, accountId: number, operationId: number, factKey?: string | null,
): Promise<{ itemId: number; origin: RoleOrigin | null; factKey: string } | null> {
  const porteurs = (await readAgendaFactCarriers(r, accountId, operationId))
    .filter((p) => factKey == null || p.factKey === factKey);
  if (!porteurs.length) return null;
  const [best] = [...porteurs].sort((a, b) => rang(b.origin) - rang(a.origin) || a.itemId - b.itemId);
  return { itemId: best.itemId, origin: roleOriginOfGraphOrigin(best.origin), factKey: best.factKey };
}

/** Retire la propagation de tous les liens d'éléments (élément détaché, fait porté retiré). */
export async function stripPropagatedDocumentLinks(r: GroupingRunner, itemIds: readonly number[]): Promise<number> {
  return removeFileLinkProvenance(r, itemIds, null, 'OPERATION_PRINCIPAL');
}

export async function recomputePrincipal(r: GroupingRunner, accountId: number, operationId: number): Promise<PrincipalRecompute> {
  const res: PrincipalRecompute = { operationId, principalItemId: null, added: 0, removed: 0, demoted: [] };
  const [op] = await r.q<{ active: boolean }>(
    `SELECT (invalidated_at IS NULL AND merged_into_operation_id IS NULL) AS active FROM business_operations WHERE id = $1 AND account_id = $2`,
    [operationId, accountId],
  );
  const items = await r.q<{ id: number }>(
    `SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2 ORDER BY id`,
    [accountId, operationId],
  );
  const itemIds = items.map((i) => Number(i.id));
  if (!op || !op.active) {
    res.removed = await stripPropagatedDocumentLinks(r, itemIds);
    return res;
  }
  // Unicité du porteur par fait (filet : le service de regroupement l'impose à l'écriture).
  const porteurs = await readAgendaFactCarriers(r, accountId, operationId);
  const garde = await currentFactCarrier(r, accountId, operationId);
  const excedent = porteurs.filter((p) => garde && p.itemId !== garde.itemId && p.factKey === garde.factKey).map((p) => p.itemId);
  if (excedent.length) {
    res.demoted = await clearAgendaLinkFacts(r, accountId, operationId, excedent, 'FACT_CARRIER_DUPLICATE');
    await stripPropagatedDocumentLinks(r, res.demoted);
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
    // Lot 86D : lien détaché par l'utilisateur sur l'élément porteur (décision portée par le lien) — jamais repropagé.
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
