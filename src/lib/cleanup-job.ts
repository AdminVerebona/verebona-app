/**
 * Purge des fichiers supprimés depuis plus de 30 jours — objets S3 (OVH) et
 * lignes `asset_files`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 65A — BRANCHÉE ET SÛRE
 *
 * Ce traitement n'était lancé par rien (route admin retirée, « cron externe »
 * jamais configuré) : les fichiers supprimés par les utilisateurs restaient
 * indéfiniment dans le stockage. Il est désormais la tâche planifiée interne
 * `deleted-files-purge` (quotidienne, `scheduled-tasks.catalog.ts`) : bail
 * anti-chevauchement, compte rendu et suspension depuis le BO › Exploitation ›
 * Tâches planifiées, arrêt d'urgence SCHEDULED_TASK_DELETED_FILES_PURGE=off.
 *
 * NOTION DE « SUPPRIMÉ » (schéma au lot 65) :
 *   · `asset_files.deleted_at` posé par la suppression d'un document (unitaire,
 *     en lot, fusion), l'abandon d'un dépôt jamais confirmé, un dépôt refusé
 *     (quota) ; AUCUN parcours ne remet `deleted_at` à NULL (pas de
 *     corbeille) : les 30 jours sont un délai de sûreté, pas une restauration.
 *     La ligne est relue SOUS VERROU juste avant la purge : une ligne qui ne
 *     serait plus supprimée (ou plus éligible) n'est jamais touchée ;
 *   · source secondaire regroupée (`grouped_into_file_id`, 0143) : masquée
 *     (`deleted_at` posé) mais CONSULTABLE depuis son document principal —
 *     jamais purgée tant que ce document existe ou a été supprimé il y a moins
 *     de 30 jours (`purgeEligibleCondition`) ;
 *   · suppression d'un BIEN, d'un COMPTE (purge J+30, rétractation…) : les
 *     lignes partent en cascade et leurs objets sont déjà confiés à la file
 *     `pending_blob_deletions` (traitée chaque jour par `blob-purge`) — hors
 *     de ce traitement ;
 *   · transfert Duo / déplacement de bien : la ligne change de compte, pas de
 *     clé de stockage — sans effet ici.
 *
 * PAR FICHIER, DANS UNE TRANSACTION :
 *   1. relecture verrouillée (FOR UPDATE SKIP LOCKED) : toujours supprimé
 *      depuis plus de 30 jours et éligible, sinon rien ;
 *   2. lien « fournisseur ← document source » détaché (seule clé étrangère
 *      sans action vers `asset_files`), puis suppression de la ligne — les
 *      liaisons partent en cascade, et le déclencheur 0241 confie les
 *      MINIATURES du document (`asset_file_thumbnails`) à la file de purge ;
 *   3. objets : la clé du fichier et celles de ses versions
 *      (`document_versions`). Une clé ENCORE RÉFÉRENCÉE ailleurs (autre ligne
 *      `asset_files` — copie de transmission en repli —, version d'un autre
 *      document, vignette de bien promue depuis ce fichier) est CONSERVÉE :
 *      seule la ligne part ; l'objet sera supprimé avec sa dernière référence ;
 *   4. suppression S3 — confirmée par S3, ou objet déjà absent (404 / NoSuchKey
 *      = acquis) ; toute autre erreur ANNULE la transaction : la ligne reste
 *      (toujours éligible), l'échec est tracé (`purge_attempts`,
 *      `purge_last_error`) et repris au passage suivant. Jamais « fichier dans
 *      S3 sans plus aucune référence » ; une validation perdue après la
 *      suppression S3 laisse une ligne dont l'objet est absent : le passage
 *      suivant la purge (404 = acquis).
 *
 * BORNÉ : lots de `batchSize` (100) fichiers, au plus `maxBatches` (20) par
 * passage et jusqu'à l'échéance de la tâche ; le reste au passage suivant.
 * IDEMPOTENT : rejoué, un fichier déjà purgé n'est plus éligible ; un fichier
 * en échec n'est retenté qu'au passage suivant (pas de boucle).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getS3Bucket, getS3Client, isS3Configured } from '@/lib/s3-config';
import { db } from '@/db';
import { assetFiles, documentVersions, equipmentSuppliers } from '@/db/schema';
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { purgeEligibleCondition } from '@/services/documents/grouped-sources';

export const SOFT_DELETE_RETENTION_DAYS = 30;
export const PURGE_BATCH_SIZE = 100;
export const PURGE_MAX_BATCHES = 20;

export interface CleanupResult {
  success: boolean;
  /** Fichiers examinés (relus sous verrou). */
  filesProcessed: number;
  /** Objets supprimés du stockage (ou déjà absents). */
  filesDeletedFromS3: number;
  /** Lignes `asset_files` supprimées. */
  filesDeletedFromDB: number;
  /** Suppression S3 en échec : ligne conservée, nouvelle tentative au prochain passage. */
  filesRetained: number;
  /** Objets conservés car encore référencés par une autre ligne (seule la ligne part). */
  objectsKeptShared: number;
  /** Lignes devenues inéligibles entre la sélection et le verrou (ou verrouillées ailleurs). */
  filesSkipped: number;
  /** Il reste des fichiers éligibles (lot ou échéance atteints). */
  more: boolean;
  /** Stockage non configuré : rien n'a été supprimé. */
  storageUnavailable?: boolean;
  errors: string[];
  startedAt: string;
  completedAt: string;
  duration: number;
}

