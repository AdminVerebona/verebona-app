/**
 * Opérations et cycle de vie des biens — transfert entre comptes (décision PO
 * Q14) et suppression définitive (CDC Opérations V1 B27, C25, F-186, F-187).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TRANSFERT D'UN BIEN VERS UN AUTRE COMPTE (Duo : demande de déplacement
 * acceptée, départ d'un membre)
 *
 *   · une Opération qui ne concerne QUE ce bien (liens actifs bien et
 *     équipements ; à défaut, tous ses liens) SUIT le bien : `account_id`
 *     change en une instruction ; sources, liens, composantes, références,
 *     historique, décisions et suppressions de projection suivent par la clé
 *     composée (ON UPDATE CASCADE) ; les détails CONTRACT / FINANCING / CLAIM
 *     et listes Sinistre suivent par leur Opération. Les Opérations absorbées
 *     (fusion) suivent leur canonique ;
 *   · une Opération multi-biens RESTE sur l'ancien compte : son lien vers le
 *     bien transféré (et ses équipements, et les attributions de composantes
 *     au bien) est retiré, historisé ;
 *   · aucune relation ne franchit les comptes après coup : parent / enfant,
 *     contrat d'assurance d'un sinistre, INTERVENTION enfant d'une action
 *     Sinistre — détachés et historisés quand un seul côté part.
 *
 * Transmission (`/api/transmission/[token]`) : le bien n'y change PAS de
 * compte — il est DUPLIQUÉ chez le destinataire (nouvel identifiant,
 * documents copiés au choix), l'original reste chez l'émetteur. Les
 * Opérations restent donc attachées au bien d'origine, dans son compte ; les
 * copier créerait des Opérations automatiquement, ce que ce lot exclut (le
 * destinataire les obtiendra par T1/T3 sur les documents copiés).
 *
 * SUPPRESSION DÉFINITIVE D'UN BIEN (`deleteAssetCompletely`)
 *
 *   · liens actifs vers le bien (et ses équipements) retirés, attributions de
 *     composantes au bien retirées — historisés AVANT que la cascade emporte
 *     les lignes ;
 *   · sources portées par le bien désactivées : documents emportés, données
 *     du bien, formulaire Sinistre, données d'équipement, sources MIGRATION
 *     dont le locator vise le bien ;
 *   · Opérations sans plus aucune source active invalidées (C8,
 *     INV-FINAL-006) — dont celles qui n'ont plus ni bien ni source ; une
 *     Opération multi-biens encore prouvée survit avec ses autres liens
 *     (F-187), une Opération sans bien mais prouvée reste active (P08).
 *
 * Même transaction que l'appelant ; événements rendus, publiés après commit.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import type { BusinessOperationEvent } from './events';
import type { DbTx } from './lock';
import { withBusinessOperationWriteInTx, type WriteOptions } from './write';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const ids = (list: Array<{ id: unknown }>) => list.map((r) => Number(r.id));

export interface AssetTransferResult {
  /** Opérations déplacées vers le nouveau compte (absorbées comprises). */
  moved: number[];
  /** Opérations multi-biens restées sur l'ancien compte, lien retiré. */
  detached: number[];
  events: BusinessOperationEvent[];
}

/**
 * Transfert des Opérations d'un bien qui change de compte. À appeler DANS la
 * transaction qui met à jour `assets.account_id`, avant ou après cette mise à
 * jour. Rend les événements à publier après commit.
 */
