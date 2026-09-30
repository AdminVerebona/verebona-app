/**
 * Génération de la réponse de l'assistant — opération `generate_answer`,
 * usage IA n°3. CDC §15.1, §12.4 et §30.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE FICHIER DÉBLOQUE
 *
 * `ports.ts` portait `generateWithAI: undefined`, avec le commentaire « Phase 3
 * branchera la génération réelle ». L'orchestrateur teste ce port avant de
 * décider d'appeler un modèle :
 *
 *     const canUseAI = cfg.aiEnabled && route.aiEligible
 *                   && ports.generateWithAI != null && sources.length > 0;
 *
 * Le port valant `undefined`, la condition était toujours fausse. **L'assistant
 * n'a jamais appelé de modèle** : il répondait uniquement par ses règles
 * déterministes, ou par le repli « voici ce que j'ai trouvé dans votre compte ».
 * Les neuf outils de lecture fonctionnaient, leur résultat n'était jamais
 * rédigé.
 *
 * La bascule reste gouvernée par `AI_INTELLIGENT_ASSISTANT` : tant qu'il vaut
 * `legacy`, ce port reste indéfini et le comportement ne change pas d'un iota.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import {
  callWithRepairOrEscalation, canEscalate, classifyModelFailure, escalate, repairInstruction,
  type EscalationReason,
} from './model-call-policy';
import { logSecurityEvents, sanitizeModelText, type SecurityEvent } from './output-safety';
import { fitToInputBudget } from './context-budget';
import { applySensitiveDataPolicy, maskSensitiveText, sensitiveNecessityFor } from './sensitive-data.policy';
import { getAssistantConfig } from '../config/assistant-config';
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import { assistantIdempotencyKey } from './assistant-cache-key';
import { isUseCaseRunning } from '@/services/ai/flags/use-case-flags';
import type { IntentRoute, AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource, Claim, SupportLevel } from '../types/sources';
import { isHelpIntent } from './help-corpus.service';
import { intentTaskFor } from '../prompts/intent-tasks';
import { validateGeneratedAnswer } from './response-validator.service';
import { findForbiddenVocabulary } from './output-safety';
import { RESPONSE_SCHEMA_VERSION } from '../types/contracts';
import { VEREBONA_INTENTS } from '../types/intents';
import { VEREBONA_ACTION_TYPES } from '../types/actions';
import { describeAccountRights } from '../prompts/rights-layer';
import { areWriteCommandsEnabled } from '../config/assistant-config';
import { getPromptArchitecture } from '@/services/ai/config/config-resolver';
import { T2AnswerOutput, type T2ClaimSupport } from '@/services/ai/assistant/master/t2-contract';
import {
  t2MasterVariables, formatT2Sources, formatResolvedTargets, t2AnswerLines,
} from '@/services/ai/assistant/master/t2-answer';
import { verifyClaimSupport } from '@/services/ai/assistant/claim-support';
import { canonicalReadEnabled } from '../canonical/mode';
import { answerFormatFor } from '../prompts/answer-format';

/**
 * Schéma de la réponse attendue du modèle — CDC §18.2, §18.4, §17.8.
 *
 * STRICT : `schemaVersion`, `intent` et `supportLevel` sont obligatoires,
 * les intentions et types d'action sont des énumérations FERMÉES (catalogues
 * versionnés), et tout champ non prévu fait rejeter la sortie (`.strict()`,
 * §17.8 « les champs non autorisés sont rejetés ») — ce qui déclenche UNE
 * réparation (§18.6), puis le repli déterministe.
 *
 * `sourceIds` est obligatoire sur chaque affirmation : le prompt annonce
 * qu'une affirmation sans source valide sera supprimée avant affichage, et
 * c'est la validation en aval qui l'applique.
 */
const SUPPORT_LEVELS = ['supported', 'partial', 'insufficient', 'conflicting'] as const;
const DERIVATIONS = ['direct', 'calculated', 'synthesized'] as const;

