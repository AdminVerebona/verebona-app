/**
 * Plafond de stockage par compte — CDC Back-Office V1 §13.1 (STO-001 à STO-004).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN GARDE-FOU TECHNIQUE, DISTINCT DU QUOTA DE DOCUMENTS
 *
 *   Standard 2 Go · Premium 10 Go · Premium Duo 15 Go   (1 Go = 1024³ octets)
 *
 * Les valeurs vivent dans `plan_limits.max_storage_bytes` (configurables par
 * offre, migration 0170) ; les constantes ci-dessous ne servent que de repli
 * si la ligne ou la colonne manque — elles doivent rester alignées.
 *
 * STO-003 : à 100 %, SEULS les nouveaux dépôts sont refusés
 * (`/api/files/presign` et `/api/files/confirm`). Consultation, suppression,
 * export et transmission ne lisent jamais ce module.
 * STO-004 : ni 80 % ni 100 % ne sont des anomalies de supervision.
 *
 * Volume consommé : somme des tailles des fichiers du compte, non supprimés,
 * dont le dépôt est confirmé (`COMPLETED`, ou NULL pour les lignes
 * antérieures au suivi de statut). Les dépôts en attente (`PENDING`) ne sont
 * pas comptés : c'est la confirmation qui les compte, en y ajoutant le lot.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { formatBytes } from '@/lib/admin/format';
import { db } from '@/db';
import { assetFiles, pendingBlobDeletions, planLimits } from '@/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  getCommercialPlanForAccount,
  type CommercialPlanCode,
} from '@/services/commercial-model.service';

export const BYTES_PER_GB = 1024 ** 3;

/** Repli code des plafonds du §13.1 (source normale : `plan_limits`). */
export const DEFAULT_STORAGE_LIMIT_BYTES: Record<CommercialPlanCode, number> = {
  standard: 2 * BYTES_PER_GB,
  premium: 10 * BYTES_PER_GB,
  premium_duo: 15 * BYTES_PER_GB,
  // Offre non commercialisée, hors CDC BO : aligné sur `subscription-limits.ts`.
  premium_pro: 500 * BYTES_PER_GB,
};

export interface StorageQuotaDecision {
  allowed: boolean;
  usedBytes: number;
  incomingBytes: number;
  limitBytes: number;
  /** Octets encore disponibles avant ce dépôt (jamais négatif). */
  remainingBytes: number;
}

/**
 * Décision pure : le dépôt de `incomingBytes` tient-il sous le plafond ?
 * Atteindre exactement le plafond est permis ; le dépasser, non.
 */
export function checkStorageQuota(input: {
  usedBytes: number;
  incomingBytes: number;
  limitBytes: number;
}): StorageQuotaDecision {
  const usedBytes = Math.max(0, input.usedBytes);
  const incomingBytes = Math.max(0, input.incomingBytes);
  const limitBytes = Math.max(0, input.limitBytes);
  return {
    allowed: usedBytes + incomingBytes <= limitBytes,
    usedBytes,
    incomingBytes,
    limitBytes,
    remainingBytes: Math.max(0, limitBytes - usedBytes),
  };
}

/** Taille lisible en français (« 1,5 Go ») — voir `lib/admin/format.ts`. */
export const formatStorageSize = formatBytes;

/** Plafond de stockage d'une offre, en octets. */
export async function getStorageLimitBytes(planCode: CommercialPlanCode): Promise<number> {
  const [row] = await db
    .select({ maxStorageBytes: planLimits.maxStorageBytes })
    .from(planLimits)
    .where(eq(planLimits.planCode, planCode))
    .limit(1)
    .catch(() => [] as Array<{ maxStorageBytes: number | null }>);
  const fromDb = row?.maxStorageBytes;
  return typeof fromDb === 'number' && fromDb > 0 ? fromDb : DEFAULT_STORAGE_LIMIT_BYTES[planCode];
}

/**
 * Exécuteur de requêtes : la connexion globale ou une transaction. Le calcul
 * du volume doit se faire DANS la transaction qui tient le verrou (voir
 * `withAccountStorageLock`), pas sur une autre connexion du pool.
 */
export type StorageExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;

/** Volume consommé par un compte, en octets (voir l'en-tête). */
export async function getAccountStorageUsedBytes(
  accountId: number,
  executor: StorageExecutor = db,
): Promise<number> {
  const [row] = await executor
    .select({ used: sql<string>`coalesce(sum(${assetFiles.size}), 0)` })
    .from(assetFiles)
    .where(
      and(
        eq(assetFiles.accountId, accountId),
        isNull(assetFiles.deletedAt),
        or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
      ),
    );
  return Number(row?.used ?? 0);
}

