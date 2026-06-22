import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { SessionService } from '@/lib/session-service';

/**
 * POST /api/admin/email-templates/seed
 * Inserts any missing templates from DEFAULT_EMAIL_TEMPLATES into the DB.
 * Idempotent — existing templates are skipped.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    const now = new Date();
    const created: string[] = [];
    const skipped: string[] = [];

    for (const [type, defaults] of Object.entries(DEFAULT_EMAIL_TEMPLATES)) {
      const [existing] = await db
        .select({ id: emailTemplates.id })
        .from(emailTemplates)
        .where(eq(emailTemplates.type, type))
        .limit(1);

      if (existing) {
        skipped.push(type);
        continue;
      }

      await db.insert(emailTemplates).values({
        type,
        subject: defaults.subject,
        body: defaults.body,
        placeholders: (defaults as any).placeholders ?? null,
        updatedAt: now,
      });

      created.push(type);
    }


    return NextResponse.json({ success: true, created, skipped });
  } catch (error) {
    const errMsg = (error as Error).message;
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED', 'INSUFFICIENT_PERMISSIONS'].includes(errMsg)) {
      return SessionService.handleSessionError(error);
    }
    console.error('[EmailTemplateSeed] Error:', error);
    return NextResponse.json({ error: 'Seed failed', detail: errMsg }, { status: 500 });
  }
}
