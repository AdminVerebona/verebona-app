/**
 * COH-TCO-AMOUNT-RECOVERY — justificatif de dépense dont le TCO ne connaît
 * pas le montant : récupération AUTOMATIQUE avant toute alerte (lot 108B,
 * ticket TCO-646 §B ; décision PO : « un montant financier manquant
 * déclenche d'abord une tentative de récupération automatique T1 ; une
 * demande à l'utilisateur est un dernier recours »). Ajouté EN FIN de registre.
 *
 * Objet : le DOCUMENT (justificatif financier rattaché à un bien vivant).
 * Inspection en lecture seule (`amount-recovery.service#diagnoseAmountRecovery`,
 * règles pures `tco/amount-recovery.ts`) :
 *   · montant établi par les sources PERSISTÉES (extraction T1, unité de la
 *     couche A, composante qui ne cite que ce document, total recoupé de la
 *     transcription ; candidats non établis = propositions) → REPAIRABLE :
 *     montant posé sur le document avec preuve et provenance (aucune IA) ;
 *   · sinon → REPAIRABLE : relance T1 du document original par la file T1
 *     existante (traitement technique non facturé), bornée par empreinte
 *     (fichier, configuration T1, règles) et au total ; budget commun des
 *     relances IA de la cohérence ; comptes Premium / essai seulement (le
 *     TCO n'est visible que là) — relance ASYNCHRONE (réparation en attente) ;
 *   · relance aboutie → provenance T1 consignée ; échec technique → constat
 *     `AMOUNT_RECOVERY_TECHNICAL_FAILURE` signalé IMMÉDIATEMENT dans la
 *     Supervision (jamais une carte « À traiter ») ; échec réel → constat
 *     `AMOUNT_TO_CONFIRM` / `AMOUNT_NOT_FOUND` : la fiche du bien affiche le
 *     document, un lien direct et l'action (dernier recours : l'utilisateur).
 * Jamais de montant inventé, jamais d'« inconnu » assimilé à 0, jamais de
 * saisie USER remplacée, jamais d'Opération créée.
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

export const TCO_AMOUNT_RECOVERY_CHECK_ID = 'COH-TCO-AMOUNT-RECOVERY';

const DETAIL_MAX = 10;

type Diagnosis = import('@/services/business-operations/tco/amount-recovery.service').AmountRecoveryDiagnosis;

/** Empreinte du diagnostic : identique tant qu'une même relance est attendue (anti-boucle du moteur). */
function inputHashOf(d: Diagnosis): string {
  const a = d.action;
  if (a.kind === 'RELAUNCH_T1') return hashOf({ f: d.fileId, k: 'T1', fp: d.fingerprint, n: a.attempt });
  if (a.kind === 'WAIT' && a.state === 'T1_PENDING') return hashOf({ f: d.fileId, k: 'T1', fp: d.row?.fingerprint ?? d.fingerprint, n: d.row?.totalAttempts ?? 0 });
  if (a.kind === 'APPLY') return hashOf({ f: d.fileId, k: 'APPLY', c: a.candidate.cents, r: a.candidate.role, s: `${a.candidate.kind}:${a.candidate.ref}` });
  return hashOf({ f: d.fileId, k: a.kind, s: 'state' in a ? a.state : null, fp: d.fingerprint });
}

