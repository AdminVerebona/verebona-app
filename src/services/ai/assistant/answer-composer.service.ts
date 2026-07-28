/**
 * Composition de la réponse — opération `generate_answer`, CDC Assistant §4.3.5.
 *
 * Le modèle rédige à partir des SEULES données remontées par les outils. Les
 * montants, dates et numéros de contrat sont repris tels quels de champs
 * structurés ou d'extraits exacts, jamais reformulés (§4.3.6).
 *
 * Le résultat passe systématiquement par la vérification des citations avant
 * d'être renvoyé à l'utilisateur.
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { verifyClaims, composeVerifiedText } from './claim-verifier.service';
import { ASSISTANT_LIMITS } from './tools/tool.port';
import type { SourceRef } from './tools/tool.port';
import type { VerifiedAnswer } from './claim-verifier.service';

const AssistantAnswerOutput = z.object({
  claims: z.array(z.object({
    text: z.string().min(1).max(1500),
    sourceIds: z.array(z.number().int()).default([]),
    factual: z.boolean().default(true),
  })).min(1).max(12),
  status: z.enum(['answered', 'insufficient_data']).default('answered'),
});

export type AssistantStatus = 'answered' | 'insufficient_data' | 'ambiguous' | 'blocked';

export interface AssistantResponse {
  status: AssistantStatus;
  text: string;
  sources: SourceRef[];
  /** Affirmations écartées faute de source valide — journalisées, non affichées. */
  droppedClaims: string[];
}

export async function composeAnswer(
  question: string,
  toolData: unknown,
  availableSources: SourceRef[],
  accountId: number,
  userId: number,
): Promise<AssistantResponse> {
  // Aucune donnée remontée : inutile d'appeler le modèle pour l'apprendre.
  if (availableSources.length === 0) {
    return {
      status: 'insufficient_data',
      text: "Je n'ai trouvé aucune information dans votre compte pour répondre à cette question.",
      sources: [], droppedClaims: [],
    };
  }

  const res = await AiGateway.execute({
    useCaseCode: 'INTELLIGENT_ASSISTANT',
    operationCode: 'generate_answer',
    accountId,
    userId,
    promptVariables: {
      QUESTION: question,
      DATA: JSON.stringify(toolData).slice(0, 40_000),
      SOURCES: availableSources
        .slice(0, ASSISTANT_LIMITS.maxSourcesRetrieved)
        .map((s) => `[id:${s.id}] ${s.type} — ${s.label}${s.excerpt ? ` : « ${s.excerpt} »` : ''}`)
        .join('\n'),
      TODAY: new Date().toISOString().slice(0, 10),
    },
    outputSchema: AssistantAnswerOutput,
  });

  const verified: VerifiedAnswer = verifyClaims(
    res.data.claims.map((c) => ({
      text: c.text, citedSourceIds: c.sourceIds, factual: c.factual,
    })),
    availableSources,
  );

  const text = composeVerifiedText(verified);

  if (verified.status === 'insufficient_data' || text.length === 0) {
    return {
      status: 'insufficient_data',
      text:
        "Je n'ai pas trouvé d'élément vérifiable dans vos documents pour répondre avec certitude. " +
        'Vous pouvez reformuler ou préciser le bien concerné.',
      sources: [],
      droppedClaims: verified.droppedClaims,
    };
  }

  return {
    status: 'answered',
    text,
    sources: verified.displayedSources,
    droppedClaims: verified.droppedClaims,
  };
}
