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
import { collectAssetEvidenceState } from './evidence-collector';
import { decide } from './decision/decision-matrix';
import { canRequestAiReview } from './decision/ai-exclusion';
import { resolveAmbiguity } from './ambiguity-resolver';
import { applyDecision, retractAutomaticValue } from './apply-decision';
import {
  planRetractions, retractionDecision, withoutStaleAuthority, NEGATIVE_REASON, isT4DateRevision, T4_REVISION_REASON,
} from './negative-reconciliation';
import { listRetiredEvidenceValues } from '../evidence/field-evidence.service';
import { writeConflict, resolveObsoleteConflict } from './conflict-writer';
import { openRun, closeRun, recordDecisions, failRun } from './reconciliation-run.repository';
import { syncReconciliationToProcess } from '@/services/to-process/reconciliation-bridge';
import type { ReconciliationDecision, ReconciliationRun } from './types';

export interface ReconcileInput {
  accountId: number;
  assetId: number;
  userId?: number;
  /** Origine du déclenchement, tracée dans l'exécution. */
  triggeredBy: 'document_analyzed' | 'document_linked' | 'manual' | 'scheduled' | 'field_changed';
  sourceFileId?: number | null;
  /** Exécution T3 (compte) à laquelle ce run local appartient. */
  accountRunId?: number | null;
}

export async function reconcileAsset(input: ReconcileInput): Promise<ReconciliationRun> {
  const traceId = randomUUID();
  // Lot 16b-3 : plus de mode observation (drapeau `AI_RECONCILIATION_ENGINE`
  // supprimé) — le moteur écrit toujours ; `shadow` reste tracé à `false`.
  const runId = await openRun({
    accountId: input.accountId, assetId: input.assetId,
    triggeredBy: input.triggeredBy, shadow: false, traceId, accountRunId: input.accountRunId ?? null,
  });
  try {
    const run = await runEngine(input, runId, traceId);
    await reconcileAgendaStatusAfter(input);
    return run;
  } catch (e) {
    // Un run local en échec est clos comme tel : il n'apparaît plus « en
    // cours », et l'exécution T3 qui l'a lancé peut continuer avec les autres.
    await failRun(runId).catch(() => {});
    throw e;
  }
}

/**
 * CDC 15 T4-12 à T4-14 (lot 14) — un document analysé ou rattaché est une
 * preuve possible de RÉALISATION d'une échéance du bien : la réconciliation
 * de statut (`reconcileStatus`, T4) s'exécute ici, après celle des champs,
 * dans le même travail (file T3 pour l'analyse et le cycle de vie des
 * documents). Jamais bloquante.
 */
async function reconcileAgendaStatusAfter(input: ReconcileInput): Promise<void> {
  if (!input.sourceFileId) return;
  if (input.triggeredBy !== 'document_analyzed' && input.triggeredBy !== 'document_linked') return;
  try {
    const { reconcileAgendaStatusForSource } = await import('@/services/agenda/agenda-status-sync');
    await reconcileAgendaStatusForSource({
      accountId: input.accountId, assetId: input.assetId, sourceFileId: input.sourceFileId, userId: input.userId,
    });
  } catch (e) {
    // Interruption (arrêt d'urgence, désactivation) : remontée, le travail
    // est remis en file ; toute autre erreur est non bloquante.
    const { isExecutionCancelled } = await import('../queue/execution-control');
    if (isExecutionCancelled(e)) throw e;
    console.error('[reconciliation] réconciliation de statut agenda (non bloquante) :', (e as Error).message);
  }
}

async function runEngine(input: ReconcileInput, runId: number, traceId: string): Promise<ReconciliationRun> {

  const { kc, fields: collected } = await collectAssetEvidenceState(input.accountId, input.assetId);
  const decisions: ReconciliationDecision[] = [];
  // ══════════════════════════════════════════════════════════════════════
  // RÉCONCILIATION NÉGATIVE (CDC 15 T3-04) — toujours active depuis le lot
  // 16b-3 (commutateur `T3_NEGATIVE_RECONCILIATION` supprimé, comportement de
  // l'ancien `enabled`) : une valeur automatique qui n'est plus prouvée perd
  // l'autorité mémorisée de sa preuve disparue (la meilleure preuve restante
  // l'emporte) ; sans aucune preuve active restante, elle est retirée
  // (`retractAutomaticValue`). USER/ADMIN jamais touchés.
  // ══════════════════════════════════════════════════════════════════════

  for (const field of collected) {
    // D-M (lot 20) : date tranchée par T4 → la preuve révisée corrige la
    // valeur automatique qu'elle remplace (jamais une valeur USER/ADMIN).
    const revision = isT4DateRevision(field.unproven, field.input);
    let decision = field.unproven || revision
      ? decide(withoutStaleAuthority(field.input))
      : decide(field.input);
    if (revision && decision.action === 'update') {
      decision = { ...decision, reasonCode: T4_REVISION_REASON };
    } else if (field.unproven && decision.action === 'update') {
      decision = { ...decision, reasonCode: NEGATIVE_REASON.REPLACE };
    }

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
          traceId,
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

  // Phase négative : valeurs automatiques dont la dernière preuve a disparu.
  if (kc) {
    const retirees = await listRetiredEvidenceValues(input.accountId, input.assetId);
    const retraits = planRetractions(kc, collected.map((f) => f.fieldKey), retirees);
    for (const r of retraits) {
      const outcome = await retractAutomaticValue({
        accountId: input.accountId, assetId: input.assetId, fieldKey: r.fieldKey, currentValue: r.currentValue, traceId,
      });
      if (outcome === 'written') {
        decisions.push(retractionDecision(r));
        await resolveObsoleteConflict(input.accountId, input.assetId, r.fieldKey, `valeur retirée : ${NEGATIVE_REASON.RETRACT}`);
      }
    }
  }
  await recordDecisions(runId, input.accountId, input.assetId, decisions);

  // ══════════════════════════════════════════════════════════════════════
  // ALIMENTATION DE LA FILE « À TRAITER » V2 (CDC V2 §11.1, §10.5)
  //
  // Le §11.1 interdit un second moteur : les décisions produites ci-dessus
  // sont traduites en actions, elles ne sont pas recalculées. Le pont filtre
  // par le catalogue §10 — un champ sans règle ne produit aucune carte,
  // conformément à P-06.
  // ══════════════════════════════════════════════════════════════════════
  await syncReconciliationToProcess({
    accountId: input.accountId,
    assetId: input.assetId,
    decisions,
  }).catch((e) => {
    console.error(
      `[reconciliation] file « À traiter » non synchronisée pour le bien ${input.assetId} :`,
      (e as Error).message,
    );
  });

  const summary: ReconciliationRun = {
    runId,
    accountId: input.accountId,
    assetId: input.assetId,
    triggeredBy: input.triggeredBy,
    decisions,
    appliedCount: decisions.filter((d) => d.action === 'apply' || d.action === 'update').length,
    conflictCount: decisions.filter((d) => d.action === 'create_conflict').length,
    aiReviewCount: decisions.filter((d) => !d.deterministic).length,
    shadow: false,
  };

  await closeRun(runId, summary);
  return summary;
}
