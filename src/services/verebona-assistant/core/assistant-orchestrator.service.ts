/**
 * Orchestrateur de l'assistant — CDC §9, §12, §30.
 *
 * Chef d'orchestre du pipeline : routage → (clarification|retrieval) → déterministe|IA
 * → validation → résolution sources/actions → persistance. Il applique le budget IA
 * (≤ 2 appels — §15.5), les timeouts (§30.2) et le repli déterministe (§30.3).
 *
 * Ce fichier est le point d'entrée appelé par la route `POST /api/verebona/messages`.
 * Les dépendances lourdes (DB, provider) sont injectées pour rester testable (§25.5).
 */
import { randomUUID } from 'crypto';
import type {
  AssistantRequestInput, AssistantRunResult, IntentRoute, ResponseMode,
} from '../types/contracts';
import type { RetrievedSource, ResolvedSource, Claim } from '../types/sources';
import type { VerebonaAction } from '../types/actions';
import { getAssistantConfig } from '../config/assistant-config';
import { ConversationMachine } from './conversation-machine';
import { routeDeterministic, routeForIntent } from './intent-router.service';
import {
  buildAssetClarification,
  FALLBACK_ASSET_MESSAGE,
  MAX_CLARIFICATION_CHAIN,
} from './clarification-builder';
import type { ClarificationState } from '../types/machine';
import {
  formatConversationForPrompt,
  resolveThreadReference,
  type ReferencedType,
  type ThreadContext,
} from './reference-resolver';
import { buildEntityClarification } from './clarification-builder';
import { formatDateFr } from './deterministic-format';
import { marquerDisponibilite } from './source-availability.service';
import { analyzeScope } from './blocked-topics';
import { tryDeterministic } from './deterministic-answer.service';
import { isPlanAiEligible } from '../registries/capability-registry';
import type { CascadeTrace } from '../types/contracts';
import {
  answerFromRetrievedSources,
  fallbackFromSources,
  type DataAnswerOutcome,
} from './data-answer.service';
import { DEFAULT_THRESHOLDS, type CascadeThresholdsLike } from './sufficiency';
import {
  contradictionAnswer, detectHelpContradiction, fallbackFromHelpSources, HELP_EXACT_THRESHOLD,
  isHelpIntent, type HelpCorpus,
} from './help-corpus.service';
import { MONTHLY_BUDGET_NOTICE } from './budget.service';
import { createAiCallBudget, type AiCallBudget } from './ai-call-budget';
import { findNavigationTarget } from './navigation-targets';
import { assistantErrorMessage } from '@/lib/verebona/error-messages';

/** Ports injectés (implémentés par les autres services / le repo). */
export interface OrchestratorPorts {
  retrieve(route: IntentRoute, input: AssistantRequestInput): Promise<RetrievedSource[]>;
  resolveSources(sources: RetrievedSource[], accountId: number): Promise<ResolvedSource[]>;
  classifyWithAI?(message: string, input: AssistantRequestInput): Promise<IntentRoute | null>;
  generateWithAI?(
    route: IntentRoute, sources: RetrievedSource[], input: AssistantRequestInput,
  ): Promise<{ answer: string; claims: Claim[]; actions: VerebonaAction[]; supportLevel: AssistantRunResult['supportLevel']; model?: string } | null>;
  /**
   * Niveaux 1 et 2 de la cascade : réponse exacte depuis les données
   * structurées et les données T1, sans modèle. Absent : la cascade passe
   * directement au retrieval classique.
   */
  answerFromData?(
    route: IntentRoute, input: AssistantRequestInput, thresholds: CascadeThresholdsLike,
  ): Promise<DataAnswerOutcome>;
  /** Seuils de non-escalade (gouvernance IA). Absent : seuils par défaut. */
  loadThresholds?(): Promise<CascadeThresholdsLike & { source: string }>;
  /**
   * Corpus du Centre d'aide (§9.4, étape 7 « recherche dans la base
   * d'aide »). Consulté seulement quand aucune règle n'a tranché, AVANT la
   * classification par modèle. Absent : étape sautée.
   */
  loadHelpCorpus?(): Promise<HelpCorpus | null>;
  /**
   * Les SOURCES sont transmises, pas seulement leurs identifiants : le type et
   * les métadonnées (bien parent d'un équipement, par exemple) sont ce qui
   * permet de choisir la bonne action et de contrôler la bonne table (§22.7).
   */
  resolveActions(
    route: IntentRoute, input: AssistantRequestInput, sources: RetrievedSource[],
  ): Promise<VerebonaAction[]>;
  /** Rend les identifiants enregistrés (fil, message) quand la persistance a eu lieu. */
  persist(
    result: AssistantRunResult,
    input: AssistantRequestInput,
  ): Promise<{ conversationId: number; messageId: number } | null | void>;
  hasPendingClarification(accountId: number, userId: number, conversationId?: number): Promise<boolean>;
  /**
   * Enregistre une clarification sur le fil de la demande. Absent, ou `false`
   * (fil introuvable) : aucune question n'est posée — une clarification à
   * laquelle on ne pourrait pas répondre ne sert à rien.
   */
  saveClarification?(state: ClarificationState): Promise<boolean>;
  /** Contexte conversationnel du fil courant (et de lui seul). */
  loadThreadContext?(input: AssistantRequestInput): Promise<ThreadContext | null>;
  /**
   * L'entité existe-t-elle toujours, dans ce compte, et reste-t-elle
   * accessible ? Rend son libellé (et sa date pour un document) ou `null`.
   * Une référence conversationnelle n'est jamais une autorisation.
   */
  describeEntity?(accountId: number, e: { type: ReferencedType; id: number }): Promise<{ label: string; date?: string | null } | null>;
  /**
   * Commande métier (« ajoute un rappel… », « marque … comme réalisée »).
   * Prépare et fige un plan SANS RIEN ÉCRIRE ; l'exécution n'a lieu qu'après
   * confirmation explicite (route de confirmation).
   */
  /**
   * Revalidation ciblée de faits T1 insuffisants (contenu persisté d'abord,
   * relecture ciblée de la source ensuite), avec réinjection du fait
   * amélioré. Rend les résultats et, en cas d'échec, une réponse prudente.
   */
  revalidateFacts?(input: AssistantRequestInput, req: { trigger: 'LOW_CONFIDENCE' | 'CONFLICT'; factIds: number[] }): Promise<{
    results: NonNullable<CascadeTrace['revalidations']>;
    established: boolean;
    prudentAnswer?: string;
  }>;
  prepareCommand?(input: AssistantRequestInput): Promise<
    | { kind: 'plan'; preview: import('../commands/catalog').CommandPlanPreview }
    | { kind: 'need_info'; message: string }
    | null
  >;
  /**
   * La demande a-t-elle été annulée (DELETE /requests/{id}) ? Consulté avant
   * chaque appel modèle : une demande annulée n'en déclenche plus (§7.8).
   */
  isCancelled?(requestId: string): Promise<boolean>;
  /** Plafond budgétaire mensuel du compte (§6.6, §31.3). Absent : pas de plafond. */
  checkMonthlyBudget?(accountId: number): Promise<{ allowed: boolean }>;
}

