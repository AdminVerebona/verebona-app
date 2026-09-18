/**
 * Fabrique des ports de l'orchestrateur — CDC §25.5.
 *
 * Assemble les implémentations concrètes (retrieval, sources, actions, persistance)
 * et les injecte dans `runAssistant`.
 *
 * La génération est branchée (`generation.adapter.ts`), via la gateway et non un
 * client fournisseur direct. Elle reste inactive tant que
 * `AI_INTELLIGENT_ASSISTANT` vaut `legacy`.
 *
 * ── CE QUI A CHANGÉ, ET POURQUOI ─────────────────────────────────────────
 * Le port `resolveActions` recevait les entités trouvées et ne s'en servait
 * pas : il fabriquait une unique intention d'action sans cible, à partir du
 * premier type autorisé par l'intention. Or les actions d'ouverture exigent une
 * cible ; sans elle le contrôle d'accès refusait, et l'action disparaissait.
 * Résultat observable : après une recherche aboutie, l'assistant n'a jamais
 * proposé « Ouvrir le bien » ni « Ouvrir le document », alors que c'est le
 * premier service attendu du §22.
 *
 * Les intentions d'action sont désormais dérivées des sources réellement
 * récupérées, dans leur ordre de pertinence.
 */
import type { OrchestratorPorts } from './assistant-orchestrator.service';
import type { IntentRoute, AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import type { ActionIntent } from '../types/actions';
import { retrieve } from './retrieval.service';
import { resolveSourcesForDisplay } from './source-resolver.service';
import { resolveActions, exigeUneCible, type AccessChecker } from './action-resolver.service';
import { parseEntityRef } from './entity-ref';
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
    // Les identifiants sont des entiers : le préfixe (« asset_42 ») est retiré
    // en amont par `parseEntityRef`. Le passer tel quel faisait échouer la
    // requête sur une colonne entière, donc refuser toutes les actions.
    assetInAccount: (a, id) =>
      exists(`SELECT 1 FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`, [id, a]),
    documentInAccount: (a, id) =>
      exists(`SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`, [id, a]),
    agendaItemInAccount: (a, id) =>
      exists(`SELECT 1 FROM agenda_items WHERE id = $1 AND account_id = $2 LIMIT 1`, [id, a]),
    helpEntryPublished: (slug) =>
      exists(`SELECT 1 FROM verebona_help_entries WHERE slug = $1 AND status = 'published' LIMIT 1`, [slug]),
  };
}

/**
 * Construit les intentions d'action à soumettre au résolveur (§22.6).
 *
 * Trois apports, dans cet ordre de priorité :
 *   1. les entités effectivement trouvées — ce sont elles qui portent la valeur
 *      d'usage, et leur ordre est celui de la pertinence du retrieval ;
 *   2. le contexte de page (§27.1) — un bien déjà ouvert rend « ajouter un
 *      document » immédiatement utile ;
 *   3. les actions de repli sans cible (listes, aide) — toujours atteignables,
 *      donc placées en dernier.
 *
 * Rien n'est validé ici : le résolveur reste seul juge de l'appartenance au
 * compte et de la limite du §22.9. Cette fonction ne fait que proposer.
 */
function construireActionIntents(
  route: IntentRoute,
  input: AssistantRequestInput,
  sources: RetrievedSource[],
): ActionIntent[] {
  const autorisees = new Set(route.allowedActionTypes);
  const intents: ActionIntent[] = [];

  for (const source of sources) {
    const ref = parseEntityRef(source.id);
    if (!ref) continue;

    switch (ref.kind) {
      case 'asset':
        if (autorisees.has('OPEN_ASSET')) intents.push({ type: 'OPEN_ASSET', targetId: source.id });
        break;
      case 'document':
        if (autorisees.has('OPEN_DOCUMENT')) intents.push({ type: 'OPEN_DOCUMENT', targetId: source.id });
        break;
      case 'agenda_item':
        if (autorisees.has('OPEN_AGENDA_ITEM')) intents.push({ type: 'OPEN_AGENDA_ITEM', targetId: source.id });
        break;
      // Un équipement ou une pièce n'a pas d'existence propre dans la
      // navigation : on ouvre le bien parent sur le bon onglet. C'est aussi ce
      // qui permet au contrôle d'accès de porter sur une table réelle.
      case 'equipment':
      case 'room': {
        const assetId = source.meta?.assetId;
        if (assetId != null && autorisees.has('OPEN_ASSET')) {
          intents.push({
            type: 'OPEN_ASSET',
            targetId: `asset_${assetId}`,
            params: { tab: ref.kind === 'room' ? 'rooms' : 'equipments' },
          });
        }
        break;
      }
    }
  }

  const assetContexte = input.pageContext?.assetId;
  if (assetContexte) {
    for (const type of ['START_ADD_DOCUMENT', 'START_ADD_AGENDA_ITEM', 'OPEN_EXPORT_AREA'] as const) {
      if (autorisees.has(type)) intents.push({ type, targetId: `asset_${assetContexte}` });
    }
  }

  for (const type of route.allowedActionTypes) {
    if (!exigeUneCible(type)) intents.push({ type });
  }

  return intents;
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

    resolveActions: (route, input, sources) =>
      resolveActions({
        accountId: input.accountId,
        intent: route.intent,
        actionIntents: construireActionIntents(route, input, sources),
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
