import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { updateDocumentForAccount } from '@/services/documents/document-write.facade';
import { NotesIntentUnavailableError, NOTES_INTENT_UNAVAILABLE_MESSAGE } from '@/services/documents/notes-description/store';

// PUT /api/documents/[id] — modification d'un document par l'utilisateur (tiroir du document).
// Lot 114 (#753, W12 / W13) : la logique métier est dans la façade `document-write.facade`
// (`updateDocumentForAccount`), partagée avec l'Assistant Verebona — titre utilisateur, date,
// « Notes / Description », rattachements, audit, réanalyse, « À traiter », DOCUMENT_UPDATED.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    if (!session.currentAccountId) {
      return NextResponse.json(
        { error: 'NO_ACCOUNT', message: 'Aucun compte sélectionné' },
        { status: 400 }
      );
    }
    // Lot 85D : écriture refusée en lecture seule (essai échu, impayé, résilié, rétractation).
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;
    const { id: rawId } = await params;
    const documentId = parseInt(rawId);

    if (isNaN(documentId)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'ID de document invalide' },
        { status: 400 }
      );
    }

    const body = await request.json();
    return await updateDocumentForAccount({ userId: session.userId, currentAccountId: session.currentAccountId }, documentId, body);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    // Carte #767 (E05) : intention « Notes / Description » non persistable → transaction annulée, erreur explicite.
    if (error instanceof NotesIntentUnavailableError) {
      return NextResponse.json({ error: error.code, reason: error.reason, message: NOTES_INTENT_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    console.error('PUT /api/documents/[id] error:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
