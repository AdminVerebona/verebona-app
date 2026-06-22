import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifyAccessToken } from '@/lib/jwt';
import { db } from '@/db';
import { assetDeleteRequests } from '@/db/schema';
import { eq } from 'drizzle-orm';
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
    const requestId = parseInt(id, 10);
    if (isNaN(requestId)) {
      return NextResponse.json({ error: 'INVALID_REQUEST_ID' }, { status: 400 });
    }

    const body = await request.json();
    const { action } = body;

    if (!action || !['ACCEPT', 'REFUSE'].includes(action)) {
      return NextResponse.json({ error: 'INVALID_ACTION' }, { status: 400 });
    }

    const [deleteRequest] = await db
      .select()
      .from(assetDeleteRequests)
      .where(eq(assetDeleteRequests.id, requestId))
      .limit(1);

    if (!deleteRequest) {
      return NextResponse.json({ error: 'REQUEST_NOT_FOUND' }, { status: 404 });
    }

    if (deleteRequest.validatorUserId !== payload.userId) {
      return NextResponse.json({ error: 'NOT_VALIDATOR' }, { status: 403 });
    }

    if (deleteRequest.status !== 'PENDING') {
      return NextResponse.json({ error: 'REQUEST_ALREADY_RESOLVED' }, { status: 409 });
    }

    const result = await DuoService.respondToDeleteRequest({
      requestId,
      action,
      resolvedByUserId: payload.userId,
      resolvedByType: 'USER',
    });

    return NextResponse.json({ 
      success: true, 
      status: result.status,
      message: action === 'ACCEPT' ? 'Suppression acceptée' : 'Suppression refusée'
    });
  } catch (error: any) {
    console.error('[DELETE_REQUEST_RESPOND] Error:', error);

    if (error.message === 'REQUEST_NOT_FOUND') {
      return NextResponse.json({ error: 'REQUEST_NOT_FOUND' }, { status: 404 });
    }

    if (error.message === 'REQUEST_ALREADY_RESOLVED') {
      return NextResponse.json({ error: 'REQUEST_ALREADY_RESOLVED' }, { status: 409 });
    }

    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
