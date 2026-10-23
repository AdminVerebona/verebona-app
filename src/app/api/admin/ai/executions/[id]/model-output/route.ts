/**
 * POST /api/admin/ai/executions/[id]/model-output — lot 33D (ticket « rapports
 * d'échec IA diagnostiquables », §4).
 *
 * Sortie RÉELLEMENT retournée par le modèle pour les appels de l'exécution
 * (réponse brute, après extraction, après parsing), conservée pour les appels
 * en échec ou corrigés. Données issues des documents des utilisateurs :
 * garde administrateur, liste optionnelle `AI_MODEL_OUTPUT_ADMIN_IDS`, chaque
 * consultation journalisée. POST (jamais mis en cache, jamais préchargé) et
 * réponse `no-store`. Lot 82C : avec les échanges capturés à la source de
 * TOUS les appels de l'exécution (`captures` : prompt final, contexte,
 * paramètres envoyés, réponse brute, sortie parsée, statut de capture).
 */
import { NextRequest, NextResponse } from 'next/server';
import { readModelOutputsForAdmin } from '@/services/ai/telemetry/model-output-access';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

const STATUS = { FORBIDDEN: 403, NOT_FOUND: 404 } as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    // Lot 82C : sorties des diagnostics ET échanges capturés à la source (même droit, même journal).
    const r = await readModelOutputsForAdmin({ adminUserId: guard.ctx.adminUserId, callId: Number(id), purpose: 'detail', includeCaptures: true });
    if (!r.ok) return NextResponse.json({ error: r.code, message: r.message }, { status: STATUS[r.code] });
    return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/executions/[id]/model-output');
  }
}