/** Suppression d'un objet S3 — injectable pour les tests (S3 simulé). */
export type DeleteObjectFn = (bucket: string, key: string) => Promise<void>;

const defaultDeleteObject: DeleteObjectFn = async (bucket, key) => {
  await getS3Client('worker').send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

/** Objet déjà absent du stockage : la suppression est acquise. */
export function isAlreadyGone(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Message court, sans clé de stockage ni identifiant (journal, BO). */
function shortMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/)[0].slice(0, 300);
}

type Exec = Pick<typeof db, 'execute'>;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] })?.rows ?? []));

/**
 * La clé désigne-t-elle encore un objet utilisé ? Autre ligne `asset_files`
 * (quel que soit son état : elle purgera l'objet à son tour), version d'un
 * document, vignette de bien (clé brute ou URL se terminant par la clé).
 */
export async function isStorageKeyReferenced(exec: Exec, key: string): Promise<boolean> {
  const [r] = rowsOf<{ ref: boolean }>(await exec.execute(sql`
    SELECT (
         EXISTS (SELECT 1 FROM asset_files WHERE s3_key = ${key})
      OR EXISTS (SELECT 1 FROM document_versions WHERE s3_key = ${key})
      OR EXISTS (SELECT 1 FROM assets WHERE thumbnail_url = ${key}
                                         OR right(thumbnail_url, length(${key}) + 1) = '/' || ${key})
    ) AS ref`));
  return r?.ref === true;
}

class RetainedError extends Error {}

type FileOutcome = { kind: 'skipped' } | { kind: 'purged'; objectsDeleted: number; objectsKept: number };

async function purgeOne(
  id: number,
  cutoff: Date,
  deleteObject: DeleteObjectFn,
  defaultBucket: string | null,
): Promise<FileOutcome> {
  return db.transaction(async (tx) => {
    // 1. Relecture verrouillée : toujours supprimé depuis > 30 j et éligible.
    const [row] = await tx
      .select({ id: assetFiles.id, s3Key: assetFiles.s3Key, s3Bucket: assetFiles.s3Bucket })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.id, id),
        isNotNull(assetFiles.deletedAt),
        lt(assetFiles.deletedAt, cutoff),
        purgeEligibleCondition(cutoff),
      ))
      .for('update', { skipLocked: true });
    if (!row) return { kind: 'skipped' as const };

    const versions = await tx
      .select({ s3Key: documentVersions.s3Key, s3Bucket: documentVersions.s3Bucket })
      .from(documentVersions)
      .where(eq(documentVersions.fileId, id));

    // 2. Ligne d'abord (une clé étrangère inattendue échoue AVANT toute
    //    suppression S3) ; cascade + déclencheur des miniatures.
    await tx.update(equipmentSuppliers).set({ sourceDocumentId: null }).where(eq(equipmentSuppliers.sourceDocumentId, id));
    await tx.delete(assetFiles).where(eq(assetFiles.id, id));

    // 3. Objets : clé du fichier et de ses versions, sauf clé encore référencée.
    const objects = new Map<string, string | null>();
    if (row.s3Key && row.s3Key !== 'temp') objects.set(row.s3Key, row.s3Bucket || null);
    for (const v of versions) if (v.s3Key && v.s3Key !== 'temp' && !objects.has(v.s3Key)) objects.set(v.s3Key, v.s3Bucket || null);

    let objectsDeleted = 0;
    let objectsKept = 0;
    for (const [key, bucket] of objects) {
      if (await isStorageKeyReferenced(tx, key)) { objectsKept++; continue; }
      const target = bucket || defaultBucket;
      if (!target) throw new RetainedError('bucket inconnu (stockage non configuré)');
      try {
        await deleteObject(target, key);
      } catch (e) {
        if (!isAlreadyGone(e)) throw new RetainedError(shortMessage(e));
      }
      objectsDeleted++;
    }
    return { kind: 'purged' as const, objectsDeleted, objectsKept };
  });
}

