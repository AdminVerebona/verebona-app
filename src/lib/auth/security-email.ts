/**
 * E-mail de sécurité « appareils déconnectés par précaution » — lot 38,
 * volet B (suite du lot 37, C2 ; CDC 18 §19.3). Constantes et règles PURES,
 * partagées par le service d'envoi et l'aperçu du BO (Communications).
 */

/** Gabarit `email_templates` (migration 0314, modifiable dans le BO). */
export const SESSIONS_REVOKED_TEMPLATE = 'SECURITY_SESSIONS_REVOKED';

/** Au plus un e-mail par utilisateur et par heure (anti-spam). */
export const SESSIONS_REVOKED_EMAIL_INTERVAL_MS = 60 * 60 * 1000;

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

/** Variables du gabarit — liste FERMÉE : rien d'autre ne part dans l'e-mail. */
export function sessionsRevokedEmailVariables(p: { firstName: string | null; at: Date; appUrl: string }): Record<string, string> {
  const base = p.appUrl.replace(/\/$/, '');
  return {
    firstName: p.firstName?.trim() || '',
    incidentDate: formatSecurityIncidentDate(p.at),
    loginUrl: `${base}/login`,
    forgotPasswordUrl: `${base}/forgot-password`,
  };
}
