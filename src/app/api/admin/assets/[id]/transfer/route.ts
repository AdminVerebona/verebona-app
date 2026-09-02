import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, users, adminAuditLog } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    }

    const token = authHeader.substring(7);
    const assetId = parseInt(params.id);

    if (isNaN(assetId)) {
      return NextResponse.json({ error: 'ID invalide' }, { status: 400 });
    }

    const body = await request.json();
    const { newUserId } = body;

    if (!newUserId || typeof newUserId !== 'number') {
      return NextResponse.json({ error: 'Nouveau propriétaire requis' }, { status: 400 });
    }

    // Verify asset exists
    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

    if (!asset) {
      return NextResponse.json({ error: 'Bien non trouvé' }, { status: 404 });
    }

    // Verify new user exists and is active
    const [newUser] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, newUserId), eq(users.isActive, true)))
      .limit(1);

    if (!newUser) {
      return NextResponse.json({ error: 'Utilisateur non trouvé ou inactif' }, { status: 404 });
    }

    // Prevent transfer to same user
    if (asset.userId === newUserId) {
      return NextResponse.json({ error: 'Le bien appartient déjà à cet utilisateur' }, { status: 400 });
    }

    const oldUserId = asset.userId;

    // Transfer asset
    await db
      .update(assets)
      .set({
        userId: newUserId,
          updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId));

    // Log the transfer in audit log
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: null, // TODO: get admin user ID from session
      adminEmail: 'system',
      actionType: 'ASSET_UPDATE',
      targetType: 'asset',
      targetId: assetId,
      details: JSON.stringify({
        assetId,
        assetName: asset.name,
        oldUserId,
        newUserId,
        transferredAt: new Date(),
      }),
    });

    return NextResponse.json({
      success: true,
      message: 'Bien transféré avec succès',
      oldUserId,
      newUserId,
    });
  } catch (error) {
    console.error('Transfer asset error:', error);
    return NextResponse.json(
      { error: 'Erreur serveur' },
      { status: 500 }
    );
  }
}