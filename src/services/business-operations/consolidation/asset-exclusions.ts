/**
 * Bien retiré d'un sinistre : exclusion MÉMORISÉE (lot 53, retour PO Q17).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS DE RÉINTÉGRATION AUTOMATIQUE CONTRE LA DÉCISION DE L'UTILISATEUR
 *
 *   · retirer un bien d'un sinistre (formulaire Sinistre) mémorise une
 *     exclusion (`business_operation_asset_exclusions`, migration 0349) ;
 *   · la consolidation T3 ne relie plus ce bien au sinistre, même si un
 *     document le cite (`applyAssetExclusions`) ;
 *   · un document qui le cite et que l'utilisateur n'a pas encore arbitré →
 *     carte « À traiter » de décision (`OPERATION-CLAIM-ASSET`), avec le
 *     document à l'origine de la contradiction ;
 *   · « Il reste hors du sinistre » : le document est mémorisé comme arbitré
 *     (aucune nouvelle carte pour lui ; un NOUVEAU document en reposera une) ;
 *     « Le rattacher à nouveau » ou un nouveau cochage dans le formulaire :
 *     l'exclusion est levée (`released_at`, jamais supprimée).
 *
 * Table non déclarée dans Drizzle : absente (migration non jouée), le
 * comportement du lot 52 s'applique (vérifié une fois, sans erreur dans la
 * transaction).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../lock';

type Runner = Pick<DbTx, 'execute'>;
const rows = async <T = Record<string, unknown>>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;

export interface AssetExclusion {
  id: number;
  assetId: number;
  /** Documents déjà arbitrés par l'utilisateur (« il reste hors du sinistre »). */
  acknowledgedFileIds: number[];
}

/** Bien cité par une preuve documentaire de l'Opération. */
export interface AssetCitation { assetId: number; fileId: number }

export interface ExclusionOutcome<T extends { assetId: number }> {
  /** Biens à relier (exclusions retirées). */
  assets: T[];
  /** Biens exclus cités par des documents non encore arbitrés → carte de décision. */
  conflicts: Array<{ assetId: number; exclusionId: number; fileIds: number[] }>;
}

/**
 * Applique les exclusions mémorisées aux biens consolidés (pure) : un bien
 * exclu n'est jamais relié ; s'il est cité par un document non encore
 * arbitré, un conflit est rendu (carte de décision).
 */
export function applyAssetExclusions<T extends { assetId: number }>(
  assets: readonly T[], citations: readonly AssetCitation[], exclusions: readonly AssetExclusion[],
): ExclusionOutcome<T> {
  if (!exclusions.length) return { assets: [...assets], conflicts: [] };
  const parBien = new Map(exclusions.map((e) => [e.assetId, e]));
  const conflicts: ExclusionOutcome<T>['conflicts'] = [];
  for (const e of exclusions) {
    const fileIds = [...new Set(citations.filter((c) => c.assetId === e.assetId && !e.acknowledgedFileIds.includes(c.fileId)).map((c) => c.fileId))]
      .sort((a, b) => a - b);
    if (fileIds.length) conflicts.push({ assetId: e.assetId, exclusionId: e.id, fileIds });
  }
  return { assets: assets.filter((a) => !parBien.has(a.assetId)), conflicts };
}

let tablePresente: boolean | null = null;

/** La table 0349 existe-t-elle ? (vérifié sans erreur SQL ; mémorisé une fois présente). */
export async function exclusionsTableReady(r: Runner): Promise<boolean> {
  if (tablePresente) return true;
  const [x] = await rows<{ ok: boolean }>(r, sql`SELECT to_regclass('business_operation_asset_exclusions') IS NOT NULL AS ok`);
  tablePresente = !!x?.ok;
  return tablePresente;
}

