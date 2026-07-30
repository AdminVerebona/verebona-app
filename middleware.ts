import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken, extractToken } from './src/lib/jwt';
import { verifyRequestOrigin } from '@/lib/csrf';

// ─── Rate limiting in-memory pour le middleware Edge ────────────────────────
// Sliding window : 5 tentatives / 15 minutes / IP
// Note : le store est réinitialisé à chaque cold-start Edge ; acceptable pour
// un déploiement single-region. Pour multi-instance, utiliser Upstash Redis.
const AUTH_MAX = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const authStore = new Map<string, number[]>();

function checkEdgeRateLimit(ip: string): { allowed: boolean; retryAfterSeconds: number; remaining: number; limit: number } {
  const now = Date.now();
  const timestamps = (authStore.get(ip) ?? []).filter((ts) => now - ts < AUTH_WINDOW_MS);

  if (timestamps.length >= AUTH_MAX) {
    const retryAfterSeconds = Math.ceil((AUTH_WINDOW_MS - (now - timestamps[0])) / 1000);
    authStore.set(ip, timestamps);
    return { allowed: false, retryAfterSeconds, remaining: 0, limit: AUTH_MAX };
  }

  timestamps.push(now);
  authStore.set(ip, timestamps);
  return { allowed: true, retryAfterSeconds: 0, remaining: AUTH_MAX - timestamps.length, limit: AUTH_MAX };
}

function getClientIp(headers: Headers): string {
  return (
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    'unknown'
  );
}
// ────────────────────────────────────────────────────────────────────────────

