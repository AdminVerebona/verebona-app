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
import { routeDeterministic } from './intent-router.service';
import { checkBlockedTopic } from './blocked-topics';
import { tryDeterministic } from './deterministic-answer.service';
import { isPlanAiEligible } from '../registries/capability-registry';

/** Ports injectés (implémentés par les autres services / le repo). */
export interface OrchestratorPorts {
  retrieve(route: IntentRoute, input: AssistantRequestInput): Promise<RetrievedSource[]>;
  resolveSources(sources: RetrievedSource[], accountId: number): Promise<ResolvedSource[]>;
  classifyWithAI?(message: string, input: AssistantRequestInput): Promise<IntentRoute | null>;
  generateWithAI?(
    route: IntentRoute, sources: RetrievedSource[], input: AssistantRequestInput,
  ): Promise<{ answer: string; claims: Claim[]; actions: VerebonaAction[]; supportLevel: AssistantRunResult['supportLevel'] } | null>;
  resolveActions(route: IntentRoute, input: AssistantRequestInput, entityIds: Set<string>): Promise<VerebonaAction[]>;
  persist(result: AssistantRunResult, input: AssistantRequestInput): Promise<void>;
  hasPendingClarification(accountId: number): Promise<boolean>;
}

export async function runAssistant(
  input: AssistantRequestInput,
  ports: OrchestratorPorts,
): Promise<AssistantRunResult> {
  const cfg = getAssistantConfig();
  const requestId = randomUUID();
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
    const sujet = checkBlockedTopic(input.message ?? '');
    if (sujet.blocked) {
      machine.transition('READY');
      return {
        ...base,
        finalState: 'READY',
        mode: 'deterministic',
        answer: sujet.message ?? "Cette question sort du périmètre de l'assistant.",
        // Ni source ni action : rien n'a été lu, et aucune suite n'est
        // proposée sur un sujet refusé.
        sources: [],
        claims: [],
        actions: [],
        blockedReason: sujet.reason,
      };
    }

    // ── Routage (§9.4) ──────────────────────────────────────────────────────
    machine.transition('ROUTING');
    const hasPending = await ports.hasPendingClarification(input.accountId);
    const outcome = routeDeterministic({
      message: input.message,
      planType: input.planType,
      hasPendingClarification: hasPending,
      pageRoute: input.pageContext?.route,
    });

    let route: IntentRoute;
    if (outcome.kind === 'route') {
      route = outcome.route;
    } else if (ports.classifyWithAI && isPlanAiEligible(input.planType)) {
      // Classification IA en dernier recours (compte comme 1 appel — §15.5).
      const classified = await ports.classifyWithAI(outcome.normalized, input);
      route = classified ?? fallbackUnknownRoute(input.planType);
    } else {
      route = fallbackUnknownRoute(input.planType);
    }
    base.route = route;

    // ── Réponse déterministe (§14) ──────────────────────────────────────────
    const det = tryDeterministic(route.intent);
    if (det.handled && det.answer) {
      const actions = await ports.resolveActions(route, input, new Set());
      return finalize(base, machine, 'deterministic', det.answer, [], [], actions, ports, input);
    }

    // ── Retrieval-first (§13) ───────────────────────────────────────────────
    let sources: RetrievedSource[] = [];
    let resolved: ResolvedSource[] = [];
    if (route.requiresRetrieval || det.needsSimpleRetrieval) {
      machine.transition('RETRIEVING');
      sources = (await withDeadline(ports.retrieve(route, input), deadline)).slice(0, cfg.maxSources);
      resolved = await ports.resolveSources(sources, input.accountId);

      // Seuil d'insuffisance (§13.10) → réponse partielle honnête, sans IA inventée.
      if (sources.length === 0 && !route.aiEligible) {
        const answer = "Je n’ai rien trouvé de correspondant dans votre compte. Vous pouvez reformuler ou préciser votre recherche.";
        const actions = await ports.resolveActions(route, input, new Set());
        return finalize(base, machine, 'classic_search', answer, [], resolved, actions, ports, input);
      }
    }

    // ── Décision IA (§15.1) : offre éligible + intention éligible + sources ──
    const entityIds = new Set(sources.map((s) => s.id));
    const canUseAI =
      cfg.aiEnabled &&
      route.aiEligible &&
      ports.generateWithAI != null &&
      sources.length > 0;

    if (canUseAI) {
      const okGuard = machine.transition('GENERATING', {
        aiAllowed: true,
        clarificationCount: 0,
      });
      if (okGuard) {
        const gen = await withDeadline(ports.generateWithAI!(route, sources, input), deadline).catch(() => null);
        if (gen) {
          machine.transition('VALIDATING');
          // (La validation détaillée est faite dans generateWithAI via response-validator.)
          const actions = gen.actions.length ? gen.actions : await ports.resolveActions(route, input, entityIds);
          return finalize(base, machine, 'ai', gen.answer, gen.claims, resolved, actions, ports, input, gen.supportLevel);
        }
      }
      // Repli déterministe si l'IA échoue/expire (§30.3).
      machine.fail(false);
    }

    // ── Repli : réponse « sources seules » (§12.4) ──────────────────────────
    const answer = resolved.length
      ? "Voici ce que j’ai trouvé dans votre compte."
      : "Je n’ai pas assez d’éléments pour répondre précisément. Souhaitez-vous préciser votre demande ?";
    const actions = await ports.resolveActions(route, input, entityIds);
    return finalize(base, machine, resolved.length ? 'classic_search' : 'fallback', answer, [], resolved, actions, ports, input);
  } catch (e) {
    machine.fail(true);
    const result: AssistantRunResult = {
      ...base,
      finalState: machine.state,
      error: { code: 'ASSISTANT_UNAVAILABLE', message: (e as Error).message, recoverable: true },
      answer: "Je rencontre un souci technique. Vous pouvez réessayer dans un instant.",
    };
    await safePersist(ports, result, input);
    return result;
  }
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
  const result: AssistantRunResult = {
    ...base, finalState: machine.state, mode, answer, claims, sources, actions, supportLevel,
  };
  await safePersist(ports, result, input);
  return result;
}

async function safePersist(ports: OrchestratorPorts, r: AssistantRunResult, input: AssistantRequestInput) {
  try { await ports.persist(r, input); } catch (e) { console.error('[verebona] persist error', (e as Error).message); }
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
