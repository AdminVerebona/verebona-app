import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiInstructions } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import postgres from 'postgres';

const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

async function ensureTable() {
  await client`
    CREATE TABLE IF NOT EXISTS ai_instructions (
      id SERIAL PRIMARY KEY,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      gemini_analysis TEXT,
      prompts_patched TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_at TIMESTAMPTZ,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `;
}

export async function GET(request: NextRequest) {
  try {
    // Garde admin serveur unique (CDC BO GEN-002) : rôle relu en base si le
    // jeton est antérieur à une promotion, refus 401/403 sinon.
    await requireAdmin(request);
    await ensureTable();
    const rows = await db
      .select()
      .from(aiInstructions)
      .orderBy(desc(aiInstructions.createdAt))
      .limit(50);
    return NextResponse.json({ instructions: rows });
  } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    console.error('[ai-instructions GET]', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    // Garde admin serveur unique (CDC BO GEN-002) : rôle relu en base si le
    // jeton est antérieur à une promotion, refus 401/403 sinon.
    const adminId = await requireAdmin(request);
    await ensureTable();
    const { instruction } = await request.json();
    if (!instruction?.trim()) {
      return NextResponse.json({ error: 'EMPTY_INSTRUCTION' }, { status: 400 });
    }
    const [row] = await db
      .insert(aiInstructions)
      .values({
        instruction: instruction.trim(),
        status: 'pending',
        createdByUserId: adminId,
      })
      .returning();
    return NextResponse.json({ instruction: row });
  } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    console.error('[ai-instructions POST]', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Garde admin serveur unique (CDC BO GEN-002) : rôle relu en base si le
    // jeton est antérieur à une promotion, refus 401/403 sinon.
    await requireAdmin(request);
    const { id, status } = await request.json();
    if (!id || !['applied', 'dismissed', 'pending'].includes(status)) {
      return NextResponse.json({ error: 'INVALID_PARAMS' }, { status: 400 });
    }
    await db
      .update(aiInstructions)
      .set({ status, appliedAt: status === 'applied' ? new Date() : null })
      .where(eq(aiInstructions.id, id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    console.error('[ai-instructions PATCH]', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