export async function runAssistant(
  input: AssistantRequestInput,
  ports: OrchestratorPorts,
): Promise<AssistantRunResult> {
  const cfg = getAssistantConfig();
  // ── Budget d'appels modèle du message (§15.5, CA-07) ──────────────────
  // Un seul compteur pour classification, revalidation et génération,
  // replis compris. Partagé par référence : les copies `{ ...input }`
  // successives gardent le même objet.
  const budget: AiCallBudget = input.aiBudget ?? createAiCallBudget(cfg.maxAiCallsPerRequest);
  // Identifiant RÉSERVÉ par la route (ligne `pending`, annulable) s'il
  // existe ; sinon généré ici (reprise de clarification, tests).
  const requestId = input.requestId ?? randomUUID();
  input = { ...input, aiBudget: budget, requestId };
  const messageId = randomUUID();
  const machine = new ConversationMachine('IDLE');
  const deadline = Date.now() + cfg.totalTimeoutMs;

  const base: AssistantRunResult = {
    requestId, messageId, finalState: 'IDLE', mode: 'deterministic',
    route: null as unknown as IntentRoute, answer: '', supportLevel: null,
    claims: [], sources: [], actions: [], clarification: null,
  };

  try {
    machine.transition('SUBMITTING');

    // ══════════════════════════════════════════════════════════════════════
    // SUJETS RÉSERVÉS — §4.3.3 et §13, AVANT TOUT TRAITEMENT
    //
    // Le §13 interdit à l'assistant tout conseil juridique, fiscal, médical
    // ou assurantiel personnalisé.
    //
    // Le contrôle vient EN PREMIER, avant le routage, la récupération et
    // l'appel modèle. Le placer plus loin laisserait une question interdite
    // atteindre les documents du compte, et lui ferait consommer un appel
    // facturé pour une réponse qu'on refusera de rendre.
    //
    // La distinction porte sur la demande, pas sur le thème : « quel est le
    // montant de ma prime ? » interroge les DONNÉES du compte et reste
    // légitime ; « dois-je changer d'assurance ? » demande un CONSEIL.
    // ══════════════════════════════════════════════════════════════════════
    //
    // ── REQUÊTE MIXTE ─────────────────────────────────────────────────────
    //
    // Le message est découpé en sous-demandes, chacune classée. Refuser tout
    // le message parce qu'une partie demande un conseil faisait perdre la
    // donnée — parfaitement légitime — demandée dans la même phrase.
    //   · FULLY_BLOCKED / AMBIGUOUS : aucun retrieval, aucun modèle ;
    //   · PARTIALLY_ALLOWED : SEULES les parties autorisées continuent (la
    //     partie interdite n'atteint ni les données ni le modèle), et le refus
    //     ciblé est ajouté à la réponse.
    // ══════════════════════════════════════════════════════════════════════
    const scope = analyzeScope(input.message ?? '');
    const sujet = { blocked: scope.kind === 'FULLY_BLOCKED' || scope.kind === 'AMBIGUOUS', reason: scope.reasons[0] ?? null };
    const scopeTrace = { kind: scope.kind, parts: scope.parts.map((p) => ({ text: p.text, allowed: p.allowed, reason: p.reason })) };
    if (sujet.blocked) {
      machine.transition('READY');
      const refus: AssistantRunResult = {
        ...base,
        finalState: 'READY',
        mode: 'deterministic',
        answer: (scope.kind === 'AMBIGUOUS' ? scope.clarification : scope.refusal)
          ?? "Cette question sort du périmètre de l'assistant.",
        // Ni source ni action : rien n'a été lu, et aucune suite n'est
        // proposée sur un sujet refusé.
        sources: [],
        claims: [],
        actions: [],
        blockedReason: sujet.reason,
        scope: scopeTrace,
      };
      await safePersist(ports, refus, input);
      return refus;
    }
    base.scope = scopeTrace;
    if (scope.kind === 'PARTIALLY_ALLOWED') {
      input = { ...input, originalMessage: input.message, message: scope.allowedText };
      base.partialRefusal = scope.refusal;
      base.blockedReason = sujet.reason;
    }

    // ── Routage (§9.4) ──────────────────────────────────────────────────────
    machine.transition('ROUTING');
    const startedAt = Date.now();
    const thresholds = ports.loadThresholds
      ? await ports.loadThresholds().catch(() => ({ ...DEFAULT_THRESHOLDS, source: 'default' }))
      : { ...DEFAULT_THRESHOLDS, source: 'default' };
    const trace: CascadeTrace = {
      intent: 'UNKNOWN', strategy: 'none', answeredBy: 'fallback', sufficiency: null,
      escalationReasons: [], attempts: [], sourceCount: 0, aiCalls: 0, model: null,
      thresholds: { database: thresholds.database, text: thresholds.text, source: thresholds.source },
      latencyMs: 0,
    };
    base.cascade = trace;
    // Sous-demandes et leur classement, tracés avec la demande.
    trace.scope = scopeTrace;
    const done = (answeredBy: CascadeTrace['answeredBy'], strategy: string, sufficiency: string | null, sourceCount: number) => {
      // Appels réellement consommés sur le budget du message (≤ plafond).
      trace.aiCalls = budget.used;
      trace.answeredBy = answeredBy;
      trace.strategy = strategy;
      trace.sufficiency = sufficiency;
      trace.sourceCount = sourceCount;
      trace.latencyMs = Date.now() - startedAt;
    };

    // ══════════════════════════════════════════════════════════════════════
    // AVANT TOUT APPEL MODÈLE : ANNULATION ET PLAFOND MENSUEL
    //
    // · Annulée (§7.8, CA-22) : aucun appel de plus, la demande se termine
    //   en CANCELLED ; la persistance n'écrira que la trace.
    // · Plafond mensuel du compte atteint (§6.6) : le budget du message est
    //   épuisé d'office — même repli déterministe que « budget épuisé », avec
    //   un message non culpabilisant.
    // Le plafond n'est lu qu'une fois par demande, et seulement si un appel
    // modèle est envisagé (aucune requête pour une réponse déterministe).
    // ══════════════════════════════════════════════════════════════════════
    let budgetMensuelVerifie = false;
    let budgetMensuelAtteint = false;
    const avantAppelModele = async (): Promise<'ok' | 'cancelled'> => {
      if (ports.isCancelled && await ports.isCancelled(requestId).catch(() => false)) return 'cancelled';
      if (!budgetMensuelVerifie && ports.checkMonthlyBudget) {
        budgetMensuelVerifie = true;
        const b = await ports.checkMonthlyBudget(input.accountId).catch(() => ({ allowed: true }));
        if (!b.allowed) {
          budgetMensuelAtteint = true;
          budget.consume(budget.max);
          trace.escalationReasons.push('AI_MONTHLY_BUDGET_EXCEEDED');
        }
      }
      return 'ok';
    };
    const annuler = async (): Promise<AssistantRunResult> => {
      machine.transition('CANCELLED');
      done('fallback', 'cancelled', null, 0);
      const r: AssistantRunResult = { ...base, finalState: 'CANCELLED', mode: 'fallback', answer: '', sources: [], claims: [], actions: [] };
      await safePersist(ports, r, input);
      return r;
    };

    // ══════════════════════════════════════════════════════════════════════
    // MÉMOIRE DU FIL — AVANT LE ROUTAGE (§16.4)
    //
    // message → contexte du fil → résolution des références → demande
    // enrichie → routage → retrieval → réponse. « Ouvre le deuxième » est
    // compris ici, sans modèle, à partir de l'ordre RÉELLEMENT affiché dans
    // CE fil — jamais d'un autre fil ni de l'autre membre d'un Duo.
    // ══════════════════════════════════════════════════════════════════════
    const early = await applyThreadMemory(input, ports, trace);
    input = early.input;
    if (early.contextUpdate) base.contextUpdate = early.contextUpdate;
    if (early.clarification) {
      done('template', 'reference.clarification', 'AMBIGUOUS_TARGET', early.clarification.candidates.length);
      return finalizeClarification(base, machine, early.clarification, ports, input);
    }
    if (early.answer) {
      const route = routeForIntent(early.answer.intent, input.planType, 'référence du fil');
      base.route = route;
      trace.intent = route.intent;
      const actions = await ports.resolveActions(route, input, early.answer.sources);
      done('structured', early.answer.strategy, 'SUFFICIENT_STRUCTURED', early.answer.sources.length);
      const resolvedEarly = early.answer.sources.length ? await ports.resolveSources(early.answer.sources, input.accountId) : [];
      return finalize(base, machine, 'deterministic', early.answer.text, [], resolvedEarly, actions, ports, input);
    }

    // ══════════════════════════════════════════════════════════════════════
    // COMMANDE MÉTIER — préparation et aperçu, AUCUNE ÉCRITURE ICI
    // ══════════════════════════════════════════════════════════════════════
    if (ports.prepareCommand && !input.resume) {
      const prep = await ports.prepareCommand(input).catch((e) => {
        console.error('[verebona] préparation de commande impossible :', (e as Error).message);
        return null;
      });
      if (prep) {
        const route = routeForIntent('UNSUPPORTED_ACTION', input.planType, 'commande métier');
        base.route = route;
        trace.intent = 'WRITE_COMMAND';
        done('template', prep.kind === 'plan' ? 'command.preview' : 'command.need_info', null, 0);
        const result = await finalize(base, machine, 'deterministic',
          prep.kind === 'plan' ? prep.preview.summary : prep.message, [], [], [], ports, input);
        if (prep.kind === 'plan') result.commandPlan = prep.preview;
        return result;
      }
    }

    // Reprise après clarification : la demande initiale garde son intention —
    // elle n'est ni re-routée ni re-classée par le modèle.
    let outcome: ReturnType<typeof routeDeterministic> = input.resume
      ? { kind: 'route' as const, route: routeForIntent(input.resume.intent, input.planType, 'reprise après clarification') }
      : routeDeterministic({
          message: input.message,
          planType: input.planType,
          hasPendingClarification: await ports.hasPendingClarification(input.accountId, input.userId, input.conversationId),
          pageRoute: input.pageContext?.route,
        });

    // ══════════════════════════════════════════════════════════════════════
    // BASE D'AIDE — §9.4 étape 7, AVANT toute classification par modèle
    //
    // Aucune règle n'a tranché : une question d'usage formulée autrement
    // (« je veux changer mon mot de passe ») est cherchée dans le Centre
    // d'aide. Un article pertinent suffit à la router en aide produit, sans
    // appel modèle. Le corpus n'est chargé qu'ici, pas à chaque message.
    // ══════════════════════════════════════════════════════════════════════
    if (outcome.kind === 'needs_classification' && ports.loadHelpCorpus) {
      const corpus = await ports.loadHelpCorpus().catch(() => null);
      if (corpus) {
        const viaAide = routeDeterministic({
          message: input.message,
          planType: input.planType,
          hasPendingClarification: false,
          pageRoute: input.pageContext?.route,
          helpCorpus: corpus,
        });
        if (viaAide.kind === 'route') outcome = viaAide;
      }
    }

    // La classification IA n'est plus sollicitée d'emblée : c'est un appel
    // modèle, et la cascade doit d'abord tenter les niveaux gratuits.
    let route: IntentRoute = outcome.kind === 'route' ? outcome.route : fallbackUnknownRoute(input.planType);
    const needsClassification = outcome.kind === 'needs_classification';
    base.route = route;
    trace.intent = route.intent;

    // ══════════════════════════════════════════════════════════════════════
    // NAVIGATION EXPLICITE — §22.9, §22.10, CA-14, 37.11
    //
    // « Ouvre mon agenda » répondait « Je n'ai pas trouvé d'élément
    // suffisant… » avec trois boutons : NAVIGATION_OPEN n'avait ni gabarit ni
    // action ciblée. Une destination connue du dictionnaire produit désormais
    // une phrase courte et UN seul bouton ; rien ne s'ouvre sans clic (§22.10).
    // ══════════════════════════════════════════════════════════════════════
    if (route.intent === 'NAVIGATION_OPEN') {
      const nav = findNavigationTarget(input.message);
      if (nav) {
        const actions = await ports.resolveActions(route, input, []);
        done('template', `template.NAVIGATION_OPEN.${nav.key}`, 'SUFFICIENT_STRUCTURED', 0);
        return finalize(base, machine, 'deterministic', nav.answer, [], [], actions, ports, input);
      }
    }

    // ── Réponse déterministe par gabarit (§14) ──────────────────────────────
    let det = tryDeterministic(route.intent);
    if (det.handled && det.answer) {
      const actions = await ports.resolveActions(route, input, []);
      done('template', `template.${route.intent}`, 'SUFFICIENT_STRUCTURED', 0);
      return finalize(base, machine, 'deterministic', det.answer, [], [], actions, ports, input);
    }

    // ══════════════════════════════════════════════════════════════════════
    // NIVEAUX 1 ET 2 — DONNÉES STRUCTURÉES PUIS DONNÉES T1, SANS MODÈLE
    //
    // Tentés pour toute question portant sur les données du compte, AVANT la
    // classification IA et AVANT la génération. Une réponse suffisante ici
    // est définitive, quel que soit `aiEligible` : l'éligibilité autorise un
    // appel modèle, elle ne l'impose jamais.
    // ══════════════════════════════════════════════════════════════════════
    let data: DataAnswerOutcome | null = null;
    if (ports.answerFromData && isDataQuestion(route)) {
      machine.transition('RETRIEVING');
      data = await withDeadline(ports.answerFromData(route, input, thresholds), deadline).catch(() => null);

      // ══════════════════════════════════════════════════════════════════
      // REVALIDATION CIBLÉE (§ T2) — seulement si les données T1 sont
      // insuffisantes : confiance trop faible ou valeurs en conflit. Le fait
      // amélioré est réinjecté, puis la cascade est rejouée UNE fois sur la
      // connaissance mise à jour.
      // ══════════════════════════════════════════════════════════════════
      if (data?.revalidation && ports.revalidateFacts && !input.revalidationDone) {
        if (await avantAppelModele() === 'cancelled') return annuler();
        const avantRv = budget.used;
        const rv = await ports.revalidateFacts(input, data.revalidation).catch(() => null);
        if (rv) {
          trace.revalidations = rv.results;
          // Un port qui n'a pas décompté ses appels sur le budget (double de
          // test, implémentation tierce) est rattrapé ici : le plafond reste
          // garanti au niveau de l'orchestrateur.
          reconcilierBudget(budget, avantRv, rv.results.reduce((n, r) => n + r.aiCalls, 0));
          trace.aiCalls = budget.used;
          trace.escalationReasons.push(`REVALIDATION:${data.revalidation.trigger}`);
          if (rv.established) {
            input = { ...input, revalidationDone: true };
            trace.attempts.push(...data.attempts);
            data = await withDeadline(ports.answerFromData(route, input, thresholds), deadline).catch(() => data);
          } else if (rv.prudentAnswer && !data.handled) {
            const actions = await ports.resolveActions(route, input, data.contextSources);
            const resolvedCtx = await ports.resolveSources(data.contextSources.slice(0, 3), input.accountId);
            done('retrieval', 'revalidation.unconfirmed', 'INSUFFICIENT', data.contextSources.length);
            return finalize(base, machine, 'deterministic', rv.prudentAnswer, [], resolvedCtx, actions, ports, input, 'insufficient');
          }
        }
      }

      if (data) {
        trace.attempts.push(...data.attempts);

        // ══════════════════════════════════════════════════════════════════
        // AMBIGUÏTÉ → CLARIFICATION (§20)
        //
        // La demande vise un bien et plusieurs correspondent aussi bien :
        // aucun n'est choisi arbitrairement. Les candidats viennent des
        // données du compte (jamais du modèle) ; l'état complet de la demande
        // est enregistré pour une reprise structurée. Au-delà de deux
        // clarifications successives, repli.
        // ══════════════════════════════════════════════════════════════════
        if (data.ambiguity && data.ambiguity.candidates.length >= 2) {
          const chainDepth = (input.resume?.chainDepth ?? 0) + 1;
          trace.escalationReasons.push(`CLARIFICATION:${data.ambiguity.reason}`);
          if (chainDepth > MAX_CLARIFICATION_CHAIN) {
            const actions = await ports.resolveActions(route, input, []);
            done('template', 'clarification.chain_exhausted', 'AMBIGUOUS_TARGET', 0);
            return finalize(base, machine, 'deterministic', FALLBACK_ASSET_MESSAGE, [], [], actions, ports, input);
          }
          const state = buildAssetClarification({
            assets: data.ambiguity.candidates,
            reason: data.ambiguity.reason,
            accountId: input.accountId,
            userId: input.userId,
            conversationId: input.conversationId,
            originalMessage: input.message,
            originalMessageId: messageId,
            originalIntent: route.intent,
            pageAssetId: Number(input.pageContext?.assetId) || null,
            chainDepth,
          });
          const saved = ports.saveClarification ? await ports.saveClarification(state).catch(() => false) : false;
          if (saved) {
            done('template', 'clarification.asset', 'AMBIGUOUS_TARGET', state.candidates.length);
            return finalizeClarification(base, machine, state, ports, input);
          }
        }

        if (data.handled && data.answer) {
          const resolvedData = await ports.resolveSources(data.sources, input.accountId);
          const actions = await ports.resolveActions(route, input, data.sources);
          done(data.decision.level === 1 ? 'structured' : 'retrieval', data.strategy, data.decision.status, data.sources.length);
          return finalize(base, machine, 'deterministic', data.answer, data.claims, resolvedData, actions, ports, input,
            data.decision.status === 'CONFLICTING' ? 'conflicting' : 'supported');
        }
        if (data.decision.reason) trace.escalationReasons.push(`N${data.decision.level}:${data.decision.reason}`);
      }
    }

    // ── Classification IA, seulement maintenant (§9.4.9, §15.5) ────────────
    if (needsClassification && ports.classifyWithAI && isPlanAiEligible(input.planType)) {
      if (await avantAppelModele() === 'cancelled') return annuler();
    }
    if (needsClassification && ports.classifyWithAI && isPlanAiEligible(input.planType) && !budget.canCall()) {
      trace.escalationReasons.push('ROUTING:AI_BUDGET_EXHAUSTED');
    } else if (needsClassification && ports.classifyWithAI && isPlanAiEligible(input.planType)) {
      trace.escalationReasons.push('ROUTING:NO_DETERMINISTIC_RULE');
      const avantCl = budget.used;
      const classified = await ports.classifyWithAI(outcome.kind === 'needs_classification' ? outcome.normalized : input.message, input);
      reconcilierBudget(budget, avantCl, 1);
      trace.aiCalls = budget.used;
      route = classified ?? fallbackUnknownRoute(input.planType);
      base.route = route;
      trace.intent = route.intent;

      // L'intention classée peut appeler une réponse imposée (hors périmètre,
      // conseil réservé, demande malveillante, politesse…) : le gabarit
      // s'applique alors, et le besoin de retrieval est réévalué.
      det = tryDeterministic(route.intent);
      if (det.handled && det.answer) {
        const actions = await ports.resolveActions(route, input, []);
        done('template', `template.${route.intent}`, 'SUFFICIENT_STRUCTURED', 0);
        return finalize(base, machine, 'deterministic', det.answer, [], [], actions, ports, input);
      }
    }

    // ── Retrieval-first (§13) ───────────────────────────────────────────────
    let sources: RetrievedSource[] = [];
    let resolved: ResolvedSource[] = [];
    if (route.requiresRetrieval || det.needsSimpleRetrieval) {
      if (machine.state !== 'RETRIEVING') machine.transition('RETRIEVING');
      let adapters: RetrievedSource[];
      try {
        adapters = (await withDeadline(ports.retrieve(route, input), deadline)).slice(0, cfg.maxSources);
      } catch (e) {
        // ══════════════════════════════════════════════════════════════════
        // TIMEOUT : LES RÉSULTATS DÉTERMINISTES SONT CONSERVÉS (§9.6, §30.1)
        //
        // L'échéance globale levait jusqu'au `catch` final : ERROR_FINAL et
        // perte de ce que les niveaux 1 et 2 avaient déjà trouvé. Si des
        // sources du compte sont déjà en main, elles sont rendues (état
        // récupérable, « Réessayer » reste possible) ; sinon, l'erreur suit
        // son cours.
        // ══════════════════════════════════════════════════════════════════
        const deja = isHelpIntent(route.intent) ? [] : (data?.contextSources ?? []);
        if ((e as Error)?.message !== 'REQUEST_TIMEOUT' || deja.length === 0) throw e;
        machine.fail(false);
        trace.escalationReasons.push('TIMEOUT:PARTIAL_RESULTS');
        const partiel = dedupeSources(deja).slice(0, cfg.maxSources);
        const resolvedPartiel = await ports.resolveSources(partiel, input.accountId).catch(() => []);
        const actionsPartiel = await ports.resolveActions(route, input, partiel).catch(() => []);
        done('fallback', 'timeout.partial', 'INSUFFICIENT', partiel.length);
        const r = await finalize(base, machine, 'classic_search',
          `La recherche complète a pris trop de temps. Voici ce que j’ai déjà trouvé : ${fallbackFromSources(partiel)}`,
          [], resolvedPartiel, actionsPartiel, ports, input, 'insufficient');
        // État récupérable, mais PAS de `error` dans la réponse : le client
        // remplacerait le texte par le libellé d'erreur et perdrait les
        // résultats déjà trouvés, qui sont précisément ce qu'on conserve.
        r.finalState = 'ERROR_RECOVERABLE';
        return r;
      }
      // Les données T1 rassemblées au niveau 2 enrichissent le contexte : le
      // modèle, s'il est appelé, répond sur ce que T1 a déjà extrait.
      // Question d'utilisation : les articles seuls, jamais le contexte du
      // compte (CDC Centre d'aide §5, T2-06).
      const contexte = isHelpIntent(route.intent) ? [] : (data?.contextSources ?? []);
      sources = dedupeSources([...contexte, ...adapters]).slice(0, cfg.maxSources);
      resolved = await ports.resolveSources(sources, input.accountId);

      // ══════════════════════════════════════════════════════════════════
      // AIDE PRODUIT — contradiction, puis réponse d'article sans modèle
      //
      // T2-04 : deux articles également pertinents qui se contredisent ne
      // sont pas arbitrés — ni par le code, ni par le modèle. Réponse « non
      // fiable », renvoi au support (OPEN_CONTACT, via `resolveActions`) et
      // alerte éditoriale journalisée avec les deux identifiants.
      //
      // §10.5 / §10.6 : un article qui répond exactement (score ≥ seuil)
      // suffit, en Standard comme en Premium : extrait + lien vers l'article,
      // sans appel modèle. Le modèle ne reformule que les cas moins nets, et
      // seulement si le compte y est éligible.
      // ══════════════════════════════════════════════════════════════════
      if (isHelpIntent(route.intent) && sources.length > 0) {
        const contradiction = detectHelpContradiction(sources);
        if (contradiction) {
          console.warn(`[verebona][alerte-éditoriale] CONTRADICTION ${contradiction.articles[0]} / ${contradiction.articles[1]} (${contradiction.unit}) — correction documentaire à prévoir (T2-04).`);
          trace.escalationReasons.push(`HELP_CONTRADICTION:${contradiction.articles.join('|')}`);
          const actions = await ports.resolveActions(route, input, sources);
          done('template', 'help.contradiction', 'CONFLICTING', sources.length);
          return finalize(base, machine, 'deterministic', contradictionAnswer(contradiction), [], resolved, actions, ports, input, 'conflicting');
        }
        const exact = (sources[0].relevanceScore ?? 0) >= HELP_EXACT_THRESHOLD;
        if (exact || !route.aiEligible) {
          const actions = await ports.resolveActions(route, input, sources);
          done('retrieval', exact ? 'help.exact_article' : 'help.article_excerpt', exact ? 'SUFFICIENT_TEXT' : 'INSUFFICIENT', sources.length);
          return finalize(base, machine, 'classic_search', fallbackFromHelpSources(sources), [], resolved, actions, ports, input, 'supported');
        }
      }

      // Réponse exacte à partir des résultats (tryDeterministicFromRetrieval).
      const exact = answerFromRetrievedSources(route.intent, input.message, adapters, thresholds);
      trace.attempts.push({ level: 2, strategy: 'retrieval.adapters', status: exact.decision.status, score: exact.decision.score, threshold: exact.decision.threshold, reason: exact.decision.reason });
      if (exact.handled && exact.answer && (adapters.length > 0 || !route.aiEligible)) {
        const resolvedAdapters = adapters.length ? await ports.resolveSources(adapters, input.accountId) : [];
        const actions = await ports.resolveActions(route, input, adapters);
        done('retrieval', 'retrieval.adapters', exact.decision.status, adapters.length);
        return finalize(base, machine, 'classic_search', exact.answer, [], resolvedAdapters, actions, ports, input);
      }
      if (exact.decision.reason) trace.escalationReasons.push(`N2:${exact.decision.reason}`);
    } else if (data?.contextSources.length) {
      sources = dedupeSources(data.contextSources).slice(0, cfg.maxSources);
      resolved = await ports.resolveSources(sources, input.accountId);
    }

    // ── Niveau 3 : modèle, uniquement après insuffisance constatée (§15.1) ──
    const canUseAI =
      cfg.aiEnabled &&
      route.aiEligible &&
      ports.generateWithAI != null &&
      sources.length > 0 &&
      // Budget du message épuisé (classification + revalidation) : repli
      // déterministe plutôt qu'un troisième appel (§15.5, CA-07).
      budget.canCall();
    if (!canUseAI && route.aiEligible && sources.length > 0 && ports.generateWithAI != null && !budget.canCall()) {
      trace.escalationReasons.push('N3:AI_BUDGET_EXHAUSTED');
    }

    if (canUseAI) {
      const okGuard = machine.transition('GENERATING', {
        aiAllowed: true,
        clarificationCount: 0,
      });
      if (okGuard && await avantAppelModele() === 'cancelled') return annuler();
      if (okGuard && !budget.canCall()) {
        // Plafond mensuel atteint à l'instant : pas d'appel (repli ci-dessous).
        trace.escalationReasons.push('N3:AI_BUDGET_EXHAUSTED');
      } else if (okGuard) {
        const avantGen = budget.used;
        const gen = await withDeadline(ports.generateWithAI!(route, sources, input), deadline).catch(() => null);
        reconcilierBudget(budget, avantGen, 1);
        trace.aiCalls = budget.used;
        if (gen) {
          machine.transition('VALIDATING');
          trace.model = gen.model ?? null;
          const actions = gen.actions.length ? gen.actions : await ports.resolveActions(route, input, sources);
          done('llm', 'llm.generate_answer', trace.escalationReasons.length ? 'INSUFFICIENT' : null, sources.length);
          return finalize(base, machine, 'ai', gen.answer, gen.claims, resolved, actions, ports, input, gen.supportLevel);
        }
        trace.escalationReasons.push('N3:GENERATION_UNAVAILABLE');
      }
      // Repli déterministe si l'IA échoue/expire (§30.3).
      machine.fail(false);
    } else if (sources.length > 0 && !route.aiEligible) {
      trace.escalationReasons.push('N3:NOT_AI_ELIGIBLE');
    }

    // ── Repli sans modèle : jamais une phrase vide de contenu ───────────────
    // Question d'utilisation : articles cités, ou aveu explicite et contact —
    // jamais « ces éléments de votre compte » (CDC Centre d'aide §5, T2-03).
    const repli = isHelpIntent(route.intent) ? fallbackFromHelpSources(sources) : fallbackFromSources(sources);
    // Plafond mensuel : le dire, sans culpabiliser (§6.6).
    const answer = budgetMensuelAtteint && route.aiEligible ? `${repli}\n\n${MONTHLY_BUDGET_NOTICE}` : repli;
    const actions = await ports.resolveActions(route, input, sources);
    done('fallback', 'fallback.sources', 'INSUFFICIENT', sources.length);
    return finalize(base, machine, resolved.length ? 'classic_search' : 'fallback', answer, [], resolved, actions, ports, input);
  } catch (e) {
    machine.fail(true);
    // §27.11 : le dépassement de l'échéance globale est un REQUEST_TIMEOUT,
    // distinct d'une panne. Le message est un libellé Verebona, jamais le
    // texte brut de l'exception (§4.2) — celui-ci reste dans les journaux.
    const code = (e as Error)?.message === 'REQUEST_TIMEOUT' ? 'REQUEST_TIMEOUT' as const : 'ASSISTANT_UNAVAILABLE' as const;
    console.error('[verebona] échec de la demande', code, (e as Error)?.message);
    const libelle = assistantErrorMessage(code);
    const result: AssistantRunResult = {
      ...base,
      finalState: machine.state,
      error: { code, message: libelle, recoverable: true },
      answer: libelle,
    };
    await safePersist(ports, result, input);
    return result;
  }
}