export const AssistantAnswerOutput = z.object({
  schemaVersion: z.literal(RESPONSE_SCHEMA_VERSION),
  /** Intention du catalogue fermé ; comparée à l'intention routée (§18.5). */
  intent: z.enum(VEREBONA_INTENTS),
  /** Niveau d'étayage annoncé par le modèle (§18.3) — croisé avec celui du serveur. */
  supportLevel: z.enum(SUPPORT_LEVELS),
  /**
   * Texte rédigé par le modèle. Facultatif, et JAMAIS affiché tel quel : la
   * réponse rendue est reconstruite à partir des seules affirmations validées
   * (voir `toGeneratedAnswer`). Le prompt ne le demande d'ailleurs pas.
   */
  answer: z.string().max(4000).optional(),
  claims: z.array(z.object({
    claimKey: z.string().max(80).optional(),
    text: z.string().min(1),
    // Le prompt montre des identifiants entre crochets ; on accepte nombre ou
    // chaîne, comparés ensuite aux identifiants réels des sources.
    sourceIds: z.array(z.union([z.string(), z.number()]).transform(String)).default([]),
    /** `false` : phrase de transition, sans information. Absent : factuelle. */
    factual: z.boolean().optional(),
    derivation: z.enum(DERIVATIONS).optional(),
  }).strict()).default([]),
  status: z.enum(['answered', 'insufficient_data']).optional(),
  /** Catalogue FERMÉ (§22.4) ; jamais exécutées ni affichées (§22.1). */
  actionIntents: z.array(z.object({
    type: z.enum(VEREBONA_ACTION_TYPES),
    targetId: z.union([z.string(), z.number()]).transform(String).optional(),
  }).strict()).default([]),
  /** Nature de l'affirmation : lue telle quelle, calculée, ou synthétisée. */
  derivations: z.array(z.enum(DERIVATIONS)).default([]),
  /** La clarification est construite par le serveur, jamais par le modèle (§20). */
  clarification: z.null().optional(),
}).strict();

export type AssistantAnswer = z.infer<typeof AssistantAnswerOutput>;

/** Sortie attendue par `OrchestratorPorts.generateWithAI`. */
export interface GeneratedAnswer {
  answer: string;
  claims: Claim[];
  actions: [];
  supportLevel: SupportLevel;
  /** Modèle effectivement appelé (trace T2). */
  model?: string;
  /**
   * Actions, URL, balisage ou sources inventées rejetés dans la sortie du
   * modèle (§18.7, CA-09, 37.12) — enregistrés dans la trace de la demande.
   */
  securityEvents?: SecurityEvent[];
  /** Réparation / escalade effectuées (§15.4, §18.6), et contexte tronqué (§13.9). */
  generationEvents?: string[];
  /**
   * Chemin de l'appel (§9.6) : `repair` = la sortie a été RÉPARÉE — la
   * machine à états passe alors par REPAIRING avant VALIDATING.
   */
  path?: 'first' | 'repair' | 'escalation';
  /**
   * Chronologie STRUCTURÉE (T2-35, master T2 format `timeline`) : un
   * événement par ligne validée, dans l'ordre fourni. `answer` en porte la
   * forme texte, une ligne par événement.
   */
  events?: AnswerTimelineEvent[];
  /** Architecture du prompt qui a produit la réponse (trace). */
  architecture?: 'steps' | 'master';
}

/** Événement de chronologie validé (T2-35). */
export interface AnswerTimelineEvent {
  /** AAAA-MM-JJ, ou `null` (date inconnue). */
  date: string | null;
  text: string;
  sourceIds: string[];
}

/** Rejet d'une génération : motif tracé par l'orchestrateur. */
export interface GenerationFailure {
  failed: true;
  reason: string;
  securityEvents: SecurityEvent[];
  generationEvents: string[];
}

/** Forme attendue, rappelée à la réparation (§18.6). */
const SCHEMA_DESCRIPTION =
  `{"schemaVersion":"${RESPONSE_SCHEMA_VERSION}","intent":"<code de l'intention reconnue>",`
  + '"supportLevel":"supported"|"partial"|"insufficient"|"conflicting",'
  + '"claims":[{"text":"phrase en français","sourceIds":["id de source fourni"],"factual":true}],'
  + '"status":"answered"|"insufficient_data","actionIntents":[]} — aucun autre champ';

/** Forme attendue de la branche ANSWER du master T2 (§24), rappelée à la réparation. */
const T2_ANSWER_SCHEMA_DESCRIPTION =
  '{"mode":"ANSWER","format":"claims","status":"answered"|"insufficient_data",'
  + '"claims":[{"text":"phrase en français","sourceIds":["id de source fourni"],"factual":true}]}'
  + ' ou {"mode":"ANSWER","format":"timeline","status":"answered","events":[{"date":"AAAA-MM-JJ"|null,"text":"…","sourceIds":["…"]}]}'
  + ' ou {"mode":"ANSWER","format":"comparison","status":"answered","criterion":"…","items":[{"targetId":"…","label":"…","value":"…"|null,"sourceIds":["…"]}]}';

/**
 * Rédige une réponse à partir des seules sources remontées par les outils.
 *
 * Rend `null` en cas d'échec — jamais une exception. L'orchestrateur traite
 * `null` comme un repli déterministe (§30.3) : l'utilisateur reçoit alors la
 * réponse « sources seules », qui reste correcte. Une exception, elle,
 * remonterait jusqu'à la réponse HTTP et transformerait une dégradation prévue
 * en panne visible.
 *
 * Les motifs (sécurité, réparation, escalade, troncature) sont versés dans
 * `input.aiReport`, partagé par référence avec l'orchestrateur, qui les
 * enregistre dans la trace de la demande — succès comme échec.
 */
