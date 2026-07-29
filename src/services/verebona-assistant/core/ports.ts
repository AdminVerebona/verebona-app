/**
 * Fabrique des ports de l'orchestrateur — CDC §25.5.
 *
 * Assemble les implémentations concrètes (retrieval, sources, actions, persistance)
 * et les injecte dans `runAssistant`.
 *
 * La génération est désormais branchée (`generation.adapter.ts`), via la
 * gateway et non un client fournisseur direct. Elle reste inactive tant que
 * `AI_INTELLIGENT_ASSISTANT` vaut `legacy`.
 */
import type { OrchestratorPorts } from './assistant-orchestrator.service';
import type { IntentRoute, AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import { retrieve } from './retrieval.service';
import { resolveSourcesForDisplay } from './source-resolver.service';
import { resolveActions, type AccessChecker } from './action-resolver.service';
import { persistResult } from './conversation.service';
import { pgClient } from '@/db';
import { buildGenerationPort } from './generation.adapter';
import { buildClassificationPort } from './classification.adapter';

/** Vérificateurs d'accès câblés sur les tables réelles du repo (§22.7). */
function buildAccessChecker(): AccessChecker {
  const exists = async (sql: string, params: unknown[]): Promise<boolean> => {
    const rows = await pgClient.unsafe(sql, params as never[]);
    return (rows as unknown[]).length > 0;
  };
  return {
    assetInAccount: (a, id) =>
      exists(`SELECT 1 FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`, [id, a]),
    documentInAccount: (a, id) =>
      exists(`SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`, [id, a]),
    agendaItemInAccount: (a, id) =>
      exists(`SELECT 1 FROM agenda_items WHERE id = $1 AND account_id = $2 LIMIT 1`, [id, a]),
    supplierInAccount: (a, id) =>
      exists(`SELECT 1 FROM suppliers WHERE id = $1 AND account_id = $2 LIMIT 1`, [id, a]),
    helpEntryPublished: (slug) =>
      exists(`SELECT 1 FROM verebona_help_entries WHERE slug = $1 AND status = 'published' LIMIT 1`, [slug]),
  };
}

export function buildOrchestratorPorts(): OrchestratorPorts {
  const access = buildAccessChecker();

  return {
    retrieve: (route: IntentRoute, input: AssistantRequestInput) => retrieve(route, input),

    resolveSources: async (sources: RetrievedSource[]) => resolveSourcesForDisplay(sources),

    // ── Génération (usage 3) ─────────────────────────────────────────────
    // Branchée, mais gouvernée par AI_INTELLIGENT_ASSISTANT : le port reste
    // `undefined` tant que le drapeau vaut `legacy`, et l'orchestrateur
    // n'entre alors jamais dans l'état GENERATING.
    //
    // Rester `undefined` est essentiel : l'orchestrateur teste la PRÉSENCE du
    // port pour décider d'appeler un modèle. Une fonction inerte lui ferait
    // traverser l'état pour rien.
    classifyWithAI: buildClassificationPort(),
    generateWithAI: buildGenerationPort(),

    resolveActions: (route, input, entityIds) =>
      resolveActions({
        accountId: input.accountId,
        intent: route.intent,
        // En Phase 1-2, les actions proviennent des règles déterministes ; en Phase 3,
        // elles viendront des actionIntents validés du modèle.
        actionIntents: route.allowedActionTypes.slice(0, 1).map((type) => ({ type })),
        access,
      }).then((actions) => actions.filter((a) => a.href !== null || !a.type.startsWith('OPEN_'))),

    persist: (result, input) => persistResult(result, input),

    hasPendingClarification: async (accountId: number) => {
      const rows = await pgClient.unsafe(
        `SELECT 1 FROM verebona_conversations
          WHERE account_id = $1 AND status = 'active'
            AND clarification_state_json IS NOT NULL LIMIT 1`,
        [accountId],
      );
      return (rows as unknown[]).length > 0;
    },
  };
}