const OPEN_REF = /\b(ouvre|ouvrir|montre|affiche|voir|consulter|va sur)\b/;
const CONTENT_NOUN = /\b(documents?|factures?|fichiers?|echeances?|rappels?|montants?|prix|equipements?|pieces?|travaux|entretiens?|contrats?|garanties?)\b/;
const DATE_REF = /\b(date|quand|date[e]?|daté|datee)\b/;
const plainTxt = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Source synthétique d'une entité référencée (actions et affichage). */
function entitySource(type: ReferencedType, id: number, label: string): RetrievedSource {
  const prefix = type === 'document' ? 'doc' : type === 'asset' ? 'asset' : 'agenda';
  return {
    id: `${prefix}_${id}`,
    type: type === 'document' ? 'document' : type === 'asset' ? 'asset_field' : 'agenda_item',
    title: label, content: '', relevanceScore: 1,
    meta: type === 'asset' ? { assetId: id } : type === 'document' ? { fileId: id } : {},
  } as RetrievedSource;
}

/**
 * Charge le contexte du fil et résout une référence conversationnelle.
 * Rend la demande enrichie, et — pour les références simples — une réponse
 * immédiate sans modèle (« ouvre le deuxième », « et sa date ? »).
 */
async function applyThreadMemory(
  input: AssistantRequestInput,
  ports: OrchestratorPorts,
  trace: CascadeTrace,
): Promise<{
  input: AssistantRequestInput;
  contextUpdate?: AssistantRunResult['contextUpdate'];
  clarification?: ClarificationState;
  answer?: { text: string; sources: RetrievedSource[]; strategy: string; intent: 'NAVIGATION_OPEN' | 'ACCOUNT_FACT_DOCUMENT' };
}> {
  // Reprise d'une clarification : le choix EST la référence.
  if (input.resume) {
    const r = input.resume;
    const ref = r.documentId ? { type: 'document' as const, id: r.documentId } : r.assetId ? { type: 'asset' as const, id: r.assetId } : null;
    if (!ref) return { input };
    const enriched: AssistantRequestInput = {
      ...input,
      reference: { ...ref, label: r.choiceLabel, method: 'clarification' },
      pageContext: { ...input.pageContext, ...(ref.type === 'document' ? { documentId: String(ref.id) } : { assetId: String(ref.id) }) },
    };
    const update = { ...ref, label: r.choiceLabel };
    // Une référence résolue par clarification peut appeler la même réponse
    // immédiate qu'une référence directe (« ouvre… », « sa date… »).
    if (ref.type === 'document' && ports.describeEntity) {
      const d = await ports.describeEntity(input.accountId, ref).catch(() => null);
      // La référence ambiguë d'origine (« ce document ») est désormais levée :
      // elle ne compte pas comme un autre objet demandé.
      const ambigu = plainTxt(input.message).match(/\b(ce|cet|cette)\s+\w+|l'autre|celui-ci|celle-ci/)?.[0];
      const quick = d ? quickAnswer(input.message, ref.type, ref.id, d, ambigu) : null;
      if (quick) return { input: enriched, contextUpdate: update, answer: quick };
    }
    return { input: enriched, contextUpdate: update };
  }

  if (!ports.loadThreadContext || !input.conversationId) return { input };
  const ctx = await ports.loadThreadContext(input).catch(() => null);
  if (!ctx) return { input };

  const res = resolveThreadReference(input.message, ctx);
  trace.reference = {
    contextMessages: ctx.messages.length,
    presentedLists: ctx.presentedLists.length,
    detected: res.kind === 'none' ? null : res.detected,
    outcome: res.kind,
    method: res.kind === 'resolved' ? res.method : res.kind === 'ambiguous' ? 'clarification' : null,
    entity: null,
  };
  let enriched: AssistantRequestInput = { ...input, threadContextText: formatConversationForPrompt(ctx, null) };

  if (res.kind === 'ambiguous') {
    const memeType = res.candidates.every((c) => c.type === res.candidates[0].type);
    if (memeType && res.candidates.length >= 2 && ports.saveClarification) {
      const state = buildEntityClarification({
        entities: res.candidates,
        accountId: input.accountId, userId: input.userId, conversationId: input.conversationId,
        originalMessage: input.message, originalMessageId: randomUUID(),
        originalIntent: res.candidates[0].type === 'document' ? 'NAVIGATION_OPEN' : 'ACCOUNT_SEARCH_ASSET',
        chainDepth: 1,
      });
      if (await ports.saveClarification(state).catch(() => false)) return { input: enriched, clarification: state };
    }
    return { input: enriched };
  }
  if (res.kind !== 'resolved') return { input: enriched };

  // Re-vérification : existe, appartient au compte, reste accessible.
  const d = ports.describeEntity ? await ports.describeEntity(input.accountId, res.entity).catch(() => null) : null;
  if (!d) {
    trace.reference.outcome = 'unavailable';
    return {
      input: enriched,
      answer: { text: 'Cet élément n’est plus disponible dans votre compte.', sources: [], strategy: 'reference.unavailable', intent: 'NAVIGATION_OPEN' },
    };
  }
  trace.reference.entity = { type: res.entity.type, id: res.entity.id };
  const label = d.label || res.entity.label || null;
  enriched = {
    ...enriched,
    reference: { type: res.entity.type, id: res.entity.id, label, method: res.method },
    threadContextText: formatConversationForPrompt(ctx, { ...res.entity, label }),
    pageContext: {
      ...input.pageContext,
      ...(res.entity.type === 'asset' ? { assetId: String(res.entity.id) } : {}),
      ...(res.entity.type === 'document' ? { documentId: String(res.entity.id) } : {}),
    },
  };
  const contextUpdate = { type: res.entity.type, id: res.entity.id, label };
  const quick = quickAnswer(input.message, res.entity.type, res.entity.id, d, res.detected);
  return quick ? { input: enriched, contextUpdate, answer: quick } : { input: enriched, contextUpdate };
}

/** Réponses immédiates sur une entité référencée : l'ouvrir, donner sa date. */
function quickAnswer(
  message: string,
  type: ReferencedType,
  id: number,
  d: { label: string; date?: string | null },
  detected?: string,
): { text: string; sources: RetrievedSource[]; strategy: string; intent: 'NAVIGATION_OPEN' | 'ACCOUNT_FACT_DOCUMENT' } | null {
  const m = plainTxt(message);
  const src = [entitySource(type, id, d.label)];
  if (type === 'document' && DATE_REF.test(m) && !OPEN_REF.test(m)) {
    return {
      text: d.date ? `« ${d.label} » est daté du ${formatDateFr(d.date)}.` : `Aucune date n’est enregistrée pour « ${d.label} ».`,
      sources: src, strategy: 'reference.document_date', intent: 'ACCOUNT_FACT_DOCUMENT',
    };
  }
  // « ouvre le deuxième », « le deuxième » : ouvrir l'élément désigné — pas
  // « montre-moi les documents de cette maison », qui demande autre chose que
  // le bien lui-même.
  const reste = detected ? m.replace(plainTxt(detected), ' ') : m;
  if (CONTENT_NOUN.test(reste)) return null;
  const court = m.replace(/[?!.]/g, '').trim().split(/\s+/).length <= 5;
  if (OPEN_REF.test(m) || court) {
    return { text: `Voici « ${d.label} ».`, sources: src, strategy: 'reference.open', intent: 'NAVIGATION_OPEN' };
  }
  return null;
}


/**
 * Rend une clarification : la question, ses candidats, et rien d'autre —
 * aucune réponse partielle sur un bien choisi au hasard.
 */
async function finalizeClarification(
  base: AssistantRunResult,
  machine: ConversationMachine,
  state: ClarificationState,
  ports: OrchestratorPorts,
  input: AssistantRequestInput,
): Promise<AssistantRunResult> {
  if (machine.state !== 'CLARIFYING') machine.transition('CLARIFYING');
  const result: AssistantRunResult = {
    ...base,
    finalState: machine.state,
    mode: 'deterministic',
    answer: state.question,
    claims: [], sources: [], actions: [],
    clarification: state,
  };
  await safePersist(ports, result, input);
  return result;
}

/** Intentions portant sur les données du compte : la cascade y est tentée. */
function isDataQuestion(route: IntentRoute): boolean {
  // Synthèse, comparaison, chronologie : une valeur exacte n'y répond pas —
  // ces intentions vont directement au retrieval puis, si éligible, au modèle.
  if (SYNTHESIS_INTENTS.has(route.intent)) return false;
  return route.intent.startsWith('ACCOUNT_') || route.intent === 'UNKNOWN';
}

const SYNTHESIS_INTENTS = new Set(['ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE']);

function dedupeSources(list: RetrievedSource[]): RetrievedSource[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

function fallbackUnknownRoute(planType: string): IntentRoute {
  return {
    intent: 'UNKNOWN', confidence: 'ambiguous', accountScope: 'server-enforced',
    entityHints: [], requiresRetrieval: false, aiEligible: false,
    clarificationRequired: false, allowedActionTypes: ['OPEN_HELP'],
    routeReason: 'aucune règle déterministe, classification indisponible',
  };
}

async function finalize(
  base: AssistantRunResult,
  machine: ConversationMachine,
  mode: ResponseMode,
  answer: string,
  claims: Claim[],
  sources: ResolvedSource[],
  actions: VerebonaAction[],
  ports: OrchestratorPorts,
  input: AssistantRequestInput,
  supportLevel: AssistantRunResult['supportLevel'] = null,
): Promise<AssistantRunResult> {
  if (machine.state !== 'VALIDATING') machine.transition('VALIDATING');
  machine.transition('READY');

  // §19.10 — dernier moment utile pour vérifier qu'une source citée existe
  // encore et reste accessible. Une source supprimée entre sa récupération et
  // l'affichage produirait un lien mort, et l'historique conservé sept jours
  // en produirait davantage encore.
  //
  // Ne lève jamais : une vérification impossible ne doit pas empêcher
  // l'affichage d'une réponse.
  const sourcesVerifiees = await marquerDisponibilite(sources, input.accountId)
    .catch(() => sources);

  const result: AssistantRunResult = {
    ...base, finalState: machine.state, mode,
    // Requête mixte : la réponse factuelle, PUIS le refus ciblé — sans
    // laisser croire que la partie interdite a été évaluée.
    answer: base.partialRefusal ? `${answer}\n\n${base.partialRefusal}` : answer,
    claims,
    sources: sourcesVerifiees, actions, supportLevel,
  };
  await safePersist(ports, result, input);
  return result;
}

/**
 * Persiste puis reporte les identifiants de la base sur le résultat : le
 * messageId rendu au client doit être celui que les routes sources /
 * explication / avis savent retrouver, et conversationId le fil réellement
 * utilisé.
 */
async function safePersist(ports: OrchestratorPorts, r: AssistantRunResult, input: AssistantRequestInput) {
  try {
    const ids = await ports.persist(r, input);
    if (ids) {
      r.messageId = String(ids.messageId);
      r.conversationId = ids.conversationId;
    }
  } catch (e) { console.error('[verebona] persist error', (e as Error).message); }
}

/**
 * Rattrape sur le budget les appels qu'un port n'y aurait pas décomptés
 * lui-même (`attendu` = appels déclarés ou supposés). Les adaptateurs réels
 * décomptent déjà via `executeWithinBudget` : rien n'est alors ajouté.
 */
function reconcilierBudget(budget: AiCallBudget, avant: number, attendu: number): void {
  const decompte = budget.used - avant;
  if (decompte < attendu) budget.consume(attendu - decompte);
}

/** Applique une échéance globale à une promesse (§30.2). */
async function withDeadline<T>(p: Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error('REQUEST_TIMEOUT');
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('REQUEST_TIMEOUT')), remaining)),
  ]);
}
