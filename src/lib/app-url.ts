/**
 * URL publique de l'application, pour les liens envoyés à un tiers
 * (retours Stripe Checkout, portail client).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI PAS `new URL(request.url).origin`
 *
 * Derrière le proxy de l'hébergeur, Next reçoit la requête sur son port
 * interne : `request.url` vaut `http://localhost:26057/...`. Stripe
 * renvoyait donc le client, après paiement comme sur « Retour au site »,
 * vers une adresse qui n'existe que dans le conteneur
 * (ERR_CONNECTION_REFUSED).
 *
 * Ordre de résolution :
 *   1. NEXT_PUBLIC_APP_URL — la valeur de référence, déjà utilisée par les
 *      emails et la configuration CORS du stockage ;
 *   2. en-têtes posés par le proxy (X-Forwarded-Host / X-Forwarded-Proto) ;
 *   3. en-tête Host, puis l'URL de la requête (développement local).
 * ══════════════════════════════════════════════════════════════════════════
 */

type HeaderSource = { headers: Headers; url: string };

function clean(url: string): string {
  return url.replace(/\/+$/, '');
}

function firstValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first ? first : null;
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(host);
}

export function getAppBaseUrl(request?: HeaderSource, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return clean(new URL(configured).origin);
    } catch {
      console.error(`[app-url] NEXT_PUBLIC_APP_URL invalide : "${configured}"`);
    }
  }

  if (request) {
    const forwardedHost = firstValue(request.headers.get('x-forwarded-host'));
    const host = forwardedHost ?? firstValue(request.headers.get('host'));
    if (host) {
      const proto =
        firstValue(request.headers.get('x-forwarded-proto')) ??
        (isLocalHost(host) ? 'http' : 'https');
      const resolved = `${proto}://${host}`;
      if (isLocalHost(host) && env.NEXT_PUBLIC_APP_ENV && env.NEXT_PUBLIC_APP_ENV !== 'local') {
        console.warn(
          `[app-url] NEXT_PUBLIC_APP_URL absente : URL publique déduite "${resolved}", ` +
          'probablement interne au conteneur. Renseigner NEXT_PUBLIC_APP_URL.',
        );
      }
      return clean(resolved);
    }
    return clean(new URL(request.url).origin);
  }

  return 'http://localhost:3000';
}
