import type { NextRequest } from 'next/server';

/**
 * Protection CSRF par verification d'origine (CDC §9.1).
 *
 * Le passage a une authentification par cookies expose au CSRF : le
 * navigateur joint automatiquement les cookies a toute requete, y compris
 * celles declenchees depuis un site tiers.
 *
 * Trois barrieres complementaires sont en place :
 *   1. les cookies sont poses en SameSite=Lax — le navigateur ne les envoie
 *      pas sur une requete inter-sites non navigationnelle ;
 *   2. les requetes modifiant des donnees (POST, PUT, PATCH, DELETE) doivent
 *      provenir d'une origine autorisee — c'est le role de ce module ;
 *   3. aucune modification de donnees n'est acceptee via GET.
 *
 * Un jeton CSRF dedie (§9.2) n'est pas necessaire tant que l'application et
 * l'API partagent la meme origine et que SameSite=Lax est conserve. Il
 * deviendrait obligatoire en cas de passage a SameSite=None ou de separation
 * des domaines.
 */

/** Methodes considerees comme modifiant l'etat. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes exemptees de la verification d'origine.
 *
 * Elles sont protegees par un autre mecanisme :
 *   - le webhook Stripe verifie la signature cryptographique de Stripe ;
 *   - les taches planifiees utilisent CRON_SECRET.
 * Aucune ne repose sur un cookie de session, donc aucune n'est vulnerable
 * au CSRF.
 */
const CSRF_EXEMPT_PREFIXES = ['/api/billing/stripe-webhook', '/api/cron/'];

/** Construit la liste des origines autorisees a partir de l'environnement. */
function allowedOrigins(): string[] {
  const origins = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_PUBLIC_SITE_URL,
  ].filter((value): value is string => Boolean(value));

  // En developpement, autoriser les origines locales usuelles.
  if (process.env.NODE_ENV !== 'production') {
    origins.push('http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000');
  }

  return origins.map((origin) => origin.replace(/\/+$/, ''));
}

/** Normalise une URL en origine (schema + hote + port). */
function toOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export interface CsrfVerdict {
  allowed: boolean;
  /** Motif du refus, journalisable sans exposer de secret. */
  reason?: 'MISSING_ORIGIN' | 'FOREIGN_ORIGIN';
  origin?: string | null;
}

/**
 * Verifie qu'une requete modifiant des donnees provient d'une origine connue.
 *
 * L'en-tete `Origin` est privilegie ; `Referer` sert de repli, certains
 * navigateurs ne transmettant pas `Origin` sur des requetes de meme site.
 */
export function verifyRequestOrigin(request: NextRequest): CsrfVerdict {
  const { pathname } = request.nextUrl;

  // Lectures et routes exemptees : rien a verifier.
  if (!MUTATING_METHODS.has(request.method)) return { allowed: true };
  if (CSRF_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return { allowed: true };
  }

  const origin = toOrigin(request.headers.get('origin')) ?? toOrigin(request.headers.get('referer'));

  // Ni Origin ni Referer : requete anormale pour un navigateur moderne.
  if (!origin) {
    return { allowed: false, reason: 'MISSING_ORIGIN', origin: null };
  }

  const permitted = new Set([...allowedOrigins(), request.nextUrl.origin]);
  if (!permitted.has(origin)) {
    return { allowed: false, reason: 'FOREIGN_ORIGIN', origin };
  }

  return { allowed: true, origin };
}