/** Exclusions ACTIVES d'une Opération (vide si la table n'existe pas). */
export async function loadActiveExclusions(r: Runner, accountId: number, operationId: number): Promise<AssetExclusion[]> {
  if (!(await exclusionsTableReady(r))) return [];
  const x = await rows<{ id: string; asset_id: number; ack: number[] | null }>(r, sql`
    SELECT id, asset_id, acknowledged_file_ids AS ack FROM business_operation_asset_exclusions
     WHERE account_id = ${accountId} AND operation_id = ${operationId} AND active ORDER BY id`);
  return x.map((e) => ({ id: Number(e.id), assetId: Number(e.asset_id), acknowledgedFileIds: (e.ack ?? []).map(Number) }));
}

/**
 * Mémorise l'exclusion d'un bien (idempotent : une seule exclusion active par
 * couple). `knownFileIds` : documents déjà connus au moment de la décision
 * (arbitrés d'emblée : seul un NOUVEAU document produit une carte).
 */
export async function excludeAsset(
  r: Runner, accountId: number, operationId: number, assetId: number, userId: number | null, knownFileIds: readonly number[] = [],
): Promise<boolean> {
  if (!(await exclusionsTableReady(r))) return false;
  const [deja] = await rows(r, sql`
    SELECT 1 FROM business_operation_asset_exclusions WHERE operation_id = ${operationId} AND asset_id = ${assetId} AND active`);
  if (deja) return false;
  await r.execute(sql`
    INSERT INTO business_operation_asset_exclusions (account_id, operation_id, asset_id, excluded_by_user_id, acknowledged_file_ids)
    VALUES (${accountId}, ${operationId}, ${assetId}, ${userId}, ${intArray(knownFileIds)}::int[])`);
  return true;
}

/** Lève l'exclusion (nouvel arbitrage) ; rend vrai si une exclusion active existait. */
export async function releaseExclusion(r: Runner, accountId: number, operationId: number, assetId: number, reason: string): Promise<boolean> {
  if (!(await exclusionsTableReady(r))) return false;
  const x = await rows(r, sql`
    UPDATE business_operation_asset_exclusions SET active = false, released_at = now(), release_reason = ${reason}, updated_at = now()
     WHERE account_id = ${accountId} AND operation_id = ${operationId} AND asset_id = ${assetId} AND active
    RETURNING id`);
  return x.length > 0;
}

/** « Il reste hors du sinistre » : ces documents sont arbitrés (aucune nouvelle carte pour eux). */
export async function acknowledgeExclusion(r: Runner, accountId: number, operationId: number, assetId: number, fileIds: readonly number[]): Promise<boolean> {
  if (!(await exclusionsTableReady(r)) || !fileIds.length) return false;
  const x = await rows(r, sql`
    UPDATE business_operation_asset_exclusions
       SET acknowledged_file_ids = (SELECT array_agg(DISTINCT f ORDER BY f) FROM unnest(acknowledged_file_ids || ${intArray(fileIds)}::int[]) AS f),
           updated_at = now()
     WHERE account_id = ${accountId} AND operation_id = ${operationId} AND asset_id = ${assetId} AND active
    RETURNING id`);
  return x.length > 0;
}

/** Annulation d'un arbitrage « il reste hors du sinistre » : ces documents redeviennent non arbitrés. */
export async function unacknowledgeExclusion(r: Runner, accountId: number, operationId: number, assetId: number, fileIds: readonly number[]): Promise<void> {
  if (!(await exclusionsTableReady(r)) || !fileIds.length) return;
  await r.execute(sql`
    UPDATE business_operation_asset_exclusions
       SET acknowledged_file_ids = COALESCE((SELECT array_agg(f ORDER BY f) FROM unnest(acknowledged_file_ids) AS f
                                              WHERE NOT f = ANY(${intArray(fileIds)}::int[])), '{}'),
           updated_at = now()
     WHERE account_id = ${accountId} AND operation_id = ${operationId} AND asset_id = ${assetId} AND active`);
}
