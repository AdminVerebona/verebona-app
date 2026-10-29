/**
 * GET /api/auth/oauth/providers — lot 93 : fournisseurs actifs (boutons
 * « Continuer avec Google / Apple »). Public, sans donnée de compte ; les deux
 * à `false` tant que les variables Scalingo ne sont pas posées.
 */
import { NextResponse } from 'next/server';
import { enabledProviders } from '@/lib/auth/oauth/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(enabledProviders(), { headers: { 'Cache-Control': 'no-store' } });
}
