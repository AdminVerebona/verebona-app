/**
 * POST /api/ai-history/[id]/revert
 * Restaure la valeur précédente d'un champ modifié par l'IA.
 *
 * CDC 15 T3-02 (lot 13, protection hors commutateur) : la valeur restaurée
 * prend l'origine USER, avec `__updatedAt`. Choix : l'annulation est un acte
 * HUMAIN explicite qui refuse la valeur de l'IA — aucune règle du code ne
 * dit autre chose (le commentaire d'`apply-decision.ts` ne traite que de
 * l'existence de la capacité). Sans cette origine, la réconciliation
 * suivante, lisant encore l'ancienne origine automatique, réappliquerait la
 * même preuve et annulerait l'annulation. Limite connue : une restauration
 * vers « vide » reste un champ vide, que T3 peut de nouveau remplir (la
 * matrice traite un champ vide sans regarder l'origine).
 * Clé du registre : `writeCanonicalAssetField` (origine USER, colonnes
 * miroirs, journal) — toujours depuis le lot 16b-3 (commutateur
 * `CANONICAL_WRITE_MODE` supprimé). Clé hors registre : keyCharacteristics.
 *
 * Lot 22 : ligne d'un ÉQUIPEMENT ou d'une PIÈCE (cible 0236) → la valeur
 * précédente est restaurée sur la fiche de l'entité par
 * `writeCanonicalEntityField` (origine USER, miroirs, journal 0216 ciblé),
 * jamais sur celle du bien porteur. Entité introuvable : 404, la ligne reste.
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

    // Cible (0236, colonnes hors Drizzle) : équipement ou pièce du bien porteur.
    const cible = await lireCible(updateId, accountId);
    if (cible) {
      const { writeCanonicalEntityField } = await import('@/services/canonical/entity-state');
      const res = await writeCanonicalEntityField({
        target: cible, accountId, key: entry.fieldKey, value: entry.oldValue ?? null, origin: 'USER',
        actorUserId: session.userId, source: { type: 'ai_history_revert', id: updateId },
      });
      if (res.notFound || res.skipped) return NextResponse.json({ error: 'ENTITY_NOT_FOUND' }, { status: 404 });
      await db.delete(aiFieldUpdates).where(eq(aiFieldUpdates.id, updateId));
      return NextResponse.json({ reverted: true });
    }

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
      const { isRegistryKey } = await import('@/services/ai/reconciliation/apply-decision');
      if (isRegistryKey(entry.fieldKey)) {
        const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
        await writeCanonicalAssetField({
          assetId: entry.assetId, accountId, key: entry.fieldKey, value: restoredValue, origin: 'USER',
          actorUserId: session.userId, source: { type: 'ai_history_revert', id: updateId },
        });
      } else {
        if (restoredValue === null) {
          delete kc[entry.fieldKey];
        } else {
          kc[entry.fieldKey] = restoredValue;
        }
        const { writeOrigin } = await import('@/services/ai/reconciliation/field-origin');
        kc = writeOrigin(kc, entry.fieldKey, 'USER', { updatedAt: new Date().toISOString() });
        await db.update(assets).set({ keyCharacteristics: JSON.stringify(kc), updatedAt: new Date() }).where(eq(assets.id, entry.assetId));
      }
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

/** Cible d'une ligne (0236) ; null pour un champ du bien ou sans la migration. */
async function lireCible(
  id: number, accountId: number,
): Promise<{ type: 'EQUIPMENT' | 'ROOM'; id: number } | null> {
  const { aiFieldUpdatesTargetReady } = await import('@/services/canonical/entity-state/entity-schema');
  if (!(await aiFieldUpdatesTargetReady())) return null;
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT target_type AS type, target_id AS "targetId" FROM ai_field_updates WHERE id = $1 AND account_id = $2`,
    [id, accountId] as never[],
  )) as unknown as Array<{ type: string | null; targetId: number | null }>;
  const r = rows[0];
  if (!r || (r.type !== 'EQUIPMENT' && r.type !== 'ROOM') || r.targetId == null) return null;
  return { type: r.type, id: Number(r.targetId) };
}
