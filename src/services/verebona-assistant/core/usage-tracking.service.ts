/**
 * Trace des appels modèle de l'assistant — CDC §17.11, §28.8, §32.1, CA-20, CA-28.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `verebona_ai_runs` ÉTAIT VIDE
 *
 * `recordAiRun` n'était appelé nulle part : la table du §28.8 restait vide, et
 * le coût par compte (§31.3) comme le plafond mensuel (§6.6) n'avaient rien à
 * lire. Elle est désormais alimentée par `executeWithinBudget`, SEUL point
 * d'appel modèle de l'assistant (classification, revalidation, génération) :
 * aucune tentative ne peut y échapper.
 *
 * Ce qui est tracé : alias fonctionnel (assistant-default / -escalation,
 * déduit du repli), modèle réellement appelé, prompt maître et consigne de
 * tâche (id + version), versions des catalogues d'intentions et d'actions,
 * version du schéma, empreinte SHA-256 des variables (jamais leur contenu —
 * §28.8 : prompts et extraits non stockés), jetons, coût, latence, statut.
 *
 * Ne lève jamais : une trace impossible n'empêche pas une réponse.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import { INTENT_CATALOG_VERSION } from '../types/intents';
import { ACTION_CATALOG_VERSION } from '../types/actions';
import { RESPONSE_SCHEMA_VERSION } from '../types/contracts';

/** Contexte d'un appel, fourni par l'adaptateur qui le déclenche. */
export interface AiRunContext {
  requestId: string;
  routeReason: string;
  promptId: string;
  promptVersion: string;
}

export interface AiRunRecord extends AiRunContext {
  accountId: number;
  messageId?: number | null;
  operationCode: string;
  resolvedModelId: string | null;
  fallbackUsed: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  latencyMs: number;
  attemptNumber: number;
  status: 'ok' | 'error' | 'timeout' | 'cached';
  errorCode?: string | null;
  promptHash: string | null;
}

/** Empreinte des variables envoyées : prouve ce qui a été envoyé sans le stocker. */
export function hashPromptVariables(vars: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(vars)).digest('hex');
}

/** Alias fonctionnel (§15.11) : l'escalade est la chaîne de repli de la passerelle. */
export function modelAliasFor(fallbackUsed: boolean): string {
  return fallbackUsed ? 'assistant-escalation' : 'assistant-default';
}

export async function recordAiRun(rec: AiRunRecord): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO verebona_ai_runs
         (request_id, account_id, message_id, provider, model_alias, resolved_model_id,
          route_reason, prompt_id, prompt_version, prompt_hash, schema_version,
          intent_catalog_version, action_catalog_version, input_tokens, output_tokens,
          estimated_cost_micros, latency_ms, fallback_used, attempt_number, status, error_code)
       VALUES ($1,$2,$3,'ai-gateway',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        rec.requestId, rec.accountId, rec.messageId ?? null,
        `${modelAliasFor(rec.fallbackUsed)}:${rec.operationCode}`, rec.resolvedModelId,
        String(rec.routeReason ?? '').slice(0, 300), rec.promptId, rec.promptVersion, rec.promptHash, RESPONSE_SCHEMA_VERSION,
        INTENT_CATALOG_VERSION, ACTION_CATALOG_VERSION, rec.inputTokens, rec.outputTokens,
        rec.costMicros, rec.latencyMs, rec.fallbackUsed, rec.attemptNumber, rec.status, rec.errorCode ?? null,
      ] as never[],
    );
  } catch (e) {
    console.error('[verebona] recordAiRun', (e as Error).message);
  }
}
