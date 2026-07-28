/**
 * Moteur unique de réconciliation — USAGE IA n°2.
 *
 * Remplace à lui seul `apply-ai-suggestions.ts`, `enrich-and-coherence.service.ts`,
 * la complétion post-analyse et la partie ambiguë de `equipment-auto-link`.
 * Critère d'acceptation n°8 : « un seul moteur enrichit, contrôle et réconcilie ».
 *
 * DEUX RUPTURES AVEC L'EXISTANT
 *
 *  1. Il contrôle les champs RENSEIGNÉS autant que les champs vides
 *     (critère n°9). L'ancienne règle « si le champ est renseigné, ne rien
 *     proposer » a disparu du code comme des prompts.
 *
 *  2. Il ne relit jamais les documents. Il travaille sur les preuves produites
 *     par l'analyse, ce qui supprime les réanalyses coûteuses de l'ancien
 *     enrichissement horaire (§5.6).
 */
import { randomUUID } from 'crypto';
import { collectFields } from './evidence-collector';
import { decide } from './decision/decision-matrix';
import { canRequestAiReview } from './decision/ai-exclusion';
import { resolveAmbiguity } from './ambiguity-resolver';
import { applyDecision } from './apply-decision';
import { writeConflict, resolveObsoleteConflict } from './conflict-writer';
import { openRun, closeRun, recordDecisions } from './reconciliation-run.repository';
import { shouldWrite } from '../flags/ai-feature-flags';
import type { ReconciliationDecision, ReconciliationRun } from './types';

export interface ReconcileInput {
  accountId: number;
  assetId: number;
  userId?: number;
  /** Origine du déclenchement, tracée dans l'exécution. */
  triggeredBy: 'document_analyzed' | 'manual' | 'scheduled' | 'field_changed';
  sourceFileId?: number | null;
  /** Force le mode observation, indépendamment du flag. */
  forceShadow?: boolean;
}

export async function reconcileAsset(input: ReconcileInput): Promise<ReconciliationRun> {
  const traceId = randomUUID();
  // Mode observation : les décisions sont produites et journalisées, mais rien
  // n'est écrit et l'ancien moteur reste seul aux commandes (§10.2 et §10.4).
  const shadow = input.forceShadow === true || !shouldWrite('AI_RECONCILIATION_ENGINE');

  const runId = await openRun({
    accountId: input.accountId, assetId: input.assetId,
    triggeredBy: input.triggeredBy, shadow, traceId,
  });

  const collected = await collectFields(input.accountId, input.assetId);
  const decisions: ReconciliationDecision[] = [];

  for (const field of collected) {
    let decision = decide(field.input);

    // Étape 7 du §4.2.8 : appel modèle UNIQUEMENT si le déterminisme n'a pas
    // tranché — et jamais sur un champ exclu du périmètre modèle.
    if (decision.action === 'request_ai_review' && canRequestAiReview(decision.fieldKey)) {
      decision = await resolveAmbiguity({
        accountId: input.accountId,
        assetId: input.assetId,
        decision,
        candidates: field.input.candidates,
        currentValue: field.input.current?.value ?? null,
        currentOrigin: field.input.current?.origin ?? 'USER',
      });
    }

    decisions.push(decision);

    if (shadow) continue;

    switch (decision.action) {
      case 'apply':
      case 'update':
        await applyDecision(decision, {
          accountId: input.accountId,
          assetId: input.assetId,
          sourceFileId: input.sourceFileId ?? null,
          bestCandidate: field.input.candidates.find(
            (c) => c.evidenceId === decision.evidenceIds[0],
          ),
        });
        // Une décision tranchée rend caduc un arbitrage antérieur sur ce champ.
        await resolveObsoleteConflict(
          input.accountId, input.assetId, decision.fieldKey,
          `tranché automatiquement : ${decision.reasonCode}`,
        );
        break;

      case 'create_conflict':
        await writeConflict(decision, {
          accountId: input.accountId,
          assetId: input.assetId,
          currentEvidenceIds: [],
          currentOrigin: field.input.current?.origin ?? 'USER',
          traceId,
        });
        break;

      case 'keep':
      case 'ignore':
      case 'request_ai_review':
        break;
    }
  }

  await recordDecisions(runId, input.accountId, input.assetId, decisions);

  const summary: ReconciliationRun = {
    runId,
    accountId: input.accountId,
    assetId: input.assetId,
    triggeredBy: input.triggeredBy,
    decisions,
    appliedCount: decisions.filter((d) => d.action === 'apply' || d.action === 'update').length,
    conflictCount: decisions.filter((d) => d.action === 'create_conflict').length,
    aiReviewCount: decisions.filter((d) => !d.deterministic).length,
    shadow,
  };

  await closeRun(runId, summary);
  return summary;
}
