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
import { persistResult, loadThreadContext } from './conversation.service';
import { isUseCaseRunning } from '@/services/ai/flags/use-case-flags';
import { isPlanAiEligible } from '../registries/capability-registry';
import { saveClarification } from './clarification.service';
import { pgClient } from '@/db';
import { buildGenerationPort } from './generation.adapter';
import { buildClassificationPort } from './classification.adapter';
import { answerFromData } from './data-answer.service';
import { accountDataRepository } from './account-data.repository';
import { loadCascadeThresholds } from './cascade-thresholds';

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

    // ── Cascade de non-escalade : niveaux 1 et 2, sans modèle ────────────
    answerFromData: (route, input, thresholds) =>
      answerFromData({
        port: accountDataRepository,
        accountId: input.accountId,
        message: input.message,
        pageAssetId: Number(input.pageContext?.assetId) || null,
        // Bien fixé par une clarification : il fait foi pour la reprise.
        // …ou par une référence du fil (« cette maison »).
        resolvedAssetId: input.resume?.assetId
          ?? (input.reference?.type === 'asset' ? input.reference.id : null),
        thresholds,
        intent: route.intent,
      }),
    loadThresholds: () => loadCascadeThresholds(),

    resolveActions: (route, input, sources) =>
      resolveActions({
        accountId: input.accountId,
        intent: route.intent,
        actionIntents: construireActionIntents(route, input, sources),
        access,
      }).then((actions) => actions.filter((a) => a.href !== null || !a.type.startsWith('OPEN_'))),

    persist: (result, input) => persistResult(result, input),

    saveClarification: (state) => saveClarification(state),

    // Revalidation ciblée des faits T1 insuffisants, coût imputé à T2.
    revalidateFacts: async (input, req) => {
      const { revalidateFact, loadFactToCheck, factValue } = await import('./revalidation.service');
      const results: Array<{ factId: number; trigger: string; mode: string; status: string; reused: boolean; reinjectedFactId: number | null; aiCalls: number; model: string | null }> = [];
      let established = false;
      let premier: { titre: string; valeur: string } | null = null;
      for (const factId of req.factIds) {
        const f = await loadFactToCheck(input.accountId, factId);
        if (f && !premier) premier = { titre: f.label ?? f.attribute ?? f.factKey, valeur: `${factValue(f) ?? ''}${f.valueUnit ? ` ${f.valueUnit}` : ''}` };
        const r = await revalidateFact({
          accountId: input.accountId, userId: input.userId, conversationId: input.conversationId,
          factId, question: input.message, trigger: req.trigger,
          // Mêmes conditions qu'une génération : usage basculé, offre éligible.
          allowModel: isUseCaseRunning('INTELLIGENT_ASSISTANT') && isPlanAiEligible(input.planType),
        });
        if (!r) continue;
        results.push({ factId, trigger: req.trigger, mode: r.mode, status: r.status, reused: r.reused, reinjectedFactId: r.reinjectedFactId, aiCalls: r.aiCalls, model: r.model });
        if (r.reinjectedFactId || (r.reused && (r.status === 'CONFIRMED' || r.status === 'CORRECTED'))) established = true;
      }
      const prudentAnswer = !established && premier
        ? `Un document indique ${premier.titre} : ${premier.valeur}, mais je n’ai pas pu confirmer cette information avec suffisamment de certitude dans le document disponible.`
        : undefined;
      return { results, established, prudentAnswer };
    },

    // Commandes métier : préparées et figées, exécutées après confirmation.
    prepareCommand: async (input) => {
      const { prepareCommand } = await import('../commands/plan.service');
      const r = await prepareCommand(input);
      if (!r) return null;
      return r.kind === 'plan' ? { kind: 'plan' as const, preview: r.preview } : r;
    },

    // Mémoire du fil : bornée au fil, à l'utilisateur et au compte.
    loadThreadContext: (input) =>
      input.conversationId ? loadThreadContext(input.accountId, input.userId, input.conversationId) : Promise.resolve(null),

    describeEntity: async (accountId, e) => {
      const sql = e.type === 'asset'
        ? `SELECT name AS label, NULL::text AS date FROM assets
            WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
              AND coalesce(status, 'EN_SERVICE') NOT IN ('ARCHIVED', 'TRANSMIS')`
        : e.type === 'document'
          ? `SELECT coalesce(retained_title, original_filename, 'Document') AS label,
                    to_char(document_date, 'YYYY-MM-DD') AS date
               FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`
          : `SELECT title AS label, to_char(start_date, 'YYYY-MM-DD') AS date
               FROM agenda_items WHERE id = $1 AND account_id = $2`;
      const rows = (await pgClient.unsafe(sql, [e.id, accountId] as never[])) as unknown as Array<{ label: string; date: string | null }>;
      return rows[0] ?? null;
    },

    // Bornée à l'utilisateur : une clarification posée à A ne détourne pas
    // la question suivante de B.
    // …et au fil : une question en attente dans un autre fil n'interprète
    // pas la question posée ici.
    hasPendingClarification: async (accountId: number, userId: number, conversationId?: number) => {
      if (!conversationId) return false;
      const rows = await pgClient.unsafe(
        `SELECT 1 FROM verebona_conversations
          WHERE id = $3 AND account_id = $1 AND user_id = $2 AND status = 'active'
            AND clarification_state_json IS NOT NULL LIMIT 1`,
        [accountId, userId, conversationId],
      );
      return (rows as unknown[]).length > 0;
    },
  };
}
