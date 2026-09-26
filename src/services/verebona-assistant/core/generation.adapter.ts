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
import { executeWithinBudget } from './ai-call-budget';
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import { assistantIdempotencyKey } from './assistant-cache-key';
import { isUseCaseRunning } from '@/services/ai/flags/use-case-flags';
import type { IntentRoute, AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource, Claim, SupportLevel } from '../types/sources';
import { isHelpIntent } from './help-corpus.service';
import { intentTaskFor } from '../prompts/intent-tasks';
import { validateGeneratedAnswer } from './response-validator.service';

/**
 * Schéma de la réponse attendue du modèle.
 *
 * `sourceIds` est obligatoire sur chaque affirmation : le prompt annonce
 * qu'une affirmation sans source valide sera supprimée avant affichage, et
 * c'est la validation en aval qui l'applique. Un schéma laxiste ici rendrait
 * cette promesse invérifiable.
 */
const AssistantAnswerOutput = z.object({
  /**
   * Texte rédigé par le modèle. Facultatif, et JAMAIS affiché tel quel : la
   * réponse rendue est reconstruite à partir des seules affirmations validées
   * (voir `toGeneratedAnswer`). Le prompt ne le demande d'ailleurs pas.
   */
  answer: z.string().max(4000).optional(),
  claims: z.array(z.object({
    text: z.string().min(1),
    // Le prompt montre des identifiants entre crochets ; on accepte nombre ou
    // chaîne, comparés ensuite aux identifiants réels des sources.
    sourceIds: z.array(z.union([z.string(), z.number()]).transform(String)).default([]),
    /** `false` : phrase de transition, sans information. Absent : factuelle. */
    factual: z.boolean().optional(),
  })).default([]),
  status: z.enum(['answered', 'insufficient_data']).optional(),
  actionIntents: z.array(z.object({
    type: z.string(),
    entityId: z.string().optional(),
  })).default([]),
  /** Nature de l'affirmation : lue telle quelle, calculée, ou synthétisée. */
  derivations: z.array(z.enum(['direct', 'calculated', 'synthesized'])).default([]),
});

export type AssistantAnswer = z.infer<typeof AssistantAnswerOutput>;

/** Sortie attendue par `OrchestratorPorts.generateWithAI`. */
export interface GeneratedAnswer {
  answer: string;
  claims: Claim[];
  actions: [];
  supportLevel: SupportLevel;
  /** Modèle effectivement appelé (trace T2). */
  model?: string;
}

/**
 * Rédige une réponse à partir des seules sources remontées par les outils.
 *
 * Rend `null` en cas d'échec — jamais une exception. L'orchestrateur traite
 * `null` comme un repli déterministe (§30.3) : l'utilisateur reçoit alors la
 * réponse « sources seules », qui reste correcte. Une exception, elle,
 * remonterait jusqu'à la réponse HTTP et transformerait une dégradation prévue
 * en panne visible.
 */