export async function generateAssistantAnswer(
  route: IntentRoute,
  sources: RetrievedSource[],
  input: AssistantRequestInput,
): Promise<GeneratedAnswer | null> {
  const r = await generateAssistantAnswerDetailed(route, sources, input);
  if (input.aiReport) {
    input.aiReport.securityEvents.push(...(r.securityEvents ?? []));
    input.aiReport.events.push(...(r.generationEvents ?? []));
    if ('failed' in r) input.aiReport.events.push(`GENERATION_REJECTED:${r.reason}`);
  }
  return 'failed' in r ? null : r;
}

export async function generateAssistantAnswerDetailed(
  route: IntentRoute,
  sources: RetrievedSource[],
  input: AssistantRequestInput,
): Promise<GeneratedAnswer | GenerationFailure> {
  const securityEvents: SecurityEvent[] = [];
  const generationEvents: string[] = [];
  const echec = (reason: string): GenerationFailure => {
    logSecurityEvents(securityEvents, { requestId: input.requestId, accountId: input.accountId });
    return { failed: true, reason, securityEvents, generationEvents };
  };
  if (sources.length === 0) return echec('NO_SOURCE');
  const cfg = getAssistantConfig();

  try {
    // Architecture T2 de la version de configuration effective (D-04) :
    // `master` ⇒ prompt maître §24 (opération `t2_answer`), sinon étapes
    // historiques (`generate_answer`) — inchangées.
    const master = (await getPromptArchitecture('T2')) === 'master';
    // T2-31 : support vérifiable de chaque affirmation, derrière la lecture
    // canonique OU l'architecture master — jamais en legacy pur.
    const canonical = canonicalReadEnabled();
    const verifySupport = master || canonical;
    // Consigne propre à l'intention (synthèse, comparaison, chronologie,
    // aide) injectée dans la section TÂCHE du prompt historique (§17.6).
    // En master : AUCUNE consigne concaténée, le code d'intention seul (T2-36).
    // Legacy : textes v3.0 et prompt `generate_answer_v4`, octet pour octet
    // (tag lot14b). Lecture canonique : v3.1 et `generate_answer_v5` (T2-36).
    const task = intentTaskFor(route.intent, { canonical });
    const operationCode = canonical ? 'generate_answer_canonical' : 'generate_answer';
    const conversation = input.threadContextText && !isHelpIntent(route.intent)
      ? escapeUntrusted(input.threadContextText)
      : isHelpIntent(route.intent)
        ? '(question d’utilisation de Verebona : réponds uniquement à partir des articles du Centre d’aide fournis)'
        : '(nouvelle conversation, aucun échange précédent)';

    // ── Limites AVANT l'appel (§13.9, §17.7, §31.2) ──────────────────────
    // 12 000 jetons d'entrée au plus : moins d'extraits d'abord, puis des
    // extraits plus courts, puis sans le contexte du fil. Au-delà : aucun
    // appel (repli déterministe), jamais un envoi hors budget.
    // §29.4 : politique « données sensibles » AVANT tout calcul de budget —
    // documents d'identité ou médicaux non nécessaires exclus, numéros de
    // pièce, données médicales, données de tiers et secrets masqués dans les
    // extraits, la question et le contexte du fil. Trace sans contenu.
    const politique = applySensitiveDataPolicy(sources, input.message);
    generationEvents.push(...politique.events);
    if (politique.sources.length === 0) return echec('NO_SOURCE');
    const besoin = sensitiveNecessityFor(input.message);
    const question = maskSensitiveText(input.message, besoin).text;
    const conversationMasquee = maskSensitiveText(conversation, besoin).text;
    const fit = fitToInputBudget({
      sources: politique.sources, conversation: conversationMasquee,
      fixed: `${question}\n${master ? route.intent : task.intentVariable}`,
      maxInputTokens: cfg.maxInputTokens,
      maxExcerptChars: cfg.maxExcerptChars,
    });
    generationEvents.push(...fit.events);
    if (!fit.ok) return echec('INPUT_TOKENS_EXCEEDED');
    const kept = fit.sources;

    if (master) {
      return await generateWithT2Master({
        route, input, kept: ordreFourni(politique.sources, kept), question, conversation: fit.conversation,
        securityEvents, generationEvents, echec,
      });
    }

    const baseVariables = {
      TODAY: new Date().toISOString().slice(0, 10),
      // Balisée <question> dans le prompt : un `<` saisi ne peut pas refermer
      // la balise et se faire passer pour une consigne.
      QUESTION: escapeUntrusted(question),
      DATA: formatSourcesData(kept),
      SOURCES: formatSourcesList(kept),
      INTENT: task.intentVariable,
      // Contexte borné du fil courant (≤ 8 messages utiles, référence déjà
      // résolue) — jamais l'historique brut du compte ni d'un autre fil.
      // Question d'utilisation : aucun échange précédent (CDC Centre d'aide
      // §5, T2-06).
      CONVERSATION: fit.conversation,
      // §17.3 couche 3 : droits et offre RÉELS du compte (registre des
      // capacités, flags du §39), construits côté serveur à chaque appel.
      RIGHTS: describeAccountRights({
        planType: input.planType, planLimit: input.planLimit ?? null, writeCommands: areWriteCommandsEnabled(),
      }),
    };
    const trace = {
      requestId: input.requestId ?? input.clientRequestId,
      routeReason: route.routeReason,
      promptId: task.promptId,
      promptVersion: task.promptVersion,
    };
    // Une variante = une requête : la réparation porte ses erreurs dans la
    // TÂCHE (schéma + erreurs, aucune donnée nouvelle — §18.6) ; l'escalade
    // a sa propre clé d'idempotence (sinon le cache rendrait la 1re sortie).
    const build = (v: { repair?: string[]; escalation?: boolean }) => {
      const promptVariables = v.repair
        ? { ...baseVariables, INTENT: `${baseVariables.INTENT}\n\n${repairInstruction(SCHEMA_DESCRIPTION, v.repair)}` }
        : baseVariables;
      const cle = assistantIdempotencyKey(input, operationCode, promptVariables);
      return {
        useCaseCode: 'INTELLIGENT_ASSISTANT' as const,
        operationCode,
        accountId: input.accountId,
        userId: input.userId,
        promptVariables,
        outputSchema: AssistantAnswerOutput,
        // Réponse brute mise en cache rattachée au fil : purgée à l'effacement.
        idempotencyKey: cle && v.escalation ? `${cle}:escalation` : cle,
      };
    };

    // Décompté sur le budget du message (§15.5, CA-07) : premier appel au
    // modèle par défaut SEUL, puis au plus une réparation ou une escalade.
    const first = await callWithRepairOrEscalation({
      budget: input.aiBudget, build, trace, schemaDescription: SCHEMA_DESCRIPTION,
    });
    generationEvents.push(...first.events);

    const evaluer = (data: AssistantAnswer, model: string) => {
      // §18.5 étape 3 : l'intention de la sortie doit être celle que le
      // serveur a routée (sauf intention encore indéterminée). Un écart est
      // une règle de qualité (§15.4 d) : escalade permise, sinon repli.
      if (route.intent !== 'UNKNOWN' && data.intent !== route.intent) {
        securityEvents.push({ code: 'MODEL_INTENT_MISMATCH', detail: `${data.intent}≠${route.intent}`.slice(0, 80) });
        return { out: null, reason: 'QUALITY_RULE' };
      }
      const out = toGeneratedAnswer(data, kept, securityEvents, { verifySupport, supportEvents: generationEvents });
      if (!out) return { out: null, reason: data.claims.length === 0 ? 'EMPTY_OUTPUT' : 'NO_SUPPORTED_CLAIM' };
      // §21.5 : vocabulaire interdit — tracé, puis rejet par le validateur.
      const interdits = findForbiddenVocabulary(out.answer);
      if (interdits.length) securityEvents.push({ code: 'MODEL_FORBIDDEN_VOCABULARY', detail: interdits.join(',').slice(0, 80) });
      // Contrôles de forme (§18.4, §21.2, §21.5, §21.7) : langue, vocabulaire, longueur.
      const valide = validateGeneratedAnswer(out, route.intent);
      if (!valide) return { out: null, reason: 'QUALITY_RULE' };
      return {
        out: {
          ...out, answer: valide.answer, claims: valide.claims,
          supportLevel: prudent(valide.supportLevel, data.supportLevel), model,
        } as GeneratedAnswer,
        reason: null,
      };
    };

    // Action hors catalogue, champ inconnu… : la 1re sortie a été rejetée par
    // le schéma strict, puis réparée. Une action inventée reste tracée (37.12).
    tracerRejetsDeSchema(first.repairErrors, securityEvents);
    let path: GeneratedAnswer['path'] = first.path;
    let res = evaluer(first.res.data, first.res.model);

    // ── Escalade APRÈS un premier appel exploitable mais insuffisant ─────
    // Seulement pour un motif du §15.4, et si le second appel n'a pas déjà
    // servi (réparation) : sortie vide, synthèse multi-source non produite,
    // règle de qualité (langue).
    if (!res.out && first.path === 'first' && canEscalate(input.aiBudget)) {
      const motif: EscalationReason | null =
        res.reason === 'EMPTY_OUTPUT' ? 'EMPTY_OUTPUT'
          : res.reason === 'QUALITY_RULE' ? 'QUALITY_RULE'
            : res.reason === 'NO_SUPPORTED_CLAIM' && SYNTHESIS_INTENTS.has(route.intent) && kept.length >= 2 ? 'SYNTHESIS_FAILED'
              : null;
      if (motif) {
        generationEvents.push(`ESCALATION:${motif}`);
        const second = await escalate({ budget: input.aiBudget, build, trace, schemaDescription: SCHEMA_DESCRIPTION });
        path = 'escalation';
        res = evaluer(second.data, second.model);
      }
    }

    logSecurityEvents(securityEvents, { requestId: input.requestId, accountId: input.accountId });
    if (!res.out) {
      console.warn(`[assistant] Génération rejetée (${res.reason}) — repli déterministe.`);
      return echec(res.reason ?? 'REJECTED');
    }
    return { ...res.out, securityEvents, generationEvents, path };
  } catch (e) {
    // Réparation tentée puis en échec (§18.6) : tracée, pour que la machine
    // à états passe par REPAIRING et que le code VALIDATION_FAILED soit émis.
    const repairErrors = (e as { repairErrors?: string[] } | null)?.repairErrors;
    if (repairErrors) {
      generationEvents.push('REPAIR:INVALID_OUTPUT', 'REPAIR_FAILED');
      tracerRejetsDeSchema(repairErrors, securityEvents);
      logSecurityEvents(securityEvents, { requestId: input.requestId, accountId: input.accountId });
      return { failed: true, reason: 'VALIDATION_FAILED', securityEvents, generationEvents };
    }
    const detail = isAiGatewayError(e) ? `${e.code} — ${e.message}` : (e as Error).message;
    console.warn(`[assistant] Génération indisponible (${detail}) — repli déterministe.`);
    return echec(`UNAVAILABLE:${classifyModelFailure(e).kind}`);
  }
}