export async function transferAssetOperationsInTx(
  tx: DbTx,
  p: { assetId: number; fromAccountId: number; toAccountId: number; reasonCode?: string },
  options: WriteOptions = {},
): Promise<AssetTransferResult> {
  if (!p.fromAccountId || !p.toAccountId || p.fromAccountId === p.toAccountId) return { moved: [], detached: [], events: [] };
  const reason = p.reasonCode ?? 'ASSET_TRANSFERRED';
  const { result, events } = await withBusinessOperationWriteInTx(tx, [p.fromAccountId, p.toAccountId], async (session) => {
    const from = p.fromAccountId;
    const to = p.toAccountId;

    // 1. Opérations (non absorbées) liées au bien, et l'ensemble de leurs biens.
    const concernees = await rows<{ id: string; mono: boolean; lien_actif: boolean }>(tx, sql`
      WITH liens AS (
        SELECT operation_id, asset_id, active FROM business_operation_asset_links WHERE account_id = ${from}
        UNION ALL
        SELECT operation_id, asset_id, active FROM business_operation_equipment_links WHERE account_id = ${from}
      ),
      agg AS (
        SELECT operation_id,
               bool_or(active) AS a_actif,
               bool_or(active AND asset_id = ${p.assetId}) AS lien_actif,
               array_agg(DISTINCT asset_id) FILTER (WHERE active) AS actifs,
               array_agg(DISTINCT asset_id) AS tous
          FROM liens GROUP BY operation_id
         HAVING bool_or(asset_id = ${p.assetId})
      )
      SELECT o.id,
             CASE WHEN agg.a_actif THEN agg.actifs = ARRAY[${p.assetId}]::int[] ELSE agg.tous = ARRAY[${p.assetId}]::int[] END AS mono,
             agg.lien_actif
        FROM agg JOIN business_operations o ON o.id = agg.operation_id AND o.account_id = ${from}
       WHERE o.merged_into_operation_id IS NULL
       ORDER BY o.id
       FOR UPDATE OF o`);
    const partantes = new Set(concernees.filter((c) => c.mono).map((c) => Number(c.id)));
    const restantes = concernees.filter((c) => !c.mono && c.lien_actif).map((c) => Number(c.id));

    // 2. Les absorbées suivent leur canonique (clé composée de fusion).
    for (let frontiere = [...partantes]; frontiere.length;) {
      const absorbees = ids(await rows(tx, sql`
        SELECT id FROM business_operations
         WHERE account_id = ${from} AND merged_into_operation_id IN ${sql.raw(`(${frontiere.join(',')})`)} FOR UPDATE`));
      frontiere = absorbees.filter((a) => !partantes.has(a));
      for (const a of frontiere) partantes.add(a);
    }
    const moved = [...partantes].sort((a, b) => a - b);
    const repoFrom = session.repository(from);

    if (moved.length) {
      const liste = sql.raw(`(${moved.join(',')})`);
      // 3. Relations qui franchiraient les comptes : détachées, historisées.
      const parentsCoupes = await rows<{ id: string; parent: string }>(tx, sql`
        SELECT id, parent_operation_id AS parent FROM business_operations
         WHERE account_id = ${from} AND parent_operation_id IS NOT NULL
           AND ((id IN ${liste} AND parent_operation_id NOT IN ${liste})
             OR (id NOT IN ${liste} AND parent_operation_id IN ${liste}))`);
      for (const r of parentsCoupes) {
        await tx.execute(sql`UPDATE business_operations SET parent_operation_id = NULL, version = version + 1, updated_at = now() WHERE id = ${Number(r.id)}`);
        await historiser(tx, from, Number(r.id), 'PARENT_CHANGED', `${reason}_PARENT_DETACHED`, { parent_operation_id: Number(r.parent) }, { parent_operation_id: null }, session);
      }
      const contratsCoupes = await rows<{ id: string; contrat: string }>(tx, sql`
        UPDATE business_operation_claim_details d SET insurance_contract_operation_id = NULL, updated_at = now()
          FROM business_operation_claim_details avant
         WHERE d.operation_id = avant.operation_id AND d.insurance_contract_operation_id IS NOT NULL
           AND ((d.operation_id IN ${liste} AND d.insurance_contract_operation_id NOT IN ${liste})
             OR (d.operation_id NOT IN ${liste} AND d.insurance_contract_operation_id IN ${liste}))
        RETURNING d.operation_id AS id, avant.insurance_contract_operation_id AS contrat`);
      for (const r of contratsCoupes) {
        const [o] = await rows<{ account_id: number }>(tx, sql`SELECT account_id FROM business_operations WHERE id = ${Number(r.id)}`);
        if (o && Number(o.account_id) === from) {
          await historiser(tx, from, Number(r.id), 'UPDATED', `${reason}_CONTRACT_DETACHED`, { insurance_contract_operation_id: Number(r.contrat) }, { insurance_contract_operation_id: null }, session);
        }
      }
      await tx.execute(sql`
        UPDATE business_operation_claim_actions SET child_operation_id = NULL
         WHERE child_operation_id IS NOT NULL
           AND ((operation_id IN ${liste} AND child_operation_id NOT IN ${liste})
             OR (operation_id NOT IN ${liste} AND child_operation_id IN ${liste}))`);

      // 4. Le déplacement : une instruction, les lignes filles suivent en cascade.
      await tx.execute(sql`
        UPDATE business_operations SET account_id = ${to}, version = version + 1, updated_at = now()
         WHERE account_id = ${from} AND id IN ${liste}`);
      for (const id of moved) {
        await historiser(tx, to, id, 'UPDATED', reason, { account_id: from }, { account_id: to, asset_id: p.assetId }, session);
        session.events.push({ type: 'BUSINESS_OPERATION_UPDATED', accountId: to, operationId: id, previousAccountId: from, reasonCode: reason });
      }
    }

    // 5. Multi-biens : restent, lien vers le bien transféré retiré.
    for (const id of restantes) await repoFrom.detachAsset(id, p.assetId, reason);
    return { moved, detached: restantes };
  }, options);
  return { ...result, events };
}

