/**
 * Lien d'invitation au parrainage — lot 34I (lien /r/<code>), lot 112B.
 *
 * Lot 112B (décision PO) : l'invitation de parrainage PAR E-MAIL est
 * supprimée (route `POST /api/referral/send-email`, gabarit
 * `REFERRAL_INVITATION`, table `referral_email_sends`, migration 1405). Le
 * parrain partage son code ou son lien depuis Mon compte › Parrainage
 * (« Partager mon invitation », copie, e-mail préparé côté client en repli —
 * `ReferralBlock.tsx`, lot 111H). Ce module ne garde que la construction du
 * lien et la destination de `/r/<code>`.
 */

/** Origine de l'application (liens de parrainage, liens des e-mails). */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Lien de parrainage partagé : `<app>/r/<CODE>`.
 *
 * Seule source de ce format — Mon compte › Parrainage (`/api/referral/me`) et
 * la route `src/app/r/[code]/route.ts` qui le reçoit doivent concorder.
 */
export function buildReferralUrl(code: string, base: string = appBaseUrl()): string {
  return `${base.replace(/\/+$/, '')}/r/${encodeURIComponent(code)}`;
}

/**
 * Destination d'un lien de parrainage `/r/<code>` (CDC parrainage §4.1-§4.4) :
 *   - code connu et actif → inscription avec le code propagé par `?ref=`
 *     (le formulaire l'affiche et le transmet à `POST /api/users`, qui
 *     mémorise l'attribution, `referral-attribution.service`) ;
 *   - code inconnu, inactif ou mal formé → inscription sans code, sans erreur.
 *
 * Aucun cookie : le CDC §4.2 interdit toute conservation persistante du code ;
 * il ne circule que par l'URL et l'état mémoire du parcours (§4.3).
 */
export function referralRedirectPath(code: string | null, touch?: string | null): string {
  if (!code) return '/signup';
  // Lot 102D : `rt` atteste l'instant d'usage du lien (fenêtre de 90 jours).
  return `/signup?ref=${encodeURIComponent(code)}${touch ? `&rt=${encodeURIComponent(touch)}` : ''}`;
}
