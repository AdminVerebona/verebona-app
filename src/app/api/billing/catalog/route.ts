import { NextRequest, NextResponse } from 'next/server';
import { getPublicCatalog, presentationTtlSeconds } from '@/services/billing/price-catalog.service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/catalog — catalogue public des offres (CDC lookup_key V4,
 * LK-29 à LK-33, EX-004, TC-14).
 *
 * SOURCE UNIQUE des montants affichés par l'application (desktop et mobile)
 * ET par la vitrine : la révision ACTIVE persistée, celle-là même que
 * Checkout relit avant de facturer. Pour chaque offre × périodicité : code,
 * montant entier en centimes, devise, cadence, révision de prix,
 * disponibilité, traitement TTC. Quotas : référentiel d'offres (`plan_limits`).
 *
 * Aucune donnée de compte, d'abonnement, de client ni secret Stripe ; le
 * `price_id` n'est pas exposé (LK-30). Sans cookie de compte. Lecture
 * mutualisée de l'état partagé : un affichage ne déclenche aucun appel
 * Stripe par visiteur (LK-33).
 *
 * Cache HTTP court (≤ 5 min, par défaut 60 s, `stale-while-revalidate`
 * borné) : la vitrine et l'application reconvergent après une publication ;
 * le montant final est de toute façon reconfirmé au clic (révision).
 * CORS : seule l'origine de la vitrine (NEXT_PUBLIC_PUBLIC_SITE_URL), en
 * lecture ; aucune écriture de facturation n'est ouverte à une autre origine.
 */
export async function GET(request: NextRequest) {
  const catalog = await getPublicCatalog().catch((e: Error) => {
    console.error('[billing/catalog] lecture impossible :', e.message);
    return { catalog_version: null, verified_at: null, status: 'unavailable' as const, purchasable: false, offers: [], plans: [] };
  });
  const ttl = presentationTtlSeconds();
  const res = NextResponse.json(catalog, {
    headers: {
      'Cache-Control': catalog.status === 'ok'
        ? `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${Math.max(0, Math.min(ttl, 300 - ttl))}`
        : 'no-store',
      ...(catalog.catalog_version ? { ETag: `"${catalog.catalog_version}"` } : {}),
    },
  });
  const publicSite = (process.env.NEXT_PUBLIC_PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  if (publicSite && request.headers.get('origin') === publicSite) {
    res.headers.set('Access-Control-Allow-Origin', publicSite);
    res.headers.set('Vary', 'Origin');
  }
  return res;
}
