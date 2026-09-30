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
  planRetractions, retractionDecision, withoutStaleAuthority, NEGATIVE_REASON,
} from './negative-reconciliation';
import { listRetiredEvidenceValues } from '../evidence/field-evidence.service';
import { t3NegativeMode } from '@/services/canonical/rollout';
import { writeConflict, resolveObsoleteConflict } from './conflict-writer';
import { openRun, closeRun, recordDecisions, failRun } from './reconciliation-run.repository';
import { shouldWrite } from '../flags/ai-feature-flags';
import { syncReconciliationToProcess } from '@/services/to-process/reconciliation-bridge';
import type { ReconciliationDecision, ReconciliationRun } from './types';

export interface ReconcileInput {
  accountId: number;
  assetId: number;
  userId?: number;
  /** Origine du déclenchement, tracée dans l'exécution. */
  triggeredBy: 'document_analyzed' | 'document_linked' | 'manual' | 'scheduled' | 'field_changed';
  sourceFileId?: number | null;
  /** Force le mode observation, indépendamment du flag. */
  forceShadow?: boolean;
  /** Exécution T3 (compte) à laquelle ce run local appartient. */
  accountRunId?: number | null;
}

export async function reconcileAsset(input: ReconcileInput): Promise<ReconciliationRun> {
  const traceId = randomUUID();
  // Mode observation : les décisions sont produites et journalisées, mais rien
  // n'est écrit et l'ancien moteur reste seul aux commandes (§10.2 et §10.4).
  const shadow = input.forceShadow === true || !shouldWrite('AI_RECONCILIATION_ENGINE');

  const runId = await openRun({
    accountId: input.accountId, assetId: input.assetId,
    triggeredBy: input.triggeredBy, shadow, traceId, accountRunId: input.accountRunId ?? null,
  });
  try {
    const run = await runEngine(input, runId, traceId, shadow);
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
 * documents). Gouvernée par AI_T4_EFFECTS=enabled ou T4 `master` (contrôle
 * dans `reconcileAgendaStatusForSource`) ; jamais bloquante.
 */
async function reconcileAgendaStatusAfter(input: ReconcileInput): Promise<void> {
  if (input.forceShadow || !input.sourceFileId) return;
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

async function runEngine(input: ReconcileInput, runId: number, traceId: string, shadow: boolean): Promise<ReconciliationRun> {

  const { kc, fields: collected } = await collectAssetEvidenceState(input.accountId, input.assetId);
  const decisions: ReconciliationDecision[] = [];
  // ══════════════════════════════════════════════════════════════════════
  // RÉCONCILIATION NÉGATIVE (CDC 15 T3-04), commutateur T3_NEGATIVE_RECONCILIATION
  //   legacy   rien ;
  //   shadow   décisions inchangées ; ce qui SERAIT remplacé ou retiré est
  //            enregistré (`reconciliation_decisions`, action keep, motifs
  //            SHADOW_*) et journalisé — rien n'est écrit, la file « À
  //            traiter » n'en est pas alimentée ;
  //   enabled  une valeur automatique qui n'est plus prouvée perd l'autorité
  //            mémorisée de sa preuve disparue (la meilleure preuve restante
  //            l'emporte) ; sans aucune preuve active restante, elle est
  //            retirée (`retractAutomaticValue`). USER/ADMIN jamais touchés.
  // Le mode observation du MOTEUR (AI_RECONCILIATION_ENGINE) prime : rien
  // n'est écrit, le négatif est alors seulement observé.
  // ══════════════════════════════════════════════════════════════════════
  const negMode = t3NegativeMode();
  const negEnabled = negMode === 'enabled' && !shadow;
  const observations: ReconciliationDecision[] = [];

  for (const field of collected) {
    let decision = field.unproven && negEnabled
      ? decide(withoutStaleAuthority(field.input))
      : decide(field.input);
    if (field.unproven && negEnabled && decision.action === 'update') {
      decision = { ...decision, reasonCode: NEGATIVE_REASON.REPLACE };
    }
    if (field.unproven && negMode !== 'legacy' && !negEnabled) {
      const alt = decide(withoutStaleAuthority(field.input));
      if (alt.action === 'update' && decision.action !== 'update') {
        observations.push({ ...alt, action: 'keep', proposedValue: field.input.current?.value ?? null, reasonCode: NEGATIVE_REASON.SHADOW_REPLACE });
      }
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
  if (negMode !== 'legacy' && kc) {
    const retirees = await listRetiredEvidenceValues(input.accountId, input.assetId);
    const retraits = planRetractions(kc, collected.map((f) => f.fieldKey), retirees);
    for (const r of retraits) {
      if (!negEnabled) { observations.push(retractionDecision(r, true)); continue; }
      const outcome = await retractAutomaticValue({
        accountId: input.accountId, assetId: input.assetId, fieldKey: r.fieldKey, currentValue: r.currentValue, traceId,
      });
      if (outcome === 'written') {
        decisions.push(retractionDecision(r, false));
        await resolveObsoleteConflict(input.accountId, input.assetId, r.fieldKey, `valeur retirée : ${NEGATIVE_REASON.RETRACT}`);
      }
    }
  }
  if (observations.length) {
    console.info(JSON.stringify({
      event: 't3.negative_reconciliation', mode: negMode, engineShadow: shadow,
      accountId: input.accountId, assetId: input.assetId, runId,
      // Jamais de valeur dans le journal (données du bien) : clés et motifs.
      observations: observations.map((o) => ({ fieldKey: o.fieldKey, reasonCode: o.reasonCode })),
      counts: {
        wouldRetract: observations.filter((o) => o.reasonCode === NEGATIVE_REASON.SHADOW_RETRACT).length,
        wouldReplace: observations.filter((o) => o.reasonCode === NEGATIVE_REASON.SHADOW_REPLACE).length,
      },
    }));
  }

  await recordDecisions(runId, input.accountId, input.assetId, [...decisions, ...observations]);

  // ══════════════════════════════════════════════════════════════════════
  // ALIMENTATION DE LA FILE « À TRAITER » V2 (CDC V2 §11.1, §10.5)
  //
  // Le §11.1 interdit un second moteur : les décisions produites ci-dessus
  // sont traduites en actions, elles ne sont pas recalculées. Le pont filtre
  // par le catalogue §10 — un champ sans règle ne produit aucune carte,
  // conformément à P-06.
  //
  // En mode observation, rien n'est écrit : la file refléterait des décisions
  // que la base ne porte pas, et l'utilisateur arbitrerait dans le vide.
  // ══════════════════════════════════════════════════════════════════════
  if (!shadow) {
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
  }

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
