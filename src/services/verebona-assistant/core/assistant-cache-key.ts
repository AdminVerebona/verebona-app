/**
 * Clé d'idempotence des appels modèle de l'assistant.
 *
 * La passerelle IA met en cache la réponse brute d'un appel
 * (`ai_operation_idempotency.result_json`) : c'est une copie de la
 * conversation. Pour que l'effacement manuel de l'historique (§24.5) puisse
 * la purger, la clé est préfixée par la conversation — `assistant:c{id}:` —
 * au lieu d'être un simple condensé du compte et des variables, impossible à
 * rattacher à un fil.
 *
 * Effet secondaire voulu : le cache ne traverse plus les fils ni les
 * utilisateurs d'un compte Duo.
 */
import { buildIdempotencyKey } from '@/services/ai/idempotency/idempotency.service';

export const assistantCachePrefix = (conversationId: number) => `assistant:c${conversationId}:`;

export function assistantIdempotencyKey(
  input: { accountId: number; conversationId?: number | null },
  operationCode: string,
  variables: Record<string, unknown>,
): string | undefined {
  if (!input.conversationId) return undefined;
  return assistantCachePrefix(input.conversationId)
    + buildIdempotencyKey({ accountId: input.accountId, operationCode, sourceIds: [], variables });
}
