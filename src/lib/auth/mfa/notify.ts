/**
 * E-mails de sécurité MFA et journal d'audit (lot 110B, ticket §1, §7).
 *
 * E-mails OBLIGATOIRES, non désactivables (catalogue `MFA_SECURITY_EVENT`,
 * `securityInformation` : e-mail seul, gabarit `notif_security` éditable au
 * BO › Communications) : clé d'accès ajoutée / retirée ; application
 * d'authentification activée / remplacée / retirée ; codes de récupération
 * régénérés ; code de récupération utilisé. Destinataire : l'utilisateur
 * SEUL (`recipientUserIds: [userId]`) — jamais l'autre membre d'un Duo.
 * Contenu : nature de l'événement, date et heure ; aucun secret, aucun code,
 * aucun nom d'appareil saisi. Jamais bloquant.
 *
 * Carte #774 : « clé d'accès ajoutée » et « application d'authentification
 * activée » emploient chacune un gabarit DÉDIÉ du gabarit transactionnel
 * commun (`notif_mfa_passkey_added`, `notif_mfa_totp_enabled`, migration
 * 1698 ; choix fait par le catalogue). Même événement, même émission, même
 * file : aucun envoi ajouté. `at` est la date de l'ÉVÉNEMENT affichée dans
 * l'e-mail (heure de Paris), jamais la date d'envoi.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { logUserActivity } from '@/lib/audit-logger';

export type MfaSecurityEvent =
  | 'passkey_added' | 'passkey_removed'
  | 'totp_enabled' | 'totp_replaced' | 'totp_removed'
  | 'recovery_regenerated' | 'recovery_used';

export async function notifyMfaEvent(userId: number, event: MfaSecurityEvent): Promise<void> {
  try {
    const { emit } = await import('@/lib/notifications');
    await emit({
      type: 'MFA_SECURITY_EVENT',
      recipientUserIds: [userId],
      entityType: 'user',
      entityId: userId,
      payload: { event, at: new Date().toISOString() },
      dedupeKey: `security:mfa:${userId}:${event}:${randomUUID()}`,
    });
  } catch (e) {
    console.error('[mfa] e-mail de sécurité non émis :', (e as Error)?.message ?? e);
  }
}

/** Journal d'audit (aucune valeur secrète). */
export function auditMfa(
  request: NextRequest | undefined,
  activityType: 'MFA_CHALLENGE_STARTED' | 'MFA_SUCCESS' | 'MFA_FACTOR_ADDED' | 'MFA_FACTOR_REMOVED' | 'MFA_RECOVERY_CODES_REGENERATED' | 'MFA_RECOVERY_USED' | 'MFA_PASSKEY_COUNTER_REGRESSION',
  userId: number,
  details: Record<string, unknown>,
): void {
  void logUserActivity({ activityType, userId, userEmail: '', details, request });
}