function inspectionOf(d: Diagnosis): Inspection {
  const a = d.action;
  const detail = {
    fileId: d.fileId, row: d.row ? { status: d.row.status, attempts: d.row.totalAttempts, technicalFailures: d.row.technicalFailures } : null,
    sources: d.sources.slice(0, DETAIL_MAX).map((s) => ({ kind: s.kind, cents: s.cents, role: s.role, confidence: s.confidence, ref: s.ref })),
    action: a.kind, t1Relaunch: a.kind === 'RELAUNCH_T1',
  };
  const inputHash = inputHashOf(d);
  switch (a.kind) {
    case 'NONE': return { verdict: d.document ? 'CONSISTENT' : 'GONE', detail };
    case 'APPLY': return {
      verdict: 'REPAIRABLE', anomaly: 'AMOUNT_RECOVERABLE_FROM_PERSISTED', faultyLink: 'PERSISTENCE',
      expected: 'montant du justificatif connu du moteur TCO', observed: { cents: a.candidate.cents, role: a.candidate.role, source: a.candidate.kind },
      detail: { ...detail, repair: 'APPLY' }, inputHash,
    };
    case 'RECORD_RESULT': return {
      verdict: 'REPAIRABLE', anomaly: 'AMOUNT_RECOVERY_RESULT_UNRECORDED', faultyLink: 'PERSISTENCE',
      expected: 'provenance du montant retrouvé consignée', observed: { state: a.state, cents: a.amountCents }, detail: { ...detail, repair: 'RECORD' }, inputHash,
    };
    case 'RELAUNCH_T1': return {
      verdict: 'REPAIRABLE', anomaly: 'AMOUNT_UNKNOWN_T1_RELAUNCH', faultyLink: 'T1',
      expected: 'montant relu par T1 sur le document original', observed: { attempt: a.attempt, technicalRetry: a.retryAfterTechnical },
      detail: { ...detail, repair: 'T1' }, inputHash,
    };
    case 'WAIT': return a.state === 'T1_PENDING'
      ? { verdict: 'REPAIRABLE', anomaly: 'AMOUNT_UNKNOWN_T1_RELAUNCH', faultyLink: 'T1', detail: { ...detail, repair: 'WAIT', reason: a.reason }, inputHash }
      : { verdict: 'FINDING', anomaly: 'AMOUNT_RECOVERY_WAITING', faultyLink: 'T1', detail: { ...detail, reason: a.reason }, inputHash };
    case 'FAIL': {
      const anomaly = a.state === 'TECHNICAL_FAILURE' ? 'AMOUNT_RECOVERY_TECHNICAL_FAILURE'
        : a.state === 'NOT_FOUND' ? 'AMOUNT_NOT_FOUND' : a.state === 'USER_OWNED' ? 'AMOUNT_CLEARED_BY_USER' : 'AMOUNT_TO_CONFIRM';
      return {
        verdict: 'FINDING', anomaly, faultyLink: 'T1',
        expected: 'montant établi automatiquement, sinon demandé à l’utilisateur sur la fiche du bien (jamais une carte « À traiter » pour un incident technique)',
        observed: { state: a.state, reason: a.reason, proposals: a.proposals.slice(0, DETAIL_MAX).map((s) => ({ cents: s.cents, role: s.role, kind: s.kind })) },
        detail: { ...detail, reason: a.reason }, inputHash,
      };
    }
  }
}

async function context(ctx: CheckContext, accountId: number): Promise<{ t1Allowed: boolean; budgetLeft: boolean }> {
  const [{ getEntitlements }, { t1RelaunchBudgetLeft }] = await Promise.all([import('@/services/entitlements.service'), import('./extract-chain')]);
  let t1Allowed = false;
  try { t1Allowed = (await getEntitlements(accountId)).premiumFeatures === true; } catch { t1Allowed = false; }
  return { t1Allowed, budgetLeft: (await t1RelaunchBudgetLeft(ctx)) > 0 };
}