/**
 * Exécute un passage de purge. Ne lève pas (erreur fatale → `success:
 * false`). `now` : horloge métier (tests) ; `deadline` : échéance de la tâche.
 */
export async function runCleanupJob(deps: {
  deleteObject?: DeleteObjectFn;
  now?: Date;
  deadline?: number;
  batchSize?: number;
  maxBatches?: number;
  /** Bucket des lignes sans `s3_bucket` (défaut : bucket configuré). */
  defaultBucket?: string | null;
} = {}): Promise<CleanupResult> {
  const startedAt = new Date();
  const startTime = Date.now();
  const now = deps.now ?? startedAt;
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? PURGE_MAX_BATCHES;
  const deadline = deps.deadline ?? Number.POSITIVE_INFINITY;

  const result: CleanupResult = {
    success: true, filesProcessed: 0, filesDeletedFromS3: 0, filesDeletedFromDB: 0, filesRetained: 0,
    objectsKeptShared: 0, filesSkipped: 0, more: false, errors: [],
    startedAt: startedAt.toISOString(), completedAt: '', duration: 0,
  };
  const finish = () => {
    result.completedAt = new Date().toISOString();
    result.duration = Date.now() - startTime;
    return result;
  };

  // Stockage non configuré : on ne supprime RIEN (pas même les lignes — leurs
  // objets existent peut-être).
  const injected = Boolean(deps.deleteObject);
  if (!injected && !isS3Configured()) {
    result.success = false;
    result.storageUnavailable = true;
    result.errors.push('Stockage S3 non configuré : purge non effectuée.');
    return finish();
  }
  const deleteObject = deps.deleteObject ?? defaultDeleteObject;
  const defaultBucket = deps.defaultBucket !== undefined ? deps.defaultBucket : (isS3Configured() ? getS3Bucket() : null);

  const cutoff = new Date(now.getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const seen = new Set<number>();

  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      if (Date.now() >= deadline) { result.more = true; break; }
      // Fichiers en échec retentés au passage SUIVANT seulement ; les moins
      // tentés d'abord, puis les plus anciens (aucun objet impossible ne
      // bloque la file).
      const candidates = await db
        .select({ id: assetFiles.id })
        .from(assetFiles)
        .where(and(
          isNotNull(assetFiles.deletedAt),
          lt(assetFiles.deletedAt, cutoff),
          purgeEligibleCondition(cutoff),
          or(isNull(assetFiles.purgeLastAttemptAt), lt(assetFiles.purgeLastAttemptAt, startedAt)),
        ))
        .orderBy(asc(assetFiles.purgeAttempts), asc(assetFiles.deletedAt), asc(assetFiles.id))
        .limit(batchSize);
      const fresh = candidates.filter((c) => !seen.has(c.id));
      if (fresh.length === 0) break;

      for (const { id } of fresh) {
        if (Date.now() >= deadline) { result.more = true; break; }
        seen.add(id);
        try {
          const r = await purgeOne(id, cutoff, deleteObject, defaultBucket);
          if (r.kind === 'skipped') { result.filesSkipped++; continue; }
          result.filesProcessed++;
          result.filesDeletedFromDB++;
          result.filesDeletedFromS3 += r.objectsDeleted;
          result.objectsKeptShared += r.objectsKept;
        } catch (error) {
          // Transaction annulée : ligne et objet conservés ; échec tracé.
          result.filesProcessed++;
          result.filesRetained++;
          const message = shortMessage(error);
          if (result.errors.length < 20) result.errors.push(`Fichier ${id} : ${message}`);
          console.error(`[CLEANUP] fichier ${id} conservé (nouvelle tentative au prochain passage) : ${message}`);
          await db
            .update(assetFiles)
            .set({
              purgeAttempts: sql`${assetFiles.purgeAttempts} + 1`,
              purgeLastError: message.slice(0, 1000),
              purgeLastAttemptAt: new Date(),
            })
            .where(eq(assetFiles.id, id))
            .catch(() => undefined);
        }
      }
      if (result.more) break;
      if (candidates.length < batchSize) break;
      if (batch === maxBatches - 1) result.more = true;
    }
    if (result.filesRetained > 0) result.success = false;
  } catch (error) {
    console.error('[CLEANUP] erreur du passage de purge :', error);
    result.success = false;
    result.errors.push(`Erreur : ${shortMessage(error)}`);
  }

  return finish();
}