export async function generateAssistantAnswer(
  route: IntentRoute,
  sources: RetrievedSource[],
  input: AssistantRequestInput,
): Promise<GeneratedAnswer | null> {
  if (sources.length === 0) return null;

  try {
    // Consigne propre à l'intention (synthèse, comparaison, chronologie,
    // aide) injectée dans la section TÂCHE du prompt maître (§17.6).
    const task = intentTaskFor(route.intent);
    const promptVariables = {
      TODAY: new Date().toISOString().slice(0, 10),
      // Balisée <question> dans le prompt : un `<` saisi ne peut pas refermer
      // la balise et se faire passer pour une consigne.
      QUESTION: escapeUntrusted(input.message),
      DATA: formatSourcesData(sources),
      SOURCES: formatSourcesList(sources),
      INTENT: task.intentVariable,
      // Contexte borné du fil courant (≤ 8 messages utiles, référence déjà
      // résolue) — jamais l'historique brut du compte ni d'un autre fil.
      //
      // Question d'utilisation : aucun échange précédent, qui peut porter des
      // données du compte — seuls les articles servent (CDC Centre d'aide §5,
      // T2-06).
      CONVERSATION: input.threadContextText && !isHelpIntent(route.intent)
        ? escapeUntrusted(input.threadContextText)
        : isHelpIntent(route.intent)
          ? '(question d’utilisation de Verebona : réponds uniquement à partir des articles du Centre d’aide fournis)'
          : '(nouvelle conversation, aucun échange précédent)',
    };
    // Décompté sur le budget du message (§15.5, CA-07) : la génération n'a
    // droit qu'aux tentatives laissées par la classification et la
    // revalidation ; épuisé → `null` → repli déterministe.
    const res = await executeWithinBudget(input.aiBudget, {
      useCaseCode: 'INTELLIGENT_ASSISTANT',
      operationCode: 'generate_answer',
      accountId: input.accountId,
      userId: input.userId,
      promptVariables,
      outputSchema: AssistantAnswerOutput,
      // Réponse brute mise en cache rattachée au fil : purgée à l'effacement.
      idempotencyKey: assistantIdempotencyKey(input, 'generate_answer', promptVariables),
    }, {
      requestId: input.requestId ?? input.clientRequestId,
      routeReason: route.routeReason,
      promptId: task.promptId,
      promptVersion: task.promptVersion,
    });

    const out = toGeneratedAnswer(res.data, sources);
    if (!out) {
      console.warn('[assistant] Aucune affirmation étayée par les sources — repli déterministe.');
      return null;
    }
    // Contrôles de forme (§18.4, §21.2, §21.7) : langue, longueur.
    const valide = validateGeneratedAnswer(out, route.intent);
    if (!valide) {
      console.warn('[assistant] Réponse rejetée par le validateur (langue ou citations) — repli déterministe.');
      return null;
    }
    return { ...out, answer: valide.answer, claims: valide.claims, supportLevel: valide.supportLevel, model: res.model };
  } catch (e) {
    const detail = isAiGatewayError(e) ? `${e.code} — ${e.message}` : (e as Error).message;
    console.warn(`[assistant] Génération indisponible (${detail}) — repli déterministe.`);
    return null;
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
export function toGeneratedAnswer(
  data: AssistantAnswer,
  sources: RetrievedSource[],
): GeneratedAnswer | null {
  // ══════════════════════════════════════════════════════════════════════
  // LE TEXTE AFFICHÉ EST RECONSTRUIT, PAS REPRIS
  //
  // Le filtrage écartait les affirmations mal sourcées de la COLLECTION de
  // citations, mais `answer` était rendu tel quel : un fait rejeté restait
  // lisible dans la réponse. La réponse est désormais composée des seules
  // phrases validées, dans l'ordre du modèle :
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
  const known = new Set(sources.map((s) => s.id));
  const portesDonnee = (t: string) => /\d/.test(t);
  const valide = (c: AssistantAnswer['claims'][number]) =>
    c.sourceIds.length > 0 && c.sourceIds.every((id) => known.has(id));
  const factuelles = data.claims.filter((c) => c.factual !== false || portesDonnee(c.text));
  const retained = factuelles.filter(valide);

  if (retained.length === 0) {
    const explication = data.status === 'insufficient_data'
      ? data.claims.find((c) => c.factual === false && !portesDonnee(c.text))
      : undefined;
    if (!explication) return null;
    return { answer: explication.text, claims: [], actions: [], supportLevel: 'insufficient' };
  }

  const phrases = data.claims
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
    derivation: data.derivations[i] ?? 'synthesized',
  }));

  return {
    answer: phrases.join(' '),
    claims,
    actions: [],
    supportLevel: computeSupportLevel(factuelles.length, claims.length),
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
 * plus. Le prompt v3 (`generate_answer_v3.txt`, règle S1) désigne ces
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
