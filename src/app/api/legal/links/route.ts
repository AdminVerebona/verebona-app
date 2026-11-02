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
import { allowedLegalOrigins } from '@/services/legal/cguv-manifest';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { mode, links } = await getServerLegalLinks();
  // Lot 103A : origines où un texte juridique peut être ouvert (site public,
  // LEGAL_PUBLIC_EXTRA_ORIGINS, surcharges) — liste blanche de `LegalLink`.
  const allowedOrigins = new Set(allowedLegalOrigins());
  for (const href of Object.values(links)) {
    try { allowedOrigins.add(new URL(href).origin); } catch { /* lien relatif : ignoré */ }
  }
  return NextResponse.json({ mode, links, allowedOrigins: [...allowedOrigins] }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
