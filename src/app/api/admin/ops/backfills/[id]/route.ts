import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { getBackfillRun } from '@/services/admin/ops/backfill/runner';
import { guardAdmin, NO_STORE, opsError } from '../../_shared';

export const dynamic = 'force-dynamic';

/** GET /api/admin/ops/backfills/:id — état, progression et synthèse d'une exécution. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const run = await getBackfillRun((await params).id);
    if (!run) return NextResponse.json({ error: 'Introuvable', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ run }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'rattrapage (lecture)', 'OPS_BACKFILL_READ_FAILED');
  }
}
