import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { AccountService } from '@/services/account-service';
import { createWebDocumentForAccount, type WebDocumentInput } from '@/services/documents/document-write.facade';
import { NotesIntentUnavailableError, NOTES_INTENT_UNAVAILABLE_MESSAGE } from '@/services/documents/notes-description/store';

export const dynamic = 'force-dynamic';

async function resolveAccountId(userId: number, jwtAccountId?: number): Promise<number | null> {
  if (jwtAccountId) return jwtAccountId;
  const account = await AccountService.getUserDefaultAccount(userId);
  return account?.id ?? null;
}

export async function GET(request: NextRequest) {
  try {
    let session;
    try { session = await getSession(request); }
    catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

    const accountId = await resolveAccountId(session.userId, session.currentAccountId);
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const assetIdInt = parseInt(searchParams.get('assetId') || '');
    if (isNaN(assetIdInt)) return NextResponse.json({ error: 'MISSING_ASSET_ID' }, { status: 400 });

    const webLinks = await db.select()
      .from(assetFiles)
      .where(and(
        eq(assetFiles.assetId, assetIdInt),
        eq(assetFiles.accountId, accountId),
        eq(assetFiles.isWebLink, true),
        isNull(assetFiles.deletedAt),
      ));

    return NextResponse.json({ data: webLinks });
  } catch (error) {
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    let session;
    try { session = await getSession(request); }
    catch { return NextResponse.json({ error: 'AUTH_REQUIRED', message: 'Session expirée, reconnectez-vous' }, { status: 401 }); }

    const accountId = await resolveAccountId(session.userId, session.currentAccountId);
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT', message: 'Aucun compte trouvé' }, { status: 401 });
    // Lot 85D : ajouter un lien web crée un document — refusé en lecture seule
    // (même règle que le dépôt d'un fichier, `files/presign` et `files/confirm`).
    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;

    let body: Record<string, unknown>;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 }); }

    // Lot 114 (#753, W10) : validation et création par la façade métier — la même que l'Assistant Verebona.
    const r = await createWebDocumentForAccount({ userId: session.userId, currentAccountId: accountId }, body as WebDocumentInput);
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.extra ?? {}), ...(r.message ? { message: r.message } : {}) }, { status: r.status });
    const newWebLink = r.webLink;

    return NextResponse.json({ success: true, webLink: newWebLink }, { status: 201 });
  } catch (error) {
    // Carte #767 (E05) : intention utilisateur non persistable → rien n'est créé, erreur explicite.
    if (error instanceof NotesIntentUnavailableError) {
      return NextResponse.json({ error: error.code, code: error.code, reason: error.reason, message: NOTES_INTENT_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    console.error('[POST /api/web-links]', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: (error as Error).message }, { status: 500 });
  }
}
