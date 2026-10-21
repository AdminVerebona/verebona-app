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
import { assertJobActive } from '../queue/execution-control';
import { T3ExecutionRecorder, writeT3Report } from '../execution-report/t3-report';
import { isRegistryKey } from './canonical-key';
import { guardFreeText, isFreeTextKey } from './information-check/inventory';
import {
  assetInventory, canonicalKeyOf, crossCheckAsset, loadConflictMemory, prepareInformationSources, recordInformationCheck,
} from './information-check/engine-steps';

export interface ReconcileInput {
  accountId: number;
  assetId: number;
  userId?: number;
  /** Origine du déclenchement, tracée dans l'exécution. */
  triggeredBy: 'document_analyzed' | 'document_linked' | 'manual' | 'scheduled' | 'field_changed';
  sourceFileId?: number | null;
  /** Exécution T3 (compte) à laquelle ce run local appartient. */
  accountRunId?: number | null;
  /**
   * Lot 76J : revue IA ciblée autorisée (défaut). Faux pour le rattrapage
   * du stock : une preuve ambiguë reste sans décision (aucun appel modèle,
   * aucune carte), comme avant le passage.
   */
  aiReview?: boolean;
}

export async function reconcileAsset(input: ReconcileInput): Promise<ReconciliationRun> {
  const traceId = randomUUID();
  // Lot 16b-3 : plus de mode observation (drapeau `AI_RECONCILIATION_ENGINE`
  // supprimé) — le moteur écrit toujours ; `shadow` reste tracé à `false`.
  const runId = await openRun({
    accountId: input.accountId, assetId: input.assetId,
    triggeredBy: input.triggeredBy, shadow: false, traceId, accountRunId: input.accountRunId ?? null,
  });
  // Lot 58C : rapport d'exécution (champs examinés, écritures confirmées, motifs).
  const rec = new T3ExecutionRecorder(traceId);
  const rapport = () => writeT3Report(rec, {
    accountId: input.accountId, assetId: input.assetId, reconciliationRunId: runId, accountRunId: input.accountRunId ?? null,
    sourceFileId: input.sourceFileId ?? null, triggeredBy: input.triggeredBy,
  });
  try {
    const run = await runEngine(input, runId, traceId, rec);
    await reconcileAgendaStatusAfter(input);
    await rapport();
    return run;
  } catch (e) {
    // Un run local en échec est clos comme tel : il n'apparaît plus « en
    // cours », et l'exécution T3 qui l'a lancé peut continuer avec les autres.
    await failRun(runId).catch(() => {});
    const { isExecutionCancelled } = await import('../queue/execution-control');
    if (!isExecutionCancelled(e)) {
      rec.failure = (e as Error)?.message ?? String(e);
      await rapport();
    }
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
  await assertJobActive('statut agenda');
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

async function runEngine(input: ReconcileInput, runId: number, traceId: string, rec?: T3ExecutionRecorder): Promise<ReconciliationRun> {

  // Lot 76J (T3 complétude) : prix d'achat ancrés dans les candidats
  // Opération T1 → preuves ordinaires, AVANT la collecte (même moteur).
  const sources = await prepareInformationSources({ accountId: input.accountId, assetId: input.assetId }, rec);
  const { kc, fields: collected, asset } = await collectAssetEvidenceState(input.accountId, input.assetId);
  const decisions: ReconciliationDecision[] = [];
  // Lot 76J : un arbitrage déjà tranché par l'utilisateur n'est pas reproposé à l'identique.
  const memoire = asset ? await loadConflictMemory(input.accountId, input.assetId, rec) : null;

  /** Exécute une décision tranchée (écriture, conflit) — commun aux preuves et aux sources croisées. */
  const executer = async (
    decision: ReconciliationDecision,
    trace: import('../execution-report/t3-report').T3FieldRecord,
    candidates: import('./types').EvidenceCandidate[],
    currentOrigin: string | undefined,
  ) => {
    switch (decision.action) {
      case 'apply':
      case 'update':
        // Lot 31C : garde avant toute écriture métier — une exécution de file
        // qui a perdu son jeton ou son bail n'écrit plus (sans effet hors file).
        await assertJobActive(`valeur ${decision.fieldKey}`);
        try {
          // Lot 58C : le RÉSULTAT réel de l'écriture est conservé (compteurs, rapport).
          trace.outcome = await applyDecision(decision, {
            accountId: input.accountId,
            assetId: input.assetId,
            sourceFileId: input.sourceFileId ?? null,
            bestCandidate: candidates.find(
              (c) => c.evidenceId === decision.evidenceIds[0],
            ),
            traceId,
          });
        } catch (e) {
          trace.error = (e as Error)?.message ?? String(e);
          throw e;
        }
        // Une décision tranchée rend caduc un arbitrage antérieur sur ce champ.
        await resolveObsoleteConflict(
          input.accountId, input.assetId, decision.fieldKey,
          `tranché automatiquement : ${decision.reasonCode}`,
        );
        break;

      case 'create_conflict':
        await assertJobActive(`proposition ${decision.fieldKey}`);
        await writeConflict(decision, {
          accountId: input.accountId,
          assetId: input.assetId,
          currentEvidenceIds: [],
          currentOrigin: currentOrigin ?? 'USER',
          traceId,
        });
        break;

      case 'keep':
      case 'ignore':
      case 'request_ai_review':
        break;
    }
  };
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
    if (decision.action === 'request_ai_review' && input.aiReview !== false && canRequestAiReview(decision.fieldKey)) {
      decision = await resolveAmbiguity({
        accountId: input.accountId,
        assetId: input.assetId,
        decision,
        candidates: field.input.candidates,
        currentValue: field.input.current?.value ?? null,
        currentOrigin: field.input.current?.origin ?? 'USER',
      });
    }

    // Lot 76J : texte libre (description, notes) jamais réécrit automatiquement ;
    // arbitrage déjà tranché à l'identique : conservé, sans nouvelle carte.
    decision = guardFreeText(decision);
    if (memoire) decision = await memoire.filter(decision);

    decisions.push(decision);
    if (!decision.deterministic && rec) rec.aiCalls++;
    const trace = { fieldKey: decision.fieldKey, current: field.input.current, candidates: field.input.candidates, decision, registry: isRegistryKey(decision.fieldKey) } as import('../execution-report/t3-report').T3FieldRecord;
    rec?.fields.push(trace);

    await executer(decision, trace, field.input.candidates, field.input.current?.origin);
  }

  // ══════════════════════════════════════════════════════════════════════
  // LOT 76J — CONFRONTATION TRANSVERSALE (date d'achat ↔ agenda / Opérations)
  //
  // La date de l'agenda n'est pas nécessairement la bonne : seul un achat
  // CONFIRMÉ par l'utilisateur complète un champ vide ou ouvre un arbitrage
  // (une fois par signature) ; un événement automatique non confirmé, une
  // projection de la fiche ou une donnée du même document que les preuves
  // ne sont que des constats (rapport), jamais des preuves indépendantes.
  // ══════════════════════════════════════════════════════════════════════
  let signatureCroisee: string | null = null;
  if (asset && kc) {
    const croise = await crossCheckAsset({
      accountId: input.accountId, assetId: input.assetId, asset, kc, collected, decisions,
    }, rec);
    if (croise) {
      rec?.cross.push(...croise.records);
      signatureCroisee = croise.signature;
      if (croise.decision) {
        const d = croise.decision;
        if (croise.replaces) decisions.splice(decisions.indexOf(croise.replaces), 1);
        decisions.push(d);
        const courant = asset.current(d.fieldKey);
        const trace = { fieldKey: d.fieldKey, current: courant, candidates: [], decision: d, registry: isRegistryKey(d.fieldKey) } as import('../execution-report/t3-report').T3FieldRecord;
        if (rec) {
          // Une seule ligne de rapport par champ : la décision croisée remplace la précédente.
          const i = rec.fields.findIndex((f) => canonicalKeyOf(f.fieldKey) === d.fieldKey);
          if (i >= 0) rec.fields.splice(i, 1);
          rec.fields.push(trace);
        }
        await executer(d, trace, [], courant?.origin);
      }
    }
  }

  // Phase négative : valeurs automatiques dont la dernière preuve a disparu.
  if (kc) {
    const retirees = await listRetiredEvidenceValues(input.accountId, input.assetId);
    // Lot 76J : un texte libre n'est jamais retiré automatiquement.
    const retraits = planRetractions(kc, collected.map((f) => f.fieldKey), retirees).filter((r) => !isFreeTextKey(r.fieldKey));
    for (const r of retraits) {
      await assertJobActive(`retrait ${r.fieldKey}`);
      const outcome = await retractAutomaticValue({
        accountId: input.accountId, assetId: input.assetId, fieldKey: r.fieldKey, currentValue: r.currentValue, traceId,
      });
      if (outcome === 'written') {
        decisions.push(retractionDecision(r));
        rec?.fields.push({
          fieldKey: r.fieldKey, current: { value: r.currentValue, normalized: null, origin: 'RECONCILIATION', updatedAt: null },
          candidates: [], decision: retractionDecision(r), outcome, retraction: true, registry: isRegistryKey(r.fieldKey),
        });
        await resolveObsoleteConflict(input.accountId, input.assetId, r.fieldKey, `valeur retirée : ${NEGATIVE_REASON.RETRACT}`);
      }
    }
  }
  await assertJobActive('journal des décisions');
  await recordDecisions(runId, input.accountId, input.assetId, decisions);

  // ══════════════════════════════════════════════════════════════════════
  // ALIMENTATION DE LA FILE « À TRAITER » V2 (CDC V2 §11.1, §10.5)
  //
  // Le §11.1 interdit un second moteur : les décisions produites ci-dessus
  // sont traduites en actions, elles ne sont pas recalculées. Le pont filtre
  // par le catalogue §10 — un champ sans règle ne produit aucune carte,
  // conformément à P-06.
  // ══════════════════════════════════════════════════════════════════════
  await assertJobActive('file « À traiter »');
  await syncReconciliationToProcess({
    accountId: input.accountId,
    assetId: input.assetId,
    decisions,
  }).then(() => rec?.ok('TO_PROCESS_SYNC'), (e) => {
    rec?.fail('TO_PROCESS_SYNC', e);
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
    // Lot 58C : écritures CONFIRMÉES (résultat `written` de la primitive), plus
    // les intentions. Sans enregistreur (tests historiques) : intentions.
    appliedCount: rec
      ? rec.writtenCount
      : decisions.filter((d) => d.action === 'apply' || d.action === 'update').length,
    intendedCount: decisions.filter((d) => d.action === 'apply' || d.action === 'update').length,
    conflictCount: decisions.filter((d) => d.action === 'create_conflict').length,
    aiReviewCount: decisions.filter((d) => !d.deterministic).length,
    shadow: false,
  };

  await assertJobActive('clôture du run');
  await closeRun(runId, summary);

  // Lot 76J : inventaire exhaustif (rapport) et état du contrôle (rattrapage du stock).
  if (rec && asset) {
    rec.inventory = assetInventory(asset, [...collected.map((f) => f.fieldKey), ...decisions.map((d) => d.fieldKey)]);
    await recordInformationCheck({
      accountId: input.accountId, assetId: input.assetId, runId, rec,
      signatures: { ...(memoire?.proposed ?? {}), ...(signatureCroisee ? { acquisitionDate: signatureCroisee } : {}) },
    });
  }
  // Prix d'achat ancré sur un ÉQUIPEMENT du bien : réconciliation ciblée de l'équipement (même moteur).
  for (const equipmentId of (sources?.equipmentTargets ?? []).slice(0, 20)) {
    await assertJobActive(`équipement ${equipmentId}`);
    try {
      const { reconcileEntity } = await import('./entity-reconciliation');
      await reconcileEntity({ accountId: input.accountId, target: { type: 'EQUIPMENT', id: equipmentId }, triggeredBy: 'manual', sourceFileId: null });
    } catch (e) {
      const { isExecutionCancelled } = await import('../queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      rec?.fail('INFORMATION_EQUIPMENT', e);
    }
  }
  return summary;
}
