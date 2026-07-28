/**
 * Garde de cloisonnement — CDC Assistant §4.3.3, non-régression §11.4.
 *
 * « Les données d'un compte ne sont jamais incluses dans un autre. »
 *
 * C'est le risque le plus coûteux du chantier : une fuite inter-comptes n'est
 * pas une gêne fonctionnelle, c'est un incident. La garde est donc doublée —
 * filtre SQL dans chaque outil, et contrôle du résultat avant retour.
 */
import type { ToolContext, ToolResult, SourceRef } from './tool.port';

export class AccountScopeViolation extends Error {
  constructor(toolName: string, detail: string) {
    super(`[cloisonnement] ${toolName} : ${detail}`);
    this.name = 'AccountScopeViolation';
  }
}

export function assertValidContext(toolName: string, ctx: ToolContext): void {
  if (!Number.isInteger(ctx.accountId) || ctx.accountId <= 0) {
    throw new AccountScopeViolation(toolName, `accountId invalide (${ctx.accountId})`);
  }
  if (!Number.isInteger(ctx.maxResults) || ctx.maxResults <= 0) {
    throw new AccountScopeViolation(toolName, 'maxResults doit être un entier positif');
  }
}

/**
 * Contrôle de second niveau : vérifie que chaque ligne renvoyée porte bien
 * l'identifiant de compte attendu. Une requête mal filtrée est arrêtée avant
 * que les données ne quittent le serveur, plutôt que découverte par un
 * utilisateur.
 */
export function assertRowsInScope<T extends { accountId?: number | null }>(
  toolName: string,
  rows: T[],
  ctx: ToolContext,
): T[] {
  for (const row of rows) {
    if (row.accountId !== undefined && row.accountId !== null && row.accountId !== ctx.accountId) {
      throw new AccountScopeViolation(
        toolName,
        `ligne du compte ${row.accountId} alors que le contexte est ${ctx.accountId}`,
      );
    }
  }
  return rows;
}

export function buildResult<T>(data: T, sources: SourceRef[], truncated = false): ToolResult<T> {
  return { data, sources, truncated };
}
