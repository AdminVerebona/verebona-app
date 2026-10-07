/**
 * POST /api/documents/upload-notification — fin d'un lot d'envoi réussi
 * (lot 32, décisions PO Q18/Q19).
 *
 * Appelée par la fenêtre d'ajout à la fin d'un lot (fichiers) ou après la
 * création d'un lien web : `{ fileIds: number[], lotId?: string }`. Émet UNE
 * notification « Documents ajoutés » pour l'utilisateur (tous comptes,
 * Standard compris) — voir `upload-notification.service`. Aucun toast.
 * Réponse 202 : la livraison (cloche, push, e-mail selon les préférences)
 * est asynchrone ; un échec n'affecte pas l'envoi, déjà réussi.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { notifyUploadCompleted } from '@/services/documents/upload-notification.service';

export async function POST(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }
  if (!session.currentAccountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  const body = (await request.json().catch(() => null)) as { fileIds?: unknown; lotId?: unknown } | null;
  if (!body || !Array.isArray(body.fileIds)) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: '`fileIds` requis.' }, { status: 400 });
  }

  try {
    const r = await notifyUploadCompleted({
      userId: session.userId,
      accountId: session.currentAccountId,
      fileIds: body.fileIds,
      lotId: body.lotId,
    });
    return NextResponse.json(r, { status: 202 });
  } catch (e) {
    console.error('[upload-notification] émission impossible :', (e as Error).message);
    return NextResponse.json({ emitted: false, count: 0 }, { status: 202 });
  }
}
