import { NextResponse } from 'next/server';
import { appleAppSiteAssociation } from '@/lib/mobile/app-links';

export const dynamic = 'force-dynamic';

/**
 * GET /.well-known/apple-app-site-association — lot 97 (CDC 12 §19 Universal
 * Links). JSON SANS extension, `application/json`, sans redirection ni
 * session (iOS le télécharge via le CDN d'Apple). Construit à partir des
 * variables MOBILE_IOS_* de l'environnement ; 404 si non configuré.
 */
export async function GET() {
  const body = appleAppSiteAssociation();
  if (!body) return new NextResponse('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
