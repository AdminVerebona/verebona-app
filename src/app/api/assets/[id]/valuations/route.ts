import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export type ValuationEntry = {
  id: string;
  value: number | null;
  date: string | null;
  mode: string | null;
  source: 'USER' | 'AI';
  addedAt: string;
};

function parseHistory(kc: Record<string, unknown>): ValuationEntry[] {
  try {
    const h = kc['valuationHistory'];
    if (Array.isArray(h)) return h as ValuationEntry[];
  } catch {}
  return [];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    let session;
    try { session = await SessionService.getSession(request); }
    catch (e) { return SessionService.handleSessionError(e); }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const [assetRow] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) return apiError(404, 'NOT_FOUND', 'Asset not found');

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    let history = parseHistory(kc);

    // Backfill: if current estimatedValue exists but history is empty, create an initial entry
    if (history.length === 0 && kc['estimatedValue'] != null) {
      history = [{
        id: 'initial',
        value: Number(kc['estimatedValue']),
        date: (kc['estimatedValueDate'] as string) ?? null,
        mode: (kc['estimatedValueMode'] as string) ?? null,
        source: 'USER',
        addedAt: (assetRow as any).updatedAt?.toISOString?.() ?? new Date().toISOString(),
      }];
    }

    return NextResponse.json({ history });
  } catch (error) {
    console.error('GET /valuations error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    let session;
    try { session = await SessionService.getSession(request); }
    catch (e) { return SessionService.handleSessionError(e); }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const [assetRow] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) return apiError(404, 'NOT_FOUND', 'Asset not found');

    let body: { value?: number | null; date?: string | null; mode?: string | null; source?: 'USER' | 'AI' };
    try { body = await request.json(); }
    catch { return apiError(400, 'INVALID_INPUT', 'Invalid JSON body'); }

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    const history = parseHistory(kc);

    const newEntry: ValuationEntry = {
      id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      value: body.value ?? null,
      date: body.date ?? null,
      mode: body.mode ?? null,
      source: body.source ?? 'USER',
      addedAt: new Date().toISOString(),
    };

    history.push(newEntry);

    // Update current estimatedValue fields to reflect the latest entry
    kc['valuationHistory'] = history;
    if (newEntry.value != null) kc['estimatedValue'] = newEntry.value;
    if (newEntry.date != null) kc['estimatedValueDate'] = newEntry.date;
    if (newEntry.mode != null) kc['estimatedValueMode'] = newEntry.mode;

    await db.update(assets)
      .set({ keyCharacteristics: JSON.stringify(kc), updatedAt: new Date() } as any)
      .where(eq(assets.id, assetId));

    return NextResponse.json({ entry: newEntry });
  } catch (error) {
    console.error('POST /valuations error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