/**
 * Middleware pour protéger les routes API (/api/*) avec vérification JWT
 * 
 * ⚠️ CRITIQUE: Les routes UI /admin/* sont protégées côté client dans le layout
 * car localStorage n'est pas accessible côté serveur (iframe constraints)
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ===== PROTECTION DES ROUTES UI / ABONNEMENT =====
  const isProtectedUI = [
    '/accueil',
    '/assets',
    '/agenda',
    '/documents',
    '/dashboard',
    '/mon-compte',
  ].some((route) => pathname === route || pathname.startsWith(route + '/'));

  const isAbonnement = pathname.startsWith('/abonnement/');

  if (isProtectedUI || isAbonnement) {
    const authHeader = request.headers.get('authorization');
    const cookieHeader = request.headers.get('cookie');
    const token = extractToken(authHeader, cookieHeader);

    if (!token) {
      if (isAbonnement) {
        return NextResponse.next();
      }
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('returnUrl', pathname);
      return NextResponse.redirect(loginUrl);
    }

    const payload = await verifyToken(token);
    if (!payload) {
      if (isAbonnement) {
        return NextResponse.next();
      }
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('returnUrl', pathname);
      return NextResponse.redirect(loginUrl);
    }

    if (payload.status === 'SUSPENDED' || payload.status === 'DELETED') {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('error', 'ACCOUNT_SUSPENDED');
      return NextResponse.redirect(loginUrl);
    }

    const hasActive = payload.hasActiveAccount === true || payload.role === 'ADMIN' || request.nextUrl.searchParams.has('session_id');

    if (isAbonnement) {
      if (hasActive && pathname === '/abonnement/onboarding') {
        return NextResponse.redirect(new URL('/accueil', request.url));
      }
      return NextResponse.next();
    }

    if (!hasActive && !pathname.startsWith('/mon-compte')) {
      return NextResponse.redirect(new URL('/abonnement/onboarding', request.url));
    }
  }

  // ===== PROTECTION DES ROUTES API =====
  if (pathname.startsWith('/api/')) {
    // ── CORS restreint (CDC cookies §9.1) ──
    // Seule la vitrine est autorisee a appeler l'API depuis une autre origine,
    // et uniquement pour le formulaire de contact. Jamais de joker, jamais de
    // cookies partages avec un tiers.
    const publicSite = (process.env.NEXT_PUBLIC_PUBLIC_SITE_URL || '').replace(/\/+$/, '');
    const requestOrigin = request.headers.get('origin');
    const isPublicSiteCall = Boolean(publicSite) && requestOrigin === publicSite;

    if (request.method === 'OPTIONS' && isPublicSiteCall) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': publicSite,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── Protection CSRF (CDC §9.1) ──
    // La session voyageant par cookies, toute requete modifiant des donnees
    // doit provenir d'une origine autorisee. Verifie avant l'authentification
    // pour rejeter au plus tot les requetes inter-sites.
    const csrf = verifyRequestOrigin(request);
    if (!csrf.allowed) {
      console.warn('[MW] requete rejetee (CSRF)', {
        pathname,
        method: request.method,
        reason: csrf.reason,
        origin: csrf.origin,
      });
      return NextResponse.json(
        { error: 'Origine non autorisee', code: 'CSRF_ORIGIN_REJECTED' },
        { status: 403 },
      );
    }

    // Routes publiques (pas besoin de JWT)
    //
    // ══════════════════════════════════════════════════════════════════════
    // LES ROUTES DU CYCLE DE VIE DU COMPTE MANQUAIENT
    //
    // `verify-email`, `resend-verification`, `forgot-password` et
    // `reset-password` sont par nature appelees SANS session : l'utilisateur
    // n'a pas encore de compte actif, ou ne peut plus se connecter. Elles
    // n'etaient pourtant pas listees ici, et tombaient donc dans le controle
    // JWT plus bas.
    //
    // Consequence : le lien de verification recu par email renvoyait un JSON
    // « 401 MISSING_TOKEN » dans le navigateur. Aucun compte cree ne pouvait
    // etre active, et aucun mot de passe oublie ne pouvait etre reinitialise.
    //
    // Le defaut etait masque par la liste `authRateLimitedRoutes` juste en
    // dessous, qui limite le debit de trois de ces routes — un traitement qui
    // n'etait jamais atteint puisqu'il est imbrique DANS le bloc des routes
    // publiques.
    // ══════════════════════════════════════════════════════════════════════
    const publicRoutes = [
      '/api/auth/login',
      '/api/auth/refresh',
      '/api/auth/logout',
      '/api/auth/verify-email',      // lien clique depuis l'email, sans session
      '/api/auth/resend-verification',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/health',
      '/api/users', // Public pour signup
      '/api/billing/stripe-webhook', // Stripe signe ses propres requêtes — pas de JWT
      '/api/referral/validate', // Validation publique du code parrainage
      '/api/contact', // Formulaire de contact du site vitrine (visiteur non connecte)
    ];

    // Cron endpoints utilisent leur propre CRON_SECRET — pas de JWT
    const isCronRoute = pathname.startsWith('/api/cron/');

    // Préfixes publics : les routes à segment dynamique ne peuvent pas être
    // listées ci-dessus, qui compare le chemin exact.
    //
    // `/api/legal/cgvu/` est public par exigence explicite du §12 : les CGVU
    // « restent accessibles après la résiliation, la fermeture ou la
    // suppression du compte ». Les faire dépendre d'une session viderait de
    // son sens le permalien envoyé par email après souscription.
    const isPublicPrefix =
      pathname.startsWith('/api/referral/validate/') ||
      pathname.startsWith('/api/legal/cgvu/');

    if (publicRoutes.includes(pathname) || isPublicPrefix || isCronRoute) {
      // Rate limiting sur les endpoints d'authentification (anti brute-force)
      const authRateLimitedRoutes = [
        '/api/auth/login',
        '/api/auth/forgot-password',
        '/api/auth/reset-password',
        '/api/auth/resend-verification',
      ];

      if (authRateLimitedRoutes.includes(pathname) && request.method === 'POST' && process.env.NODE_ENV !== 'development') {
        const ip = getClientIp(request.headers);
        const rl = checkEdgeRateLimit(ip);

        if (!rl.allowed) {
          return NextResponse.json(
            {
              error: 'Too Many Requests',
              code: 'RATE_LIMIT_EXCEEDED',
              message: `Trop de tentatives. Réessayez dans ${rl.retryAfterSeconds} secondes.`,
            },
            {
              status: 429,
              headers: {
                'Retry-After': String(rl.retryAfterSeconds),
                'X-RateLimit-Limit': String(rl.limit),
                'X-RateLimit-Remaining': '0',
              },
            }
          );
        }

        const response = NextResponse.next();
        response.headers.set('X-RateLimit-Limit', String(rl.limit));
        response.headers.set('X-RateLimit-Remaining', String(rl.remaining));
        return response;
      }

      return NextResponse.next();
    }

    // Extract token from cookies or Authorization header
    const authHeader = request.headers.get('authorization');
    const cookieHeader = request.headers.get('cookie');
    const token = extractToken(authHeader, cookieHeader);

    // No token → 401
    if (!token) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'MISSING_TOKEN',
          message: 'Authentication required',
        },
        { status: 401 }
      );
    }

    // Verify token
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        },
        { status: 401 }
      );
    }

      // Check if account is suspended or deleted
      if (payload.status === 'SUSPENDED' || payload.status === 'DELETED') {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'ACCOUNT_SUSPENDED',
            message: 'Account is suspended or deleted',
          },
          { status: 403 }
        );
      }

      // § 3.3 : Utilisateur authentifié SANS compte actif
      // → Bloquer accès aux routes applicatives (sauf /api/billing/me, /api/users/me, /api/billing/create-*)
      if (payload.hasActiveAccount === false && payload.role !== 'ADMIN') {
        const allowedRoutesWithoutAccount = [
          '/api/billing/me',
          '/api/users/me',
          '/api/billing/create-checkout-session',
          '/api/billing/create-customer-portal-session',
          '/api/accounts',
          '/api/account',
          '/api/assets',
          '/api/agenda',
        ];

        const isAllowed = allowedRoutesWithoutAccount.some(route => pathname.startsWith(route));
        
        if (!isAllowed) {
          return NextResponse.json(
            {
              error: 'Forbidden',
              code: 'NO_ACTIVE_ACCOUNT',
              message: 'Vous devez créer un compte pour accéder à cette ressource. Rendez-vous sur /abonnement',
            },
            { status: 403 }
          );
        }
      }

      // Note: le contrôle de rôle ADMIN pour /api/admin/* est délégué aux route handlers
      // via SessionService.requireAdmin (qui inclut un fallback DB pour les tokens stales).
      // Le middleware ne peut pas faire de lookup DB (Edge Runtime).

      return NextResponse.next();
  }

  return NextResponse.next();
}

// Configure which routes to run middleware on
export const config = {
  matcher: [
    '/api/:path*',
    '/accueil/:path*',
    '/assets/:path*',
    '/agenda/:path*',
    '/documents/:path*',
    '/dashboard/:path*',
    '/mon-compte/:path*',
    '/abonnement/:path*',
  ],
};