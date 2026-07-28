/**
 * Analyse d'une instruction administrateur — opération `analyze_instruction`.
 *
 * ⚠️ SÉPARATION STRICTE — CDC §4.5.3.
 *
 * Ce module produit une PROPOSITION. Il n'écrit dans aucun prompt actif, ne
 * touche à aucun fichier, et la version candidate qu'il crée porte le statut
 * `CANDIDATE` : elle ne peut être servie à aucun appel tant qu'un humain n'a
 * pas validé le diff, puis les tests, puis l'activation.
 *
 * C'est exactement ce que l'ancienne route `admin/ai-instructions/apply` ne
 * faisait pas : elle appliquait les patchs dans la requête qui les produisait.
 */
import { z } from 'zod';
import { createHash } from 'crypto';
import { AiGateway } from '../gateway/ai-gateway';
import { computeDiff } from './diff.service';
import type { DiffSummary } from './diff.service';

const InstructionAnalysisOutput = z.object({
  /** Analyse d'impact en langage naturel, destinée à l'administrateur. */
  impactAnalysis: z.string().min(20).max(3000),
  /** Contenu complet du prompt proposé — jamais un patch partiel. */
  proposedContent: z.string().min(50).max(50_000),
  /** Risques identifiés par le modèle lui-même. */
  risks: z.array(z.string().max(300)).max(10).default([]),
});

export interface AnalysisProposal {
  impactAnalysis: string;
  proposedContent: string;
  proposedHash: string;
  risks: string[];
  diff: DiffSummary;
  /** Refus motivé lorsque la proposition est inexploitable. */
  rejected?: string;
}

export async function analyzeInstruction(
  promptCode: string,
  currentContent: string,
  instruction: string,
  accountId: number,
  userId: number,
): Promise<AnalysisProposal> {
  const res = await AiGateway.execute({
    useCaseCode: 'AI_GOVERNANCE',
    operationCode: 'analyze_instruction',
    accountId,
    userId,
    promptVariables: {
      PROMPT_CODE: promptCode,
      CURRENT_CONTENT: currentContent,
      INSTRUCTION: instruction,
    },
    outputSchema: InstructionAnalysisOutput,
  });

  const diff = computeDiff(currentContent, res.data.proposedContent);

  // Une proposition qui ne change rien n'a pas à encombrer le circuit de
  // validation : elle est refusée avant même l'affichage du diff.
  const rejected = diff.identical
    ? "la proposition est identique au prompt actuel — aucune modification à valider"
    : undefined;

  return {
    impactAnalysis: res.data.impactAnalysis,
    proposedContent: res.data.proposedContent,
    proposedHash: hashContent(res.data.proposedContent),
    risks: res.data.risks,
    diff,
    rejected,
  };
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
