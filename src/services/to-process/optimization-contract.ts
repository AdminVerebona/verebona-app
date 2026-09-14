/**
 * Contrat de sortie du traitement d'optimisation — CDC V2.0 §11.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SORTIE PAR DONNÉE ANALYSÉE, PAS UNE PAR DOCUMENT
 *
 * Le §11.5 énumère les champs attendus « pour chaque donnée ou relation
 * analysée ». C'est la granularité qui rend le §7.1 tenable — « une carte =
 * une action » — et celle qui permet au §7.3 de reconnaître un problème déjà
 * connu : sans `fieldKey` dans la sortie, impossible de savoir si la nouvelle
 * analyse redit la même chose ou en dit une autre.
 *
 * ── CE CONTRAT EST AUSSI LA TRACE ─────────────────────────────────────────
 *
 * `reasonCode`, `ruleCode`, `promptVersion` et `pipelineVersion` ne servent à
 * aucune décision. Ils servent au jour où un utilisateur signale que Verebona
 * s'est trompé : sans eux, on sait qu'une valeur est fausse, jamais quelle
 * règle ni quelle version l'a produite — donc jamais si une correction a
 * réglé le problème ou l'a déplacé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type {
  ActionProposal,
  TargetType,
  ValueOrigin,
} from './action-model';
import type { Decision, DecisionReasonCode, RecommendedDecision } from './decision-engine';

/** Une ligne de sortie, telle que décrite au §11.5. */
export interface OptimizationOutput {
  objectType: TargetType;
  objectId: number;
  /** Donnée analysée. Exclusif avec `relationKey`. */
  fieldKey?: string;
  /** Relation analysée. Exclusif avec `fieldKey`. */
  relationKey?: string;
  currentValue: string | number | boolean | null;
  proposedValues: ActionProposal[];
  recommendedDecision: RecommendedDecision;
  reasonCode: DecisionReasonCode;
  ruleCode: string | null;
  /** Version du prompt ayant produit les propositions, quand un modèle a été appelé. */
  promptVersion: string | null;
  pipelineVersion: string;
  /** Version du référentiel en vigueur au moment de la décision (§11.6). */
  referentialVersion: string;
  /** Origine à inscrire si la décision écrit une valeur (§12.1). */
  origin?: ValueOrigin;
  /** Valeur à écrire pour APPLY / UPDATE. */
  valueToWrite?: string | number | boolean | null;
  explanation: string;
}

export interface OutputContext {
  objectType: TargetType;
  objectId: number;
  fieldKey?: string;
  relationKey?: string;
  currentValue: string | number | boolean | null;
  proposals: ActionProposal[];
  promptVersion?: string | null;
  pipelineVersion: string;
  referentialVersion: string;
}

/**
 * Projette une décision du moteur dans le format du §11.5.
 *
 * `proposedValues` reprend les propositions PORTÉES PAR LA DÉCISION lorsqu'il
 * y en a — elles sont filtrées (valeur utilisateur jointe, candidats
 * divergents seuls) — et à défaut les propositions d'entrée. Rendre
 * systématiquement les propositions brutes ferait apparaître dans la trace des
 * candidats que le moteur avait écartés, et l'on croirait à tort qu'ils ont
 * été soumis à l'utilisateur.
 */
export function toOptimizationOutput(
  decision: Decision,
  ctx: OutputContext,
): OptimizationOutput {
  return {
    objectType: ctx.objectType,
    objectId: ctx.objectId,
    fieldKey: ctx.fieldKey,
    relationKey: ctx.relationKey,
    currentValue: ctx.currentValue,
    proposedValues: decision.proposals ?? ctx.proposals,
    recommendedDecision: decision.decision,
    reasonCode: decision.reasonCode,
    ruleCode: decision.ruleCode,
    promptVersion: ctx.promptVersion ?? null,
    pipelineVersion: ctx.pipelineVersion,
    referentialVersion: ctx.referentialVersion,
    origin: decision.origin,
    valueToWrite: decision.valueToWrite,
    explanation: decision.explanation,
  };
}

/** Synthèse d'un passage du traitement, pour le journal technique. */
export interface OptimizationRunSummary {
  outputs: OptimizationOutput[];
  appliedCount: number;
  actionCount: number;
  ignoredCount: number;
}

export function summarize(outputs: OptimizationOutput[]): OptimizationRunSummary {
  return {
    outputs,
    appliedCount: outputs.filter(
      (o) => o.recommendedDecision === 'APPLY' || o.recommendedDecision === 'UPDATE',
    ).length,
    actionCount: outputs.filter(
      (o) => o.recommendedDecision === 'ARBITRATE' || o.recommendedDecision === 'COMPLETE',
    ).length,
    ignoredCount: outputs.filter(
      (o) => o.recommendedDecision === 'IGNORE' || o.recommendedDecision === 'KEEP',
    ).length,
  };
}