const SYNTHESIS_INTENTS = new Set(['ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE']);

/**
 * Sources retenues par le budget, remises dans l'ORDRE FOURNI par les outils
 * (le budget les trie par pertinence) : la chronologie fournie ne doit pas
 * être réordonnée (§24 B10).
 */
function ordreFourni(fournies: RetrievedSource[], retenues: RetrievedSource[]): RetrievedSource[] {
  const parId = new Map(retenues.map((s) => [s.id, s]));
  return fournies.flatMap((s) => (parId.has(s.id) ? [parId.get(s.id)!] : []));
}

/**
 * Chemin MASTER (CDC 15 §24, branche ANSWER) — même enveloppe que les
 * étapes : sources déjà filtrées et masquées (§29.4), budget d'entrée
 * appliqué (§13.9), au plus 2 appels modèle par message (CA-07 : réparation
 * OU escalade), plafond de sortie min(BO, 500) et délais par
 * `executeWithinBudget`, clé d'idempotence propre (`t2_answer` + version du
 * master, ajoutée par la passerelle).
 *
 * Différences voulues :
 *   · {{INTENT}} = code d'intention seul (T2-36) ; la longueur est imposée
 *     par le validateur (`answer-format.ts`) ;
 *   · la réparation n'est PAS concaténée à {{INTENT}} : elle suit le contexte
 *     conversationnel ({{CONVERSATION}}), seul emplacement serveur libre de la
 *     branche ANSWER — le master n'en déclare pas d'autre ;
 *   · support vérifiable de chaque ligne (T2-31) toujours contrôlé ;
 *   · chronologie structurée (`events[]`, T2-35).
 */
