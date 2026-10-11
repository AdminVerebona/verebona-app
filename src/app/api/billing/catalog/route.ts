import { NextRequest, NextResponse } from 'next/server';
import { getPublicCatalog, presentationTtlSeconds } from '@/services/billing/price-catalog.service';
import { allowedCatalogOrigins, matchCatalogOrigin, normalizeOrigin, noteRefusedOrigin } from '@/lib/billing/catalog-cors';

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
 * CORS : seule l'origine de la vitrine (NEXT_PUBLIC_PUBLIC_SITE_URL et ses
 * variantes raisonnables, voir `lib/billing/catalog-cors`), en lecture ;
 * aucune écriture de facturation n'est ouverte à une autre origine.
 *
 * Lot 36B : quand le catalogue n'est pas `ok`, `reason` (code non sensible)
 * et `unavailable` (raison par offre) disent pourquoi — jamais un `price_…`.
 */
export async function GET(request: NextRequest) {
  const catalog = await getPublicCatalog().catch((e: Error) => {
    console.error('[billing/catalog] lecture impossible :', e.message);
    return { catalog_version: null, verified_at: null, status: 'unavailable' as const, purchasable: false, offers: [], plans: [], reason: 'SYNC_FAILED' as const, unavailable: [] };
  });
  const ttl = presentationTtlSeconds();
  const res = NextResponse.json(catalog, {
    headers: {
      'Cache-Control': catalog.status === 'ok'
        ? `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${Math.max(0, Math.min(ttl, 300 - ttl))}`
        : 'no-store',
      ...(catalog.catalog_version ? { ETag: `"${catalog.catalog_version}"` } : {}),
      // La réponse dépend de l'origine (CORS) : jamais partagée entre origines par un cache.
      Vary: 'Origin',
    },
  });
  applyCatalogCors(request, res);
  return res;
}

/**
 * CORS (lot 36B) : origine de la vitrine comparée après normalisation
 * (`www.` ↔ apex, casse, slash final, valeur figée au build OU lue à
 * l'exécution, `PUBLIC_SITE_EXTRA_ORIGINS`). Lecture seule, sans cookie :
 * aucune écriture de facturation n'est ouverte. Une origine refusée est
 * journalisée une fois par instance et listée dans le BO (Catalogue Stripe).
 */
function applyCatalogCors(request: NextRequest, res: NextResponse): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const allowed = allowedCatalogOrigins(process.env.NEXT_PUBLIC_PUBLIC_SITE_URL);
  const match = matchCatalogOrigin(origin, allowed);
  if (match) {
    res.headers.set('Access-Control-Allow-Origin', match);
    return;
  }
  // Même origine que l'application : pas de CORS nécessaire.
  if (normalizeOrigin(origin) === normalizeOrigin(request.nextUrl.origin)) return;
  if (noteRefusedOrigin(origin)) {
    console.warn(JSON.stringify({ evt: 'billing.catalog.cors_refused', origin, allowed }));
  }
}
