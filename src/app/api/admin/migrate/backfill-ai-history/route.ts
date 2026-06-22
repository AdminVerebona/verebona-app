/**
 * POST /api/admin/migrate/backfill-ai-history
 * Backfill one-time : crée les entrées manquantes dans ai_field_updates
 * pour tous les biens dont keyCharacteristics est rempli mais qui n'ont
 * aucun enregistrement dans ai_field_updates.
 *
 * À déclencher une seule fois. Idempotent : ne recrée pas les entrées existantes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, aiFieldUpdates } from '@/db/schema';
import { eq, isNotNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function POST(request: NextRequest) {
  try { await requireAdmin(request); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const allAssets = await db
    .select({
      id: assets.id,
      accountId: assets.accountId,
      name: assets.name,
      keyCharacteristics: assets.keyCharacteristics,
      updatedAt: assets.updatedAt,
    })
    .from(assets)
    .where(
      isNotNull(assets.keyCharacteristics),
    );

  let inserted = 0;
  let skipped = 0;

  for (const asset of allAssets) {
    if (!asset.keyCharacteristics) continue;

    let kc: Record<string, unknown> = {};
    try { kc = JSON.parse(asset.keyCharacteristics); } catch { continue; }

    const filledEntries = Object.entries(kc).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (filledEntries.length === 0) continue;

    // Vérifier si cet asset a déjà des entrées dans ai_field_updates
    const existing = await db
      .select({ fieldKey: aiFieldUpdates.fieldKey })
      .from(aiFieldUpdates)
      .where(eq(aiFieldUpdates.assetId, asset.id));

    const existingKeys = new Set(existing.map(r => r.fieldKey));

    const toInsert = filledEntries.filter(([k]) => !existingKeys.has(k));
    if (toInsert.length === 0) { skipped++; continue; }

    if (!asset.accountId) { skipped++; continue; }

    await db.insert(aiFieldUpdates).values(
      toInsert.map(([fieldKey, value]) => ({
        accountId: asset.accountId as number,
        assetId: asset.id,
        assetFileId: null,
        fieldKey,
        oldValue: null,
        newValue: String(value),
        // Utiliser updatedAt du bien comme date approximative
        createdAt: asset.updatedAt ?? new Date(),
      }))
    );

    inserted += toInsert.length;
  }

  return NextResponse.json({
    ok: true,
    inserted,
    skipped,
    message: `${inserted} entrées créées, ${skipped} biens déjà à jour.`,
  });
}