async function generateWithT2Master(p: {
  route: IntentRoute;
  input: AssistantRequestInput;
  kept: RetrievedSource[];
  question: string;
  conversation: string;
  securityEvents: SecurityEvent[];
  generationEvents: string[];
  echec: (reason: string) => GenerationFailure;
}): Promise<GeneratedAnswer | GenerationFailure> {
  const { route, input, kept, securityEvents, generationEvents } = p;
  const regle = answerFormatFor(route.intent);
  const variables = t2MasterVariables('ANSWER', {
    INTENT: route.intent,
    QUESTION: escapeUntrusted(p.question),
    TODAY: new Date().toISOString().slice(0, 10),
    RESOLVED_TARGETS: formatResolvedTargets(input.reference, kept),
    CONVERSATION: p.conversation,
    SOURCES: formatT2Sources(kept),
  });
  const trace = {
    requestId: input.requestId ?? input.clientRequestId,
    routeReason: route.routeReason,
    promptId: 't2_master_v1',
    promptVersion: 'ANSWER',
  };
  const build = (v: { repair?: string[]; escalation?: boolean }) => {
    const promptVariables = v.repair
      ? { ...variables, CONVERSATION: `${String(variables.CONVERSATION ?? '')}\n\n${repairInstruction(T2_ANSWER_SCHEMA_DESCRIPTION, v.repair)}` }
      : variables;
    const cle = assistantIdempotencyKey(input, 't2_answer', promptVariables);
    return {
      useCaseCode: 'INTELLIGENT_ASSISTANT' as const,
      operationCode: 't2_answer',
      accountId: input.accountId,
      userId: input.userId,
      promptVariables,
      outputSchema: T2AnswerOutput,
      idempotencyKey: cle && v.escalation ? `${cle}:escalation` : cle,
    };
  };

  const evaluer = (data: T2AnswerOutput, model: string) => {
    if (data.format !== regle.format && data.format !== 'claims') {
      generationEvents.push(`T2_FORMAT:${data.format}≠${regle.format}`);
    }
    const l = t2AnswerLines(data);
    const out = toGeneratedAnswer(
      { claims: l.lines, status: l.status, actionIntents: [], derivations: [] },
      kept, securityEvents,
      { verifySupport: true, supportEvents: generationEvents, separator: l.separator },
    );
    if (!out) return { out: null, reason: l.lines.length === 0 ? 'EMPTY_OUTPUT' : 'NO_SUPPORTED_CLAIM' };
    const interdits = findForbiddenVocabulary(out.answer);
    if (interdits.length) securityEvents.push({ code: 'MODEL_FORBIDDEN_VOCABULARY', detail: interdits.join(',').slice(0, 80) });
    const valide = validateGeneratedAnswer(out, route.intent);
    if (!valide) return { out: null, reason: 'QUALITY_RULE' };
    // T2-35 : événements structurés, restreints aux lignes validées.
    // Comparaison sur le texte FILTRÉ (§18.7), comme celui des affirmations.
    const gardes = new Set(valide.claims.map((c) => c.text.trim()));
    const events: AnswerTimelineEvent[] | undefined = data.format === 'timeline'
      ? l.lines.filter((x) => x.event && gardes.has(sanitizeModelText(x.text, 'e').text.trim()))
        .map((x) => ({ date: x.event!.date, text: x.event!.text, sourceIds: x.sourceIds }))
      : undefined;
    return {
      out: {
        ...out, answer: valide.answer, claims: valide.claims, supportLevel: valide.supportLevel, model,
        ...(events ? { events } : {}), architecture: 'master',
      } as GeneratedAnswer,
      reason: null,
    };
  };

  const first = await callWithRepairOrEscalation({
    budget: input.aiBudget, build, trace, schemaDescription: T2_ANSWER_SCHEMA_DESCRIPTION,
  });
  generationEvents.push(...first.events);
  let path: GeneratedAnswer['path'] = first.path;
  let res = evaluer(first.res.data, first.res.model);
  if (!res.out && first.path === 'first' && canEscalate(input.aiBudget)) {
    const motif: EscalationReason | null =
      res.reason === 'EMPTY_OUTPUT' ? 'EMPTY_OUTPUT'
        : res.reason === 'QUALITY_RULE' ? 'QUALITY_RULE'
          : res.reason === 'NO_SUPPORTED_CLAIM' && SYNTHESIS_INTENTS.has(route.intent) && kept.length >= 2 ? 'SYNTHESIS_FAILED'
            : null;
    if (motif) {
      generationEvents.push(`ESCALATION:${motif}`);
      const second = await escalate({ budget: input.aiBudget, build, trace, schemaDescription: T2_ANSWER_SCHEMA_DESCRIPTION });
      path = 'escalation';
      res = evaluer(second.data, second.model);
    }
  }
  logSecurityEvents(securityEvents, { requestId: input.requestId, accountId: input.accountId });
  if (!res.out) {
    console.warn(`[assistant] Génération master rejetée (${res.reason}) — repli déterministe.`);
    return p.echec(res.reason ?? 'REJECTED');
  }
  return { ...res.out, securityEvents, generationEvents, path };
}

