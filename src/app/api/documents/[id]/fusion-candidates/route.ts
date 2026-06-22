/**
 * GET /api/documents/[id]/fusion-candidates
 * Retourne les candidats fusion pour le fichier donné.
 * Utilisé par le client pour afficher FusionSuggestionModal après upload.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { detectFusionCandidates } from '@/services/document-ai/fusion-detector';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { id: rawId } = await params;
    const accountId = session.currentAccountId;

    if (!accountId) {
      return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });
    }

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    const result = await detectFusionCandidates(assetFileId, accountId);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/documents/[id]/fusion-candidates error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
