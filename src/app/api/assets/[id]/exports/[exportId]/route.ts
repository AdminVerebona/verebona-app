/**
 * GET    /api/assets/[id]/exports/[exportId] — Statut d'une génération (suivi, §17)
 * DELETE /api/assets/[id]/exports/[exportId] — Supprime le fichier d'une génération
 *
 * Accès par compte (Duo compris, DRH-002) via `findAccessibleAssetForExport`.
 *
 * DRH-004 : « La suppression manuelle supprime le fichier mais conserve
 * l'entrée d'historique. » Les objets PDF/ZIP sont supprimés du stockage (les
 * échecs passent par la file `pending_blob_deletions`) ; l'entrée reste avec
 * le statut `deleted` (« Fichier supprimé »), sans clé ni lien.
 *
 * Même traitement que `/api/export-generations/[publicId]` et
 * `/api/export-generations/[publicId]/file` (contrats §17).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { exportGenerations, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { exportRouteError, EXPORT_ERROR_MESSAGES } from '@/services/exports/export-errors';
import { toGenerationDto } from '@/services/exports/v12/generation/status';
import { deleteGenerationFile } from '@/services/exports/v12/generation/files';

type Loaded =
  | { ok: false; response: NextResponse }
  | { ok: true; session: { userId: number }; row: typeof exportGenerations.$inferSelect };

async function loadRow(request: NextRequest, params: Promise<{ id: string; exportId: string }>): Promise<Loaded> {
  const session = await SessionService.getSession(request);
  const { id, exportId } = await params;
  const assetId = parseInt(id);
  const exportIdNum = parseInt(exportId);
  if (isNaN(assetId) || isNaN(exportIdNum)) return { ok: false, response: NextResponse.json({ error: 'INVALID_ID' }, { status: 400 }) };
  const asset = await findAccessibleAssetForExport(session, assetId);
  if (!asset) return { ok: false, response: NextResponse.json({ error: 'ASSET_NOT_FOUND', code: 'ASSET_NOT_FOUND', message: EXPORT_ERROR_MESSAGES.ASSET_NOT_FOUND }, { status: 404 }) };
  const [row] = await db.select().from(exportGenerations)
    .where(and(eq(exportGenerations.id, exportIdNum), eq(exportGenerations.assetId, assetId))).limit(1);
  if (!row) return { ok: false, response: NextResponse.json({ error: 'EXPORT_NOT_FOUND' }, { status: 404 }) };
  return { ok: true, session, row };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; exportId: string }> },
) {
  try {
    const r = await loadRow(request, params);
    if (!r.ok) return r.response;
    const [author] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, r.row.userId)).limit(1);
    const authorName = author ? [author.firstName, author.lastName].filter((x) => x?.trim()).join(' ') || null : null;
    return NextResponse.json(toGenerationDto(r.row, { authorName }));
  } catch (error) {
    return exportRouteError(error, '[Exports GET one]');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; exportId: string }> },
) {
  try {
    const r = await loadRow(request, params);
    if (!r.ok) return r.response;
    if (r.row.status === 'generating' || r.row.status === 'queued' || r.row.status === 'pending') {
      return NextResponse.json({
        error: 'EXPORT_IN_PROGRESS',
        code: 'EXPORT_IN_PROGRESS',
        message: 'Cet export est en cours de génération : il pourra être supprimé une fois terminé.',
      }, { status: 409 });
    }
    // Idempotent : fichier déjà supprimé, l'entrée reste telle quelle.
    if (r.row.status === 'deleted') return NextResponse.json({ success: true, fileDeleted: true });
    const { blobsDeleted, blobsScheduled } = await deleteGenerationFile(r.row.id, r.session.userId);
    return NextResponse.json({ success: true, fileDeleted: true, blobsDeleted, blobsScheduled });
  } catch (error) {
    return exportRouteError(error, '[Exports DELETE]');
  }
}
