/**
 * Lot 114H (Trello #775, audit T1 du 13/11) sur PostgreSQL réel — reprises
 * T1 bornées, remise en file sans rejeu fictif, réévaluation du stock et
 * alertes. Points d'entrée de production (`runCompletenessRetry`,
 * `requeueDocumentForRereadDetailed`, `runCoverageReassessment`,
 * `getCoverageReassessmentReport`) ; file T1 durable réelle (`ai_job_queue`) ;
 * aucune sortie modèle enregistrée : tout appel IA ferait échouer le scénario.
 * Les couvertures sont écrites par `writeSourceLayer` (la vraie écriture),
 * puis vieillies par SQL pour reproduire les états laissés par l'ancien code
 * (faits de la carte : plafond consommé, échéance encore posée, alerte
 * ouverte, document supprimé).
 *
 *   L114H-E01  migration 1705 rejouable ;
 *   L114H-E02  R4 — plafond atteint, unités en attente, échéance due : 0
 *              appel IA, échéance retirée, tentative non consommée, plus
 *              jamais reprise ; page manquante au plafond : lacune définitive
 *              et alerte de Supervision ;
 *   L114H-E03  R5 — page manquante, reprise restante : travail T1 réellement
 *              en file ; seconde demande : déjà vivante, une seule tentative ;
 *              deux demandes simultanées : un seul travail ; compte non
 *              éligible : aucun travail, rien consommé, demande laissée due ;
 *   L114H-E04  R6 / R7 — campagne sur plusieurs comptes, lots de 2 : états
 *              recalculés, alerte obsolète close (avec cause), alerte réelle
 *              maintenue, alerte d'un document supprimé close, journal avant /
 *              après, bilan ; seconde campagne : rien ; aucun fait créé.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import type { AccountRow } from '../factories';
import type { CoveredSourceUnit, SourceLayer } from '@/services/ai/source-analysis/source-units/types';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const TEXTES = ['Référence dossier : AB-2291', 'Montant restant dû : 132,00 €', 'Échéance du 14/02/2026', 'Numéro de police : 778899'];
const unite = (n: number, over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
  sourceUnitId: `page:1:block:${n}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null, text: TEXTES[n - 1], payload: {}, location: {},
  origin: 'PASS_1', salient: true, status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0, repairAttempts: 0, repairState: null, ...over,
});
const couverte = (n: number) => unite(n, { status: 'COVERED', reason: 'fact', factCount: 1 });
const pdf = (missing: number[] = []) => ({
  status: missing.length ? 'PARTIAL' as const : 'VERIFIED' as const, reason: missing.length ? 'pages_missing' : null,
  pagesExpected: 3, verified: [1, 2, 3].filter((p) => !missing.includes(p)), missing, unverified: [], scanned: [],
});
const image = { status: 'UNVERIFIABLE' as const, reason: 'image_not_checkable', pagesExpected: 1, verified: [], missing: [], unverified: [1], scanned: [1] };

scenario('L114H', 'T1 — reprises bornées, remise en file réelle, réévaluation du stock (#775)', ({ sql, make, replay }) => {
  useTargetState({}, { masters: ['T1'] });

  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  /** Écrit une couche A par la VRAIE écriture (analyse), état calculé par le vrai rapport. */
  const ecrire = async (compte: AccountRow, fileId: number, units: CoveredSourceUnit[], verification: unknown = pdf()) => {
    const { buildCompletenessReport } = await import('@/services/ai/source-analysis/source-units/coverage');
    const { withResidualPolicies } = await import('@/services/ai/source-analysis/source-units/coverage-reconciliation');
    const { writeSourceLayer } = await import('@/services/ai/source-analysis/source-units/repository');
    const { SOURCE_LAYER_VERSION } = await import('@/services/ai/source-analysis/source-units/types');
    const u = withResidualPolicies(units);
    const layer: SourceLayer = {
      layerVersion: SOURCE_LAYER_VERSION, units: u, unresolvedFacts: [], retryable: true,
      report: buildCompletenessReport(u, {
        factsCount: 1, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 1, chunkCount: 0, warningCodes: [], retryAllowed: true,
        verification: verification as never,
      }),
    };
    await sql.begin(async (tx) => { await writeSourceLayer(tx as never, { accountId: compte.id, fileId, extractionId: null, layer }); });
  };
  /** Reproduit l'état laissé par l'ancien code : plafonds consommés, échéance encore due. */
  const vieillir = async (fileId: number, p: { attempts: number; runs?: number; due?: boolean }) => {
    await sql`UPDATE document_extraction_coverage
                 SET retry_attempts = ${p.attempts}, next_retry_at = ${p.due === false ? null : sql`NOW() - interval '2 hours'`},
                     verification = jsonb_set(coalesce(verification, '{}'::jsonb), '{continuationRuns}', ${String(p.runs ?? 0)}::jsonb, true)
               WHERE file_id = ${fileId}`;
  };
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT quality_state AS q, anomalies, retry_attempts AS attempts, next_retry_at AS next, last_retry_result AS result, last_error AS error, verification
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const unites = (fileId: number) => sql<Json[]>`
    SELECT source_unit_id AS id, coverage_status AS status, repair_state AS repair, residual_policy AS policy, repair_attempts AS attempts, content_text AS text
      FROM document_source_units WHERE file_id = ${fileId} ORDER BY ordinal`;
  const travaux = (fileId: number) => sql<Json[]>`
    SELECT id, status, payload FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)} ORDER BY id`;
  const alertes = (fileId: number) => sql<Json[]>`
    SELECT fingerprint, status, resolution_source, auto_resolution_origin AS origin, auto_resolution_cause AS cause
      FROM admin_anomalies WHERE fingerprint IN (${`ai:t1-completeness:${fileId}`}, ${`ai:t1-normalisation-loss:${fileId}`}, ${`ai:t1-requeue:${fileId}`}) ORDER BY id`;
  const signaler = async (compte: AccountRow, fileId: number) => {
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({ domain: 'ai', fingerprint: `ai:t1-completeness:${fileId}`, title: `Analyse T1 incomplète (document ${fileId})`, accountId: compte.id, detail: { fileId } });
  };
  const reprise = async () => (await import('@/services/ai/source-analysis/source-units/jobs')).runCompletenessRetry({ env: {} });

  it('L114H-E01 — migration 1705 rejouable, table présente', async () => {
    const contenu = readFileSync(join(process.cwd(), 'src/db/migrations/1705_l114h_t1_reevaluation_couverture.sql'), 'utf8');
    for (let i = 0; i < 2; i++) await sql.begin(async (tx) => { await tx.unsafe(contenu); });
    const { reassessmentJournalReady } = await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    expect(await reassessmentJournalReady()).toBe(true);
  });

  it('L114H-E02 — R4 : plafonds atteints, échéance due → 0 appel IA, échéance retirée, plus jamais reprise ; page manquante : lacune définitive', async () => {
    const c = await make.account();
    const attente = await fichier(c);
    await ecrire(c, attente, [couverte(1), unite(2, { repairState: 'PENDING' }), unite(3, { repairState: 'PENDING' })]);
    expect(await couverture(attente)).toMatchObject({ q: 'INCOMPLETE_RETRYABLE' });
    await vieillir(attente, { attempts: 2, runs: 20 });
    const manquante = await fichier(c);
    await ecrire(c, manquante, [couverte(1)], pdf([2]));
    expect(await couverture(manquante)).toMatchObject({ q: 'INCOMPLETE_RETRYABLE' });
    await vieillir(manquante, { attempts: 2 });

    const r = await reprise();
    expect(r).toMatchObject({ examined: 2, failed: 0, requeued: 0, notQueued: 0 });
    expect(replay.calls).toHaveLength(0);
    const a = await couverture(attente);
    expect(a).toMatchObject({ q: 'COMPLETE_WITH_UNRESOLVED', attempts: 2, next: null, result: 'RETRY_NOT_ADMISSIBLE:CONTINUATION_CAP_REACHED' });
    expect(a.anomalies).not.toContain('REPAIR_PENDING');
    const u = await unites(attente);
    expect(u.map((x) => x.repair)).toEqual([null, null, null]);
    expect(u.slice(1).map((x) => x.policy)).toEqual(['REPAIR_NOT_RUN:RETRY_CAP_REACHED', 'REPAIR_NOT_RUN:RETRY_CAP_REACHED']);
    expect(u.map((x) => x.text)).toEqual(TEXTES.slice(0, 3));
    const m = await couverture(manquante);
    expect(m).toMatchObject({ q: 'INCOMPLETE_FINAL', attempts: 2, next: null });
    expect(m.anomalies).toEqual(expect.arrayContaining(['COVERAGE_INCOMPLETE', 'PAGE_MISSING']));
    expect(await travaux(manquante)).toEqual([]);
    expect(await alertes(manquante)).toEqual([expect.objectContaining({ fingerprint: `ai:t1-completeness:${manquante}`, status: 'open' })]);
    // Aucune boucle : les passages suivants ne retrouvent aucun de ces documents.
    for (let i = 0; i < 3; i++) expect((await reprise()).examined).toBe(0);
    expect(replay.calls).toHaveLength(0);
  });

  it('L114H-E03 — R5 : remise en file réelle, déjà vivante, simultanée, compte non éligible', async () => {
    const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
    const c = await make.account();
    const f = await fichier(c);
    await ecrire(c, f, [couverte(1)], pdf([2]));
    await vieillir(f, { attempts: 0 });
    const r = await reprise();
    expect(r).toMatchObject({ examined: 1, requeued: 1, notQueued: 0 });
    const file = await travaux(f);
    expect(file).toHaveLength(1);
    expect(file[0]).toMatchObject({ status: 'PENDING', payload: { origin: 't1-completeness-retry', billable: false } });
    expect(await couverture(f)).toMatchObject({ attempts: 1, next: null, result: 'REQUEUED_T1', error: null });
    expect((await couverture(f)).verification.requeue).toMatchObject({ status: 'ACCEPTED', jobId: Number(file[0].id), attemptConsumed: true });

    // Seconde demande pendant que le travail attend : confirmée « déjà vivante », aucune tentative de plus.
    const deja = await jobs.requeueDocumentForRereadDetailed({ fileId: f, accountId: c.id, attempt: 2, origin: 't1-completeness-retry', result: 'REQUEUED_T1', scheduled: true });
    expect(deja).toMatchObject({ status: 'ALREADY_RUNNING', queued: true, attemptConsumed: false, jobId: Number(file[0].id) });
    expect(await travaux(f)).toHaveLength(1);
    expect(await couverture(f)).toMatchObject({ attempts: 1, result: 'REQUEUE_ALREADY_RUNNING' });

    // Deux demandes simultanées (tâche planifiée + BO) : un seul travail, une seule tentative.
    const g = await fichier(c);
    await ecrire(c, g, [couverte(1)], pdf([3]));
    const demande = { fileId: g, accountId: c.id, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1' };
    const [x, y] = await Promise.all([jobs.requeueDocumentForRereadDetailed(demande), jobs.requeueDocumentForRereadDetailed(demande)]);
    expect([x.queued, y.queued]).toEqual([true, true]);
    expect([x.status, y.status].sort()).toEqual(['ACCEPTED', 'ALREADY_RUNNING']);
    expect((await travaux(g)).filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect(Number((await couverture(g)).attempts)).toBe(1);

    // Compte non éligible : aucun travail, rien consommé, la demande planifiée reste due ; aucune réussite annoncée.
    const inactif = await make.account();
    const h = await fichier(inactif);
    await ecrire(inactif, h, [couverte(1)], pdf([2]));
    await sql`UPDATE accounts SET is_active = false WHERE id = ${inactif.id}`;
    const refus = await jobs.requeueDocumentForRereadDetailed({ fileId: h, accountId: inactif.id, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1', scheduled: true });
    expect(refus).toMatchObject({ status: 'ACCOUNT_NOT_ELIGIBLE', queued: false, attemptConsumed: false, result: 'REQUEUE_ACCOUNT_NOT_ELIGIBLE' });
    expect(await travaux(h)).toEqual([]);
    const ch = await couverture(h);
    expect(ch).toMatchObject({ attempts: 0, result: 'REQUEUE_ACCOUNT_NOT_ELIGIBLE' });
    expect(ch.next).not.toBeNull();
    expect(await jobs.requeueDocumentForReread({ fileId: h, accountId: inactif.id, attempt: 1, origin: 'coherence-control', result: 'REQUEUED_T1_COHERENCE' })).toBe(false);
    // La tâche planifiée ne prend pas ce compte : rien n'est consommé tant qu'il n'est pas réactivé.
    await reprise();
    expect(Number((await couverture(h)).attempts)).toBe(0);
    expect(replay.calls).toHaveLength(0);
  });

  it('L114H-E04 — R6 / R7 : campagne sur plusieurs comptes, alertes, journal, bilan, idempotence', async () => {
    const { runCoverageReassessment, getCoverageReassessmentReport, T1_COVERAGE_RULES_VERSION } = await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    const avantCampagne = await getCoverageReassessmentReport();
    const c1 = await make.account();
    const c2 = await make.account();
    // (a) « reprise programmée » sans reprise possible + alerte ouverte obsolète.
    const a = await fichier(c1);
    await ecrire(c1, a, [couverte(1), unite(2, { repairState: 'PENDING' })]);
    await vieillir(a, { attempts: 2, runs: 20 });
    await sql`UPDATE document_extraction_coverage SET next_retry_at = NOW() + interval '3 days' WHERE file_id = ${a}`;
    await signaler(c1, a);
    // (b) lacune réelle définitive (échec définitif d'une unité) + alerte : doit rester active.
    const b = await fichier(c2);
    await ecrire(c2, b, [couverte(1), unite(2, { status: 'FAILED', reason: 'repair_failed:final', repairAttempts: 1 })]);
    expect((await couverture(b)).q).toBe('INCOMPLETE_FINAL');
    await signaler(c2, b);
    // (c) image lue, non vérifiable (type document 389) : incertitude conservée, aucune relance.
    const img = await fichier(c2);
    await ecrire(c2, img, [couverte(1)], image);
    expect((await couverture(img)).q).toBe('VERIFICATION_INCOMPLETE');
    // (d) document supprimé dont l'alerte est restée ouverte.
    const d = await fichier(c1);
    await ecrire(c1, d, [couverte(1), unite(2, { status: 'FAILED', reason: 'repair_failed:final', repairAttempts: 1 })]);
    await signaler(c1, d);
    await sql`UPDATE asset_files SET deleted_at = NOW() WHERE id = ${d}`;
    const faitsAvant = (await sql<Json[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id IN (${a}, ${b}, ${img}, ${d})`)[0].n;

    let passages = 0;
    let r = await runCoverageReassessment({ env: { T1_REASSESSMENT_BATCH: '2' }, maxBatches: 1 });
    passages++;
    while (r.more && passages < 20) { r = await runCoverageReassessment({ env: { T1_REASSESSMENT_BATCH: '2' }, maxBatches: 1 }); passages++; }
    expect(r.more).toBe(false);
    expect(replay.calls).toHaveLength(0);

    // (a) état recalculé, échéance retirée, alerte close avec règle, version et cause.
    expect(await couverture(a)).toMatchObject({ q: 'COMPLETE_WITH_UNRESOLVED', next: null, attempts: 2 });
    expect(await alertes(a)).toEqual([expect.objectContaining({ status: 'resolved', resolution_source: 'auto', origin: `t1_coverage_reassessment:v${T1_COVERAGE_RULES_VERSION}` })]);
    expect((await alertes(a))[0].cause).toContain('COMPLETE_WITH_UNRESOLVED');
    // (b) anomalie avérée : toujours ouverte, état inchangé.
    expect((await couverture(b)).q).toBe('INCOMPLETE_FINAL');
    expect(await alertes(b)).toEqual([expect.objectContaining({ status: 'open' })]);
    // (c) incertitude préservée, aucune alerte de réparation, aucune échéance.
    expect(await couverture(img)).toMatchObject({ q: 'VERIFICATION_INCOMPLETE', next: null });
    expect(await alertes(img)).toEqual([]);
    expect(await travaux(img)).toEqual([]);
    // (d) document supprimé : alerte close, jamais journalisé comme document examiné.
    expect(await alertes(d)).toEqual([expect.objectContaining({ status: 'resolved' })]);
    expect((await alertes(d))[0].cause).toContain('document supprimé');

    const journal = await sql<Json[]>`
      SELECT file_id, account_id, rules_version, outcome, state_before, state_after, alerts, detail, attempts FROM t1_coverage_reassessments
       WHERE file_id IN (${a}, ${b}, ${img}, ${d}) ORDER BY file_id`;
    expect(journal.map((j) => Number(j.file_id)).sort((x, y) => x - y)).toEqual([a, b, img].sort((x, y) => x - y));
    const ja = journal.find((j) => Number(j.file_id) === a)!;
    expect(ja).toMatchObject({
      account_id: c1.id, rules_version: T1_COVERAGE_RULES_VERSION, outcome: 'STILL_UNRESOLVED', attempts: 1,
      state_before: { qualityState: 'INCOMPLETE_RETRYABLE', retryScheduled: true }, state_after: { qualityState: 'COMPLETE_WITH_UNRESOLVED', retryScheduled: false },
      detail: { aiCalls: 0, retry: { pendingReleased: 1 } },
    });
    expect(ja.alerts).toEqual([expect.objectContaining({ action: 'CLOSED', fingerprint: `ai:t1-completeness:${a}` })]);
    expect(journal.find((j) => Number(j.file_id) === b)).toMatchObject({ account_id: c2.id, outcome: 'UNCHANGED' });
    expect(journal.find((j) => Number(j.file_id) === b)!.alerts).toEqual([expect.objectContaining({ action: 'MAINTAINED' })]);
    expect(journal.find((j) => Number(j.file_id) === img)).toMatchObject({ outcome: 'UNCHANGED' });

    // Bilan cumulé (résultat réel de la base, comparé à l'état d'avant la campagne).
    const bilan = await getCoverageReassessmentReport();
    expect(bilan).toMatchObject({ available: true, rulesVersion: T1_COVERAGE_RULES_VERSION, aiCalls: 0, aiCost: 0 });
    expect(bilan.documents - avantCampagne.documents).toBeGreaterThanOrEqual(3);
    expect(bilan.alertsClosed - avantCampagne.alertsClosed).toBeGreaterThanOrEqual(2);
    expect(bilan.transitions).toContainEqual(expect.objectContaining({ from: 'INCOMPLETE_RETRYABLE', to: 'COMPLETE_WITH_UNRESOLVED' }));

    // Seconde campagne : aucun document retraité, aucune alerte rouverte, aucun fait créé.
    const mtime = await sql<Json[]>`SELECT file_id, updated_at FROM document_extraction_coverage WHERE file_id IN (${a}, ${b}, ${img}) ORDER BY file_id`;
    const bis = await runCoverageReassessment({ env: { T1_REASSESSMENT_BATCH: '2' } });
    expect(bis).toMatchObject({ alertsClosed: 0, alertsOpened: 0, more: false });
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM t1_coverage_reassessments WHERE file_id IN (${a}, ${b}, ${img}, ${d})`)[0].n).toBe(3);
    expect(await sql<Json[]>`SELECT file_id, updated_at FROM document_extraction_coverage WHERE file_id IN (${a}, ${b}, ${img}) ORDER BY file_id`).toEqual(mtime);
    expect((await alertes(a)).map((x) => x.status)).toEqual(['resolved']);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id IN (${a}, ${b}, ${img}, ${d})`)[0].n).toBe(faitsAvant);
    expect(replay.calls).toHaveLength(0);
  });
});
