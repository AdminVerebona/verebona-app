import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE_HEADERS, isDiagnosticAuthorized } from '@/lib/health/probes';
import { buildHealthReport } from '@/lib/health/diagnostic';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — DIAGNOSTIC (endpoint historique, conservé pour la
 * transition des sondes ; contrats : `src/lib/health/probes.ts`).
 *
 * Contrôles bornés, en parallèle et partagés entre appels : base (SELECT 1),
 * schéma critique, stockage S3 (appel réseau réel, résultat gardé 30 s).
 *
 * Codes : 200 `ok` | `degraded` (schéma incomplet, S3 configuré mais en
 * échec — l'application sert encore), 503 `down` (base injoignable).
 * Sans en-tête `x-health-token` valide : codes et noms de fichiers seulement,
 * jamais de message SQL, de cause S3 ni de nom de variable.
 */
export async function GET(request: NextRequest) {
  const { result, httpStatus } = await buildHealthReport({ detailed: isDiagnosticAuthorized(request.headers) });
  return NextResponse.json(result, { status: httpStatus, headers: NO_STORE_HEADERS });
}
