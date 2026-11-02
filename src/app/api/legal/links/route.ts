/**
 * GET /api/legal/links — public (lot 102B).
 *
 * Les cinq liens légaux du site public, résolus par le serveur : adresses
 * ACTUELLES du site (/cgu, /mentions-legales, /confidentialite) tant que son
 * manifeste n'a jamais été lu, nouvelles adresses /legal/… ensuite (ou selon
 * `LEGAL_PUBLIC_V2`), surcharges `NEXT_PUBLIC_LEGAL_*_URL` comprises. Lu par
 * `useLegalLinks` (navigateur, application mobile). Aucune donnée personnelle.
 */
import { NextResponse } from 'next/server';
import { getServerLegalLinks } from '@/services/legal/cguv-referential.service';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { mode, links } = await getServerLegalLinks();
  return NextResponse.json({ mode, links }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