async function diagnose(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, Diagnosis>> {
  const { diagnoseAmountRecovery } = await import('@/services/business-operations/tco/amount-recovery.service');
  return diagnoseAmountRecovery(ctx.sql, accountId, ids, { now: ctx.now, today: ctx.today, hashOf, ...(await context(ctx, accountId)) });
}

async function candidats(ctx: CheckContext, accountId: number, extra: string, params: unknown[], tail = ''): Promise<number[]> {
  const s = await import('@/services/business-operations/tco/amount-recovery.service');
  if (!(await s.amountRecoveryTableReady(ctx.sql))) return [];
  const { codes, invoiceLike } = await s.expenseTypeFilters();
  return idsOf(await rows(ctx.sql, s.AMOUNT_RECOVERY_CANDIDATES_SQL(codes, invoiceLike, extra, tail), [accountId, ...params]));
}

export const tcoAmountRecoveryCheck: CoherenceCheck = {
  id: TCO_AMOUNT_RECOVERY_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'TCO : montant inconnu d’un justificatif de dépense récupéré automatiquement avant toute alerte',
  domain: 'tco',
  level: 'N3',
  objectType: 'document',
  scope: 'justificatifs financiers (facture, ticket, quittance…) rattachés à un bien vivant, sans montant exploitable pour le moteur TCO, ou dont une récupération est en cours',
  sources: ['asset_files', 'document_extractions', 'document_source_units', 'document_operation_candidates', 'business_operation_financial_components',
    'business_operation_financial_component_sources', 'ai_job_queue', 'document_amount_recoveries'],
  applicability: 'compte éligible ; relance T1 réservée aux comptes Premium / Premium Duo / essai (le TCO n’est visible que là) ; budget commun des relances IA de la cohérence (COHERENCE_T1_RELAUNCH_DAILY_MAX)',
  invariant: 'aucune alerte « montant illisible » tant qu’une récupération automatique est possible ; un montant retrouvé est posé une fois, avec sa preuve et sa provenance ; après échec réel, le document est identifié avec un lien et une action',
  anomalies: ['AMOUNT_RECOVERABLE_FROM_PERSISTED', 'AMOUNT_RECOVERY_RESULT_UNRECORDED', 'AMOUNT_UNKNOWN_T1_RELAUNCH', 'AMOUNT_RECOVERY_WAITING',
    'AMOUNT_RECOVERY_TECHNICAL_FAILURE', 'AMOUNT_TO_CONFIRM', 'AMOUNT_NOT_FOUND', 'AMOUNT_CLEARED_BY_USER'],
  autoRepairWhen: 'un seul montant établi par les sources persistées (même valeur, même rôle de montant du document, aucune contradiction) ; sinon relance T1 bornée (1 par empreinte fichier × configuration T1 × règles, 3 au total, reprises techniques espacées)',
  forbiddenRepairs: ['inventer un montant ou compter 0 €', 'remplacer un montant saisi ou retiré par l’utilisateur', 'retenir un HT, une TVA, une remise, un paiement ou un acompte comme total sans preuve',
    'relancer T1 à la consultation', 'créer une carte « À traiter » pour un incident technique', 'créer une Opération'],
  services: ['business-operations/tco/amount-recovery.service#applyRecoveredAmount', 'business-operations/tco/amount-recovery.service#requestT1Relaunch',
    'ai/source-analysis/queue/t1-handler#enqueueFileAnalyses', 'business-operations/finance/economic-lines#qualifyDocumentLines'],
  chain: ['EXTRACT', 'T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse / modification du document',
  criticality: 'HIGH',
  tests: ['L108B-U-PLAN', 'L108B-U-VIEW', 'L108B-E2E-01', 'L108B-E2E-02', 'L108B-E2E-03', 'L108B-E2E-04', 'L108B-E2E-05'],
  // Échec réel : signalé à l'utilisateur sur la fiche du bien (« Montant à confirmer / introuvable ») — pas un constat technique.
  externalSupervision: 'fiche du bien (TCO : « Montant à confirmer » / « Montant introuvable »)',
  immediateSupervision: ['AMOUNT_RECOVERY_TECHNICAL_FAILURE'],

  async listObjects(ctx, accountId, afterId, limit) {
    return candidats(ctx, accountId, 'AND f.id > $2', [afterId, limit], 'ORDER BY f.id LIMIT $3');
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return candidats(ctx, accountId, 'AND f.id = $2', [e.entityId]);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const diags = await diagnose(ctx, accountId, ids);
    for (const id of intArray(ids)) {
      const d = diags.get(id);
      out.set(id, d ? inspectionOf(d) : { verdict: 'GONE' });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const s = await import('@/services/business-operations/tco/amount-recovery.service');
    // Diagnostic relu au moment de réparer (jamais sur un état périmé).
    const diags = await diagnose(ctx, accountId, items.map((i) => i.id));
    for (const { id } of items) {
      const d = diags.get(id);
      const a = d?.action;
      if (!d || !a) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      if (a.kind === 'APPLY') {
        const r = await s.applyRecoveredAmount(ctx.sql, accountId, d);
        out.set(id, {
          called: true, service: s.AMOUNT_RECOVERY_APPLY_SERVICE, aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
          result: { applied: r.applied, cents: r.amountCents, role: a.candidate.role, source: a.candidate.kind, ref: a.candidate.ref },
          rollbackRef: r.applied ? `asset_files:id=${id}:amount_cents=NULL;document_amount_recoveries:file=${id}` : null,
        });
      } else if (a.kind === 'RECORD_RESULT') {
        await s.recordRecoveryResult(ctx.sql, accountId, d);
        out.set(id, { called: true, service: 'recordRecoveryResult', aiCalls: 0, result: { state: a.state, cents: a.amountCents } });
      } else if (a.kind === 'RELAUNCH_T1') {
        const r = await s.requestT1Relaunch(ctx.sql, accountId, d);
        out.set(id, {
          called: true, service: s.AMOUNT_RECOVERY_T1_SERVICE, pending: true, aiCalls: 0,
          result: { queued: r.queued, attempt: a.attempt, technicalRetry: a.retryAfterTechnical, origin: s.AMOUNT_RECOVERY_T1_ORIGIN },
          rollbackRef: `document_amount_recoveries:file=${id}`,
        });
      } else if (a.kind === 'WAIT' && a.state === 'T1_PENDING') {
        // Relance déjà en file : on en attend l'issue, jamais une seconde relance.
        out.set(id, { called: false, service: 'none', pending: true, result: { skipped: 'T1_RELAUNCH_IN_PROGRESS' } });
      } else {
        out.set(id, { called: false, service: 'none', result: { skipped: 'NO_REPAIR_FOR_DIAGNOSTIC', action: a.kind } });
      }
    }
    return out;
  },

  async recordOutcomes(ctx, accountId, items) {
    const s = await import('@/services/business-operations/tco/amount-recovery.service');
    if (!(await s.amountRecoveryTableReady(ctx.sql))) return;
    const diags = await diagnose(ctx, accountId, items.map((i) => i.id));
    for (const it of items) {
      const d = diags.get(it.id);
      if (d) await s.recordRecoveryOutcome(ctx.sql, accountId, d, { dryRun: ctx.mode === 'DRY_RUN' || it.result === 'WOULD_REPAIR' });
    }
  },
};
