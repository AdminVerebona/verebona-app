import { NextRequest, NextResponse } from 'next/server';
import { getMascotPresentation } from '@/services/home/mascot/mascot.service';
import { mascotSession } from './_session';

/**
 * GET /api/home/mascot — prise de parole de la mascotte d'accueil
 * (CDC Mascotte d'accueil & T6, §16 : MascotPresentation).
 *
 * Calculée au niveau du COMPTE (DUO-001) ; salutation et prénom sont rendus
 * par le client, hors T6 et hors cache (UX-002, RUN-005).
 *
 * Lot 26 : la réponse n'attend plus le modèle — formulation T6 en cache ou
 * texte déterministe, la génération se poursuit en arrière-plan
 * (`t6DisplayWaitMs`). `maxDuration` reste une borne de sécurité.
 */
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  try {
    const t0 = Date.now();
    const presentation = await getMascotPresentation(s.accountId, 'display');
    // Mesure (lot 26, point 17) : visible dans l'onglet Réseau du navigateur ;
    // une prise de parole lente est signalée dans les journaux.
    const ms = Date.now() - t0;
    if (ms > 1_000) console.warn(`[mascotte] prise de parole lente : ${ms} ms (source ${presentation.source})`);
    return NextResponse.json(presentation, {
      headers: { 'Cache-Control': 'private, no-store', 'Server-Timing': `mascot;dur=${ms};desc="${presentation.source}"` },
    });
  } catch (e) {
    console.error('GET /api/home/mascot', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