/**
 * Compteurs de la purge (diagnostic du BO, compte rendu de la tâche).
 */
export async function getCleanupStats(now: Date = new Date()): Promise<{
  totalSoftDeleted: number;
  eligibleForCleanup: number;
  estimatedSpaceReclaim: number;
  /** Fichiers dont la suppression S3 a déjà échoué au moins une fois. */
  overduePurges: number;
}> {
  const cutoffDate = new Date(now.getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const [total] = await db
    .select({ count: sql<number>`count(*)` })
    .from(assetFiles)
    .where(isNotNull(assetFiles.deletedAt));

  const [eligible] = await db
    .select({
      count: sql<number>`count(*)`,
      totalSize: sql<number>`COALESCE(SUM(${assetFiles.size}), 0)`,
    })
    .from(assetFiles)
    .where(and(
      isNotNull(assetFiles.deletedAt),
      lt(assetFiles.deletedAt, cutoffDate),
      purgeEligibleCondition(cutoffDate),
    ));

  const [overdue] = await db
    .select({ count: sql<number>`count(*)` })
    .from(assetFiles)
    .where(and(isNotNull(assetFiles.deletedAt), sql`${assetFiles.purgeAttempts} > 0`));

  return {
    totalSoftDeleted: Number(total?.count || 0),
    eligibleForCleanup: Number(eligible?.count || 0),
    estimatedSpaceReclaim: Number(eligible?.totalSize || 0),
    overduePurges: Number(overdue?.count || 0),
  };
}

/** Compte rendu court de la tâche planifiée (aucune donnée personnelle). */
export function cleanupNote(r: CleanupResult, remaining?: { eligibleForCleanup: number; overduePurges: number } | null): string {
  if (r.storageUnavailable) return 'Stockage S3 non configuré : aucune suppression.';
  const parts = [
    `${r.filesDeletedFromDB} fichier(s) purgé(s)`,
    `${r.filesDeletedFromS3} objet(s) supprimé(s) du stockage`,
  ];
  if (r.objectsKeptShared) parts.push(`${r.objectsKeptShared} objet(s) conservé(s) car encore utilisé(s) ailleurs`);
  if (r.filesRetained) parts.push(`${r.filesRetained} en échec S3 (conservé(s), nouvelle tentative au prochain passage)`);
  if (r.filesSkipped) parts.push(`${r.filesSkipped} ignoré(s) (modifié(s) entre-temps)`);
  if (remaining) parts.push(`reste éligible : ${remaining.eligibleForCleanup}${remaining.overduePurges ? `, en échec répété : ${remaining.overduePurges}` : ''}`);
  else if (r.more) parts.push('reste à traiter au prochain passage');
  return parts.join(' ; ');
}
