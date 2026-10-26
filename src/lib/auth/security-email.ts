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
