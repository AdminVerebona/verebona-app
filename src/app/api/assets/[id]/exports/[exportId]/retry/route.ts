/**
 * POST /api/assets/[id]/exports/[exportId]/retry
 *
 * Relance TECHNIQUE d'une génération en échec (ou bloquée : bail expiré sans
 * reprise) : la génération est remise en file avec la MÊME demande figée
 * (`snapshot_json.request`) — ce n'est pas une régénération depuis
 * l'historique au sens de DRH-007 (qui imposerait une nouvelle préparation),
 * mais la reprise d'un travail qui n'a jamais abouti.
 *
 * Accès par compte (Duo compris) ; offre et CIL-RULE-002 contrôlés ici (réponse
 * immédiate), éligibilité et données refaites par le worker (validate_request).
 *
 * Garde-fous : limitation de débit par utilisateur, au plus
 * `MAX_USER_RETRIES` relances par génération, plafond de générations actives
 * par compte, et le compteur de tentatives n'est JAMAIS remis à zéro — un
 * dossier qui fait tomber le worker ne peut pas être relancé indéfiniment
 * (au-delà de `MAX_ATTEMPTS`, une exécution interrompue est close en échec).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { exportGenerations } from '@/db/schema';
import { eq, and, inArray, lt, sql } from 'drizzle-orm';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { exportRouteError, EXPORT_ERROR_MESSAGES } from '@/services/exports/export-errors';
import { normalizeExportCode, EXPORT_BRUT_CODE } from '@/services/exports/catalog';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import {
  evaluateCilReadiness, CIL_ACTION_REQUIRED_CODE, CIL_ACTION_REQUIRED_MESSAGE,
} from '@/services/exports/cil-preparation.service';
import { toGenerationDto } from '@/services/exports/v12/generation/status';
import { nudgeExportWorker } from '@/services/exports/v12/generation/worker';
import { exportRateLimitResponse } from '@/services/exports/v12/generation/rate-limit';
import { MAX_ACTIVE_PER_ACCOUNT, countActiveGenerations } from '@/services/exports/v12/generation/repository';
import { TOO_MANY_GENERATIONS_MESSAGE } from '@/services/exports/v12/generation/enqueue';

/** Relances manuelles autorisées par génération. */
const MAX_USER_RETRIES = 3;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; exportId: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id, exportId } = await params;
    const assetId = parseInt(id);
    const exportIdNum = parseInt(exportId);
    if (isNaN(assetId) || isNaN(exportIdNum)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const limited = exportRateLimitResponse(session.userId);
    if (limited) return limited;

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND', code: 'ASSET_NOT_FOUND', message: EXPORT_ERROR_MESSAGES.ASSET_NOT_FOUND }, { status: 404 });

    const [row] = await db.select().from(exportGenerations)
      .where(and(eq(exportGenerations.id, exportIdNum), eq(exportGenerations.assetId, assetId))).limit(1);
    if (!row) return NextResponse.json({ error: 'EXPORT_NOT_FOUND' }, { status: 404 });

    const code = normalizeExportCode(row.exportType);
    const stuck = row.status === 'generating' && (
      row.lockedUntil ? new Date(row.lockedUntil).getTime() < Date.now()
        : row.generationStartedAt != null && new Date(row.generationStartedAt).getTime() < Date.now() - 5 * 60 * 1000
    );
    const canRetry = code !== null && code !== EXPORT_BRUT_CODE
      && (row.status === 'failed' || row.status === 'error' || row.status === 'pending' || stuck);
    if (!canRetry) {
      return NextResponse.json({
        error: 'RETRY_NOT_ALLOWED', status: row.status, code: 'RETRY_NOT_ALLOWED',
        message: 'Cet export ne peut pas être relancé dans son état actuel.',
      }, { status: 400 });
    }

    if ((row.userRetryCount ?? 0) >= MAX_USER_RETRIES) {
      return NextResponse.json({
        error: 'RETRY_LIMIT_REACHED', code: 'RETRY_LIMIT_REACHED',
        message: 'Cet export a déjà été relancé plusieurs fois sans succès. Lancez une nouvelle génération ou contactez le support.',
      }, { status: 429 });
    }

    const decision = await canUsePremiumFeature(asset.accountId);
    if (!decision.allowed) return NextResponse.json({ error: decision.reason, code: decision.reason, message: decision.message }, { status: 403 });

    // CIL-RULE-002 : même blocage qu'à la création.
    if (code === 'CIL') {
      const readiness = await evaluateCilReadiness(asset);
      if (readiness.globalStatus === 'action_required') {
        return NextResponse.json({
          error: CIL_ACTION_REQUIRED_CODE, code: CIL_ACTION_REQUIRED_CODE, message: CIL_ACTION_REQUIRED_MESSAGE,
          blockingBlocks: readiness.blockingBlocks.map((b) => ({ id: b.id, label: b.label })),
        }, { status: 422 });
      }
    }

    // Plafond de générations actives du compte (une génération bloquée compte déjà).
    if (!stuck && (await countActiveGenerations(asset.accountId)) >= MAX_ACTIVE_PER_ACCOUNT) {
      return NextResponse.json({ error: 'TOO_MANY_GENERATIONS', code: 'TOO_MANY_GENERATIONS', message: TOO_MANY_GENERATIONS_MESSAGE, limit: MAX_ACTIVE_PER_ACCOUNT }, { status: 429 });
    }

    // Remise en file atomique (seulement depuis l'état constaté). Le compteur
    // de tentatives est conservé ; celui des relances manuelles incrémenté.
    const [updated] = await db.update(exportGenerations).set({
      status: 'queued',
      exportType: code,
      errorCode: null,
      errorPayload: null,
      lockedBy: null,
      lockedUntil: null,
      nextAttemptAt: null,
      userRetryCount: sql`${exportGenerations.userRetryCount} + 1`,
      // Réaligne l'entrée sur le compte du bien (anciennes lignes).
      accountId: asset.accountId,
    }).where(and(
      eq(exportGenerations.id, exportIdNum),
      inArray(exportGenerations.status, [row.status]),
      lt(exportGenerations.userRetryCount, MAX_USER_RETRIES),
    ))
      .returning();
    if (!updated) return NextResponse.json({ error: 'LOCK_FAILED' }, { status: 409 });

    nudgeExportWorker();
    const dto = toGenerationDto(updated);
    return NextResponse.json({ exportId: dto.id, publicId: dto.publicId, status: dto.status, generationStatus: dto.generationStatus, pollUrl: dto.pollUrl }, { status: 202 });
  } catch (error) {
    return exportRouteError(error, '[ExportRetry]');
  }
}
