/**
 * Cloisonnement de compte — CDC §13.2 / §29.1.
 *
 * Point de passage unique pour garantir qu'aucune requête ne franchit la frontière du
 * compte. L'`accountId` provient TOUJOURS de la session serveur (`SessionService`),
 * jamais du corps de requête client (§27.1).
 */
import type { SessionPayload } from '@/lib/session-service';

export class AccountScopeError extends Error {
  constructor(msg = 'Accès hors périmètre du compte') { super(msg); this.name = 'AccountScopeError'; }
}

/** Résout l'accountId de confiance ; lève si absent (§13.2). */
export function requireAccountId(session: SessionPayload): number {
  if (!session.currentAccountId) throw new AccountScopeError('Aucun compte actif en session');
  return session.currentAccountId;
}

/** Garde-fou : rejette tout accountId venant du client s'il diffère de la session. */
export function assertNoClientAccountOverride(clientAccountId: unknown, sessionAccountId: number): void {
  if (clientAccountId != null && Number(clientAccountId) !== sessionAccountId) {
    throw new AccountScopeError('Tentative de surcharge de compte côté client (§27.1)');
  }
}
