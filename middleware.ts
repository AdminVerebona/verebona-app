import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken, extractToken } from './src/lib/jwt';

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
    // 🔍 LOG: Vérifier si Authorization header est envoyé
    console.log('[MW] API request', {
      pathname,
      authorization: request.headers.get('authorization')?.slice(0, 30) ?? null,
      hasCookie: !!request.cookies.get('access_token'),
    });

    // Routes publiques (pas besoin de JWT)
    const publicRoutes = [
      '/api/auth/login',
      '/api/auth/refresh',
      '/api/auth/logout',
      '/api/health',
      '/api/users', // Public pour signup
      '/api/billing/stripe-webhook', // Stripe signe ses propres requêtes — pas de JWT
      '/api/referral/validate', // Validation publique du code parrainage
    ];

    // Cron endpoints utilisent leur propre CRON_SECRET — pas de JWT
    const isCronRoute = pathname.startsWith('/api/cron/');

    if (publicRoutes.includes(pathname) || pathname.startsWith('/api/referral/validate/') || isCronRoute) {
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