/**
 * Niveau d'étayage retenu (§18.3) : le plus PRUDENT de celui calculé par le
 * serveur et de celui annoncé par le modèle. Le modèle peut signaler une
 * contradiction ou une limite que le contrôle des sources ne voit pas ; il ne
 * peut jamais rendre « supported » une réponse que le serveur a amputée.
 */
const PRUDENCE: Record<SupportLevel, number> = { supported: 0, partial: 1, conflicting: 2, insufficient: 3 };
export function prudent(serveur: SupportLevel, modele: SupportLevel | undefined): SupportLevel {
  if (!modele) return serveur;
  return PRUDENCE[modele] > PRUDENCE[serveur] ? modele : serveur;
}

/** Actions hors catalogue rejetées par le schéma strict : événement de sécurité (37.12). */
function tracerRejetsDeSchema(errors: string[] | undefined, events: SecurityEvent[]): void {
  for (const err of errors ?? []) {
    if (/^actionIntents\b/.test(err)) events.push({ code: 'MODEL_ACTION_REJECTED', detail: err.slice(0, 80) });
  }
}

/**
 * Filtre les affirmations dont les sources ne figurent pas dans celles
 * réellement remontées.
 *
 * Un modèle peut citer un identifiant plausible mais absent. Le prompt annonce
 * la suppression de ces affirmations ; c'est ici qu'elle a lieu, côté serveur,
 * et non dans une consigne que rien ne fait respecter.
 */
