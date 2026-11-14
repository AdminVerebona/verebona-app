/**
 * E-mail de sécurité « appareils déconnectés par précaution » — lot 38,
 * volet B (suite du lot 37, C2 ; CDC 18 §19.3). Constantes et règles PURES,
 * partagées par le service d'envoi et l'aperçu du BO (Communications).
 */

/**
 * Date et heure de l'incident, en clair, fuseau Europe/Paris
 * (« 11 octobre 2026 à 18 h 05 »). Aucune autre donnée de contexte : ni IP,
 * ni appareil, ni localisation.
 */
export function formatSecurityIncidentDate(at: Date): string {
  const jour = at.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  const heure = at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).replace(':', ' h ');
  return `${jour} à ${heure}`;
}

/**
 * Carte #774 — codes des gabarits dédiés « Clé d'accès ajoutée » et
 * « Application d'authentification activée » (table `email_templates`,
 * migration 1698 ; corps : `lib/email/security-notification-templates.ts`).
 */
export const PASSKEY_ADDED_TEMPLATE_CODE = 'notif_mfa_passkey_added';
export const TOTP_ENABLED_TEMPLATE_CODE = 'notif_mfa_totp_enabled';

/**
 * Carte #774 — date et heure RÉELLES d'un événement de sécurité pour la
 * variable `{{eventWhen}}` : « le 13 novembre 2026 à 17 h 06 (heure de
 * Paris) ». Fuseau Europe/Paris (heure d'été / d'hiver gérées par `Intl`), à
 * partir de l'horodatage UTC de l'événement — jamais la date d'envoi.
 * Horodatage absent ou invalide : « récemment » (aucune date inventée).
 */
export function formatSecurityEventWhen(at: unknown): string {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return 'récemment';
  return `le ${formatSecurityIncidentDate(new Date(at))} (heure de Paris)`;
}
