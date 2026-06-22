import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { AccountService } from '@/services/account-service';

export const dynamic = 'force-dynamic';

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

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

    let body: Record<string, unknown>;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 }); }

    const { url, title, documentType, assetId, documentDate, description, supplier, amountCents } = body as {
      url?: string; title?: string; documentType?: string; assetId?: number | string | null;
      documentDate?: string; description?: string; supplier?: string; amountCents?: number;
    };

    if (!url || !url.trim()) return NextResponse.json({ error: 'MISSING_URL', message: 'URL requise' }, { status: 400 });
    if (!title || !title.trim()) return NextResponse.json({ error: 'MISSING_TITLE', message: 'Nom du document requis' }, { status: 400 });
    if (!isValidUrl(url.trim())) return NextResponse.json({ error: 'INVALID_URL', message: "L'URL doit commencer par http:// ou https://" }, { status: 400 });

    let assetIdInt: number | null = null;
    if (assetId && assetId !== 0 && assetId !== '0') {
      assetIdInt = parseInt(String(assetId));
      if (isNaN(assetIdInt)) return NextResponse.json({ error: 'INVALID_ASSET_ID' }, { status: 400 });

      const [asset] = await db.select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, assetIdInt), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
        .limit(1);

      if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND', message: 'Bien introuvable' }, { status: 404 });
    }

    const now = new Date();
    const [newWebLink] = await db.insert(assetFiles).values({
      userId: session.userId,
      accountId,
      assetId: assetIdInt,
      isWebLink: true,
      webLinkUrl: url.trim(),
      webLinkTitle: title.trim(),
      originalFilename: title.trim(),
      filename: `weblink-${Date.now()}`,
      mimeType: 'application/x-web-link',
      fileExtension: 'url',
      size: 0,
      sha256Hash: `weblink-${session.userId}-${Date.now()}`,
      s3Key: 'weblink',
      s3Bucket: 'weblink',
      s3Region: 'weblink',
      documentType: (typeof documentType === 'string' && documentType) ? documentType : 'AUTRE',
      documentDate: documentDate || null,
      description: description || null,
      supplier: supplier || null,
      amountCents: amountCents || null,
      uploadStatus: 'COMPLETED',
      scope: 'personal',
      isDraft: false,
      isIgnored: false,
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning();

    if (!newWebLink) throw new Error('Échec de la création');

    return NextResponse.json({ success: true, webLink: newWebLink }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/web-links]', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: (error as Error).message }, { status: 500 });
  }
}