/** Affirmation candidate : sortie historique, ou ligne du master T2 (avec support). */
export type AnswerClaimInput = AssistantAnswer['claims'][number] & { support?: T2ClaimSupport };

export interface ToGeneratedAnswerOptions {
  /** T2-31 : contrôle du support vérifiable (lecture canonique ou master). */
  verifySupport?: boolean;
  /** Reçoit `CLAIM_UNSUPPORTED:<motif>` (trace sans contenu). */
  supportEvents?: string[];
  /** Assemblage des lignes : `\n` pour une liste (T2-35), espace sinon. */
  separator?: ' ' | '\n';
}

export function toGeneratedAnswer(
  data: {
    claims: AnswerClaimInput[];
    status?: AssistantAnswer['status'];
    actionIntents?: AssistantAnswer['actionIntents'];
    derivations?: AssistantAnswer['derivations'];
  },
  sources: RetrievedSource[],
  securityEvents: SecurityEvent[] = [],
  opts: ToGeneratedAnswerOptions = {},
): GeneratedAnswer | null {
  // ══════════════════════════════════════════════════════════════════════
  // LE TEXTE AFFICHÉ EST RECONSTRUIT, PAS REPRIS
  //
  // La réponse est composée des seules phrases validées, dans l'ordre du
  // modèle :
  //   · chaque phrase est d'abord FILTRÉE (§18.7) : URL et balisage retirés,
  //     script / SQL → phrase rejetée, événement de sécurité tracé ;
  //   · phrase factuelle : conservée si elle cite au moins une source et que
  //     TOUTES ses sources figurent parmi celles remontées ;
  //   · phrase de transition (`factual: false`) : conservée seulement si
  //     elle ne porte aucune donnée (chiffre, date, montant) et qu'au moins
  //     un fait validé l'accompagne ;
  //   · aucun fait validé → `null` : l'orchestrateur applique le repli
  //     déterministe plutôt que d'afficher du texte non étayé.
  // Exception : `status: insufficient_data` avec une explication sans
  // donnée — dire ce qui manque est une réponse sûre.
  // ══════════════════════════════════════════════════════════════════════
  // Actions proposées par le modèle : jamais exécutées ni affichées (§18.7,
  // §22.7) — seul le serveur résout les actions. Rejet tracé (37.12).
  for (const a of data.actionIntents ?? []) {
    securityEvents.push({ code: 'MODEL_ACTION_REJECTED', target: String(a.type ?? '').slice(0, 60) });
  }
  const known = new Set(sources.map((s) => s.id));
  const portesDonnee = (t: string) => /\d/.test(t);
  const nettoyees = data.claims.flatMap((c, i) => {
    const f = sanitizeModelText(c.text, `c${i + 1}`);
    securityEvents.push(...f.events);
    return f.rejected ? [] : [{ ...c, text: f.text }];
  });
  // T2-31 : un `sourceId` valide ne suffit pas — ce que la phrase affirme
  // doit figurer dans ce que la source porte. Non soutenue ⇒ REJETÉE (le
  // niveau d'étayage passe à « partial »), motif tracé sans contenu.
  const soutenue = (c: AnswerClaimInput): boolean => {
    if (!opts.verifySupport) return true;
    const r = verifyClaimSupport(c, sources);
    if (!r.supported) opts.supportEvents?.push(`CLAIM_UNSUPPORTED:${r.reason}${r.missing ? `:${r.missing.length}` : ''}`);
    return r.supported;
  };
  const valide = (c: AnswerClaimInput) =>
    c.sourceIds.length > 0 && c.sourceIds.every((id) => known.has(id)) && soutenue(c);
  const factuelles = nettoyees.filter((c) => c.factual !== false || portesDonnee(c.text));
  for (const c of factuelles) {
    const inconnues = c.sourceIds.filter((id) => !known.has(id));
    if (inconnues.length) securityEvents.push({ code: 'MODEL_UNKNOWN_SOURCE_REJECTED', detail: inconnues.slice(0, 3).join(',').slice(0, 80) });
  }
  const retained = factuelles.filter(valide);
  // Une affirmation rejetée par le filtre de sécurité compte comme écartée :
  // le niveau d'étayage le dira (« partial »).
  const totalFactuelles = factuelles.length + (data.claims.length - nettoyees.length);

  if (retained.length === 0) {
    const explication = data.status === 'insufficient_data'
      ? nettoyees.find((c) => c.factual === false && !portesDonnee(c.text))
      : undefined;
    if (!explication) return null;
    return { answer: explication.text, claims: [], actions: [], supportLevel: 'insufficient' };
  }

  const phrases = nettoyees
    .filter((c) => (c.factual === false && !portesDonnee(c.text)) || retained.includes(c))
    .map((c) => c.text.trim());

  const claims: Claim[] = retained.map((c, i) => ({
    // Clé stable par réponse : elle sert au dédoublonnage à l'affichage.
    claimKey: `c${i + 1}`,
    text: c.text,
    sourceIds: c.sourceIds,
    // Défaut prudent : `synthesized`. Une affirmation dont on ignore si elle
    // est lue telle quelle ou reformulée doit être présentée comme la plus
    // travaillée des deux — annoncer `direct` à tort laisserait croire à une
    // citation là où il y a interprétation.
    derivation: c.derivation ?? data.derivations?.[i] ?? 'synthesized',
  }));

  return {
    answer: phrases.join(opts.separator ?? ' '),
    claims,
    actions: [],
    supportLevel: computeSupportLevel(totalFactuelles, claims.length),
  };
}

