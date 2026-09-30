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
  AssistantRequestInput, AssistantRunResult, IntentRoute, ResponseMode, VerebonaErrorCode,
} from '../types/contracts';
import type { RetrievedSource, ResolvedSource, Claim } from '../types/sources';
import type { VerebonaAction } from '../types/actions';
import { getAssistantConfig } from '../config/assistant-config';
import { ConversationMachine } from './conversation-machine';
import { routeClarificationReason, routeDeterministic, routeForIntent } from './intent-router.service';
import { analyserPeriode, aujourdhuiParis } from './query-period';
import {
  buildActionClarification,
  buildAssetClarification,
  buildPeriodClarification,
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
  nearResultsAnswer,
  type DataAnswerOutcome,
} from './data-answer.service';
import { dedupeLogique } from './source-dedupe';
import { DEFAULT_THRESHOLDS, type CascadeThresholdsLike } from './sufficiency';
import {
  contradictionAnswer, detectHelpContradiction, fallbackFromHelpSources, HELP_EXACT_THRESHOLD,
  isHelpIntent, type HelpCorpus,
} from './help-corpus.service';
import { MONTHLY_BUDGET_NOTICE } from './budget.service';

/** Repli sans modèle pendant un arrêt d'urgence ou une désactivation de T2 (T2-041, WF-34). */
export const AI_UNAVAILABLE_NOTICE =
  'La partie « réponse rédigée » de l’assistant est momentanément indisponible : '
  + 'cette réponse est construite à partir de vos données uniquement. La recherche et le Centre d’aide restent disponibles.';
import { createAiCallBudget, type AiCallBudget } from './ai-call-budget';
import { findNavigationTarget } from './navigation-targets';
import { assistantErrorMessage } from '@/lib/verebona/error-messages';
import { isAssistantFlagOn } from '../config/assistant-flags';
import { buildResultGroups } from './result-groups';
import { foundWithoutInfoMessage } from './document-status';
import { getIntentDefinition } from '../registries/intent-registry';
import { ROUTES } from './entity-ref';
import { canonicalReadEnabled } from '../canonical/mode';
import { targetsFromInput, type AssistantTargets } from './assistant-targets';
import type { TargetAnswer } from './target-answer';
import { clientTimelineEvents, planTimelineEvents, timelineAnswer, type SynthesisPlan } from './synthesis-planner';
import { documentSearchFilters, hasDocumentFilters } from './query-terms';
import { CLARIFICATION_TTL_MS } from './clarification-builder';
import type { VerebonaIntent } from '../types/intents';

/** Ports injectés (implémentés par les autres services / le repo). */
export interface OrchestratorPorts {
  retrieve(route: IntentRoute, input: AssistantRequestInput): Promise<RetrievedSource[]>;
  /**
   * Résultats proches (§11.4) : seconde passe tolérante, appelée seulement
   * quand la recherche n'a rien trouvé. Absent : pas de résultats proches.
   */
  retrieveNear?(route: IntentRoute, input: AssistantRequestInput): Promise<RetrievedSource[]>;
  resolveSources(sources: RetrievedSource[], accountId: number): Promise<ResolvedSource[]>;
  classifyWithAI?(message: string, input: AssistantRequestInput): Promise<IntentRoute | null>;
  generateWithAI?(
    route: IntentRoute, sources: RetrievedSource[], input: AssistantRequestInput,
  ): Promise<{
    answer: string; claims: Claim[]; actions: VerebonaAction[]; supportLevel: AssistantRunResult['supportLevel'];
    model?: string; path?: 'first' | 'repair' | 'escalation';
    /** Chronologie structurée (T2-35, master T2 format `timeline`). */
    events?: Array<{ date: string | null; text: string; sourceIds: string[] }>;
  } | null>;
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
  /**
   * La partie IA de T2 est-elle bloquée par l'exploitation (arrêt d'urgence,
   * T2 désactivé ou suspendu) ? Consulté seulement au repli sans modèle, pour
   * dire à l'utilisateur que c'est l'IA — et non ses données — qui manque
   * (CDC BO IA T2-041, WF-34 étape 3). Absent : aucun message.
   */
  isAiUnavailable?(): Promise<boolean>;
  /** Plafond budgétaire mensuel du compte (§6.6, §31.3). Absent : pas de plafond. */
  checkMonthlyBudget?(accountId: number): Promise<{ allowed: boolean }>;
  /**
   * CDC 15 T2-19, T2-20, T2-21 (ASSISTANT_CANONICAL_READ=enabled) : lecture
   * ciblée d'un document ou d'une échéance déjà désignés (page, fil,
   * clarification) — « quel est le montant ? », « et sa date ? ». `null` :
   * la question ne porte pas sur la cible, la demande suit son cours.
   */
  readTarget?(input: AssistantRequestInput, targets: AssistantTargets, route?: IntentRoute): Promise<TargetAnswer | null>;
  /**
   * CDC 15 T2-10, T2-33, T2-34 (ASSISTANT_CANONICAL_READ=enabled) :
   * planificateurs dédiés de synthèse, comparaison et chronologie. `null` :
   * pas de plan (recherche générique en repli).
   */
  buildSynthesisContext?(route: IntentRoute, input: AssistantRequestInput): Promise<SynthesisPlan | null>;
}