export interface AssetDeletionResult {
  detached: number[];
  sourcesDeactivated: number;
  invalidated: number[];
  events: BusinessOperationEvent[];
}

/**
 * Suppression définitive d'un bien : à appeler dans la transaction de
 * suppression, AVANT `DELETE FROM assets` (les équipements et fichiers
 * existent encore). Rend les événements à publier après commit.
 */
export async function retireDeletedAssetFromOperationsInTx(
  tx: DbTx,
  p: { accountId: number; assetId: number; fileIds: readonly number[] },
  options: WriteOptions = {},
): Promise<AssetDeletionResult> {
  const reason = 'ASSET_DELETED';
  const { result, events } = await withBusinessOperationWriteInTx(tx, [p.accountId], async (session) => {
    const repo = session.repository(p.accountId);
    const equipmentIds = ids(await rows(tx, sql`SELECT id FROM equipments WHERE asset_id = ${p.assetId}`));
    const equipSql = equipmentIds.length ? sql.raw(`(${equipmentIds.join(',')})`) : sql.raw('(NULL)');

    // Opérations du compte qui visent le bien (lien, équipement, attribution).
    const visees = ids(await rows(tx, sql`
      SELECT operation_id AS id FROM business_operation_asset_links WHERE account_id = ${p.accountId} AND asset_id = ${p.assetId} AND active
      UNION SELECT operation_id FROM business_operation_equipment_links WHERE account_id = ${p.accountId} AND asset_id = ${p.assetId} AND active
      UNION SELECT operation_id FROM business_operation_financial_components
             WHERE account_id = ${p.accountId} AND (target_asset_id = ${p.assetId} OR target_equipment_id IN ${equipSql})
      ORDER BY 1`));
    for (const id of visees) await repo.detachAsset(id, p.assetId, reason);

    // Sources portées par le bien (convention `SOURCE_KEY_TABLE`).
    const keys = (list: readonly number[]) => list.length ? sql.raw(`(${list.map((x) => `'${Number(x)}'`).join(',')})`) : sql.raw('(NULL)');
    const sources = await rows<{ id: string; operation_id: string }>(tx, sql`
      SELECT id, operation_id FROM business_operation_sources
       WHERE account_id = ${p.accountId} AND active
         AND ((source_kind = 'DOCUMENT' AND source_entity_key IN ${keys(p.fileIds)})
           OR (source_kind IN ('ASSET_DATA', 'CLAIM_FORM') AND source_entity_key = ${String(p.assetId)})
           OR (source_kind = 'EQUIPMENT_DATA' AND source_entity_key IN ${keys(equipmentIds)})
           OR (source_kind = 'MIGRATION' AND locator->>'assetId' = ${String(p.assetId)}))
       ORDER BY id`);
    for (const s of sources) await repo.deactivateSource(Number(s.id), reason);

    const touchees = [...new Set([...visees, ...sources.map((s) => Number(s.operation_id))])].sort((a, b) => a - b);
    const invalidated: number[] = [];
    for (const id of touchees) {
      if (await repo.invalidateIfUnsupported(id, `${reason}_NO_SOURCE`)) invalidated.push(id);
    }
    return { detached: visees, sourcesDeactivated: sources.length, invalidated };
  }, options);
  return { ...result, events };
}

async function historiser(
  tx: DbTx, accountId: number, operationId: number, eventType: string, reasonCode: string,
  before: Record<string, unknown>, after: Record<string, unknown>,
  session: { correlationId: string; actorUserId: number | null },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO business_operation_history (account_id, operation_id, event_type, reason_code, actor_user_id, before_json, after_json, correlation_id)
    VALUES (${accountId}, ${operationId}, ${eventType}, ${reasonCode}, ${session.actorUserId},
            ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, ${session.correlationId})`);
}
