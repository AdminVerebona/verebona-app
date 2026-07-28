/**
 * Synchronisation du référentiel code → base — CDC §5.1.
 *
 * La source de vérité reste le code (versionné en Git, relu en revue). La base
 * en est une projection, destinée à l'administration et aux jointures SQL avec
 * les tables de suivi. La synchronisation est idempotente et s'exécute au
 * démarrage.
 */
import { pgClient } from '@/db';
import { AI_USE_CASES } from './use-cases';
import { AI_OPERATIONS } from './operations';

let _synced = false;

export async function syncAiRegistry(): Promise<void> {
  if (_synced) return;
  _synced = true;

  try {
    for (const uc of Object.values(AI_USE_CASES)) {
      await pgClient.unsafe(
        `INSERT INTO ai_use_cases (code, label, purpose, replaces_legacy_usages, active)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (code) DO UPDATE SET
           label = EXCLUDED.label, purpose = EXCLUDED.purpose,
           replaces_legacy_usages = EXCLUDED.replaces_legacy_usages,
           active = EXCLUDED.active, updated_at = NOW()`,
        [uc.code, uc.label, uc.purpose, JSON.stringify(uc.replacesLegacyUsages), uc.active] as never[],
      );
    }

    for (const op of Object.values(AI_OPERATIONS)) {
      await pgClient.unsafe(
        `INSERT INTO ai_operations (
           operation_code, use_case_code, label, provider, primary_model,
           fallback_models, prompt_code, timeout_ms, output_schema, active, billable
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
         ON CONFLICT (operation_code) DO UPDATE SET
           use_case_code = EXCLUDED.use_case_code, label = EXCLUDED.label,
           provider = EXCLUDED.provider, primary_model = EXCLUDED.primary_model,
           fallback_models = EXCLUDED.fallback_models, prompt_code = EXCLUDED.prompt_code,
           timeout_ms = EXCLUDED.timeout_ms, output_schema = EXCLUDED.output_schema,
           active = EXCLUDED.active, billable = EXCLUDED.billable, updated_at = NOW()`,
        [
          op.operationCode, op.useCaseCode, op.label, op.provider, op.primaryModel,
          JSON.stringify(op.fallbackModels), op.promptCode ?? null, op.timeoutMs,
          op.outputSchema, op.active, op.billable,
        ] as never[],
      );
    }

    // Désactive en base toute opération disparue du code (jamais supprimée :
    // les traces historiques y font référence).
    const codes = Object.keys(AI_OPERATIONS);
    await pgClient.unsafe(
      `UPDATE ai_operations SET active = FALSE, updated_at = NOW()
        WHERE operation_code <> ALL($1::text[]) AND active = TRUE`,
      [codes] as never[],
    );
  } catch (e) {
    _synced = false;
    console.error('[ai-registry] synchronisation impossible :', (e as Error).message);
  }
}
