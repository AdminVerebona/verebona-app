import { NextResponse } from 'next/server';

/** Seule la vitrine (Centre d'aide) appelle ces routes depuis une autre origine. */
export function withCors(request: Request, res: NextResponse): NextResponse {
  const publicSite = (process.env.NEXT_PUBLIC_PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  if (publicSite && request.headers.get('origin') === publicSite) {
    res.headers.set('Access-Control-Allow-Origin', publicSite);
    res.headers.set('Vary', 'Origin');
  }
  return res;
}
