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
import { AiGateway } from '@/services/ai/gateway/ai-gateway';
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import { isUseCaseRunning } from '@/services/ai/flags/use-case-flags';
import type { IntentRoute, AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource, Claim, SupportLevel } from '../types/sources';

/**
 * Schéma de la réponse attendue du modèle.
 *
 * `sourceIds` est obligatoire sur chaque affirmation : le prompt annonce
 * qu'une affirmation sans source valide sera supprimée avant affichage, et
 * c'est la validation en aval qui l'applique. Un schéma laxiste ici rendrait
 * cette promesse invérifiable.
 */
const AssistantAnswerOutput = z.object({
  answer: z.string().min(1).max(4000),
  claims: z.array(z.object({
    text: z.string().min(1),
    sourceIds: z.array(z.string()).min(1),
  })).default([]),
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
    const res = await AiGateway.execute({
      useCaseCode: 'INTELLIGENT_ASSISTANT',
      operationCode: 'generate_answer',
      accountId: input.accountId,
      userId: input.userId,
      promptVariables: {
        TODAY: new Date().toISOString().slice(0, 10),
        QUESTION: input.message,
        DATA: formatSourcesData(sources),
        SOURCES: formatSourcesList(sources),
        INTENT: route.intent,
      },
      outputSchema: AssistantAnswerOutput,
    });

    return toGeneratedAnswer(res.data, sources);
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
): GeneratedAnswer {
  const known = new Set(sources.map((s) => s.id));
  const retained = data.claims.filter((c) => c.sourceIds.every((id) => known.has(id)));

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
    answer: data.answer,
    claims,
    actions: [],
    supportLevel: computeSupportLevel(data.claims.length, claims.length),
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

function formatSourcesData(sources: RetrievedSource[]): string {
  return sources
    .map((s) => `[${s.id}] ${s.type} — ${s.title}\n${s.content}`)
    .join('\n\n');
}

function formatSourcesList(sources: RetrievedSource[]): string {
  return sources.map((s) => `[${s.id}] ${s.title}`).join('\n');
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
