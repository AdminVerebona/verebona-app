/**
 * Suppression définitive d'un bien — carte #849 (B) : « tout ce qui lui
 * appartient EXCLUSIVEMENT est supprimé ; ce qui est lié aussi à un autre
 * bien survit ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 * Supprimer un bien supprime tout ce qui lui appartient EXCLUSIVEMENT :
 * documents et versions, photos, pièces, équipements, échéances, événements,
 * éléments d'Agenda, Opérations et leurs dépenses, exports… Un élément lié
 * AUSSI à un autre bien du compte (document multi-biens, Opération ou
 * échéance partagée) est CONSERVÉ : seule sa relation au bien supprimé
 * disparaît (plan unique : `asset-deletion-plan.ts`). Aucune option de
 * conservation, aucune corbeille, aucun délai : l'action est irréversible.
 *
 * Garde-fous (#849, B1/B2) :
 *   · ligne du bien VERROUILLÉE (FOR UPDATE) : double clic, suppressions
 *     simultanées, rattachement concurrent sérialisés ; un bien déjà supprimé
 *     → issue « déjà supprimé », rien d'autre ;
 *   · EMPREINTE de l'inventaire confirmé recalculée sous verrou : écart →
 *     `AssetDeletionInventoryChangedError`, transaction annulée, rien détruit ;
 *   · une seule transaction : un échec DB n'a rien détruit à moitié.
 *
 * Les objets du stockage (S3/OVH) ne sont pas couverts par la cascade : ils
 * sont mis en file de purge (`pending_blob_deletions`) DANS la même
 * transaction, AVANT la suppression des lignes — comme la suppression de
 * compte. Le cron `/api/cron/purge-blobs` les supprime APRÈS commit, en
 * revérifiant qu'aucun fichier ni version ne les référence encore
 * (`blob-purge.service`), avec relance et suivi des échecs. Les sauvegardes
 * de la base suivent leur propre rétention (jamais instantanée).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { getS3Bucket, isS3Configured } from '@/lib/s3-config';
import { eq, sql, type SQL } from 'drizzle-orm';
import {
  deleteExclusiveOperationsInTx, retireDeletedAssetFromOperationsInTx, supersedeDeletedAssetComponentsInTx,
} from '@/services/business-operations/asset-lifecycle';
import { assets } from '@/db/schema';
import { publishBusinessOperationEvents, type BusinessOperationEvent } from '@/services/business-operations/events';
import {
  deletionPlanFingerprint, inventoryOfPlan, planAssetDeletion, type AssetDeletionInventory, type DeletionPlan,
} from './asset-deletion-plan';

/** Décompte présenté avant confirmation (DeleteAssetDialog) — #849 : inventaire complet. */
export type AssetDeletionSummary = AssetDeletionInventory;

/** #849 : l'inventaire a changé depuis son affichage (rattachement, partage…) — rien n'a été supprimé. */
export class AssetDeletionInventoryChangedError extends Error {
  readonly code = 'DELETION_INVENTORY_CHANGED' as const;
  constructor(public readonly inventory: AssetDeletionInventory) {
    super('L’inventaire du bien a changé depuis son affichage : rien n’a été supprimé.');
    this.name = 'AssetDeletionInventoryChangedError';
  }
}

/* ── Fonctions pures (testées unitairement) ─────────────────────────────── */

/**
 * Clé de stockage d'une vignette. La vignette est enregistrée soit comme clé
 * brute, soit (historique) comme URL S3 path-style ou virtual-host.
 */
export function thumbnailStorageKey(thumbnailUrl: string | null | undefined, bucket?: string | null): string | null {
  if (!thumbnailUrl) return null;
  const value = thumbnailUrl.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value;
  if (!bucket) return null;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (url.hostname.startsWith(`${bucket}.`)) return path || null;
    if (path.startsWith(`${bucket}/`)) return path.slice(bucket.length + 1) || null;
  } catch {
    // URL invalide : rien à purger de façon sûre.
  }
  return null;
}

