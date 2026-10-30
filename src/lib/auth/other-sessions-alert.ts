/**
 * Confirmation « Vos autres appareils ont été déconnectés » — lot 100D
 * (décision PO A2 du 27/10/2026 ; CDC 18 §20.3, §22).
 *
 * Appelée par la SEULE route « Déconnecter tous les autres appareils »
 * (`app/api/users/me/sessions/revoke-others`), après la révocation validée,
 * avec le nombre de sessions réellement révoquées par cet appel. Aucun autre
 * appelant (déconnexion d'un appareil, BO, mot de passe, rejeu) : un test
 * le vérifie (`l100d-securite.test.ts`).
 */
import { sessionPublicId } from './session-registry';

/** Issue de la confirmation de sécurité (journalisée, jamais bloquante). */
export type OtherSessionsEmailOutcome = 'queued' | 'none_revoked' | 'error';

/**
 * Lot 100D (A2) : émet la confirmation OTHER_SESSIONS_REVOKED si `count > 0`.
 * File `notification_outbox` (clé unique) : un rejeu de la même demande
 * n'envoie rien de plus. Ne lève jamais : la révocation est déjà validée.
 */
export async function confirmOtherSessionsRevoked(input: {
  userId: number; sid: string | null; count: number; deviceLabel?: string; browserLabel?: string;
}): Promise<OtherSessionsEmailOutcome> {
  if (!(input.count > 0)) return 'none_revoked';
  try {
    const { emit } = await import('@/lib/notifications');
    await emit({
      type: 'OTHER_SESSIONS_REVOKED',
      recipientUserIds: [input.userId],
      entityType: 'user',
      entityId: input.userId,
      payload: {
        at: new Date().toISOString(),
        count: Math.min(input.count, 1000),
        ...(input.deviceLabel ? { deviceLabel: input.deviceLabel.slice(0, 80) } : {}),
        ...(input.browserLabel ? { browserLabel: input.browserLabel.slice(0, 80) } : {}),
      },
      // Une confirmation par demande : la session qui la fait (identifiant public, jamais le `sid`).
      dedupeKey: `security:other-sessions-revoked:${input.userId}:${input.sid ? sessionPublicId(input.sid) : `t${Date.now()}`}`,
    });
    return 'queued';
  } catch (e) {
    console.error('[revoke-others] confirmation de sécurité non émise :', (e as Error)?.message ?? e);
    return 'error';
  }
}
