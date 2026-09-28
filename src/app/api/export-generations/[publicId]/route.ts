/**
 * GET /api/export-generations/[publicId] — Statut d'une génération (CDC V12 §17).
 *
 * Réponse : statut V12 (`generationStatus` : queued, generating, ready,
 * partial, failed, expired, deleted), format, message générique d'erreur
 * (DRH-008), message de génération partielle (MSG-PREP-007) et liens de
 * téléchargement vers l'endpoint `/download`, qui revérifie les droits.
 * Droits revérifiés à chaque appel (bien du compte courant, Duo compris).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { exportRouteError } from '@/services/exports/export-errors';
import { findAccessibleGeneration } from '@/services/exports/v12/generation/access';
import { toGenerationDto } from '@/services/exports/v12/generation/status';

export async function GET(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const session = await SessionService.getSession(request);
    const { publicId } = await params;
    const found = await findAccessibleGeneration(session, publicId);
    if (!found) return NextResponse.json({ error: 'EXPORT_NOT_FOUND', code: 'EXPORT_NOT_FOUND', message: 'Dossier introuvable.' }, { status: 404 });
    const [author] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, found.row.userId)).limit(1);
    const authorName = author ? [author.firstName, author.lastName].filter((x) => x?.trim()).join(' ') || null : null;
    return NextResponse.json(toGenerationDto(found.row, { authorName }));
  } catch (error) {
    return exportRouteError(error, '[ExportGeneration GET]');
  }
}
