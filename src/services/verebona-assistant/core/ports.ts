/**
 * Fabrique des ports de l'orchestrateur — CDC §25.5.
 *
 * Assemble les implémentations concrètes (retrieval, sources, actions, persistance)
 * et les injecte dans `runAssistant`.
 *
 * La génération est branchée (`generation.adapter.ts`), via la gateway et non un
 * client fournisseur direct — master T2 seul depuis le lot 16b-2 (drapeau
 * `AI_INTELLIGENT_ASSISTANT` retiré).
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
import { retrieve, retrieveNear } from './retrieval.service';
import { detectHelpContradiction, helpArticlePublished, isHelpIntent } from './help-corpus.service';
import { areWriteCommandsEnabled, getAssistantConfig } from '../config/assistant-config';
import { cachedRetrieve } from './retrieval-cache';
import { RETRIEVAL_CACHE_HIT_EVENT } from './assistant-orchestrator.service';
import { registerAssistantBusinessEventHandlers } from '../events/handlers';
import { checkMonthlyBudget } from './budget.service';
import { isRequestCancelled } from './request-lifecycle.service';
import { resolveSourcesForDisplay } from './source-resolver.service';
import { resolveActions, exigeUneCible, type AccessChecker } from './action-resolver.service';
import { parseEntityRef } from './entity-ref';
import { persistResult, loadThreadContext } from './conversation.service';
import { isPlanAiEligible } from '../registries/capability-registry';
import { saveClarification } from './clarification.service';
import { pgClient } from '@/db';
import { assistantAssetAvailability } from './asset-availability';
import { buildGenerationPort } from './generation.adapter';
import { isTreatmentRunnable } from '@/services/ai/queue/runnable-guard';
import { buildClassificationPort } from './classification.adapter';
import { answerFromData } from './data-answer.service';
import { accountDataRepository } from './account-data.repository';
import { loadCascadeThresholds } from './cascade-thresholds';
import { loadHelpCorpus } from './help-corpus.service';
import { DEFAULT_ACTION_BY_INTENT, findNavigationTarget, helpPrimaryAction } from './navigation-targets';
import { extractSearchTerms } from './query-terms';
import { openHelpSearch } from './help-search.port';

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
    // Fiche fournisseur : mêmes règles que la page (`supplier-detail.service`).
    supplierInAccount: (a, id) =>
      exists(`SELECT 1 FROM suppliers WHERE id = $1 AND account_id = $2 AND status <> 'deleted' LIMIT 1`, [id, a]),
    // Article publié dans le corpus du Centre d'aide de l'environnement — la
    // table `verebona_help_entries` n'est plus une source (CDC Centre d'aide §2).
    helpEntryPublished: (id) => helpArticlePublished(id),
    // Lot 33 : libellés « Ouvrir « <nom> » » (plusieurs biens dans la réponse).
    assetNames: async (a, ids) => {
      const rows = (await pgClient.unsafe(
        `SELECT id, name FROM assets WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
        [a, ids] as never[],
      )) as unknown as Array<{ id: number; name: string | null }>;
      return new Map(rows.filter((r) => r.name).map((r) => [Number(r.id), String(r.name)]));
    },
  };
}

/**
 * Construit les intentions d'action à soumettre au résolveur (§22.6).
 *
 * Navigation explicite (« Ouvre mon agenda ») : UNE action, celle de la
 * destination nommée, et rien d'autre (§22.10, CA-14).
 *
 * Sinon, trois apports, dans cet ordre de priorité :
 *   0. aide produit : l'action qui fait ce que la question demande
 *      (« Comment ajouter un document ? » → Ajouter un document — §10.5) ;
 *   1. les entités effectivement trouvées — ce sont elles qui portent la valeur
 *      d'usage, et leur ordre est celui de la pertinence du retrieval ;
 *   2. le contexte de page (§27.1) — un bien déjà ouvert rend « ajouter un
 *      document » immédiatement utile ;
 *   3. UNE action de repli sans cible (liste, aide) propre à l'intention —
 *      et non plus tous les types sans cible en bloc, qui produisaient trois
 *      boutons sans rapport avec la question (§22.9).
 *   Plus, hors quota métier (§22.9) : « Voir les sources » et « Pourquoi ? »
 *   quand des sources existent et que l'intention les autorise.
 *
 * Rien n'est validé ici : le résolveur reste seul juge de l'appartenance au
 * compte et de la limite du §22.9. Cette fonction ne fait que proposer.
 */
