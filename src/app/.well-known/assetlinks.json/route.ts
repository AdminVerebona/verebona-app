import { NextResponse } from 'next/server';
import { androidAssetLinks } from '@/lib/mobile/app-links';

export const dynamic = 'force-dynamic';

/**
 * GET /.well-known/assetlinks.json — lot 97 (CDC 12 §19 App Links Android).
 * Déclaration Digital Asset Links construite à partir des variables
 * MOBILE_ANDROID_* de l'environnement ; 404 si non configuré.
 */
export async function GET() {
  const body = androidAssetLinks();
  if (!body) return new NextResponse('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
