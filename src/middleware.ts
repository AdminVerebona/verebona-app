import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyAccessToken, extractToken } from '@/lib/jwt';
import { verifyRequestOrigin, CSRF_REJECTED_MESSAGE } from '@/lib/csrf';
import {
  ACCOUNT_PENDING_DELETION_CODE,
  ACCOUNT_PENDING_DELETION_MESSAGE,
  PENDING_DELETION_PAGE,
  isApiAllowedWhilePendingDeletion,
  isPageAllowedWhilePendingDeletion,
  isPendingDeletion,
} from '@/lib/auth/account-closure';

// Lot 37 (C4) : plus aucun limiteur en mémoire ici. Le limiteur des parcours
// d'authentification (connexion, mot de passe oublié, réinitialisation,
// renvoi de vérification) est PARTAGÉ en base et appliqué par les routes
// elles-mêmes (`lib/auth/auth-rate-limit.ts`) : le middleware Edge n'a pas
// accès à PostgreSQL, et un `Map` par processus multipliait le plafond par le
// nombre d'instances.

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
    '/fournisseurs',
    PENDING_DELETION_PAGE,
  ].some((route) => pathname === route || pathname.startsWith(route + '/'));

  if (isProtectedUI) {
    const authHeader = request.headers.get('authorization');
    const cookieHeader = request.headers.get('cookie');
    const token = extractToken(authHeader, cookieHeader);
    // Jeton d'ACCÈS uniquement (lot 37, C1).
    const payload = token ? await verifyAccessToken(token) : null;

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

    // Compte clôturé, suppression à J+30 (`lib/auth/account-closure`) : la
    // seule page servie est « Compte en cours de suppression » (annuler,
    // exporter). Toute autre page protégée y renvoie.
    if (isPendingDeletion(payload.status) && !isPageAllowedWhilePendingDeletion(pathname)) {
      return NextResponse.redirect(new URL(PENDING_DELETION_PAGE, request.url));
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
        host: request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
        proto: request.headers.get('x-forwarded-proto'),
      });
      return NextResponse.json(
        { error: 'Origine non autorisee', code: 'CSRF_ORIGIN_REJECTED', message: CSRF_REJECTED_MESSAGE },
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
      '/api/health/live',  // vitalité, sans E/S (APP-PERF-37)
      '/api/health/ready', // disponibilité critique (APP-PERF-37)
      '/api/users', // Public pour signup
      '/api/billing/stripe-webhook', // Stripe signe ses propres requêtes — pas de JWT
      '/api/webhooks/resend', // Lot 57A : Resend signe ses requêtes (Svix, RESEND_WEBHOOK_SECRET) — pas de JWT
      '/api/billing/catalog', // Catalogue public des offres (lecture, sans cookie) — app et vitrine
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

    // Verify token — jeton d'ACCÈS uniquement (lot 37, C1) : un jeton de
    // renouvellement présenté en Bearer ou en cookie `access_token` est refusé.
    const payload = await verifyAccessToken(token);
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

      // Compte clôturé en attente de suppression : seules l'annulation,
      // l'export RGPD et la lecture de l'identité restent possibles. Défense
      // en profondeur dans `SessionService.getSession`.
      if (isPendingDeletion(payload.status) && !isApiAllowedWhilePendingDeletion(pathname, request.method)) {
        return NextResponse.json(
          { error: 'Forbidden', code: ACCOUNT_PENDING_DELETION_CODE, message: ACCOUNT_PENDING_DELETION_MESSAGE },
          { status: 403 },
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
    '/fournisseurs/:path*',
    '/compte-en-suppression/:path*',
  ],
};