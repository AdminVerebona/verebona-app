/**
 * GET /api/internal/production-deletion-signals — lot 104A (P1-F).
 *
 * Route SERVEUR À SERVEUR : la préproduction y lit, depuis la production, les
 * suppressions de comptes exécutées (registre minimal 102A), sous forme
 * d'empreintes HMAC non réversibles — aucune adresse, aucun nom, aucun
 * identifiant en clair, aucun secret échangé. Requête signée par la clé
 * partagée `PRODUCTION_DELETION_SIGNAL_KEY` (horodatage ± 5 min), réponse
 * signée. Hors production : 404 (rien n'est exposé). Sans session (pas de
 * cookie entre serveurs) : l'authentification est la signature.
 * Protocole : `services/admin/production-copies/deletion-signals.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await ensureMigrations();
    const { serveDeletionSignals } = await import('@/services/admin/production-copies/deletion-propagation.service');
    const r = await serveDeletionSignals({ method: request.method, url: request.url, headers: request.headers });
    return new NextResponse(r.body, { status: r.status, headers: r.headers });
  } catch (e) {
    console.error('[deletion-signals] service indisponible :', (e as Error).message);
    return NextResponse.json({ code: 'UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
