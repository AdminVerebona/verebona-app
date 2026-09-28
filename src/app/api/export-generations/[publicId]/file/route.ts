/**
 * DELETE /api/export-generations/[publicId]/file — Supprime le fichier généré
 * (CDC V12 §17, DRH-004) : objets PDF/ZIP supprimés du stockage, entrée
 * d'historique conservée (statut `deleted`). Idempotent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { exportRouteError } from '@/services/exports/export-errors';
import { findAccessibleGeneration } from '@/services/exports/v12/generation/access';
import { deleteGenerationFile } from '@/services/exports/v12/generation/files';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const session = await SessionService.getSession(request);
    const { publicId } = await params;
    const found = await findAccessibleGeneration(session, publicId);
    if (!found) return NextResponse.json({ error: 'EXPORT_NOT_FOUND', code: 'EXPORT_NOT_FOUND', message: 'Dossier introuvable.' }, { status: 404 });
    const { row } = found;
    if (row.status === 'queued' || row.status === 'generating' || row.status === 'pending') {
      return NextResponse.json({
        error: 'EXPORT_IN_PROGRESS', code: 'EXPORT_IN_PROGRESS',
        message: 'Cet export est en cours de génération : il pourra être supprimé une fois terminé.',
      }, { status: 409 });
    }
    if (row.status === 'deleted') return NextResponse.json({ success: true, fileDeleted: true });
    const r = await deleteGenerationFile(row.id, session.userId);
    return NextResponse.json({ success: true, fileDeleted: true, ...r });
  } catch (error) {
    return exportRouteError(error, '[ExportGeneration DELETE file]');
  }
}