/** Consommation et plafond d'un compte (fiche Compte du BO, STO-002). */
export async function getAccountStorageUsage(
  accountId: number,
  executor: StorageExecutor = db,
): Promise<{ usedBytes: number; limitBytes: number; planCode: CommercialPlanCode }> {
  const planCode = await getCommercialPlanForAccount(accountId);
  const [usedBytes, limitBytes] = await Promise.all([
    getAccountStorageUsedBytes(accountId, executor),
    getStorageLimitBytes(planCode),
  ]);
  return { usedBytes, limitBytes, planCode };
}

/** Contrôle complet d'un dépôt pour un compte. */
export async function checkAccountStorageQuota(
  accountId: number,
  incomingBytes: number,
  executor: StorageExecutor = db,
): Promise<StorageQuotaDecision> {
  const { usedBytes, limitBytes } = await getAccountStorageUsage(accountId, executor);
  return checkStorageQuota({ usedBytes, incomingBytes, limitBytes });
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * VERROU PAR COMPTE — CONTRÔLE ET ÉCRITURE INDISSOCIABLES
 *
 * Le contrôle (« somme des fichiers confirmés + ce lot ≤ plafond ») et
 * l'écriture (passage en COMPLETED) étaient deux requêtes indépendantes :
 * deux confirmations simultanées lisaient chacune la même somme, passaient
 * chacune le contrôle, et ensemble dépassaient le plafond.
 *
 * Un verrou consultatif transactionnel (`pg_advisory_xact_lock`) par compte
 * sérialise désormais les sections « contrôle + écriture » d'un même compte.
 * Il est libéré automatiquement au COMMIT/ROLLBACK — aucun risque de verrou
 * oublié — et ne bloque que les dépôts du même compte.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function storageLockKey(accountId: number): string {
  return `storage_quota:${accountId}`;
}

export async function withAccountStorageLock<T>(
  accountId: number,
  fn: (tx: StorageExecutor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${storageLockKey(accountId)}))`);
    return fn(tx);
  });
}

/**
 * Écarte des dépôts refusés (413 à la confirmation) : l'objet a déjà été
 * téléversé, mais il ne sera jamais confirmé — le laisser, c'est un objet
 * S3 et une ligne PENDING orphelins jusqu'à la purge des 24 h, et un
 * stockage consommé sans être compté.
 *
 * Même mécanisme que `purgePendingUploads` : suppression logique de la ligne
 * et programmation IMMÉDIATE de l'objet dans `pending_blob_deletions`
 * (traitée par `/api/cron/purge-blobs`). Seules les lignes encore PENDING
 * de l'utilisateur sont concernées.
 */
export async function discardRejectedUploads(
  executor: StorageExecutor,
  files: Array<{ id: number; s3Key: string | null }>,
  userId: number,
): Promise<number> {
  if (files.length === 0) return 0;
  const now = new Date();
  const discarded = await executor
    .update(assetFiles)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(
      inArray(assetFiles.id, files.map((f) => f.id)),
      eq(assetFiles.userId, userId),
      eq(assetFiles.uploadStatus, 'PENDING'),
      isNull(assetFiles.deletedAt),
    ))
    .returning({ id: assetFiles.id, s3Key: assetFiles.s3Key });
  // `temp` : clé provisoire du presign, ne désigne aucun objet réel.
  const blobs = discarded.filter((f) => f.s3Key && f.s3Key !== 'temp');
  if (blobs.length > 0) {
    await executor.insert(pendingBlobDeletions).values(
      blobs.map((f) => ({ fileId: f.id, storagePath: f.s3Key as string, scheduledFor: now, createdAt: now })),
    );
  }
  return discarded.length;
}

/** Réponse 413 `STORAGE_QUOTA_EXCEEDED` (STO-003). */
export function storageQuotaExceededResponse(decision: StorageQuotaDecision): NextResponse {
  return NextResponse.json(
    {
      error: 'STORAGE_QUOTA_EXCEEDED',
      code: 'STORAGE_QUOTA_EXCEEDED',
      message:
        `Espace de stockage insuffisant : ${formatStorageSize(decision.usedBytes)} utilisés sur ` +
        `${formatStorageSize(decision.limitBytes)} inclus dans votre offre. ` +
        'Supprimez des documents ou changez d’offre pour déposer de nouveaux fichiers. ' +
        'Vos documents existants restent consultables.',
      usedBytes: decision.usedBytes,
      limitBytes: decision.limitBytes,
      incomingBytes: decision.incomingBytes,
    },
    { status: 413 },
  );
}