/** Clés des fichiers générés d'un export (`output_payload` JSON). */
export function exportStorageKeys(outputPayload: string | null | undefined): string[] {
  if (!outputPayload) return [];
  try {
    const parsed = JSON.parse(outputPayload) as Record<string, unknown>;
    return ['pdfS3Key', 'zipS3Key']
      .map((k) => parsed?.[k])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Clés à programmer : dédoublonnées, sans la valeur provisoire `temp` du
 * presign, sans celles encore référencées par un fichier qui survit, et sans
 * celles déjà en attente de purge.
 */
export function selectBlobKeysToPurge(input: {
  candidates: Array<string | null | undefined>;
  stillReferenced?: Iterable<string>;
  alreadyPending?: Iterable<string>;
}): string[] {
  const excluded = new Set<string>([...(input.stillReferenced ?? []), ...(input.alreadyPending ?? [])]);
  const out = new Set<string>();
  for (const key of input.candidates) {
    if (!key || key === 'temp' || excluded.has(key)) continue;
    out.add(key);
  }
  return [...out];
}

/* ── Accès base ─────────────────────────────────────────────────────────── */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rows = async <T = Record<string, unknown>>(r: Pick<typeof db, 'execute'>, q: SQL): Promise<T[]> =>
  (await r.execute(q)) as unknown as T[];
const pgInts = (list: readonly number[]) => `{${list.map((n) => Math.trunc(Number(n))).join(',')}}`;

/**
 * #849 — inventaire de la suppression (supprimé / conservé) et son empreinte.
 * `null` : bien introuvable. Lecture seule.
 */
export async function getAssetDeletionInventory(assetId: number): Promise<AssetDeletionInventory | null> {
  const plan = await planAssetDeletion(db, assetId);
  return plan ? inventoryOfPlan(plan) : null;
}

/** Décompte (compatibilité) : inventaire, ou inventaire vide si le bien a disparu. */
export async function getAssetDeletionSummary(assetId: number): Promise<AssetDeletionSummary> {
  const inv = await getAssetDeletionInventory(assetId);
  if (!inv) throw new Error(`Bien ${assetId} introuvable : inventaire impossible`);
  return inv;
}

/** Tables sans clé étrangère vers `assets` qui portent des données DU bien (purgées avec lui). */
const DONNEES_DU_BIEN_SANS_CLE = [
  'field_evidence', 'agenda_equivalence_decisions', 'economic_qualification_reviews',
  'document_fact_provenance_events', 'document_asset_identifier_changes',
] as const;

export interface AssetDeletionOutcome {
  blobsScheduled: number;
  /** Documents supprimés (preuves retirées des autres biens par l'appelant). */
  fileIds: number[];
  /** Biens qui reçoivent un document conservé (réconciliés par l'appelant). */
  rehomedToAssetIds: number[];
  /** Bien déjà supprimé (double clic, suppression simultanée) : rien n'a été fait. */
  alreadyDeleted?: boolean;
  inventory?: AssetDeletionInventory;
}

/**
 * Supprime le bien et ce qui lui appartient exclusivement ; conserve et
 * détache le partagé ; programme la purge des objets de stockage.
 * `expectedFingerprint` : empreinte de l'inventaire CONFIRMÉ (obligatoire
 * côté HTTP) — écart → `AssetDeletionInventoryChangedError`.
 */
export async function deleteAssetCompletely(asset: {
  id: number;
  thumbnailUrl?: string | null;
}, opts: { expectedFingerprint?: string | null } = {}): Promise<AssetDeletionOutcome> {
  const assetId = asset.id;
  const bucket = isS3Configured() ? getS3Bucket() : null;
  // Lot 39 (O1) : événements Opération publiés APRÈS commit seulement.
  let operationEvents: BusinessOperationEvent[] = [];

  const outcome = await db.transaction(async (tx: Tx): Promise<AssetDeletionOutcome> => {
    // 0. Ligne du bien verrouillée : suppressions / rattachements concurrents sérialisés.
    const [verrou] = await rows<{ id: number; account_id: number | null; thumbnail_url: string | null }>(tx,
      sql`SELECT id, account_id, thumbnail_url FROM assets WHERE id = ${assetId} FOR UPDATE`);
    if (!verrou) return { blobsScheduled: 0, fileIds: [], rehomedToAssetIds: [], alreadyDeleted: true };
    const plan = (await planAssetDeletion(tx, assetId)) as DeletionPlan;
    if (opts.expectedFingerprint && deletionPlanFingerprint(plan) !== opts.expectedFingerprint) {
      throw new AssetDeletionInventoryChangedError(inventoryOfPlan(plan));
    }
    const accountId = plan.accountId;
    const fileIds = plan.exclusiveFileIds;

    // 1. Objets de stockage des seuls éléments SUPPRIMÉS, relevés AVANT les suppressions.
    const files = fileIds.length
      ? await rows<{ s3_key: string | null }>(tx, sql.raw(`SELECT s3_key FROM asset_files WHERE id = ANY('${pgInts(fileIds)}'::int[])`))
      : [];
    const versions = plan.versionIds.length
      ? await rows<{ s3_key: string | null }>(tx, sql.raw(`SELECT s3_key FROM document_versions WHERE id = ANY('${pgInts(plan.versionIds)}'::int[])`))
      : [];
    const exportsRows = await rows<{ output_payload: string | null }>(tx, sql`SELECT output_payload FROM export_generation WHERE asset_id = ${assetId}`);
    const candidates = [
      ...files.map((f) => f.s3_key),
      ...versions.map((v) => v.s3_key),
      ...exportsRows.flatMap((e) => exportStorageKeys(e.output_payload)),
      thumbnailStorageKey(asset.thumbnailUrl ?? verrou.thumbnail_url, bucket),
    ].filter((k): k is string => !!k && k !== 'temp');

    let keys: string[] = [];
    if (candidates.length > 0) {
      const unique = [...new Set(candidates)];
      // Clés passées en paramètre JSON (jamais concaténées dans le SQL).
      const keysJson = JSON.stringify(unique);
      const exclus = pgInts(fileIds);
      // Garde-fou : un objet encore référencé par un fichier ou une version qui SURVIT n'est jamais purgé.
      const stillReferenced = await rows<{ k: string }>(tx, sql`
        SELECT s3_key AS k FROM asset_files
         WHERE s3_key IN (SELECT jsonb_array_elements_text(${keysJson}::jsonb)) AND NOT (id = ANY(${exclus}::int[]))
        UNION SELECT s3_key FROM document_versions
         WHERE s3_key IN (SELECT jsonb_array_elements_text(${keysJson}::jsonb)) AND NOT (file_id = ANY(${exclus}::int[]))`);
      const alreadyPending = await rows<{ k: string }>(tx, sql`
        SELECT storage_path AS k FROM pending_blob_deletions
         WHERE storage_path IN (SELECT jsonb_array_elements_text(${keysJson}::jsonb)) AND processed_at IS NULL`);
      keys = selectBlobKeysToPurge({
        candidates: unique,
        stillReferenced: stillReferenced.map((r) => r.k).filter((k): k is string => !!k),
        alreadyPending: alreadyPending.map((r) => r.k),
      });
    }
    if (keys.length > 0) {
      // `file_id` nul : la ligne `asset_files` disparaît dans la même transaction.
      // Purge immédiate (comme la suppression de compte) : action confirmée, annoncée irréversible.
      const now = new Date().toISOString();
      for (const storagePath of keys) {
        await tx.execute(sql`INSERT INTO pending_blob_deletions (file_id, storage_path, scheduled_for, created_at)
                             VALUES (NULL, ${storagePath}, ${now}::timestamptz, ${now}::timestamptz)`);
      }
    }

    // 2. Seule clé étrangère sans cascade vers `assets`.
    await tx.execute(sql`UPDATE asset_transmissions SET duplicated_asset_id = NULL WHERE duplicated_asset_id = ${assetId}`);

    // 3. CONSERVÉS : documents, échéances, événements liés aussi à un autre bien — relations au bien retirées.
    const subs = `(SELECT id FROM substructures WHERE asset_id = ${assetId})`;
    const eqs = `(SELECT id FROM equipments WHERE asset_id = ${assetId})`;
    const rms = `(SELECT id FROM rooms WHERE asset_id = ${assetId})`;
    if (plan.sharedFiles.length) {
      await tx.execute(sql.raw(`
        UPDATE asset_files f SET
          asset_id = CASE WHEN f.asset_id = ${assetId} THEN v.new_asset ELSE f.asset_id END,
          linked_asset_id = CASE WHEN f.linked_asset_id = ${assetId} OR (f.asset_id = ${assetId} AND f.linked_asset_id = v.new_asset)
                                 THEN NULL ELSE f.linked_asset_id END,
          linked_room_id = CASE WHEN f.linked_room_id IN ${rms} THEN NULL ELSE f.linked_room_id END,
          substructure_id = CASE WHEN f.substructure_id IN ${subs} THEN NULL ELSE f.substructure_id END,
          equipment_id = CASE WHEN f.equipment_id IN ${eqs} THEN NULL ELSE f.equipment_id END,
          updated_at = now()
          FROM unnest('${pgInts(plan.sharedFiles.map((x) => x.id))}'::int[], '{${plan.sharedFiles.map((x) => x.newAssetId ?? 'NULL').join(',')}}'::int[]) AS v(id, new_asset)
         WHERE f.id = v.id`));
    }
    for (const [table, ids] of [['deadlines', plan.sharedDeadlineIds], ['events', plan.sharedEventIds]] as const) {
      if (!ids.length) continue;
      await tx.execute(sql.raw(`
        UPDATE ${table} t SET
          asset_id = CASE WHEN t.asset_id = ${assetId} THEN t.linked_asset_id ELSE t.asset_id END,
          linked_asset_id = CASE WHEN t.asset_id = ${assetId} OR t.linked_asset_id = ${assetId} THEN NULL ELSE t.linked_asset_id END,
          linked_room_id = CASE WHEN t.linked_room_id IN ${rms} THEN NULL ELSE t.linked_room_id END,
          substructure_id = CASE WHEN t.substructure_id IN ${subs} THEN NULL ELSE t.substructure_id END,
          equipment_id = CASE WHEN t.equipment_id IN ${eqs} THEN NULL ELSE t.equipment_id END
         WHERE t.id = ANY('${pgInts(ids)}'::int[])`));
    }

    // 4. Opérations métier (lot 39, CDC Opérations V1 B27, C25) : liens vers le bien retirés et sources
    //    emportées désactivées, HISTORISÉS ; Opérations sans plus aucune source invalidées.
    if (accountId) {
      // #849 (B2) : ventilations AU BIEN d'une Opération conservée retirées (remplacées, historisées) AVANT le
      // détachement — sinon, sans cible, elles seraient reportées sur les autres biens (TCO doublé).
      const retirees = await supersedeDeletedAssetComponentsInTx(tx, { accountId, componentIds: plan.sharedOperationExpenseIds });
      const retrait = await retireDeletedAssetFromOperationsInTx(tx, { accountId, assetId, fileIds });
      const supprimees = new Set(plan.exclusiveOperationIds);
      operationEvents = [...retirees, ...retrait.events].filter((e) => !supprimees.has(Number(e.operationId)));
    }

    // 5. SUPPRIMÉS hors cascade : éléments d'Agenda exclusifs, puis Opérations exclusives (dépenses,
    //    ventilations, preuves et historique par cascade), puis documents / échéances / événements.
    if (accountId && plan.exclusiveAgendaItemIds.length) {
      await tx.execute(sql.raw(`DELETE FROM agenda_items WHERE account_id = ${accountId} AND id = ANY('${pgInts(plan.exclusiveAgendaItemIds)}'::int[])`));
    }
    if (accountId) await deleteExclusiveOperationsInTx(tx, { accountId, operationIds: plan.exclusiveOperationIds });
    if (fileIds.length) await tx.execute(sql.raw(`DELETE FROM asset_files WHERE id = ANY('${pgInts(fileIds)}'::int[])`));
    if (plan.exclusiveDeadlineIds.length) await tx.execute(sql.raw(`DELETE FROM deadlines WHERE id = ANY('${pgInts(plan.exclusiveDeadlineIds)}'::int[])`));
    if (plan.exclusiveEventIds.length) await tx.execute(sql.raw(`DELETE FROM events WHERE id = ANY('${pgInts(plan.exclusiveEventIds)}'::int[])`));

    // 6. Données du bien sans clé étrangère (preuves de champ, revues, traces) ; cartes « À traiter » du bien closes.
    if (accountId) {
      for (const table of DONNEES_DU_BIEN_SANS_CLE) {
        const [ok] = await rows<{ ok: boolean }>(tx, sql.raw(`SELECT to_regclass('${table}') IS NOT NULL AS ok`));
        if (ok?.ok) await tx.execute(sql.raw(`DELETE FROM ${table} WHERE account_id = ${accountId} AND asset_id = ${assetId}`));
      }
      await tx.execute(sql`
        UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
         WHERE account_id = ${accountId} AND target_type = 'ASSET' AND target_id = ${assetId} AND resolved_at IS NULL`);
    }

    // 7. Le bien ; la cascade emporte le reste (pièces, équipements, photos, exports, liens…).
    await tx.delete(assets).where(eq(assets.id, assetId));

    return {
      blobsScheduled: keys.length,
      fileIds,
      rehomedToAssetIds: [...new Set(plan.sharedFiles.map((f) => f.newAssetId).filter((x): x is number => x !== null))],
      inventory: inventoryOfPlan(plan),
    };
  });
  await publishBusinessOperationEvents(operationEvents);
  return outcome;
}
