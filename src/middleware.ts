import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken, extractToken } from '@/lib/jwt';
import { verifyRequestOrigin } from '@/lib/csrf';

// ─── Rate limiting in-memory pour le middleware Edge ────────────────────────
// Sliding window : 5 tentatives / 15 minutes / IP
// Note : le store est réinitialisé à chaque cold-start Edge ; acceptable pour
// un déploiement single-region. Pour multi-instance, utiliser Upstash Redis.
const AUTH_MAX = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const authStore = new Map<string, number[]>();

function checkEdgeRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number; remaining: number; limit: number } {
  const now = Date.now();
  const timestamps = (authStore.get(key) ?? []).filter((ts) => now - ts < AUTH_WINDOW_MS);

  if (timestamps.length >= AUTH_MAX) {
    const retryAfterSeconds = Math.ceil((AUTH_WINDOW_MS - (now - timestamps[0])) / 1000);
    authStore.set(key, timestamps);
    return { allowed: false, retryAfterSeconds, remaining: 0, limit: AUTH_MAX };
  }

  timestamps.push(now);
  authStore.set(key, timestamps);
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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE FICHIER N'ÉTAIT JAMAIS EXÉCUTÉ
 *
 * Il se trouvait à la racine du dépôt alors que l'application utilise
 * `src/app`. Next.js ne cherche le middleware qu'au niveau du dossier qui
 * contient `app/` (ici `src/`, comme `src/instrumentation.ts`) : à la
 * racine, il était ignoré sans avertissement. Rien de ce qui suit — contrôle
 * JWT des routes /api/*, protection CSRF (dont dépend explicitement
 * `/api/withdrawal/confirm`), limitation de débit des routes d'auth — n'était
 * actif ; seules les gardes des route handlers protégeaient l'API.
 *
 * En l'activant (déplacement dans `src/`), trois règles jamais éprouvées ont
 * été corrigées pour ne rien casser :
 *   1. routes publiques manquantes : flux ICS par jeton (`/api/calendar/`,
 *      appelé par les agendas externes, sans cookie), transmission d'un bien
 *      (`/api/transmission/`, destinataire sans compte), manifeste PWA
 *      (chargé sans cookie par le navigateur), clé publique Web Push,
 *      purge planifiée `/api/purge-pending-uploads` (CRON_SECRET) ;
 *   2. le blocage « pas de compte actif » (403 NO_ACTIVE_ACCOUNT, redirection
 *      vers l'onboarding) est RETIRÉ : il aurait interdit le mode restreint
 *      (essai échu, offre résiliée), où la consultation et l'export doivent
 *      rester possibles (entitlements.service). Les droits d'écriture sont
 *      décidés par les route handlers (`write-access-guard`,
 *      `entitlements.service`), qui lisent l'état réel en base — le jeton,
 *      lui, peut être périmé ;
 *   3. pages protégées : sans jeton d'accès mais avec un jeton de
 *      renouvellement, la page est servie — le cookie d'accès ne vit que
 *      15 min, et le client renouvelle la session (api-client) au lieu
 *      d'être renvoyé à la connexion. Les fichiers statiques (`/assets/…`
 *      de `public/`) ne sont jamais interceptés.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Fichiers statiques de `public/` (ex. `/assets/verebona/…/md.webp`) :
  // jamais soumis à la session. Un identifiant de bien n'a pas d'extension.
  const isStaticFile = /\/[^/]+\.[a-z0-9]+$/i.test(pathname) && !pathname.startsWith('/api/');

  // ===== PROTECTION DES ROUTES UI / ABONNEMENT =====
  const isProtectedUI = !isStaticFile && [
    '/accueil',
    '/assets',
    '/agenda',
    '/documents',
    '/dashboard',
    '/mon-compte',
  ].some((route) => pathname === route || pathname.startsWith(route + '/'));

  if (isProtectedUI) {
    const authHeader = request.headers.get('authorization');
    const cookieHeader = request.headers.get('cookie');
    const token = extractToken(authHeader, cookieHeader);
    const payload = token ? await verifyToken(token) : null;

    if (!payload) {
      // Jeton d'accès absent ou expiré, mais session renouvelable : la page
      // est servie, le client renouvelle (POST /api/auth/refresh) au premier
      // appel d'API. Sans cela, toute navigation après 15 min d'inactivité
      // renverrait à la connexion alors que la session est valide.
      if (request.cookies.get('refresh_token')?.value) {
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

    // Pas de redirection « sans compte actif » vers l'onboarding : voir
    // l'en-tête (mode restreint). L'orientation est faite par l'interface.
    return NextResponse.next();
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
      '/api/manifest', // Manifeste PWA : chargé par le navigateur SANS cookie
      '/api/push/public-key', // Clé publique VAPID : publique par nature
      '/api/purge-pending-uploads', // Tâche planifiée, protégée par CRON_SECRET
      // Invitation Premium Duo : GET vérifie le lien pour un invité pas encore
      // inscrit (« public endpoint » par conception). POST exige toujours une
      // session — contrôlée par la route (`SessionService.getSession`).
      '/api/duo/join',
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
      pathname.startsWith('/api/legal/cgvu/') ||
      // CDC rétractation §6.1 : « la page doit être accessible sans
      // authentification ». Un consommateur qui ne parvient plus à se
      // connecter doit pouvoir exercer son droit — subordonner la
      // rétractation à une session la rendrait inaccessible à ceux qui en ont
      // le plus besoin.
      pathname.startsWith('/api/withdrawal/public/') ||
      // CDC Centre d'aide FEEDBACK-01 : « Oui/Non fonctionne sans
      // authentification ». Débit limité dans la route elle-même.
      pathname.startsWith('/api/public/help-feedback') ||
      // Abonnement ICS d'un agenda externe (Google, Apple…) : aucune session,
      // l'accès repose sur le jeton secret du compte, vérifié par la route.
      pathname.startsWith('/api/calendar/') ||
      // Transmission d'un bien : GET « public, sans auth » par conception ;
      // POST sans session renvoie `requiresSignup` au destinataire sans
      // compte. La route lit la session si elle existe.
      pathname.startsWith('/api/transmission/');

    if (publicRoutes.includes(pathname) || isPublicPrefix || isCronRoute) {
      // Rate limiting sur les endpoints d'authentification (anti brute-force)
      // `/api/auth/login` n'est PAS limité ici : sa route applique déjà la
      // même limite (5 / 15 min / IP) et la remet à zéro après une connexion
      // réussie. Compter aussi ici — sans remise à zéro — bloquerait des
      // utilisateurs légitimes partageant une IP (foyer, bureau) après
      // quelques connexions réussies.
      const authRateLimitedRoutes = [
        '/api/auth/forgot-password',
        '/api/auth/reset-password',
        '/api/auth/resend-verification',
      ];

      if (authRateLimitedRoutes.includes(pathname) && request.method === 'POST' && process.env.NODE_ENV !== 'development') {
        const ip = getClientIp(request.headers);
        // Compteur par route : les trois parcours ne partagent pas un même
        // quota (une inscription suivie d'un renvoi d'e-mail ne doit pas
        // épuiser la réinitialisation du mot de passe).
        const rl = checkEdgeRateLimit(`${pathname}:${ip}`);

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

      // § 3.3 « pas de compte actif » : volontairement NON bloqué ici (voir
      // l'en-tête). Ce blocage, jamais actif jusqu'ici, aurait interdit la
      // consultation et l'export en mode restreint, ainsi que /api/auth/me.

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
  ],
};