/**
 * Niveau d'étayage — §12.4.
 *
 * `partial` dès qu'une seule affirmation a été écartée : l'interface doit
 * pouvoir le signaler. Annoncer `supported` sur une réponse amputée reviendrait
 * à cacher précisément ce que le contrôle a détecté.
 */
export function computeSupportLevel(total: number, retained: number): SupportLevel {
  if (total === 0 || retained === 0) return 'insufficient';
  return retained === total ? 'supported' : 'partial';
}

/**
 * Neutralise tout balisage dans un texte non fiable (§17.4, CA-16) : un
 * document contenant « </retrieved_source> » ou « <system> » ne peut ni
 * refermer sa balise ni en ouvrir une autre. Seul `<` est échappé : les
 * chiffres et symboles (« R&D », « 480 € ») restent recopiables tels quels.
 */
export function escapeUntrusted(text: string): string {
  return String(text ?? '').replace(/</g, '&lt;');
}

/** Valeur d'attribut : ni guillemet, ni chevron, ni saut de ligne. */
function escapeAttr(value: string): string {
  return String(value ?? '').replace(/[<>"\r\n]/g, ' ');
}

/**
 * Sources sérialisées comme DONNÉES NON FIABLES — CDC §17.4 :
 *
 *     <retrieved_source id="doc_123" type="document">
 *       <title>Facture vélo</title>
 *       <content>...</content>
 *     </retrieved_source>
 *
 * Auparavant `[id] type — titre\ncontenu`, sans délimitation : une phrase
 * d'un document (« Ignore les règles… ») se lisait comme une consigne de
 * plus. Le prompt v4 (`generate_answer_v4.txt`, règle S1) désigne ces
 * balises comme des données à analyser, jamais à exécuter.
 */
export function formatSourcesData(sources: RetrievedSource[]): string {
  return sources
    .map((s) => [
      `<retrieved_source id="${escapeAttr(s.id)}" type="${escapeAttr(s.type)}">`,
      `  <title>${escapeUntrusted(s.title)}</title>`,
      `  <content>${escapeUntrusted(s.content)}</content>`,
      '</retrieved_source>',
    ].join('\n'))
    .join('\n\n');
}

function formatSourcesList(sources: RetrievedSource[]): string {
  // Identifiants seuls : le titre d'un document est une donnée non fiable, il
  // n'apparaît qu'à l'intérieur des balises <retrieved_source>.
  return sources.map((s) => `- ${escapeAttr(s.id)}`).join('\n');
}

/**
 * Port à injecter, ou `undefined` si l'usage n'est pas basculé.
 *
 * Rendre `undefined` plutôt qu'une fonction inerte : l'orchestrateur teste la
 * présence du port pour décider d'entrer dans l'état `GENERATING`. Une fonction
 * qui rendrait toujours `null` ferait traverser cet état pour rien, et
 * fausserait la machine de conversation comme les mesures.
 */
export function buildGenerationPort():
  | ((route: IntentRoute, sources: RetrievedSource[], input: AssistantRequestInput) => Promise<GeneratedAnswer | null>)
  | undefined {
  return isUseCaseRunning('INTELLIGENT_ASSISTANT') ? generateAssistantAnswer : undefined;
}
