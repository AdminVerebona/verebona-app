import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE } from '../../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/anomalies/[id]/conflicts — lot 113AQ (Trello #751) :
 * diagnostic STRUCTURÉ d'une anomalie IDENTITY_ATTRIBUTE_CONFLICT (une entrée
 * par Opération × attribut × rôle, valeurs côte à côte, qualification, dernier
 * contrôle, état de ligne et d'alerte, lecture des signalements).
 *
 *   ?page=N (défaut 1)            pagination par Opération (50 par page) ;
 *   ?scope=alerting (défaut)|all  Opérations qui maintiennent l'alerte, ou toutes
 *                                 celles qui gardent un fait divergent.
 *
 * Garde administrateur AVANT toute lecture (anti-énumération : 403 identique).
 * LECTURE SEULE : aucune mutation, aucun appel IA, aucune reconsolidation.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const raw = (await params).id;
  const id = /^\d{1,9}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  if (!id) return NextResponse.json({ error: 'Identifiant invalide', code: 'INVALID_ID' }, { status: 400, headers: NO_STORE });
  const sp = request.nextUrl.searchParams;
  const pageRaw = sp.get('page') ?? '1';
  const scope = sp.get('scope') ?? 'alerting';
  if (!/^\d{1,6}$/.test(pageRaw) || Number(pageRaw) < 1 || (scope !== 'alerting' && scope !== 'all')) {
    return NextResponse.json({ error: 'Paramètres invalides (page, scope).', code: 'INVALID_PARAMS' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { anomalyConflictDiagnostic } = await import('@/services/admin/anomaly-conflicts');
    const r = await anomalyConflictDiagnostic(id, { page: Number(pageRaw), scope });
    if (r.status === 'NOT_FOUND') return NextResponse.json({ error: 'Anomalie introuvable', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    if (r.status === 'NOT_APPLICABLE') {
      return NextResponse.json({ error: 'Diagnostic propre aux contradictions d’attributs d’Opération.', code: 'NOT_APPLICABLE' }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ diagnostic: r.diagnostic }, { headers: NO_STORE });
  } catch (e) {
    console.error('[admin/anomalies/conflicts] lecture :', (e as Error)?.message ?? e);
    // Diagnostic partiel jamais présenté comme complet : erreur explicite.
    return NextResponse.json({ error: 'Diagnostic indisponible (lecture en échec, voir le journal du serveur).', code: 'DIAGNOSTIC_FAILED' }, { status: 500, headers: NO_STORE });
  }
}
