import { createHash } from 'node:crypto';

/**
 * Empreinte du dernier jeton d'invitation Duo consommé (lot 57A,
 * `duo_accounts.last_used_invite_token_hash`, 0405) : permet de dire
 * « invitation déjà utilisée » sans conserver le jeton. Serveur uniquement.
 */
export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(`duo-invite:${token}`).digest('hex');
}
