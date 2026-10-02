/**
 * Génération de la réponse de l'assistant — branche ANSWER du master T2
 * (opération `t2_answer`, CDC 15 §24), usage IA n°3. CDC Assistant §15.1,
 * §12.4 et §30.3.
 *
 * L'orchestrateur teste ce port avant de décider d'appeler un modèle :
 *
 *     const canUseAI = cfg.aiEnabled && route.aiEligible
 *                   && ports.generateWithAI != null && sources.length > 0;
 *
 * Lot 16b-2 : l'étape historique `generate_answer` (prompts
 * `generate_answer_v4` / `v5`, consignes par intention concaténées de
 * `prompts/intent-tasks.ts`), la lecture `ASSISTANT_CANONICAL_READ` et le
 * drapeau `AI_INTELLIGENT_ASSISTANT` sont retirés : le master T2 est le seul
 * moteur, et le port est toujours branché. Un échec du master (modèle
 * indisponible, sortie invalide après réparation, aucune affirmation
 * soutenue) rend `null` : l'orchestrateur applique le repli déterministe
 * (« sources seules », §30.3) — jamais d'autre moteur.
 */
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
import type { IntentRoute, AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource, Claim, SupportLevel } from '../types/sources';
import { isHelpIntent } from './help-corpus.service';
import { validateGeneratedAnswer } from './response-validator.service';
import { findForbiddenVocabulary } from './output-safety';
import { T2AnswerOutput, type T2ClaimSupport } from '@/services/ai/assistant/master/t2-contract';
import {
  t2MasterVariables, formatT2Sources, formatResolvedTargets, t2AnswerLines,
} from '@/services/ai/assistant/master/t2-answer';
import { verifyClaimSupport } from '@/services/ai/assistant/claim-support';
import { answerFormatFor } from '../prompts/answer-format';

/** Nature d'une affirmation : lue telle quelle, calculée, ou synthétisée. */
type Derivation = 'direct' | 'calculated' | 'synthesized';

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
  /** Architecture du prompt qui a produit la réponse (trace) : toujours `master` (lot 16b-2). */
  architecture?: 'master';
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
      fixed: `${question}\n${route.intent}`,
      maxInputTokens: cfg.maxInputTokens,
      maxExcerptChars: cfg.maxExcerptChars,
    });
    generationEvents.push(...fit.events);
    if (!fit.ok) return echec('INPUT_TOKENS_EXCEEDED');

    return await generateWithT2Master({
      route, input, kept: ordreFourni(politique.sources, fit.sources), question, conversation: fit.conversation,
      securityEvents, generationEvents, echec,
    });
  } catch (e) {
    // Réparation tentée puis en échec (§18.6) : tracée, pour que la machine
    // à états passe par REPAIRING et que le code VALIDATION_FAILED soit émis.
    const repairErrors = (e as { repairErrors?: string[] } | null)?.repairErrors;
    if (repairErrors) {
      generationEvents.push('REPAIR:INVALID_OUTPUT', 'REPAIR_FAILED');
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
 * Branche ANSWER du master T2 (CDC 15 §24) : sources déjà filtrées et
 * masquées (§29.4), budget d'entrée appliqué (§13.9), au plus 2 appels
 * modèle par message (CA-07 : réparation OU escalade), plafond de sortie
 * min(BO, 500) et délais par `executeWithinBudget`, clé d'idempotence propre
 * (`t2_answer` + version du master, ajoutée par la passerelle).
 *
 *   · {{INTENT}} = code d'intention seul (T2-36) ; la longueur est imposée
 *     par le validateur (`answer-format.ts`) ;
 *   · la réparation suit le contexte conversationnel ({{CONVERSATION}}),
 *     seul emplacement serveur libre de la branche ANSWER ;
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
 * Filtre les affirmations dont les sources ne figurent pas dans celles
 * réellement remontées.
 *
 * Un modèle peut citer un identifiant plausible mais absent. Le prompt annonce
 * la suppression de ces affirmations ; c'est ici qu'elle a lieu, côté serveur,
 * et non dans une consigne que rien ne fait respecter.
 */
/** Affirmation candidate : ligne du master T2 (avec son support vérifiable). */
export interface AnswerClaimInput {
  claimKey?: string;
  text: string;
  sourceIds: string[];
  /** `false` : phrase de transition, sans information. Absent : factuelle. */
  factual?: boolean;
  derivation?: Derivation;
  support?: T2ClaimSupport;
}

export interface ToGeneratedAnswerOptions {
  /** T2-31 : contrôle du support vérifiable (toujours demandé par le master T2). */
  verifySupport?: boolean;
  /** Reçoit `CLAIM_UNSUPPORTED:<motif>` (trace sans contenu). */
  supportEvents?: string[];
  /** Assemblage des lignes : `\n` pour une liste (T2-35), espace sinon. */
  separator?: ' ' | '\n';
}

export function toGeneratedAnswer(
  data: {
    claims: AnswerClaimInput[];
    status?: 'answered' | 'insufficient_data';
    actionIntents?: Array<{ type: string; targetId?: string }>;
    derivations?: Derivation[];
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

/** Port de génération (toujours branché depuis le lot 16b-2). */
export function buildGenerationPort(): (route: IntentRoute, sources: RetrievedSource[], input: AssistantRequestInput) => Promise<GeneratedAnswer | null> {
  return generateAssistantAnswer;
}
