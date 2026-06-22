import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const token = extractAccessToken(request);

  if (!token) {
    return NextResponse.json(
      { error: 'AUTH_REQUIRED', message: 'Authentification requise' },
      { status: 401 }
    );
  }

  const payload = await verifyAccessToken(token);

  if (!payload) {
    return NextResponse.json(
      { error: 'INVALID_TOKEN', message: 'Token invalide ou expiré' },
      { status: 401 }
    );
  }

  try {
    await db
      .update(users)
      .set({
        hasSeenUploadNotice: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, payload.userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[UPLOAD_NOTICE] Error updating user:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: 'Erreur serveur' },
      { status: 500 }
    );
  }
}