export function construireActionIntents(
  route: IntentRoute,
  input: AssistantRequestInput,
  sources: RetrievedSource[],
): ActionIntent[] {
  const autorisees = new Set(route.allowedActionTypes);
  const intents: ActionIntent[] = [];

  if (route.intent === 'NAVIGATION_OPEN' && sources.length === 0) {
    const nav = findNavigationTarget(input.message);
    if (nav && autorisees.has(nav.action)) return [{ type: nav.action }];
  }

  // Lot 34G : un bien DÉJÀ RÉSOLU (page, référence du fil, clarification)
  // est la cible de l'ajout de document ou d'échéance — le formulaire
  // l'ouvre présélectionné. Le résolveur revérifie son appartenance au compte.
  const aide = helpPrimaryAction(input.message, route.intent);
  const bienResolu = resolvedAssetId(input);
  if (aide && autorisees.has(aide)) {
    intents.push(bienResolu && (aide === 'START_ADD_DOCUMENT' || aide === 'START_ADD_AGENDA_ITEM')
      ? { type: aide, targetId: `asset_${bienResolu}` }
      : { type: aide });
  }

  // ── Aide produit : l'ARTICLE précis, et le support si besoin ───────────
  // Lien profond vers l'article le plus pertinent (« Lire l'article ») au
  // lieu de l'accueil du Centre d'aide ; renvoi au formulaire de contact
  // quand le corpus ne répond pas ou se contredit (CDC Centre d'aide §5,
  // T2-03, T2-04).
  const aideSources = isHelpIntent(route.intent) ? sources.filter((s) => s.type === 'help_entry') : [];
  let aideCiblee = false;
  const contradiction = aideSources.length ? detectHelpContradiction(aideSources) : null;
  if (contradiction && autorisees.has('OPEN_CONTACT')) intents.push({ type: 'OPEN_CONTACT' });
  const article = aideSources.find((s) => typeof s.meta?.articleId === 'string' && typeof s.meta?.path === 'string');
  if (article && autorisees.has('OPEN_HELP') && !contradiction) {
    intents.push({
      type: 'OPEN_HELP',
      targetId: String(article.meta!.articleId),
      params: { path: String(article.meta!.path).split('#')[0] },
    });
    aideCiblee = true;
  }

  // §22.4 (D-J3) : plusieurs résultats d'une recherche → « Voir les
  // résultats », qui ouvre Mes documents (ou l'agenda) filtrés sur CES
  // résultats. En tête : c'est l'action utile d'une liste ; le résolveur
  // scelle les identifiants dans un jeton signé, lié au compte.
  const recherche = searchResultsIntent(route.intent, sources);
  if (recherche && autorisees.has('OPEN_SEARCH_RESULTS')) intents.push(recherche);

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
      case 'supplier':
        if (autorisees.has('OPEN_SUPPLIER')) intents.push({ type: 'OPEN_SUPPLIER', targetId: source.id });
        break;
      // Export ou dossier (§12.1) : l'onglet « Exports » de son bien, avec
      // le type d'export pour le contrôle d'offre (§22.7).
      case 'export': {
        const assetId = source.meta?.assetId;
        if (assetId != null && autorisees.has('OPEN_EXPORT_AREA')) {
          intents.push({
            type: 'OPEN_EXPORT_AREA',
            targetId: `asset_${assetId}`,
            ...(typeof source.meta?.exportType === 'string' ? { params: { exportType: source.meta.exportType } } : {}),
          });
        }
        break;
      }
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
      // Une seule action de création par type (lot 34G) : déjà ciblée ci-dessus.
      if (autorisees.has(type) && !intents.some((i) => i.type === type)) intents.push({ type, targetId: `asset_${assetContexte}` });
    }
  }

  const repli = DEFAULT_ACTION_BY_INTENT[route.intent];
  const aideSansArticle = isHelpIntent(route.intent) && aideSources.length === 0;
  if (repli && autorisees.has(repli) && !exigeUneCible(repli) && !(repli === 'OPEN_HELP' && aideCiblee)) {
    // Question d'aide sans article (D-J4, §10.6, CDC 14 T2-03) : « Ouvrir
    // l'aide » D'ABORD, sur la recherche du Centre d'aide avec les mots de la
    // question — puis le support, en second.
    intents.push(repli === 'OPEN_HELP' && aideSansArticle ? helpSearchIntent(input.message) : { type: repli });
  }
  if (aideSansArticle && autorisees.has('OPEN_CONTACT')) {
    intents.push({ type: 'OPEN_CONTACT' });
  }

  // Actions d'interface (hors quota métier) : seulement s'il y a de quoi
  // montrer — un « Voir les sources » sans source serait un bouton mort.
  if (sources.length > 0) {
    if (autorisees.has('SHOW_SOURCES')) intents.push({ type: 'SHOW_SOURCES' });
    if (autorisees.has('SHOW_EXPLANATION')) intents.push({ type: 'SHOW_EXPLANATION' });
  }
  if (autorisees.has('RETRY_REQUEST')) intents.push({ type: 'RETRY_REQUEST' });

  return intents;
}

