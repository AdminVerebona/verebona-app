import type { NextRequest } from 'next/server';
import { duoRouteRemoved, DUO_CROSS_VALIDATION_REMOVED } from '@/lib/duo/removed-routes';
import { refuserSiRequeteSurBienTransmis } from '@/lib/asset-read-only-guard';

/**
 * Lot 72D (ticket P0 « Premium Duo — compte partagé », décision PO Q11) :
 * route retirée — 410 `DUO_CROSS_VALIDATION_REMOVED`. Voir `src/lib/duo/removed-routes.ts`.
 * Tables et historique conservés jusqu'à la contraction (lot ultérieur).
 */
export async function POST(request: NextRequest) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(request, undefined, { kind: 'moveRequest' }); if (refusTransmis) return refusTransmis; }
  return duoRouteRemoved(request, DUO_CROSS_VALIDATION_REMOVED);
}
