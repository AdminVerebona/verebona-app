/**
 * Garde d'accès en lecture à un fichier — commune au proxy et aux miniatures
 * (APP-PERF-13, APP-PERF-06/27).
 *
 * Mêmes règles que `/api/files/[id]/view` :
 *   · session vérifiée par `SessionService` (en-tête ou cookie, jamais un
 *     jeton en paramètre d'URL) ;
 *   · fichier du COMPTE COURANT seulement ;
 *   · supprimé = introuvable, sauf source secondaire d'un document existant
 *     (`viewableFileCondition`, migration 0143) ;
 *   · upload terminé (`COMPLETED`, ou historique NULL).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { viewableFileCondition } from '@/services/documents/grouped-sources';

export interface ReadableFile {
  id: number;
  accountId: number;
  s3Bucket: string | null;
  s3Key: string | null;
  mimeType: string | null;
  size: number | null;
  originalFilename: string | null;
  isWebLink: boolean;
}

export type FileAccessResult =
  | { ok: true; file: ReadableFile; accountId: number; userId: number }
  | { ok: false; response: NextResponse };

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** Décision pure à partir de la ligne lue — testée unitairement. */
export function decideFileAccess(
  row: (ReadableFile & { uploadStatus: string | null }) | undefined,
  accountId: number,
): { ok: true } | { ok: false; status: number; code: string } {
  if (!row) return { ok: false, status: 404, code: 'FILE_NOT_FOUND' };
  // 404 et non 403 : ne pas confirmer l'existence d'un fichier d'un autre compte.
  if (row.accountId !== accountId) return { ok: false, status: 404, code: 'FILE_NOT_FOUND' };
  if (row.uploadStatus !== 'COMPLETED' && row.uploadStatus !== null) return { ok: false, status: 409, code: 'FILE_NOT_READY' };
  return { ok: true };
}

export async function loadReadableFile(request: NextRequest, rawId: string): Promise<FileAccessResult> {
  let session: Awaited<ReturnType<typeof SessionService.getSession>>;
  try {
    session = await SessionService.getSession(request);
  } catch (e) {
    return { ok: false, response: SessionService.handleSessionError(e) };
  }
  const accountId = session.currentAccountId;
  if (!accountId) {
    return { ok: false, response: NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 401, headers: NO_STORE }) };
  }
  const fileId = Number(rawId);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return { ok: false, response: NextResponse.json({ error: 'INVALID_ID' }, { status: 400, headers: NO_STORE }) };
  }

  const [row] = await db
    .select({
      id: assetFiles.id,
      accountId: assetFiles.accountId,
      s3Bucket: assetFiles.s3Bucket,
      s3Key: assetFiles.s3Key,
      mimeType: assetFiles.mimeType,
      size: assetFiles.size,
      originalFilename: assetFiles.originalFilename,
      isWebLink: assetFiles.isWebLink,
      uploadStatus: assetFiles.uploadStatus,
    })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId), viewableFileCondition))
    .limit(1);

  const decision = decideFileAccess(row, accountId);
  if (!decision.ok) {
    return { ok: false, response: NextResponse.json({ error: decision.code }, { status: decision.status, headers: NO_STORE }) };
  }
  const { uploadStatus: _ignored, ...file } = row!;
  return { ok: true, file, accountId, userId: session.userId };
}
