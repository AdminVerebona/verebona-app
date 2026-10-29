/**
 * Forme du retour Google / Apple vers l'application — lot 95 (PO M1).
 *
 * Module PUR partagé par le serveur (`GET /api/mobile/config`, bloc `auth`) et
 * l'app : `APP_OAUTH_RETURN_URL` (lot 93) est soit une adresse https (lien
 * d'app vérifié — iOS 17.4+ pour la session d'authentification d'Apple), soit
 * un schéma privé RFC 8252 (`fr.verebona.app.preprod:/oauth`). Une seule
 * valeur par environnement : l'app attend la forme annoncée par le serveur.
 */
export type AppOAuthReturnKind = 'https' | 'scheme' | null;

export function appOAuthReturnKind(url: string | null | undefined): AppOAuthReturnKind {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return 'https';
    return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && u.protocol !== 'http:' ? 'scheme' : null;
  } catch {
    return null;
  }
}
