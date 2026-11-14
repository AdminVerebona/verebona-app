/**
 * Lot 114H (Trello #775) — T1 : règle unique des reprises (P1-A), issue réelle
 * d'une remise en file (P1-B), réévaluation du stock et alertes (P1-C), issue
 * actuelle d'une couverture pour le BO (P1-D, § 6). Fonctions PURES : aucun
 * accès base, aucun appel IA, aucune dépendance à la date du jour.
 *
 *   L114H-U01  bornes lues une seule fois, valeurs 0 / absentes / hors plage ;
 *   L114H-U02  R4 — `missing > 0` ou `PENDING > 0` avec plafond à 0, atteint,
 *              dépassé : jamais INCOMPLETE_RETRYABLE, jamais COMPLETE ;
 *   L114H-U03  R4 — continuation (travail jamais exécuté) ≠ tentatives épuisées ;
 *              plafond de continuation ; relecture du fichier ;
 *   L114H-U04  garde finale des écritures : état cohérent, attente levée,
 *              politiques synchronisées, idempotente ;
 *   L114H-U05  R5 — traduction des VRAIES réponses de la file et écritures de la
 *              couverture pour chaque issue (tentatives exactes) ;
 *   L114H-U06  R6 — décision sur une alerte : close seulement si la cause a
 *              disparu, maintenue sinon, jamais rouverte sans fait nouveau ;
 *   L114H-U07  issue de la réévaluation et cible d'une empreinte ;
 *   L114H-U08  P1-D — image / scan : limite de vérification, pas une réparation
 *              en attente ; les six issues du BO ;
 *   L114H-U09  textes du BO (bilan, issues, reprises) et garde-fous de source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCompletenessReport, type ReportInput } from '../coverage';
import { withResidualPolicies } from '../coverage-reconciliation';
import {
  decideRetry, releaseUnschedulablePending, retryFactsOf, retryLimits, settleLayerRetry, type RetryFacts,
} from '../retry-policy';
import { coverageIssueOf, COVERAGE_ISSUES } from '../coverage-issue';
import { alertDecisionOf, alertTargetOf, reassessmentOutcomeOf, T1_COVERAGE_RULES_VERSION, type CoverageSnapshot } from '../historical-reassessment';
import { requeueCoverageUpdate, REQUEUE_TRANSIENT_MAX } from '../jobs';
import { t1EnqueueConfirmed, t1EnqueueOutcomeOf } from '../../queue/t1-handler';
import { SOURCE_LAYER_VERSION, type CoveredSourceUnit, type SourceLayer } from '../types';
import { issuesText, reassessmentText, type ReassessmentReport } from '@/app/admin/ai-executions/_components/T1CompletenessPanel';
import { policyLabel, retryChangeText } from '@/app/admin/ai-executions/_components/T1CompletenessUnits';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const unite = (id: string, over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
  sourceUnitId: id, kind: 'TEXT_BLOCK', page: 1, ordinal: Number(id.split(':').pop()) || 1, parentUnitId: null,
  text: 'Montant restant dû : 132,00 €', payload: {}, location: {}, origin: 'PASS_1', salient: true,
  status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0, repairAttempts: 0, repairState: null, ...over,
});
const couverte = (id: string) => unite(id, { status: 'COVERED', reason: 'fact', factCount: 1 });
const base: ReportInput = {
  factsCount: 2, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0,
  warningCodes: [], retryAllowed: true,
};
const pdfVerifie = (missing: number[] = []) => ({
  status: missing.length ? 'PARTIAL' as const : 'VERIFIED' as const, reason: missing.length ? 'pages_missing' : null,
  pagesExpected: 3, verified: [1, 2, 3].filter((p) => !missing.includes(p)), missing, unverified: [], scanned: [],
});
const DEFAUT = retryLimits({});
const faits = (over: Partial<RetryFacts> = {}): RetryFacts => ({
  pending: 0, pendingSelectable: 0, transientRepairable: 0, retryablePageGaps: 0, missingPages: 0, sourceRereadable: 0,
  transientVerification: false, manuallyRepairable: 0, ...over,
});
const couche = (units: CoveredSourceUnit[], input: Partial<ReportInput> = {}): SourceLayer => ({
  layerVersion: SOURCE_LAYER_VERSION, units, unresolvedFacts: [], retryable: true,
  report: buildCompletenessReport(units, { ...base, ...input }),
});

describe('L114H-U01 — bornes des reprises : une seule lecture, valeurs 0, absentes, hors plage', () => {
  it('défauts identiques à ceux des lots précédents', () => {
    expect(DEFAUT).toEqual({ maxRetries: 2, unitCap: 3, sourceCap: 2, continuationMaxRuns: 20, repairMaxCalls: 3 });
  });

  it('valeurs configurées, vides, non numériques, hors plage', () => {
    expect(retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '0', T1_MAX_REPAIR_PASSES: '0' })).toMatchObject({ maxRetries: 0, unitCap: 1, sourceCap: 1 });
    expect(retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '', T1_REPAIR_MAX_CALLS: 'abc' })).toMatchObject({ maxRetries: 2, repairMaxCalls: 3 });
    expect(retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '99', T1_REPAIR_CONTINUATION_MAX_RUNS: '0', T1_REPAIR_MAX_CALLS: '50' }))
      .toMatchObject({ maxRetries: 5, continuationMaxRuns: 1, repairMaxCalls: 10 });
  });

  it('`repository` et `repair` lisent ces mêmes bornes (plus de défaut dupliqué)', async () => {
    const { maxCompletenessRetries } = await import('../repository');
    const { repairAttemptCap, repairSettings } = await import('../repair');
    for (const env of [{}, { T1_COMPLETENESS_MAX_RETRIES: '0' }, { T1_COMPLETENESS_MAX_RETRIES: '4', T1_MAX_REPAIR_PASSES: '2', T1_REPAIR_MAX_CALLS: '7' }]) {
      const l = retryLimits(env);
      expect(maxCompletenessRetries(env)).toBe(l.maxRetries);
      expect(repairAttemptCap(env)).toBe(l.unitCap);
      expect(repairSettings(env).maxCalls).toBe(l.repairMaxCalls);
    }
  });
});

describe('L114H-U02 — R4 : page manquante ou unité en attente, plafond à 0, atteint, dépassé', () => {
  const enAttente = [couverte('page:1:block:1'), unite('page:1:block:2', { repairState: 'PENDING' })];

  it('reprise admissible : INCOMPLETE_RETRYABLE (comportement inchangé)', () => {
    expect(buildCompletenessReport(enAttente, base)).toMatchObject({ qualityState: 'INCOMPLETE_RETRYABLE', anomalies: expect.arrayContaining(['REPAIR_PENDING', 'COVERAGE_INCOMPLETE']) });
    expect(buildCompletenessReport([couverte('page:1:block:1')], { ...base, verification: pdfVerifie([2]) }).qualityState).toBe('INCOMPLETE_RETRYABLE');
  });

  it('règle remplacée : sans reprise admissible, une page manquante est une lacune DÉFINITIVE, jamais « reprise programmée » ni COMPLETE', () => {
    const r = buildCompletenessReport([couverte('page:1:block:1')], { ...base, retryAllowed: false, verification: pdfVerifie([2]) });
    expect(r.qualityState).toBe('INCOMPLETE_FINAL');
    expect(r.anomalies).toEqual(expect.arrayContaining(['COVERAGE_INCOMPLETE', 'PAGE_MISSING']));
  });

  it('règle remplacée : sans reprise admissible, des unités seulement en attente ne sont ni « en reprise » ni COMPLETE', () => {
    const r = buildCompletenessReport(enAttente, { ...base, retryAllowed: false });
    expect(r.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    expect(r.anomalies).not.toContain('REPAIR_PENDING');
    expect(r.anomalies).not.toContain('COVERAGE_INCOMPLETE');
    // Unité en attente dont l'état de couverture serait « incertain » : toujours pas COMPLETE.
    const incertaine = [couverte('page:1:block:1'), unite('page:1:block:2', { status: 'UNCERTAIN', reason: 'fact_conflictual', repairState: 'PENDING' })];
    expect(buildCompletenessReport(incertaine, { ...base, retryAllowed: false }).qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
  });

  it.each([
    ['plafond à 0', { T1_COMPLETENESS_MAX_RETRIES: '0' }, 0, 'RETRIES_DISABLED'],
    ['plafond atteint', {}, 2, 'RETRY_CAP_REACHED'],
    ['plafond dépassé (valeur réduite après coup)', { T1_COMPLETENESS_MAX_RETRIES: '1' }, 4, 'RETRY_CAP_REACHED'],
  ])('%s : page manquante → aucune action, aucune échéance', (_nom, env, tentatives, motif) => {
    const limites = retryLimits(env);
    const d = decideRetry(faits({ missingPages: 1 }), { retryAttempts: tentatives, continuationRuns: 0 }, limites);
    expect(d).toMatchObject({ automatic: false, manual: false, actions: [], blocked: motif, unitMotive: motif });
  });

  it('reprise restante : page manquante, lacune de pages, source momentanément illisible → relecture par la file T1', () => {
    for (const f of [faits({ missingPages: 2 }), faits({ retryablePageGaps: 1 }), faits({ transientVerification: true })]) {
      expect(decideRetry(f, { retryAttempts: 1, continuationRuns: 0 }, DEFAUT)).toMatchObject({ automatic: true, actions: ['REQUEUE_T1'] });
    }
  });

  it('rien à reprendre : aucune action ; résidu réparable seulement à la demande : pas d’échéance automatique', () => {
    expect(decideRetry(faits(), { retryAttempts: 0, continuationRuns: 0 }, DEFAUT)).toMatchObject({ automatic: false, blocked: 'NOTHING_TO_RETRY' });
    expect(decideRetry(faits({ manuallyRepairable: 3 }), { retryAttempts: 0, continuationRuns: 0 }, DEFAUT)).toMatchObject({ automatic: false, manual: true, blocked: 'NOT_AUTOMATIC' });
    expect(decideRetry(faits({ manuallyRepairable: 3 }), { retryAttempts: 2, continuationRuns: 0 }, DEFAUT)).toMatchObject({ automatic: false, manual: false, blocked: 'RETRY_CAP_REACHED' });
  });
});

describe('L114H-U03 — R4 : continuation, plafond de continuation, plafond par unité, relecture du fichier', () => {
  it('travail jamais exécuté faute de budget : continuation admise APRÈS le plafond de reprises, jusqu’à son propre plafond', () => {
    const f = faits({ pending: 5, pendingSelectable: 5, manuallyRepairable: 5 });
    expect(decideRetry(f, { retryAttempts: 2, continuationRuns: 3 }, DEFAUT)).toMatchObject({ automatic: true, actions: ['CONTINUATION'] });
    expect(decideRetry(f, { retryAttempts: 2, continuationRuns: 20 }, DEFAUT)).toMatchObject({ automatic: false, blocked: 'CONTINUATION_CAP_REACHED' });
    // Plafond de continuation atteint mais une reprise ordinaire reste : elle traite les unités en attente (consomme une reprise).
    expect(decideRetry(f, { retryAttempts: 1, continuationRuns: 20 }, DEFAUT)).toMatchObject({ automatic: true, actions: ['TEXT_REPAIR'] });
  });

  it('reprises désactivées (0) : aucune continuation non plus — aucun appel IA automatique', () => {
    const f = faits({ pending: 5, pendingSelectable: 5, manuallyRepairable: 5 });
    expect(decideRetry(f, { retryAttempts: 0, continuationRuns: 0 }, retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '0' })))
      .toMatchObject({ automatic: false, manual: false, actions: [], blocked: 'RETRIES_DISABLED' });
  });

  it('unité en attente mais plus sélectionnable (plafond par unité, texte absent) : plus aucun chemin', () => {
    const units = [unite('page:1:block:1', { repairState: 'PENDING', repairAttempts: 3 }), unite('page:1:block:2', { repairState: 'PENDING', text: null })];
    const f = retryFactsOf(units, { qualityState: 'INCOMPLETE_RETRYABLE', verificationReason: null, pagesMissing: [] }, DEFAUT);
    expect(f).toMatchObject({ pending: 2, pendingSelectable: 0 });
    expect(decideRetry(f, { retryAttempts: 0, continuationRuns: 0 }, DEFAUT)).toMatchObject({ automatic: false, blocked: 'UNIT_CAP_REACHED' });
  });

  it('échec transitoire de réparation : repris tant qu’une reprise et le plafond par unité le permettent', () => {
    const transitoire = (tentatives: number) => [unite('page:1:block:1', { status: 'FAILED', reason: 'repair_failed:retryable', repairAttempts: tentatives })];
    const f1 = retryFactsOf(transitoire(1), { qualityState: 'INCOMPLETE_RETRYABLE' }, DEFAUT);
    expect(decideRetry(f1, { retryAttempts: 1, continuationRuns: 0 }, DEFAUT)).toMatchObject({ automatic: true, actions: ['TEXT_REPAIR'] });
    expect(decideRetry(f1, { retryAttempts: 2, continuationRuns: 0 }, DEFAUT).automatic).toBe(false);
    const f3 = retryFactsOf(transitoire(3), { qualityState: 'INCOMPLETE_RETRYABLE' }, DEFAUT);
    expect(decideRetry(f3, { retryAttempts: 0, continuationRuns: 0 }, DEFAUT).automatic).toBe(false);
  });

  it('relecture du fichier (observation incertaine) : bornée par les reprises ET par le plafond de relecture de l’unité', () => {
    const observation = (tentatives: number, etat: CoveredSourceUnit['repairState'] = 'NEEDS_SOURCE') => [unite('page:1:visual:1', {
      kind: 'VISUAL_OBSERVATION', status: 'UNCERTAIN', reason: 'observation_conflictual', repairAttempts: tentatives, repairState: etat,
    })];
    const f = retryFactsOf(observation(0), { qualityState: 'VERIFICATION_INCOMPLETE', verificationReason: 'image_not_checkable' }, DEFAUT);
    expect(f.sourceRereadable).toBe(1);
    expect(decideRetry(f, { retryAttempts: 0, continuationRuns: 0 }, DEFAUT)).toMatchObject({ automatic: true, actions: ['SOURCE_REREAD'] });
    expect(decideRetry(f, { retryAttempts: 2, continuationRuns: 0 }, DEFAUT).automatic).toBe(false);
    expect(retryFactsOf(observation(2), {}, DEFAUT).sourceRereadable).toBe(0);
    expect(retryFactsOf(observation(1, 'EXHAUSTED'), {}, DEFAUT).sourceRereadable).toBe(0);
  });
});

describe('L114H-U04 — garde finale des écritures (`settleLayerRetry`) et synchronisation des unités', () => {
  it('action admissible : la couche n’est pas touchée', () => {
    const l = couche([couverte('page:1:block:1'), unite('page:1:block:2', { repairState: 'PENDING' })]);
    const r = settleLayerRetry(l, { retryAttempts: 0, continuationRuns: 0 }, DEFAUT);
    expect(r).toMatchObject({ settled: false, decision: { automatic: true } });
    expect(r.layer).toBe(l);
  });

  it('unités en attente au plafond de continuation : attente levée, JAMAIS « épuisée », motif du plafond, texte conservé', () => {
    const units = withResidualPolicies([couverte('page:1:block:1'), unite('page:1:block:2', { repairState: 'PENDING' })]);
    const l = couche(units);
    expect(l.report.qualityState).toBe('INCOMPLETE_RETRYABLE');
    const r = settleLayerRetry(l, { retryAttempts: 2, continuationRuns: 20 }, DEFAUT);
    expect(r.settled).toBe(true);
    expect(r.layer.retryable).toBe(false);
    expect(r.layer.report).toMatchObject({ qualityState: 'COMPLETE_WITH_UNRESOLVED', diagnostics: { pendingRepairUnits: 0 } });
    expect(r.layer.report.anomalies).not.toContain('REPAIR_PENDING');
    expect(r.layer.report.anomalies).not.toContain('COVERAGE_INCOMPLETE');
    const u = r.layer.units[1];
    expect(u).toMatchObject({ status: 'UNRESOLVED', repairState: null, repairAttempts: 0, residualPolicy: 'REPAIR_NOT_RUN:RETRY_CAP_REACHED', text: 'Montant restant dû : 132,00 €' });
    expect(r.decision.blocked).toBe('CONTINUATION_CAP_REACHED');
    expect(r.layer.report.diagnostics?.residualPolicies).toEqual({ 'REPAIR_NOT_RUN:RETRY_CAP_REACHED': 1 });
    // La couche d'origine n'est pas mutée.
    expect(l.units[1].repairState).toBe('PENDING');
  });

  it('source non vérifiée + unités en attente sans chemin : VERIFICATION_INCOMPLETE conservée (incertitude jamais effacée)', () => {
    const units = [couverte('page:1:block:1'), unite('page:1:block:2', { repairState: 'PENDING' })];
    const l = couche(units, { verification: { status: 'UNVERIFIABLE', reason: 'image_not_checkable', pagesExpected: 1, verified: [], missing: [], unverified: [1], scanned: [1] } });
    const r = settleLayerRetry(l, { retryAttempts: 2, continuationRuns: 20 }, DEFAUT);
    expect(r.layer.report.qualityState).toBe('VERIFICATION_INCOMPLETE');
    expect(r.layer.report.anomalies).toContain('COVERAGE_UNVERIFIED');
  });

  it('page manquante ou échec « réessayable » sans reprise : INCOMPLETE_FINAL, politique « échec définitif »', () => {
    const manquante = couche([couverte('page:1:block:1')], { verification: pdfVerifie([3]) });
    expect(settleLayerRetry(manquante, { retryAttempts: 2, continuationRuns: 0 }, DEFAUT).layer.report)
      .toMatchObject({ qualityState: 'INCOMPLETE_FINAL', anomalies: expect.arrayContaining(['COVERAGE_INCOMPLETE', 'PAGE_MISSING']) });
    const echec = withResidualPolicies([unite('page:1:block:1', { status: 'FAILED', reason: 'repair_failed:retryable', repairAttempts: 1 })]);
    expect(echec[0].residualPolicy).toBe('REPAIR_RETRY_SCHEDULED');
    const r = settleLayerRetry(couche(echec), { retryAttempts: 2, continuationRuns: 0 }, DEFAUT);
    expect(r.layer.report.qualityState).toBe('INCOMPLETE_FINAL');
    expect(r.layer.units[0]).toMatchObject({ status: 'FAILED', residualPolicy: 'TECHNICAL_FAILURE_FINAL' });
  });

  it('idempotente : une couche déjà réglée n’est plus modifiée', () => {
    const l = couche(withResidualPolicies([couverte('page:1:block:1'), unite('page:1:block:2', { repairState: 'PENDING' })]));
    const un = settleLayerRetry(l, { retryAttempts: 2, continuationRuns: 20 }, DEFAUT);
    const deux = settleLayerRetry(un.layer, { retryAttempts: 2, continuationRuns: 20 }, DEFAUT);
    expect(deux.settled).toBe(false);
    expect(deux.layer).toBe(un.layer);
  });

  it('synchronisation : « non tentée » reste telle quelle tant qu’une reprise manuelle est possible ; vraies tentatives jamais requalifiées', () => {
    const units = withResidualPolicies([
      unite('page:1:block:1'), unite('page:1:block:2', { repairAttempts: 3, repairState: 'EXHAUSTED' }), unite('page:1:block:3', { repairAttempts: 1, repairState: 'ATTEMPTED_FAILED' }),
    ]);
    expect(units.map((u) => u.residualPolicy)).toEqual(['REPAIR_NOT_ATTEMPTED', 'REPAIR_EXHAUSTED', 'REPAIR_ATTEMPTED_NO_RESULT']);
    expect(releaseUnschedulablePending(units, { manual: true, unitMotive: null })).toEqual(units);
    const auPlafond = releaseUnschedulablePending(units, { manual: false, unitMotive: 'RETRY_CAP_REACHED' });
    expect(auPlafond.map((u) => u.residualPolicy)).toEqual(['REPAIR_NOT_RUN:RETRY_CAP_REACHED', 'REPAIR_EXHAUSTED', 'REPAIR_ATTEMPTED_NO_RESULT']);
    // Idempotence après un recalcul des politiques (réconciliation suivante).
    expect(releaseUnschedulablePending(withResidualPolicies(auPlafond), { manual: false, unitMotive: 'RETRY_CAP_REACHED' }).map((u) => u.residualPolicy))
      .toEqual(auPlafond.map((u) => u.residualPolicy));
  });
});

describe('L114H-U05 — R5 : issue RÉELLE d’une remise en file T1 et écritures de la couverture', () => {
  it('traduction des réponses de la file (aucun statut inventé)', () => {
    expect(t1EnqueueOutcomeOf(7, { decision: 'create', jobId: 91, reasonCode: null })).toEqual({ fileId: 7, status: 'ACCEPTED', jobId: 91, reason: null });
    expect(t1EnqueueOutcomeOf(7, { decision: 'skip', jobId: 55, reasonCode: 'DUPLICATE_PENDING' })).toMatchObject({ status: 'ALREADY_RUNNING', jobId: 55, reason: 'DUPLICATE_PENDING' });
    expect(t1EnqueueOutcomeOf(7, { decision: 'coalesce', jobId: 56, reasonCode: 'DUPLICATE_RUNNING' })).toMatchObject({ status: 'ALREADY_RUNNING', jobId: 56, reason: 'DUPLICATE_RUNNING' });
    expect(t1EnqueueOutcomeOf(7, { decision: 'skip', jobId: 57, reasonCode: 'ALREADY_QUEUED' })).toMatchObject({ status: 'ALREADY_RUNNING', jobId: 57 });
    expect(t1EnqueueOutcomeOf(7, { decision: 'skip', jobId: null, reasonCode: 'ACCOUNT_INELIGIBLE' })).toMatchObject({ status: 'ACCOUNT_NOT_ELIGIBLE', jobId: null });
    expect(t1EnqueueOutcomeOf(7, { decision: 'skip', jobId: null, reasonCode: 'CROSS_ACCOUNT_SCOPE' })).toMatchObject({ status: 'REJECTED_FINAL', reason: 'CROSS_ACCOUNT_SCOPE' });
    // Aucun travail désigné et motif inconnu : jamais une réussite.
    expect(t1EnqueueOutcomeOf(7, { decision: 'skip', jobId: null, reasonCode: null })).toMatchObject({ status: 'REJECTED_TRANSIENT', reason: 'UNKNOWN_SKIP' });
    expect(['ACCEPTED', 'ALREADY_RUNNING', 'ACCOUNT_NOT_ELIGIBLE', 'REJECTED_FINAL', 'REJECTED_TRANSIENT'].map((status) => t1EnqueueConfirmed({ status: status as never })))
      .toEqual([true, true, false, false, false]);
  });

  const demande = { attempt: 1, result: 'REQUEUED_T1', reason: null, maxRetries: 2, transientRefusals: 0, scheduled: true, nowMs: Date.UTC(2026, 0, 15, 10, 0, 0) };

  it('acceptée : seule issue qui consigne « REQUEUED_T1 » et consomme la reprise', () => {
    expect(requeueCoverageUpdate({ ...demande, status: 'ACCEPTED' })).toEqual({ result: 'REQUEUED_T1', consumeAttempt: true, transientRefusals: 0, lastError: null, alert: false, nextRetryAt: null });
  });

  it('déjà vivante : aucune reprise consommée (deux demandes concurrentes = une seule tentative)', () => {
    expect(requeueCoverageUpdate({ ...demande, status: 'ALREADY_RUNNING' })).toMatchObject({ result: 'REQUEUE_ALREADY_RUNNING', consumeAttempt: false, nextRetryAt: null, alert: false });
  });

  it('compte non éligible : rien consommé, la demande planifiée reste due ; une demande manuelle ne touche pas l’échéance', () => {
    const r = requeueCoverageUpdate({ ...demande, status: 'ACCOUNT_NOT_ELIGIBLE' });
    expect(r).toMatchObject({ result: 'REQUEUE_ACCOUNT_NOT_ELIGIBLE', consumeAttempt: false, alert: false });
    expect(r.nextRetryAt).toEqual(new Date(demande.nowMs));
    expect(requeueCoverageUpdate({ ...demande, status: 'ACCOUNT_NOT_ELIGIBLE', scheduled: false }).nextRetryAt).toBe('KEEP');
  });

  it('refus transitoire : échéance reposée (délai croissant) sans consommer ; répété, il consomme une reprise ; au plafond : plus d’échéance, alerte', () => {
    const delais: number[] = [];
    for (let n = 0; n < REQUEUE_TRANSIENT_MAX; n++) {
      const r = requeueCoverageUpdate({ ...demande, status: 'REJECTED_TRANSIENT', reason: 'ENQUEUE_ERROR', transientRefusals: n });
      expect(r).toMatchObject({ result: 'REQUEUE_REJECTED_TRANSIENT', consumeAttempt: false, transientRefusals: n + 1, alert: false });
      expect(r.lastError).toContain('ENQUEUE_ERROR');
      delais.push((r.nextRetryAt as Date).getTime() - demande.nowMs);
    }
    expect(delais).toEqual([15 * 60_000, 30 * 60_000, 60 * 60_000]);
    const repete = requeueCoverageUpdate({ ...demande, status: 'REJECTED_TRANSIENT', reason: 'ENQUEUE_ERROR', transientRefusals: REQUEUE_TRANSIENT_MAX });
    expect(repete).toMatchObject({ consumeAttempt: true, transientRefusals: 0, alert: false });
    expect(repete.nextRetryAt).toBeInstanceOf(Date);
    const auPlafond = requeueCoverageUpdate({ ...demande, attempt: 2, status: 'REJECTED_TRANSIENT', reason: 'ENQUEUE_ERROR', transientRefusals: REQUEUE_TRANSIENT_MAX });
    expect(auPlafond).toMatchObject({ consumeAttempt: true, alert: true, nextRetryAt: null });
  });

  it('refus définitif : statut explicite, aucune échéance, aucune reprise consommée, alerte de Supervision', () => {
    const r = requeueCoverageUpdate({ ...demande, status: 'REJECTED_FINAL', reason: 'CROSS_ACCOUNT_SCOPE' });
    expect(r).toMatchObject({ result: 'REQUEUE_REJECTED_FINAL', consumeAttempt: false, nextRetryAt: null, alert: true });
    expect(r.lastError).toContain('CROSS_ACCOUNT_SCOPE');
  });

  it('la reprise planifiée ne consigne plus « REQUEUED_T1 » sans lire l’issue (défaut confirmé de la carte)', () => {
    const jobs = lire('src/services/ai/source-analysis/source-units/jobs.ts');
    expect(jobs).not.toMatch(/await requeueDocumentForReread\(\{[^}]*\}\);\s*return issue\('requeued', 'REQUEUED_T1'\)/);
    expect(jobs.match(/return issue\(rq\.queued \? 'requeued' : 'not_queued', rq\.result\)/g)).toHaveLength(2);
    expect(lire('src/app/api/admin/ai/t1-completeness/retry/route.ts')).toContain("error: 'NOT_QUEUED'");
  });
});

describe('L114H-U06 — R6 : alerte close seulement si sa cause a disparu', () => {
  const v = T1_COVERAGE_RULES_VERSION;
  const completude = (over: Partial<Parameters<typeof alertDecisionOf>[0]>) => alertDecisionOf({
    kind: 'COMPLETENESS', open: true, deleted: false, qualityState: 'COMPLETE', normalisationLosses: 0, rulesVersion: v, ...over,
  });

  it('état recalculé non définitif : close, avec la version des règles et l’état dans la cause', () => {
    for (const q of ['COMPLETE', 'COMPLETE_WITH_UNRESOLVED', 'VERIFICATION_INCOMPLETE', 'INCOMPLETE_RETRYABLE']) {
      const d = completude({ qualityState: q });
      expect(d?.action).toBe('CLOSED');
      expect(d?.cause).toContain(`règles T1 v${v}`);
      expect(d?.cause).toContain(q);
    }
  });

  it('lacune réelle toujours là : maintenue ; lacune réelle jamais signalée : ouverte', () => {
    expect(completude({ qualityState: 'INCOMPLETE_FINAL' })?.action).toBe('MAINTAINED');
    expect(completude({ qualityState: 'INCOMPLETE_FINAL', open: false })?.action).toBe('OPENED');
  });

  it('alerte déjà close : jamais rouverte sans fait nouveau (aucune décision)', () => {
    for (const q of ['COMPLETE', 'COMPLETE_WITH_UNRESOLVED', 'VERIFICATION_INCOMPLETE', 'INCOMPLETE_RETRYABLE']) expect(completude({ qualityState: q, open: false })).toBeNull();
  });

  it('cause non vérifiable (couverture ou diagnostics absents) : maintenue, jamais close par défaut', () => {
    expect(completude({ qualityState: null })?.action).toBe('MAINTAINED');
    expect(alertDecisionOf({ kind: 'NORMALISATION_LOSS', open: true, deleted: false, qualityState: 'COMPLETE', normalisationLosses: null, rulesVersion: v })?.action).toBe('MAINTAINED');
  });

  it('perte de normalisation : maintenue tant que le compteur est positif, close à zéro', () => {
    const perte = (n: number, open = true) => alertDecisionOf({ kind: 'NORMALISATION_LOSS', open, deleted: false, qualityState: 'COMPLETE_WITH_UNRESOLVED', normalisationLosses: n, rulesVersion: v });
    expect(perte(2)?.action).toBe('MAINTAINED');
    expect(perte(0)?.action).toBe('CLOSED');
    expect(perte(2, false)).toBeNull();
  });

  it('document supprimé : alerte close (plus d’objet), rien si aucune alerte', () => {
    expect(completude({ deleted: true, qualityState: 'INCOMPLETE_FINAL' })).toMatchObject({ action: 'CLOSED', cause: expect.stringContaining('document supprimé') });
    expect(completude({ deleted: true, open: false })).toBeNull();
  });
});

describe('L114H-U07 — issue d’une réévaluation, cible d’une empreinte', () => {
  const etat = (over: Partial<CoverageSnapshot> = {}): CoverageSnapshot => ({
    qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: [], covered: 8, unresolved: 2, uncertain: 0, failed: 0, total: 10,
    retryAttempts: 0, retryScheduled: false, lastRetryResult: null, ...over,
  });

  it('issues', () => {
    const o = (before: CoverageSnapshot, after: CoverageSnapshot, requalified = 0, written = true) => reassessmentOutcomeOf({ before, after, requalified, written });
    expect(o(etat(), etat({ qualityState: 'COMPLETE', unresolved: 0, covered: 10 }), 2)).toBe('RESOLVED');
    expect(o(etat(), etat({ unresolved: 1, covered: 9 }), 1)).toBe('RECONCILED');
    expect(o(etat(), etat(), 0, false)).toBe('UNCHANGED');
    expect(o(etat({ qualityState: 'INCOMPLETE_RETRYABLE', retryScheduled: true }), etat({ qualityState: 'COMPLETE_WITH_UNRESOLVED' }))).toBe('STILL_UNRESOLVED');
    expect(o(etat({ qualityState: 'INCOMPLETE_RETRYABLE', retryScheduled: true }), etat({ qualityState: 'VERIFICATION_INCOMPLETE' }))).toBe('UNVERIFIABLE');
    expect(o(etat({ qualityState: 'INCOMPLETE_RETRYABLE' }), etat({ qualityState: 'INCOMPLETE_RETRYABLE', retryScheduled: true }))).toBe('REPAIR_SCHEDULED');
    expect(o(etat({ qualityState: 'INCOMPLETE_RETRYABLE', retryScheduled: true }), etat({ qualityState: 'INCOMPLETE_FINAL' }))).toBe('FINAL_GAP');
    expect(o(etat({ qualityState: 'INCOMPLETE_FINAL' }), etat({ qualityState: 'INCOMPLETE_FINAL' }), 0, false)).toBe('UNCHANGED');
  });

  it('empreintes des alertes T1 de couverture', () => {
    expect(alertTargetOf('ai:t1-completeness:388')).toEqual({ kind: 'COMPLETENESS', fileId: 388 });
    expect(alertTargetOf('ai:t1-normalisation-loss:126')).toEqual({ kind: 'NORMALISATION_LOSS', fileId: 126 });
    for (const fp of ['ai:t1-completeness:', 'ai:t1-completeness:abc', 'ai:t1-requeue:12', 'ai:schema:t1']) expect(alertTargetOf(fp)).toBeNull();
  });
});

describe('L114H-U08 — P1-D et § 6 : issue ACTUELLE d’une couverture pour le BO', () => {
  const image = { qualityState: 'VERIFICATION_INCOMPLETE', anomalies: ['PAGE_UNVERIFIED', 'COVERAGE_UNVERIFIED'], retryAttempts: 0, maxRetries: 2, verification: { verificationReason: 'image_not_checkable' } };

  it('image JPEG lue, sans preuve indépendante (type document 389) : limite de vérification, pas une réparation en attente ; état conservé', () => {
    const v = coverageIssueOf(image);
    expect(v).toMatchObject({ issue: 'VERIFICATION_LIMIT', actionable: false });
    expect(v.reason).toContain('image ou scan');
    expect(v.nextAction).toContain('Aucune action automatique');
    // Même après des relectures épuisées : toujours une limite, jamais « complète ».
    expect(coverageIssueOf({ ...image, retryAttempts: 2, anomalies: [...image.anomalies, 'REPAIR_EXHAUSTED'], verification: { verificationReason: 'image_not_checkable', needsSourceExhausted: 1 } }).issue).toBe('VERIFICATION_LIMIT');
    expect(coverageIssueOf({ ...image, verification: { verificationReason: 'pages_unverified' } }).issue).toBe('VERIFICATION_LIMIT');
    expect(coverageIssueOf({ qualityState: 'VERIFICATION_INCOMPLETE', sourceVerification: 'RECONSTRUCTED', verification: {} }).reason).toContain('reconstruite');
  });

  it('une reprise réellement programmée prime ; un problème de fichier ou un refus de remise en file est une anomalie technique', () => {
    expect(coverageIssueOf({ ...image, nextRetryAt: '2026-01-15T10:00:00.000Z', verification: { verificationReason: 'source_unreadable' } }).issue).toBe('REPAIR_SCHEDULED');
    expect(coverageIssueOf({ ...image, verification: { verificationReason: 'pdf_unreadable' } }).issue).toBe('TECHNICAL_ANOMALY');
    for (const res of ['REQUEUE_REJECTED_FINAL', 'REQUEUE_REJECTED_TRANSIENT', 'REQUEUE_ACCOUNT_NOT_ELIGIBLE', 'ERROR']) {
      expect(coverageIssueOf({ qualityState: 'INCOMPLETE_RETRYABLE', lastRetryResult: res, verification: {} }).issue).toBe('TECHNICAL_ANOMALY');
    }
  });

  it('les six issues, chacune avec motif et prochaine action', () => {
    const cas: Array<[string, Parameters<typeof coverageIssueOf>[0]]> = [
      ['RESOLVED', { qualityState: 'COMPLETE' }],
      ['REPAIR_SCHEDULED', { qualityState: 'INCOMPLETE_RETRYABLE', nextRetryAt: '2026-01-15T10:00:00.000Z', retryAttempts: 1, maxRetries: 2, verification: { pagesMissing: [2] } }],
      ['TECHNICAL_ANOMALY', { qualityState: 'COMPLETE_WITH_UNRESOLVED', lastRetryResult: 'ERROR' }],
      ['CAP_REACHED', { qualityState: 'INCOMPLETE_FINAL', retryAttempts: 2, maxRetries: 2, verification: { pagesMissing: [2] } }],
      ['VERIFICATION_LIMIT', image],
      ['ACTIONABLE_UNRESOLVED', { qualityState: 'COMPLETE_WITH_UNRESOLVED', retryAttempts: 0, maxRetries: 2 }],
    ];
    expect(cas.map(([attendu]) => attendu).sort()).toEqual([...COVERAGE_ISSUES].sort());
    for (const [attendu, entree] of cas) {
      const v = coverageIssueOf(entree);
      expect(v.issue).toBe(attendu);
      expect(v.reason.length).toBeGreaterThan(5);
      expect(v.nextAction.length).toBeGreaterThan(5);
    }
    expect(coverageIssueOf({ qualityState: 'COMPLETE_WITH_UNRESOLVED', retryAttempts: 2, maxRetries: 2 }).issue).toBe('CAP_REACHED');
    expect(coverageIssueOf({ qualityState: 'INCOMPLETE_FINAL', retryAttempts: 2, maxRetries: 2, verification: { pagesMissing: [2] } }).reason).toContain('1 page(s) manquante(s)');
  });

  it('aucun texte du BO ne dit « Opération » (règle permanente)', () => {
    const textes = JSON.stringify([
      lire('src/services/ai/source-analysis/source-units/coverage-issue.ts').match(/'[^'\n]{12,}'/g),
      reassessmentText({ rulesVersion: 1, available: true, documents: 3, byOutcome: { RESOLVED: 1, ERROR: 1 }, transitions: [], unitsRequalified: 0, alertsClosed: 0, alertsMaintained: 0, alertsOpened: 0, retriesScheduled: 0, retriesCancelled: 0, errors: 1, remaining: 0, openAlerts: 0, totalDurationMs: 0, aiCalls: 0, aiCost: 0, firstAt: null, lastAt: null }),
    ]);
    expect(textes).not.toMatch(/op[ée]ration/i);
  });
});

describe('L114H-U09 — BO : bilan de la réévaluation, issues, effet sur les reprises ; garde-fous', () => {
  const bilan: ReassessmentReport = {
    rulesVersion: 1, available: true, documents: 13, byOutcome: { RESOLVED: 2, RECONCILED: 4, UNVERIFIABLE: 6, UNCHANGED: 1, ERROR: 0 },
    transitions: [{ from: 'COMPLETE_WITH_UNRESOLVED', to: 'COMPLETE', documents: 2 }], unitsRequalified: 37, alertsClosed: 3, alertsMaintained: 1, alertsOpened: 0,
    retriesScheduled: 1, retriesCancelled: 2, errors: 0, remaining: 0, openAlerts: 1, totalDurationMs: 4_200, aiCalls: 0, aiCost: 0, firstAt: null, lastAt: null,
  };

  it('bilan : documents par issue, unités, alertes, durée, appels IA à 0 ; absent si le journal n’existe pas', () => {
    const l = reassessmentText(bilan);
    expect(l[0]).toContain('13 document(s) examiné(s)');
    expect(l[0]).toContain('2 devenue(s) complète(s)');
    expect(l[0]).not.toContain('en erreur');
    expect(l.join('\n')).toContain('3 close(s) (cause disparue) · 1 maintenue(s)');
    expect(l.join('\n')).toContain('appels IA : 0');
    expect(l.join('\n')).toContain('COMPLETE_WITH_UNRESOLVED → COMPLETE (2)');
    expect(reassessmentText({ ...bilan, available: false })).toEqual([]);
    expect(reassessmentText(null)).toEqual([]);
  });

  it('issues de la période et effet d’une réconciliation sur les reprises', () => {
    expect(issuesText({ RESOLVED: 4, VERIFICATION_LIMIT: 6, CAP_REACHED: 0 })).toBe('État actuel : 4 résolue · 6 limite de vérification — aucune action automatique');
    expect(issuesText(undefined)).toBe('');
    expect(retryChangeText({
      before: { qualityState: 'INCOMPLETE_RETRYABLE' }, after: { qualityState: 'COMPLETE_WITH_UNRESOLVED' },
      retry: { scheduledBefore: true, scheduledAfter: false, pendingReleased: 2, actions: [], blocked: 'RETRY_CAP_REACHED', stateChanged: true },
    })).toBe('Reprises : état INCOMPLETE_RETRYABLE → COMPLETE_WITH_UNRESOLVED · reprise programmée retirée (plus aucune reprise admissible) · 2 unité(s) en attente : attente levée · plafond de reprises du document atteint');
    expect(retryChangeText({ before: { qualityState: 'COMPLETE' }, after: { qualityState: 'COMPLETE' } })).toBe('');
    expect(policyLabel('REPAIR_NOT_RUN:RETRY_CAP_REACHED')).toBe('réparation non exécutée (plafond de reprises du document atteint)');
    expect(policyLabel('REPAIR_NOT_RUN:RETRIES_DISABLED')).toBe('réparation non exécutée (reprises désactivées (T1_COMPLETENESS_MAX_RETRIES=0))');
  });

  it('la campagne n’importe aucun chemin d’appel IA et ne modifie aucun texte de prompt', () => {
    const source = lire('src/services/ai/source-analysis/source-units/historical-reassessment.ts');
    for (const interdit of ['callAnalyzeDocument', 'runRepairPass', 'gateway/', 'analyze-document.step', 'enqueueFileAnalyses', 'retryDocument', 'repairDocumentSourceUnits']) {
      expect(source).not.toContain(interdit);
    }
    // Tâche planifiée déclarée, au démarrage, relancée tant qu'il reste des documents ; jamais concurrente de la reprise.
    const catalogue = lire('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(catalogue).toMatch(/code: 't1-coverage-reassessment',[\s\S]{0,200}schedule: \{ kind: 'startup'/);
    expect(catalogue.match(/code: 't1-completeness-retry'/g)).toHaveLength(1);
  });

  it('nouvelle table déclarée : export diagnostic, catalogue de recette, transfert de compte', async () => {
    expect(lire('src/services/admin/diagnostics-export/coverage.ts')).toContain("t1_coverage_reassessments: C('extractions-ia')");
    expect(lire('src/services/admin/diagnostics-export/recette-catalog.ts')).toContain('t1_coverage_reassessments:');
    const { FILE_SCOPED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
    expect(FILE_SCOPED_TABLES).toContainEqual(['t1_coverage_reassessments', 'file_id']);
    const migration = lire('src/db/migrations/1705_l114h_t1_reevaluation_couverture.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS t1_coverage_reassessments');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS t1_coverage_reassessments_file_version_uidx');
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b(?![^\n]*le code ignore)/i);
  });
});
