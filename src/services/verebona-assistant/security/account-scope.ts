/**
 * Cloisonnement de compte — CDC §13.2 / §29.1.
 *
 * Point de passage unique pour garantir qu'aucune requête ne franchit la frontière du
 * compte. L'`accountId` provient TOUJOURS de la session serveur (`SessionService`),
 * jamais du corps de requête client (§27.1).
 */

export class AccountScopeError extends Error {
  constructor(msg = 'Accès hors périmètre du compte') { super(msg); this.name = 'AccountScopeError'; }
}

/** Garde-fou : rejette tout accountId venant du client s'il diffère de la session. */
export function assertNoClientAccountOverride(clientAccountId: unknown, sessionAccountId: number): void {
  if (clientAccountId != null && Number(clientAccountId) !== sessionAccountId) {
    throw new AccountScopeError('Tentative de surcharge de compte côté client (§27.1)');
  }
}
