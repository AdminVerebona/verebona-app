import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
import { db } from '@/db';
import { sql } from 'drizzle-orm';

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

  if (payload.role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'Accès refusé' },
      { status: 403 }
    );
  }

  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN has_seen_upload_notice INTEGER DEFAULT 0 NOT NULL
    `);

    return NextResponse.json({ success: true, message: 'Migration executed successfully' });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage.includes('duplicate column name')) {
      return NextResponse.json({ success: true, message: 'Column already exists' });
    }
    
    console.error('[MIGRATE_UPLOAD_NOTICE] Error:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: errorMessage },
      { status: 500 }
    );
  }
}
