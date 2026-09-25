/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * COM-013 / REC-MOD-06 : le contenu des modèles n'est pas éditable depuis le BO
 * (versionné dans le code ou les migrations). POST supprimé, ainsi que
 * `[id]` PUT, `[id]/reset` et `seed`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    // Verify admin authentication with JWT
    await await requireAdmin(request);

    // Fetch all email templates
    const templates = await db
      .select()
      .from(emailTemplates);

    return NextResponse.json(templates, { status: 200 });

  } catch (error) {
    console.error('GET email templates error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}

