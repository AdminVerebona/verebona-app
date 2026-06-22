import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
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
    const duoId = parseInt(id, 10);
    if (isNaN(duoId)) {
      return NextResponse.json({ error: 'INVALID_DUO_ID' }, { status: 400 });
    }

    const duo = await DuoService.getDuoByUserId(payload.userId);
    if (!duo || duo.id !== duoId) {
      return NextResponse.json({ error: 'NOT_A_MEMBER' }, { status: 403 });
    }

    await DuoService.leaveDuo({
      duoId,
      userId: payload.userId,
    });

    return NextResponse.json({ success: true, message: 'Vous avez quitté le duo' });
  } catch (error) {
    console.error('[DUO_LEAVE] Error:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
