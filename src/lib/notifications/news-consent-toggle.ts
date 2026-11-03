/**
 * Enregistrement du consentement « Actualités Verebona » depuis Mon compte ›
 * Notifications — lot 107B (recette iOS du 02/11/2026).
 *
 * Règle : AUCUN message de succès (l'interrupteur montre déjà l'état) ; l'état
 * retenu est celui que le serveur a ENREGISTRÉ ; un échec rend une erreur
 * compréhensible et l'appelant revient à l'état précédent (pas de faux
 * succès, aucun consentement implicite).
 */

export const NEWS_CONSENT_SAVE_ERROR = 'Votre choix pour les actualités n’a pas été enregistré. Réessayez.';

export interface SavedNewsConsent { consented: boolean; consentedAt: string | null }

export type NewsConsentSaveResult =
  | { ok: true; consent: SavedNewsConsent | null }
  | { ok: false; error: string };

type Post = (url: string, body: unknown) => Promise<unknown>;

export async function saveNewsConsent(next: boolean, post: Post): Promise<NewsConsentSaveResult> {
  try {
    const res = (await post('/api/notification-preferences/news-consent', {
      consented: next, source: 'mon-compte/notifications',
    })) as { consented?: unknown; consentedAt?: unknown } | null | undefined;
    // État relu de la réponse du serveur ; sans réponse exploitable, `null` :
    // l'appelant relit les préférences plutôt que de supposer l'état demandé.
    const consent = res && typeof res.consented === 'boolean'
      ? { consented: res.consented, consentedAt: typeof res.consentedAt === 'string' ? res.consentedAt : null }
      : null;
    return { ok: true, consent };
  } catch {
    return { ok: false, error: NEWS_CONSENT_SAVE_ERROR };
  }
}
