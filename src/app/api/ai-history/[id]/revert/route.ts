/**
 * POST /api/ai-history/[id]/revert
 * Restaure la valeur précédente d'un champ modifié par l'IA.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { aiFieldUpdates, assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const { id: rawId } = await params;
    const updateId = parseInt(rawId);
    if (isNaN(updateId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    // Récupérer l'entrée d'historique
    const [entry] = await db.select()
      .from(aiFieldUpdates)
      .where(and(eq(aiFieldUpdates.id, updateId), eq(aiFieldUpdates.accountId, accountId)))
      .limit(1);
    if (!entry) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

    // Récupérer le bien
    const [asset] = await db.select({ keyCharacteristics: assets.keyCharacteristics, name: assets.name })
      .from(assets)
      .where(eq(assets.id, entry.assetId))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    // Restaurer la valeur précédente dans keyCharacteristics
    let kc: Record<string, unknown> = {};
    try { kc = asset.keyCharacteristics ? JSON.parse(asset.keyCharacteristics) : {}; } catch {}

    const restoredValue = entry.oldValue ?? null;

    if (entry.fieldKey === 'name') {
      if (restoredValue) {
        await db.update(assets).set({ name: restoredValue, updatedAt: new Date() }).where(eq(assets.id, entry.assetId));
      }
    } else {
      if (restoredValue === null) {
        delete kc[entry.fieldKey];
      } else {
        kc[entry.fieldKey] = restoredValue;
      }
      await db.update(assets).set({ keyCharacteristics: JSON.stringify(kc), updatedAt: new Date() }).where(eq(assets.id, entry.assetId));
    }

    // Supprimer l'entrée de l'historique
    await db.delete(aiFieldUpdates).where(eq(aiFieldUpdates.id, updateId));

    return NextResponse.json({ reverted: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('POST /api/ai-history/[id]/revert error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