/**
 * Bien déjà résolu pour la demande (pure) : page ouverte, puis bien fixé par
 * une clarification, puis référence du fil (« cette maison »).
 */
export function resolvedAssetId(input: Pick<AssistantRequestInput, 'pageContext' | 'resume' | 'reference'>): number | null {
  const candidats = [
    Number(input.pageContext?.assetId),
    Number(input.resume?.assetId),
    input.reference?.type === 'asset' ? Number(input.reference.id) : NaN,
  ];
  return candidats.find((n) => Number.isSafeInteger(n) && n > 0) ?? null;
}

export function buildOrchestratorPorts(): OrchestratorPorts {
  const access = buildAccessChecker();
  // Consommateurs des événements métier (§25.7) : idempotent.
  registerAssistantBusinessEventHandlers();

  return {
    // §43 RETRIEVAL_CACHE_TTL_SECONDS : cache par compte, invalidé par les
    // événements métier (§25.7) ; un succès est signalé pour cache_hit (§28.7).
    retrieve: async (route: IntentRoute, input: AssistantRequestInput) => {
      const r = await cachedRetrieve(route, input, () => retrieve(route, input), getAssistantConfig().retrievalCacheTtlSeconds);
      if (r.hit) input.aiReport?.events.push(RETRIEVAL_CACHE_HIT_EVENT);
      return r.sources;
    },
    // Résultats proches quand la recherche n'a rien donné (§11.4).
    retrieveNear: (route: IntentRoute, input: AssistantRequestInput) => retrieveNear(route, input),

    resolveSources: async (sources: RetrievedSource[]) => resolveSourcesForDisplay(sources),

    // ── Classification et génération (usage 3, master T2) ────────────────
    // Toujours branchées depuis le lot 16b-2 ; l'offre, le réglage
    // `account_ai` et l'état du traitement T2 décident encore de l'appel.
    classifyWithAI: buildClassificationPort(),
    generateWithAI: buildGenerationPort(),
    // EStop / T2 désactivé ou suspendu : message explicite au repli (T2-041).
    isAiUnavailable: async () => !(await isTreatmentRunnable('T2')),

    // ── Cascade de non-escalade : niveaux 1 et 2, sans modèle ────────────
    answerFromData: (route, input, thresholds) =>
      answerFromData({
        port: accountDataRepository,
        accountId: input.accountId,
        message: input.message,
        pageAssetId: Number(input.pageContext?.assetId) || null,
        // Document de la page, de la clarification ou du fil (§12.2).
        pageDocumentId: Number(input.pageContext?.documentId) || input.resume?.documentId
          || (input.reference?.type === 'document' ? input.reference.id : null) || null,
        // Bien fixé par une clarification : il fait foi pour la reprise.
        // …ou par une référence du fil (« cette maison »).
        resolvedAssetId: input.resume?.assetId
          ?? (input.reference?.type === 'asset' ? input.reference.id : null),
        thresholds,
        intent: route.intent,
      }),
    loadThresholds: () => loadCascadeThresholds(),
    // Étape « base d'aide » du routage (§9.4.7) — corpus en cache (§43 HELP_CACHE_TTL_SECONDS).
    loadHelpCorpus: () => loadHelpCorpus(),

    resolveActions: (route, input, sources) =>
      resolveActions({
        accountId: input.accountId,
        intent: route.intent,
        actionIntents: construireActionIntents(route, input, sources),
        access,
        // Offre vérifiée pour chaque action (§22.7 étape 3).
        planType: input.planType,
        planLimit: input.planLimit ?? null,
      }).then((actions) => actions.filter((a) => a.href !== null || !a.type.startsWith('OPEN_'))),

    persist: (result, input) => persistResult(result, input),

    saveClarification: (state) => saveClarification(state),

    // Revalidation ciblée des faits T1 insuffisants, coût imputé à T2.
    revalidateFacts: async (input, req) => {
      const { revalidateFact, loadFactToCheck, factValue } = await import('./revalidation.service');
      const results: Array<{ factId: number; trigger: string; mode: string; status: string; reused: boolean; reinjectedFactId: number | null; aiCalls: number; model: string | null }> = [];
      let established = false;
      let premier: { titre: string; valeur: string } | null = null;
      // Revalidation limitée à UN fait par message (§15.5, CA-07) : chaque
      // fait pouvait coûter deux appels modèle, et N faits épuisaient le
      // budget avant même la génération.
      for (const factId of req.factIds.slice(0, 1)) {
        const f = await loadFactToCheck(input.accountId, factId);
        if (f && !premier) premier = { titre: f.label ?? f.attribute ?? f.factKey, valeur: `${factValue(f) ?? ''}${f.valueUnit ? ` ${f.valueUnit}` : ''}` };
        const r = await revalidateFact({
          accountId: input.accountId, userId: input.userId, conversationId: input.conversationId,
          factId, question: input.message, trigger: req.trigger,
          requestId: input.requestId,
          // Mêmes conditions qu'une génération : offre éligible.
          allowModel: isPlanAiEligible(input.planType),
          // Budget partagé du message : la revalidation y puise comme la
          // classification et la génération.
          budget: input.aiBudget,
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
    //
    // Écart assumé au CDC §4.8 / §22.5 (V1 sans écriture) : conservées sur
    // décision produit, derrière VEREBONA_ASSISTANT_WRITE_COMMANDS. Coupé :
    // aucun plan n'est préparé, la demande suit le parcours de lecture.
    prepareCommand: async (input) => {
      if (!areWriteCommandsEnabled()) return null;
      const { prepareCommand } = await import('../commands/plan.service');
      const r = await prepareCommand(input);
      if (!r) return null;
      return r.kind === 'plan' ? { kind: 'plan' as const, preview: r.preview } : r;
    },

    // Annulation effective (§7.8, §9.7) : consultée avant chaque appel modèle.
    isCancelled: (requestId) => isRequestCancelled(requestId),

    // Plafond budgétaire mensuel du compte (§6.6, §31.3).
    checkMonthlyBudget: (accountId) => checkMonthlyBudget(accountId),

    // CDC 15 T2-19 à T2-21 (lecture canonique) : lecture ciblée d'un document
    // ou d'une échéance désignés, par la couche canonique de X.
    readTarget: async (input, targets, route) => {
      const { readTargetForRequest } = await import('./target-answer');
      return readTargetForRequest(input, targets, route);
    },
    // Lot 32 : résolution serveur des cibles (évaluation de la compréhension,
    // indices d'UNDERSTAND ramenés au compte) — biens DISPONIBLES seulement.
    resolveTargets: async (input, route) => {
      const { resolveAssistantTargets } = await import('./assistant-targets');
      return resolveAssistantTargets(input, route);
    },
    // CDC 15 T2-10, T2-33, T2-34 (lecture canonique) : planificateurs dédiés.
    // Lot 33 : cascade du Centre d'aide (corpus, contexte et rôles lus une fois).
    openHelpSearch: (input: AssistantRequestInput) => openHelpSearch(input),

    buildSynthesisContext: async (route, input) => {
      const { buildSynthesisContext } = await import('./synthesis-planner');
      return buildSynthesisContext(route, input);
    },

    // Mémoire du fil : bornée au fil, à l'utilisateur et au compte.
    loadThreadContext: (input) =>
      input.conversationId ? loadThreadContext(input.accountId, input.userId, input.conversationId) : Promise.resolve(null),

    describeEntity: async (accountId, e) => {
      // Lot 29 (ticket 13) : équipement / pièce revérifiés comme leur fiche
      // (bien parent du compte et disponible, équipement non archivé).
      if (e.type === 'equipment' || e.type === 'room') {
        const { findEntityById } = await import('./target-lookup.repository');
        const x = await findEntityById(accountId, e.type, e.id);
        return x ? { label: x.name, date: null, assetId: x.assetId } : null;
      }
      const sql = e.type === 'asset'
        ? `SELECT a.name AS label, NULL::text AS date FROM assets a
            WHERE a.id = $1 AND a.account_id = $2 AND ${assistantAssetAvailability.sql('a')}`
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

/** Seuil : en dessous, chaque résultat a déjà son bouton (« Ouvrir le document »). */
export const SEARCH_RESULTS_MIN = 2;

/**
 * Intention OPEN_SEARCH_RESULTS d'une recherche (documents, biens, agenda)
 * ayant trouvé au moins `SEARCH_RESULTS_MIN` objets de la portée. Pur.
 */
export function searchResultsIntent(intent: string, sources: RetrievedSource[]): ActionIntent | null {
  const assetOf = (s: RetrievedSource): number | null => {
    const a = Number(s.meta?.assetId);
    return Number.isSafeInteger(a) && a > 0 ? a : null;
  };
  const refs = sources.map((s) => ({ s, ref: parseEntityRef(s.id) })).filter((x) => x.ref);
  if (intent === 'ACCOUNT_SEARCH_DOCUMENT' || intent === 'ACCOUNT_SEARCH_ASSET') {
    const docs = refs.filter((x) => x.ref!.kind === 'document');
    if (docs.length < SEARCH_RESULTS_MIN) return null;
    const assets = [...new Set(docs.map((x) => assetOf(x.s)).filter((a): a is number => a !== null))];
    return { type: 'OPEN_SEARCH_RESULTS', params: { scope: 'documents', ids: docs.map((x) => x.ref!.id).join(','), assets: assets.join(',') } };
  }
  if (intent === 'ACCOUNT_SEARCH_AGENDA') {
    const items = refs.filter((x) => x.ref!.kind === 'agenda_item');
    if (items.length < SEARCH_RESULTS_MIN) return null;
    const assets = [...new Set(items.map((x) => assetOf(x.s)).filter((a): a is number => a !== null))];
    if (assets.length === 0) return null;
    return { type: 'OPEN_SEARCH_RESULTS', params: { scope: 'agenda', ids: items.map((x) => x.ref!.id).join(','), assets: assets.join(',') } };
  }
  return null;
}

/**
 * « Ouvrir l'aide » sur la recherche du Centre d'aide (`/aide?q=`), avec les
 * MOTS UTILES de la question (sans mots vides, 80 caractères au plus) — sans
 * mot utile, l'accueil du Centre d'aide. Pur.
 */
export function helpSearchIntent(message: string): ActionIntent {
  const q = extractSearchTerms(message).join(' ').slice(0, 80).trim();
  return { type: 'OPEN_HELP', params: { path: q ? `/aide?q=${encodeURIComponent(q)}` : '/aide', search: true } };
}