export async function runAssistant(
  input: AssistantRequestInput,
  ports: OrchestratorPorts,
): Promise<AssistantRunResult> {
  const cfg = getAssistantConfig();
  // §39 `verebona_assistant_account_ai` / VEREBONA_ASSISTANT_AI_ENABLED, lus
  // à CHAQUE demande : coupés, aucun appel modèle (rollback « désactiver
  // l'IA » en gardant recherche classique et aide).
  const aiActif = cfg.aiEnabled && isAssistantFlagOn('account_ai');
  // ── Budget d'appels modèle du message (§15.5, CA-07) ──────────────────
  // Un seul compteur pour classification, revalidation et génération,
  // replis compris. Partagé par référence : les copies `{ ...input }`
  // successives gardent le même objet.
  const budget: AiCallBudget = input.aiBudget ?? createAiCallBudget(cfg.maxAiCallsPerRequest);
  // Identifiant RÉSERVÉ par la route (ligne `pending`, annulable) s'il
  // existe ; sinon généré ici (reprise de clarification, tests).
  const requestId = input.requestId ?? randomUUID();
  // Rapport des appels modèle (sécurité, réparation, escalade), partagé par
  // référence comme le budget et versé dans la trace à la fin.
  const aiReport = input.aiReport ?? { securityEvents: [], events: [] };
  input = { ...input, aiBudget: budget, requestId, aiReport };
  const messageId = randomUUID();
  const machine = new ConversationMachine('IDLE');
  const deadline = Date.now() + cfg.totalTimeoutMs;
  // §30.1 : retrieval déterministe borné à 3 s (dans l'échéance globale).
  const retrievalDeadline = () => Math.min(deadline, Date.now() + Math.max(1, cfg.retrievalTimeoutMs || 3000));

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
      if (aiReport.securityEvents.length) trace.securityEvents = [...aiReport.securityEvents];
      if (aiReport.events.length) trace.aiEvents = [...aiReport.events];
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
      return finalize(base, machine, 'deterministic', early.answer.text, early.answer.claims ?? [], resolvedEarly, actions, ports, input,
        early.answer.claims?.length ? 'supported' : null);
    }

    // ══════════════════════════════════════════════════════════════════════
    // COMMANDE MÉTIER — préparation et aperçu, AUCUNE ÉCRITURE ICI
    // ══════════════════════════════════════════════════════════════════════
    // Compte en lecture seule (fin d'essai, §6.5) : aucune commande d'écriture.
    if (ports.prepareCommand && !input.resume && !input.planLimit) {
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

    // ══════════════════════════════════════════════════════════════════════
    // CIBLE DE LA PAGE — CDC 15 T2-21 (lecture canonique)
    //
    // « Quel est le montant ? » sur la page d'un ticket vise CE ticket : la
    // page devient une cible explicite, lue AVANT toute analyse textuelle qui
    // chercherait dans le compte entier. Seulement si la question ne nomme
    // rien d'autre (garde-fou de `answerFromTarget`).
    // ══════════════════════════════════════════════════════════════════════
    if (canonicalReadEnabled() && ports.readTarget && !input.resume) {
      const cibles = targetsFromInput(input);
      if (cibles.primary && (cibles.primary.type === 'document' || cibles.primary.type === 'agenda_item')) {
        const lu = await withDeadline(ports.readTarget(input, cibles), retrievalDeadline()).catch(() => null);
        if (lu) {
          const route = routeForIntent(lu.intent, input.planType, `cible ${cibles.primary.origin}`);
          base.route = route;
          trace.intent = route.intent;
          const actions = await ports.resolveActions(route, input, lu.sources);
          done('structured', lu.strategy, 'SUFFICIENT_STRUCTURED', lu.sources.length);
          const resolvedCible = await ports.resolveSources(lu.sources, input.accountId);
          return finalize(base, machine, 'deterministic', lu.text, lu.claims, resolvedCible, actions, ports, input, 'supported');
        }
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
          pageContext: input.pageContext,
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
          pageContext: input.pageContext,
          helpCorpus: corpus,
        });
        if (viaAide.kind === 'route') outcome = viaAide;
      }
    }

    // La classification IA n'est plus sollicitée d'emblée : c'est un appel
    // modèle, et la cascade doit d'abord tenter les niveaux gratuits.
    let route: IntentRoute = outcome.kind === 'route' ? outcome.route : fallbackUnknownRoute(input.planType);
    route = affinerRoute(route, input);
    const needsClassification = outcome.kind === 'needs_classification';
    base.route = route;
    trace.intent = route.intent;

    // ══════════════════════════════════════════════════════════════════════
    // CLARIFICATION EXIGÉE PAR LE ROUTAGE — §20.1
    //
    // Période non identifiable (« mes factures de mars » sans année) ou
    // action ambiguë (« ajoute », sans objet) : l'utilisateur choisit, rien
    // n'est tranché au hasard. Jamais sur une reprise (la demande rejouée
    // porte déjà le choix) ; sans fil où l'enregistrer, la demande suit son
    // cours normal.
    // ══════════════════════════════════════════════════════════════════════
    if (route.clarificationRequired && !input.resume && ports.saveClarification) {
      const raison = routeClarificationReason(input.message, route.intent);
      const commun = {
        accountId: input.accountId, userId: input.userId, conversationId: input.conversationId,
        originalMessage: input.message, originalMessageId: messageId, originalIntent: route.intent, chainDepth: 1,
      };
      const periode = raison === 'PERIOD_UNIDENTIFIABLE' ? analyserPeriode(input.message, aujourdhuiParis()) : null;
      const state = periode?.kind === 'ambiguous'
        ? buildPeriodClarification({ ...commun, expression: periode.expression, choices: periode.choices })
        : raison === 'ACTION_AMBIGUOUS' ? buildActionClarification(commun) : null;
      if (state && await ports.saveClarification(state).catch(() => false)) {
        trace.escalationReasons.push(`CLARIFICATION:${raison}`);
        done('template', raison === 'PERIOD_UNIDENTIFIABLE' ? 'clarification.period' : 'clarification.action', 'AMBIGUOUS_TARGET', state.candidates.length);
        return finalizeClarification(base, machine, state, ports, input);
      }
    }

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

    // ── Flag §39 `verebona_assistant_product_help` coupé ────────────────────
    // Rollback de l'aide produit : aucune réponse d'aide rédigée, renvoi au
    // Centre d'aide (la recherche classique reste disponible).
    if (isHelpIntent(route.intent) && !isAssistantFlagOn('product_help')) {
      const actions = await ports.resolveActions(route, input, []);
      done('template', 'flag.product_help_off', null, 0);
      return finalize(base, machine, 'deterministic', PRODUCT_HELP_OFF_MESSAGE, [], [], actions, ports, input);
    }

    // ── Réponse déterministe par gabarit (§14) ──────────────────────────────
    // Offre et limite du compte : le gabarit « offre » en dépend (§9.2).
    const detCtx = { planType: input.planType, planLimit: input.planLimit ?? null };
    let det = tryDeterministic(route.intent, detCtx);
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
    if (ports.answerFromData && isDataQuestion(route, input.message)) {
      machine.transition('RETRIEVING');
      data = await withDeadline(ports.answerFromData(route, input, thresholds), retrievalDeadline()).catch(() => null);

      // ══════════════════════════════════════════════════════════════════
      // REVALIDATION CIBLÉE (§ T2) — seulement si les données T1 sont
      // insuffisantes : confiance trop faible ou valeurs en conflit. Le fait
      // amélioré est réinjecté, puis la cascade est rejouée UNE fois sur la
      // connaissance mise à jour.
      // ══════════════════════════════════════════════════════════════════
      if (data?.revalidation && ports.revalidateFacts && !input.revalidationDone && aiActif) {
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
            data = await withDeadline(ports.answerFromData(route, input, thresholds), retrievalDeadline()).catch(() => data);
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
          // Listes et document retrouvé : cartes de résultats (§22.2, §22.3).
          if (CARD_STRATEGIES.has(data.strategy)) base.resultGroups = buildResultGroups(data.sources);
          if (data.documentState) trace.escalationReasons.push(`DOCUMENT:${data.documentState.kind}`);
          return finalize(base, machine, 'deterministic', data.answer, data.claims, resolvedData, actions, ports, input,
            data.decision.status === 'CONFLICTING' ? 'conflicting' : data.documentState ? 'insufficient' : 'supported');
        }
        if (data.decision.reason) trace.escalationReasons.push(`N${data.decision.level}:${data.decision.reason}`);
      }
    }

    // ── Classification IA, seulement maintenant (§9.4.9, §15.5) ────────────
    // Flag §39 `account_ai` (ou VEREBONA_ASSISTANT_AI_ENABLED) coupé : AUCUN
    // appel modèle — ni classification, ni revalidation, ni génération.
    const classifier = needsClassification && ports.classifyWithAI && aiActif && isPlanAiEligible(input.planType);
    if (needsClassification && ports.classifyWithAI && !aiActif) trace.escalationReasons.push('ROUTING:AI_DISABLED');
    if (classifier) {
      if (await avantAppelModele() === 'cancelled') return annuler();
    }
    if (classifier && !budget.canCall()) {
      trace.escalationReasons.push('ROUTING:AI_BUDGET_EXHAUSTED');
    } else if (classifier && ports.classifyWithAI) {
      trace.escalationReasons.push('ROUTING:NO_DETERMINISTIC_RULE');
      const avantCl = budget.used;
      const classified = await ports.classifyWithAI(outcome.kind === 'needs_classification' ? outcome.normalized : input.message, input);
      reconcilierBudget(budget, avantCl, 1);
      trace.aiCalls = budget.used;
      route = affinerRoute(classified ?? fallbackUnknownRoute(input.planType), input);
      base.route = route;
      trace.intent = route.intent;

      // ════════════════════════════════════════════════════════════════
      // CLASSIFICATION AMBIGUË — CDC 15 T2-09 (lecture canonique)
      //
      // Le modèle a répondu `ambiguous` : pas de recherche large sur une
      // demande qu'on n'a pas comprise. Résolution déterministe si une
      // cible est déjà connue (page, fil, clarification) pour une question
      // sur les données ; sinon clarification — les choix viennent du
      // registre des intentions, jamais du modèle.
      // ════════════════════════════════════════════════════════════════
      if (canonicalReadEnabled() && route.clarificationRequired && !input.resume) {
        const cible = targetsFromInput(input, route).primary;
        if (route.intent.startsWith('ACCOUNT_') && cible) {
          trace.escalationReasons.push(`CLASSIFICATION:AMBIGUOUS_RESOLVED_BY_${cible.origin.toUpperCase()}`);
        } else {
          trace.escalationReasons.push('CLARIFICATION:CLASSIFICATION_AMBIGUOUS');
          const state = buildIntentClarification({
            accountId: input.accountId, userId: input.userId, conversationId: input.conversationId,
            originalMessage: input.message, originalMessageId: messageId, proposed: route.intent,
          });
          if (ports.saveClarification && await ports.saveClarification(state).catch(() => false)) {
            done('template', 'clarification.classification', 'AMBIGUOUS_TARGET', state.candidates.length);
            return finalizeClarification(base, machine, state, ports, input);
          }
          // Sans fil où enregistrer la question : la poser quand même, sans
          // chercher (jamais de retrieval sur une demande ambiguë).
          const actions = await ports.resolveActions(route, input, []);
          done('template', 'clarification.classification_unsaved', 'AMBIGUOUS_TARGET', 0);
          return finalize(base, machine, 'deterministic',
            `${state.question} Par exemple : ${state.candidates.map((c) => c.label.toLowerCase()).join(', ')}.`, [], [], actions, ports, input, 'insufficient');
        }
      }

      // L'intention classée peut appeler une réponse imposée (hors périmètre,
      // conseil réservé, demande malveillante, politesse…) : le gabarit
      // s'applique alors, et le besoin de retrieval est réévalué.
      det = tryDeterministic(route.intent, detCtx);
      if (det.handled && det.answer) {
        const actions = await ports.resolveActions(route, input, []);
        done('template', `template.${route.intent}`, 'SUFFICIENT_STRUCTURED', 0);
        return finalize(base, machine, 'deterministic', det.answer, [], [], actions, ports, input);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // FAIT DEMANDÉ PAR LE MASTER T2 — CDC 15 §24 A4 (lecture canonique)
    //
    // `t2_understand` a identifié UN champ du FIELD_CATALOG : s'il porte sur
    // UN bien ciblé (question, fil, page, indice), il est lu sur la fiche
    // canonique, sans recherche ni génération.
    // ══════════════════════════════════════════════════════════════════════
    if (canonicalReadEnabled() && ports.readTarget && route.understanding?.requestedFacts.length) {
      const lu = await withDeadline(ports.readTarget(input, targetsFromInput(input, route), route), retrievalDeadline()).catch(() => null);
      if (lu) {
        const actions = await ports.resolveActions(route, input, lu.sources);
        done('structured', lu.strategy, 'SUFFICIENT_STRUCTURED', lu.sources.length);
        const resolvedFait = await ports.resolveSources(lu.sources, input.accountId);
        return finalize(base, machine, 'deterministic', lu.text, lu.claims, resolvedFait, actions, ports, input, 'supported');
      }
    }

    // ── Retrieval-first (§13) ───────────────────────────────────────────────
    let sources: RetrievedSource[] = [];
    let resolved: ResolvedSource[] = [];
    let plan: SynthesisPlan | null = null;
    if (route.requiresRetrieval || det.needsSimpleRetrieval) {
      if (machine.state !== 'RETRIEVING') machine.transition('RETRIEVING');
      let adapters: RetrievedSource[];
      // Tous les candidats classés (≤ 20, §13.9) : cartes et quotas (§11.3).
      let candidats: RetrievedSource[] = [];
      try {
        // CDC 15 T2-10, T2-33 : planificateur dédié pour une synthèse, une
        // comparaison ou une chronologie ; recherche générique en repli.
        plan = canonicalReadEnabled() && SYNTHESIS_INTENTS.has(route.intent) && ports.buildSynthesisContext
          ? await withDeadline(ports.buildSynthesisContext(route, input), retrievalDeadline()).catch((err) => {
            if ((err as Error)?.message === 'REQUEST_TIMEOUT') throw err;
            return null;
          })
          : null;
        if (plan && plan.sources.length) {
          trace.escalationReasons.push(`SYNTHESIS:${plan.kind}:${plan.sources.length}${plan.timeline ? `:events=${plan.timeline.events.length}/${plan.timeline.totalEvents}` : ''}`);
          candidats = plan.sources;
        } else {
          plan = null;
          candidats = await withDeadline(ports.retrieve(route, input), retrievalDeadline());
        }
        adapters = candidats.slice(0, cfg.maxSources);
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

      // ══════════════════════════════════════════════════════════════════
      // AUCUN RÉSULTAT → RÉSULTATS PROCHES (§11.4)
      //
      // Reformulation, filtre et aide étaient proposés ; les « résultats
      // proches » manquaient. Seconde passe tolérante (fautes, préfixes),
      // même périmètre, au plus 3 cartes présentées comme proches — jamais
      // comme la réponse. Sans modèle, en Standard comme en Premium.
      // ══════════════════════════════════════════════════════════════════
      if (adapters.length === 0 && !data?.documentState && ports.retrieveNear
        && route.intent.startsWith('ACCOUNT_') && !SYNTHESIS_INTENTS.has(route.intent)) {
        const proches = await withDeadline(ports.retrieveNear(route, input), retrievalDeadline()).catch(() => [] as RetrievedSource[]);
        if (proches.length > 0) {
          const resolvedProches = await ports.resolveSources(proches, input.accountId);
          const actions = await ports.resolveActions(route, input, proches);
          done('retrieval', 'retrieval.near', 'INSUFFICIENT', proches.length);
          base.resultGroups = buildResultGroups(proches);
          return finalize(base, machine, 'classic_search', nearResultsAnswer(input.message, proches, isPlanAiEligible(input.planType)),
            [], resolvedProches, actions, ports, input, 'insufficient');
        }
      }

      // Réponse exacte à partir des résultats (tryDeterministicFromRetrieval).
      const exact = answerFromRetrievedSources(route.intent, input.message, adapters, thresholds, {
        candidates: candidats, aiEligible: isPlanAiEligible(input.planType),
      });
      trace.attempts.push({ level: 2, strategy: 'retrieval.adapters', status: exact.decision.status, score: exact.decision.score, threshold: exact.decision.threshold, reason: exact.decision.reason });
      // « Aucun résultat » ne s'applique pas quand un document a été trouvé
      // au niveau 2 sans l'information cherchée (§12.4 : états distincts).
      const documentTrouve = adapters.length === 0 && Boolean(data?.documentState);
      if (exact.handled && exact.answer && (adapters.length > 0 || !route.aiEligible) && !documentTrouve) {
        const resolvedAdapters = adapters.length ? await ports.resolveSources(adapters, input.accountId) : [];
        const actions = await ports.resolveActions(route, input, adapters);
        done('retrieval', 'retrieval.adapters', exact.decision.status, adapters.length);
        if (exact.groups?.length) base.resultGroups = exact.groups;
        return finalize(base, machine, 'classic_search', exact.answer, [], resolvedAdapters, actions, ports, input);
      }
      if (exact.decision.reason) trace.escalationReasons.push(`N2:${exact.decision.reason}`);
    } else if (data?.contextSources.length) {
      sources = dedupeSources(data.contextSources).slice(0, cfg.maxSources);
      resolved = await ports.resolveSources(sources, input.accountId);
    }

    // ── Niveau 3 : modèle, uniquement après insuffisance constatée (§15.1) ──
    const canUseAI =
      aiActif &&
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
        const evenementsAvant = aiReport.events.length;
        const gen = await withDeadline(ports.generateWithAI!(route, sources, input), deadline).catch(() => null);
        reconcilierBudget(budget, avantGen, 1);
        trace.aiCalls = budget.used;
        // §9.6 : une sortie réparée (ou dont la réparation a échoué) passe par
        // l'état REPAIRING — la réparation n'est plus invisible de la machine.
        const repare = gen?.path === 'repair'
          || aiReport.events.slice(evenementsAvant).some((e) => e.startsWith('REPAIR:'));
        if (repare) machine.transition('REPAIRING');
        if (gen) {
          machine.transition('VALIDATING');
          trace.model = gen.model ?? null;
          const actions = gen.actions.length ? gen.actions : await ports.resolveActions(route, input, sources);
          // T2-35 : chronologie structurée transmise au client, liens résolus
          // côté serveur à partir des sources fournies.
          if (gen.events?.length) base.events = clientTimelineEvents(gen.events, sources);
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
    // Document trouvé mais information absente (§12.4, §19.12) : le dire,
    // plutôt que « ces éléments semblent liés ».
    const repli = isHelpIntent(route.intent)
      ? fallbackFromHelpSources(sources)
      // Chronologie planifiée (T2-34) : la liste datée elle-même, sans modèle.
      : plan?.kind === 'timeline' && plan.timeline?.events.length
        ? timelineAnswer(plan)
        : data?.documentState?.kind === 'FOUND_WITHOUT_INFO'
        ? foundWithoutInfoMessage(data.documentState.title)
        : fallbackFromSources(sources);
    if (data?.documentState?.kind === 'FOUND_WITHOUT_INFO') trace.escalationReasons.push('DOCUMENT:FOUND_WITHOUT_INFO');
    // Chronologie planifiée servie sans modèle : liste structurée aussi.
    if (!isHelpIntent(route.intent) && plan?.kind === 'timeline' && plan.timeline?.events.length) base.events = planTimelineEvents(plan);
    // Plafond mensuel : le dire, sans culpabiliser (§6.6).
    // IA bloquée par l'exploitation (EStop, T2 désactivé/suspendu) alors que
    // la question en aurait eu besoin : le dire (T2-041, WF-34 étape 3) —
    // y compris quand aucune source n'a été trouvée : sans IA, l'utilisateur
    // doit savoir pourquoi la réponse est pauvre.
    const iaIndisponible = !budgetMensuelAtteint && route.aiEligible
      && ports.isAiUnavailable != null
      && await ports.isAiUnavailable().catch(() => false);
    if (iaIndisponible) trace.escalationReasons.push('N3:AI_BLOCKED');
    // Fin d'essai / sans abonnement (§6.5) : la question aurait demandé une
    // réponse intelligente — l'assistant explique la limite et propose la
    // page des offres. La recherche et l'aide restent servies normalement.
    const limiteOffre = Boolean(input.planLimit) && !isPlanAiEligible(input.planType)
      && (needsClassification || getIntentDefinition(route.intent).geminiEligible);
    if (limiteOffre) trace.escalationReasons.push(`PLAN_LIMIT:${input.planLimit}`);
    const answerBase = budgetMensuelAtteint && route.aiEligible
      ? `${repli}\n\n${MONTHLY_BUDGET_NOTICE}`
      : iaIndisponible ? `${repli}\n\n${AI_UNAVAILABLE_NOTICE}` : repli;
    const answer = limiteOffre ? `${answerBase}\n\n${planLimitNotice(input.planLimit!)}` : answerBase;
    const actionsResolues = await ports.resolveActions(route, input, sources);
    const actions = limiteOffre && !actionsResolues.some((a) => a.type === 'OPEN_PRICING')
      ? [pricingAction(), ...actionsResolues]
      : actionsResolues;
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
  answer?: {
    text: string; sources: RetrievedSource[]; strategy: string;
    intent: 'NAVIGATION_OPEN' | 'ACCOUNT_FACT_DOCUMENT' | 'ACCOUNT_FACT_AGENDA' | 'ACCOUNT_FACT_ASSET';
    claims?: Claim[];
  };
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
    // CDC 15 T2-19 (lecture canonique) : document choisi → lecture ciblée
    // (« son montant »), avant les réponses immédiates historiques.
    if (ref.type === 'document') {
      const lu = await lectureCiblee(enriched, ports);
      if (lu) return { input: enriched, contextUpdate: update, answer: lu };
    }
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
  // CDC 15 T2-19, T2-20 (lecture canonique) : « et son montant ? », « et sa
  // date ? » sur le document ou l'échéance cités — lus sur l'objet lui-même.
  const lu = await lectureCiblee(enriched, ports);
  if (lu) return { input: enriched, contextUpdate, answer: lu };
  const quick = quickAnswer(input.message, res.entity.type, res.entity.id, d, res.detected);
  return quick ? { input: enriched, contextUpdate, answer: quick } : { input: enriched, contextUpdate };
}

/** Lecture ciblée (canonique) d'une entité du fil ou d'une clarification. */
async function lectureCiblee(
  input: AssistantRequestInput,
  ports: OrchestratorPorts,
): Promise<NonNullable<Awaited<ReturnType<typeof applyThreadMemory>>['answer']> | null> {
  if (!canonicalReadEnabled() || !ports.readTarget) return null;
  const lu = await ports.readTarget(input, targetsFromInput(input)).catch(() => null);
  return lu ? { text: lu.text, sources: lu.sources, strategy: lu.strategy, intent: lu.intent, claims: lu.claims } : null;
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
function isDataQuestion(route: IntentRoute, message = ''): boolean {
  // Synthèse, comparaison, chronologie : une valeur exacte n'y répond pas —
  // ces intentions vont directement au retrieval puis, si éligible, au modèle.
  if (SYNTHESIS_INTENTS.has(route.intent)) return false;
  // CDC 15 T2-14 (lecture canonique) : une recherche de documents FILTRÉE
  // (non rattachés, statut d'analyse, fournisseur) est servie par
  // l'adaptateur documents, seul à appliquer ces filtres exactement.
  if (canonicalReadEnabled() && route.intent === 'ACCOUNT_SEARCH_DOCUMENT' && hasDocumentFilters(documentSearchFilters(message).filters)) return false;
  return route.intent.startsWith('ACCOUNT_') || route.intent === 'UNKNOWN';
}

/**
 * Correction de route, lecture canonique (CDC 15 T2-14) : « quels documents
 * sont en cours d'analyse ? » ou « … ne sont rattachés à aucun bien ? » est
 * une RECHERCHE de documents filtrée, pas une synthèse. Sans effet en legacy.
 */
export function affinerRoute(route: IntentRoute, input: Pick<AssistantRequestInput, 'message' | 'planType'>): IntentRoute {
  if (!canonicalReadEnabled()) return route;
  if (route.intent !== 'ACCOUNT_SUMMARY' && route.intent !== 'UNKNOWN') return route;
  const plainMsg = plainTxt(input.message ?? '');
  if (!/\b(documents?|fichiers?|factures?|devis|contrats?|pieces?)\b/.test(plainMsg)) return route;
  if (!hasDocumentFilters(documentSearchFilters(input.message ?? '').filters)) return route;
  return { ...routeForIntent('ACCOUNT_SEARCH_DOCUMENT', input.planType, 'recherche de documents filtrée'), entityHints: route.entityHints };
}

/**
 * Clarification d'une classification ambiguë — CDC 15 T2-09. Choix issus du
 * registre des intentions (l'intention proposée par le modèle d'abord) ; la
 * reprise rejoue la demande avec l'intention choisie, sans re-classement.
 */
export function buildIntentClarification(p: {
  accountId: number; userId: number; conversationId?: number;
  originalMessage: string; originalMessageId: string; proposed: VerebonaIntent; now?: Date;
}): ClarificationState {
  const now = p.now ?? new Date();
  const CHOIX: Array<[VerebonaIntent, string]> = [
    ['ACCOUNT_SEARCH_DOCUMENT', 'Retrouver un document'],
    ['ACCOUNT_SEARCH_AGENDA', 'Retrouver une échéance'],
    ['ACCOUNT_FACT_ASSET', 'Une information sur un bien'],
    ['PRODUCT_HELP_HOW_TO', 'Savoir comment faire dans Verebona'],
  ];
  const propose = p.proposed.startsWith('ACCOUNT_') || p.proposed.startsWith('PRODUCT_HELP')
    ? [[p.proposed, getIntentDefinition(p.proposed).label] as [VerebonaIntent, string]] : [];
  const choix = [...propose, ...CHOIX.filter(([i]) => i !== p.proposed)].slice(0, 4);
  return {
    clarificationId: randomUUID(),
    conversationId: p.conversationId, accountId: p.accountId, userId: p.userId,
    originalMessageId: p.originalMessageId, originalMessage: p.originalMessage, originalIntent: p.proposed,
    resolvedContext: {},
    ambiguity: { kind: 'action', field: 'intent', reason: 'CLASSIFICATION_AMBIGUOUS' },
    candidateType: 'action',
    candidates: choix.map(([intent, label]) => ({ id: `intent_${intent.toLowerCase()}`, label, resumeMessage: p.originalMessage, resumeIntent: intent })),
    question: 'Je ne suis pas sûr de comprendre votre demande. Que cherchez-vous ?',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CLARIFICATION_TTL_MS).toISOString(),
    attemptCount: 0, chainDepth: 1, status: 'PENDING',
  };
}

const SYNTHESIS_INTENTS = new Set(['ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE']);

/** Dédoublonnage logique (§13.8) : même entité, même contenu, copie. */
function dedupeSources(list: RetrievedSource[]): RetrievedSource[] {
  return dedupeLogique(list);
}

/** Stratégies dont le résultat est une liste d'objets : rendu en cartes. */
const CARD_STRATEGIES = new Set<string>([
  'structured.list_documents', 'structured.list_assets', 'structured.list_rented', 'retrieval.document',
  'retrieval.document_status',
  // Statut d'un document en question directe et exports disponibles (§12.1, §12.2).
  'structured.document_status', 'structured.exports',
]);

/** Flag `verebona_assistant_product_help` coupé (§39). */
export const PRODUCT_HELP_OFF_MESSAGE =
  'L’aide de l’assistant est momentanément indisponible. Vous pouvez consulter le Centre d’aide Verebona.';

/** Limite d'offre à l'expiration de l'essai ou sans abonnement (§6.5). */
export function planLimitNotice(kind: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED'): string {
  return kind === 'TRIAL_EXPIRED'
    ? 'Votre essai est terminé : les réponses intelligentes sont désactivées tant qu’une offre n’est pas choisie. La recherche et l’aide restent disponibles.'
    : 'Les réponses intelligentes demandent une offre active. La recherche et l’aide restent disponibles.';
}

/** Action « Voir les offres » (§6.5, catalogue §22.4), construite côté serveur. */
function pricingAction(): VerebonaAction {
  return {
    actionId: randomUUID(), type: 'OPEN_PRICING', label: 'Voir les offres', href: ROUTES.OFFRES,
    token: null, requiresConfirmation: false, expiresAt: null, analyticsCode: 'verebona.action.open_pricing',
  };
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
  // l'affichage produirait un lien mort, et l'historique conservé
  // `historyDays` jours (3 mois, CDC 15 T2-46) en produirait davantage encore.
  //
  // Ne lève jamais : une vérification impossible ne doit pas empêcher
  // l'affichage d'une réponse.
  const sourcesVerifiees = trierParContribution(
    await marquerDisponibilite(sources, input.accountId).catch(() => sources),
    claims,
  );

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
 * Ordre d'affichage des sources — §19.4 : d'abord celles qui soutiennent le
 * plus d'affirmations (la première affirmation, principale, départage), puis
 * le score de retrieval ; à égalité, l'ordre d'origine. Sans affirmation,
 * l'ordre du retrieval est conservé tel quel.
 */
export function trierParContribution(sources: ResolvedSource[], claims: Claim[]): ResolvedSource[] {
  if (sources.length < 2 || claims.length === 0) return sources;
  const citations = new Map<string, number>();
  const principale = new Set(claims[0]?.sourceIds ?? []);
  for (const c of claims) for (const id of new Set(c.sourceIds)) citations.set(id, (citations.get(id) ?? 0) + 1);
  return sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      (citations.get(b.s.id) ?? 0) - (citations.get(a.s.id) ?? 0)
      || Number(principale.has(b.s.id)) - Number(principale.has(a.s.id))
      || (b.s.relevanceScore ?? 0) - (a.s.relevanceScore ?? 0)
      || a.i - b.i)
    .map((x) => x.s);
}

/**
 * Persiste puis reporte les identifiants de la base sur le résultat : le
 * messageId rendu au client doit être celui que les routes sources /
 * explication / avis savent retrouver, et conversationId le fil réellement
 * utilisé.
 */
async function safePersist(ports: OrchestratorPorts, r: AssistantRunResult, input: AssistantRequestInput) {
  // §27.11 : codes informatifs (non bloquants), calculés sur le résultat
  // final — ils partent avec la réponse et restent dans la trace.
  const notices = noticesFor(r);
  if (notices.length) {
    r.notices = notices;
    if (r.cascade) r.cascade.notices = notices.map((n) => n.code);
  }
  // §28.7 : retrieval servi par le cache (§43 RETRIEVAL_CACHE_TTL_SECONDS).
  if (r.cascade && (input.aiReport?.events ?? []).includes(RETRIEVAL_CACHE_HIT_EVENT)) r.cascade.cacheHit = true;
  try {
    const ids = await ports.persist(r, input);
    if (ids) {
      r.messageId = String(ids.messageId);
      r.conversationId = ids.conversationId;
    }
  } catch (e) { console.error('[verebona] persist error', (e as Error).message); }
}

/** Événement posé par le port de retrieval quand le cache a répondu (§43). */
export const RETRIEVAL_CACHE_HIT_EVENT = 'CACHE:RETRIEVAL';

/**
 * Codes fonctionnels du §27.11 émis À TITRE INFORMATIF avec une réponse
 * rendue — ils étaient déclarés (`VEREBONA_ERROR_CODES`) sans jamais être
 * émis. Une erreur bloquante garde son propre `error` ; aucun code n'est
 * doublé.
 *
 *   PLAN_NOT_ELIGIBLE   la réponse intelligente dépasse l'offre (§6.5) ;
 *   NO_RELEVANT_SOURCE  repli sans aucune source pertinente ;
 *   INVALID_ACTION      action proposée par le modèle rejetée (§22.7, 37.12) ;
 *   SOURCE_UNAVAILABLE  une source citée n'existe plus ou n'est plus
 *                       accessible (§19.10) ;
 *   VALIDATION_FAILED   sortie modèle rejetée par la validation serveur
 *                       (§18.5, §18.6) — repli déterministe servi ;
 *   UNSAFE_REQUEST      demande refusée : sujet réservé, malveillance (§13,
 *                       §29.2).
 */
export function noticesFor(r: AssistantRunResult): NonNullable<AssistantRunResult['notices']> {
  const codes = new Set<VerebonaErrorCode>();
  const c = r.cascade;
  const raisons = c?.escalationReasons ?? [];
  if (raisons.some((x) => x.startsWith('PLAN_LIMIT:'))) codes.add('PLAN_NOT_ELIGIBLE');
  if (r.finalState !== 'CANCELLED' && !r.error && !r.clarification && !r.commandPlan
      && c?.answeredBy === 'fallback' && r.sources.length === 0 && c.strategy.startsWith('fallback.')) {
    codes.add('NO_RELEVANT_SOURCE');
  }
  if ((c?.securityEvents ?? []).some((e) => e.code === 'MODEL_ACTION_REJECTED')) codes.add('INVALID_ACTION');
  if (r.sources.some((s) => s.isAvailable === false)) codes.add('SOURCE_UNAVAILABLE');
  if ((c?.aiEvents ?? []).some((e) => e.startsWith('GENERATION_REJECTED:') || e === 'REPAIR_FAILED')) codes.add('VALIDATION_FAILED');
  if (r.blockedReason || r.scope?.kind === 'FULLY_BLOCKED' || r.scope?.kind === 'PARTIALLY_ALLOWED'
      || r.route?.intent === 'UNSAFE_OR_MALICIOUS' || r.route?.intent === 'SENSITIVE_ADVICE') {
    codes.add('UNSAFE_REQUEST');
  }
  if (r.error) codes.delete(r.error.code);
  return [...codes].map((code) => ({ code, message: assistantErrorMessage(code) }));
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
