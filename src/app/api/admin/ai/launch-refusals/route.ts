/**
 * GET /api/admin/ai/launch-refusals?ref=AN-XXXXXXXX&document=ID&account=ID&category=CODE
 *
 * Lot 113U (carte #720) — BO › File d'attente IA › « Refus de lancement
 * d'analyse » : chaque réponse non aboutie du lancement depuis le tiroir
 * (code, catégorie, document, compte, utilisateur, origine Web/iOS/Android,
 * statut HTTP, référence d'incident). Lecture seule, administrateurs.
 * Métadonnées du document seulement (jamais son nom ni son contenu).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { listLaunchRefusals } from '@/services/ai/source-analysis/launch-refusals';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const p = request.nextUrl.searchParams;
    const num = (k: string) => { const n = Number(p.get(k)); return Number.isInteger(n) && n > 0 ? n : null; };
    const r = await listLaunchRefusals({
      incidentRef: p.get('ref')?.trim() || null,
      assetFileId: num('document'),
      accountId: num('account'),
      category: p.get('category')?.trim() || null,
      limit: num('limit') ?? 100,
    });
    return NextResponse.json(r);
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/ai/launch-refusals] erreur :', error);
    return NextResponse.json({ error: 'Chargement impossible', code: 'LAUNCH_REFUSALS_LOAD_FAILED' }, { status: 500 });
  }
}
