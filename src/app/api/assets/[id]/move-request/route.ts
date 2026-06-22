import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { DuoService } from '@/services/duo.service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = extractAccessToken(request);
    if (!token) {
      return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    }

    const payload = await verifyAccessToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    const { id } = await params;
    const assetId = parseInt(id, 10);
    if (isNaN(assetId)) {
      return NextResponse.json({ error: 'INVALID_ASSET_ID' }, { status: 400 });
    }

    const body = await request.json();
    const { targetAccountId } = body;

    if (!targetAccountId) {
      return NextResponse.json({ error: 'TARGET_ACCOUNT_ID_REQUIRED' }, { status: 400 });
    }

    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

    if (!asset) {
      return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });
    }

    if (asset.deletedAt) {
      return NextResponse.json({ error: 'ASSET_DELETED' }, { status: 400 });
    }

    if (!asset.duoId) {
      return NextResponse.json({ error: 'NOT_A_DUO_ASSET' }, { status: 400 });
    }

    const duo = await DuoService.getDuoByUserId(payload.userId);
    if (!duo || duo.id !== asset.duoId) {
      return NextResponse.json({ error: 'NOT_A_MEMBER' }, { status: 403 });
    }

    if (asset.lockState !== 'NONE') {
      return NextResponse.json({ error: 'ASSET_LOCKED', lockState: asset.lockState }, { status: 423 });
    }

    const otherMember = await DuoService.getOtherDuoMember(duo.id, payload.userId);
    if (!otherMember) {
      return NextResponse.json({ error: 'NO_OTHER_MEMBER' }, { status: 400 });
    }

    const targetAccount = await DuoService.getUserAccount(otherMember.userId);
    if (!targetAccount || targetAccount.accountId !== targetAccountId) {
      return NextResponse.json({ error: 'INVALID_TARGET_ACCOUNT' }, { status: 400 });
    }

    const targetAssetCount = await DuoService.countAssetsForAccount(targetAccountId);
    if (targetAssetCount >= 3) {
      return NextResponse.json(
        { error: 'TARGET_ACCOUNT_FULL', message: 'Le compte cible a atteint la limite de 2 biens (Standard)' },
        { status: 400 }
      );
    }

    const initiatorDisplay = await DuoService.getUserDisplayName(payload.userId);
    const targetUserDisplay = `Compte personnel de ${otherMember.userFirstName || ''} ${otherMember.userLastName || ''}`.trim();

    await DuoService.createMoveRequest({
      assetId,
      duoId: duo.id,
      targetAccountId,
      initiatorUserId: payload.userId,
      validatorUserId: otherMember.userId,
      assetLabel: asset.name,
      targetUserDisplay,
      initiatorUserDisplay: initiatorDisplay,
    });

    return NextResponse.json({ success: true, message: 'Demande de déplacement créée' });
  } catch (error: any) {
    console.error('[ASSET_MOVE_REQUEST] Error:', error);

    if (error.message === 'PENDING_REQUEST_EXISTS') {
      return NextResponse.json(
        { error: 'PENDING_REQUEST_EXISTS', message: 'Une demande de déplacement est déjà en cours pour ce bien' },
        { status: 409 }
      );
    }

    if (error.message === 'PENDING_DELETE_REQUEST_EXISTS') {
      return NextResponse.json(
        { error: 'PENDING_DELETE_REQUEST_EXISTS', message: 'Une demande de suppression est en cours pour ce bien' },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
