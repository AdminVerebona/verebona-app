/**
 * GET /api/documents/[id]/knowledge — représentation durable du document (T1).
 * [id] = asset_files.id
 *
 * Contenu source extrait (texte, description, titre, date, émetteur, montant,
 * preuves des éléments structurants, métadonnées) et faits génériques actifs,
 * avec provenance et extraits justificatifs. Lecture seule, limitée au compte
 * courant. `?text=0` omet le texte intégral (réponse plus légère).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { getDocumentKnowledge } from '@/services/ai/knowledge/document-knowledge.service';
import { listGroupedSources } from '@/services/documents/grouped-sources';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const { id } = await params;
    const fileId = parseInt(id);
    if (isNaN(fileId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const knowledge = await getDocumentKnowledge(accountId, fileId);
    if (!knowledge) return NextResponse.json({ error: 'NOT_ANALYZED' }, { status: 404 });

    const withText = request.nextUrl.searchParams.get('text') !== '0';
    // Sources originales regroupées dans ce document (pages, photos…) :
    // conservées comme preuves, ouvrables par /api/files/{id}/view.
    const groupedSources = await listGroupedSources(fileId, accountId).catch(() => []);
    return NextResponse.json({
      extraction: withText ? knowledge.extraction : { ...knowledge.extraction, fullText: undefined },
      facts: knowledge.facts,
      groupedSources,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/documents/[id]/knowledge error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
