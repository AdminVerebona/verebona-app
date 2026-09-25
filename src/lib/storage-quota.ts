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
import { assetFiles, planLimits } from '@/db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
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

/** Volume consommé par un compte, en octets (voir l'en-tête). */
export async function getAccountStorageUsedBytes(accountId: number): Promise<number> {
  const [row] = await db
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
): Promise<{ usedBytes: number; limitBytes: number; planCode: CommercialPlanCode }> {
  const planCode = await getCommercialPlanForAccount(accountId);
  const [usedBytes, limitBytes] = await Promise.all([
    getAccountStorageUsedBytes(accountId),
    getStorageLimitBytes(planCode),
  ]);
  return { usedBytes, limitBytes, planCode };
}

/** Contrôle complet d'un dépôt pour un compte. */
export async function checkAccountStorageQuota(
  accountId: number,
  incomingBytes: number,
): Promise<StorageQuotaDecision> {
  const { usedBytes, limitBytes } = await getAccountStorageUsage(accountId);
  return checkStorageQuota({ usedBytes, incomingBytes, limitBytes });
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
