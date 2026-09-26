/**
 * GET /api/admin/gdpr/subjects?q= — recherche de la personne concernée
 * (utilisateur et son compte) pour la création d'une demande manuelle
 * (CDC BO GDP-010). E-mail, nom, prénom, nom de compte ou identifiant.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { searchSubjects } from '@/services/gdpr/gdpr-request.repository';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ subjects: [] });
  try {
    return NextResponse.json({ subjects: await searchSubjects(q.slice(0, 100)) });
  } catch (error) {
    console.error('[admin/gdpr/subjects] :', error);
    return NextResponse.json({ error: 'SUBJECT_SEARCH_FAILED', message: 'Recherche impossible.' }, { status: 500 });
  }
}
