/**
 * Suivi d'usage IA — CDC §28.8 / §32.1.
 *
 * Trace chaque appel IA (alias, modèle résolu, tokens, coût estimé, latence, fallback)
 * dans `verebona_ai_runs`, et chaque demande dans `verebona_request_runs`. Alimente les
 * tableaux de bord (réutiliser l'admin IA existant) et les alertes de coût (§31.3).
 */
import { pgClient } from '@/db';
import { estimateCostMicros } from '../registries/pricing-catalog';

export interface AiRunRecord {
  requestId: string;
  accountId: number;
  messageId?: string | null;
  modelAlias: string;
  resolvedModelId: string;
  routeReason: string;
  promptId: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  fallbackUsed: boolean;
  attemptNumber: number;
  status: 'ok' | 'error' | 'timeout';
  errorCode?: string | null;
}

export async function recordAiRun(rec: AiRunRecord): Promise<void> {
  // `estimateCostMicros` rend `null` quand aucun tarif n'est connu — la
  // colonne est nullable, et `null` y signifie « coût inconnu », ce que `0`
  // ne dirait pas. Un appel sans tarif n'est pas un appel gratuit.
  const cost = estimateCostMicros(rec.resolvedModelId, rec.inputTokens, rec.outputTokens);

  if (cost === null) {
    // Signalé, car un tarif manquant se répare : il suffit d'ajouter le
    // modèle à la grille. Sans ce message, la colonne se remplirait de
    // `null` sans que personne ne sache pourquoi.
    console.warn(
      `[verebona] coût non estimable pour ${rec.resolvedModelId} : ` +
      'modèle absent de la grille tarifaire et des valeurs de secours.',
    );
  }
  await pgClient.unsafe(
    `INSERT INTO verebona_ai_runs
       (request_id, account_id, message_id, provider, model_alias, resolved_model_id,
        route_reason, prompt_id, prompt_version, input_tokens, output_tokens,
        estimated_cost_micros, latency_ms, fallback_used, attempt_number, status, error_code, schema_version)
     VALUES ($1,$2,$3,'google-genai',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'assistant-response-v1.0')`,
    [
      rec.requestId, rec.accountId, rec.messageId ?? null, rec.modelAlias, rec.resolvedModelId,
      rec.routeReason, rec.promptId, rec.promptVersion, rec.inputTokens, rec.outputTokens,
      cost, rec.latencyMs, rec.fallbackUsed, rec.attemptNumber, rec.status, rec.errorCode ?? null,
    ],
  ).catch((e) => console.error('[verebona] recordAiRun', (e as Error).message));
}
