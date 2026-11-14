/**
 * Lot 114H (Trello #775) — reprises T1 de bout en bout DANS LE CODE, base et
 * file SIMULÉES (aucun PostgreSQL, aucun appel IA) : les points d'entrée réels
 * (`runCompletenessRetry`, `requeueDocumentForRereadDetailed`,
 * `writeSourceLayer`, `reconcileStoredDocumentCoverage`) sont exécutés ; seuls
 * le pilote SQL, la file T1, la Supervision et la passe de réparation (appel
 * modèle) sont remplacés par des doubles qui ENREGISTRENT ce qui est écrit.
 *
 * Ce fichier ne prouve PAS que le SQL s'exécute sur PostgreSQL (scénario
 * `l114h-t1-reprises-historique.e2e.ts`) : il prouve les décisions, les
 * valeurs écrites et l'absence d'appel IA.
 *
 *   B01  R4 — garde finale de `writeSourceLayer`, toutes origines ;
 *   B02  R5 — remise en file : acceptée, déjà vivante, compte non éligible,
 *        refus transitoire, refus définitif, travail introuvable après
 *        l'opération, erreur de la file ; tentatives exactes, Supervision ;
 *   B03  R4 — `runCompletenessRetry` : plafond atteint, plafond à 0, page
 *        manquante, continuation, plafond de continuation — appels IA comptés ;
 *   B04  R5 — reprise planifiée : jamais « requeued » sans travail confirmé ;
 *   B05  P1-C — réconciliation du stock : état recalculé, échéance retirée ou
 *        reposée, idempotence, simulation sans écriture, aucune relance de
 *        masse d'une image.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoveredSourceUnit, SourceLayer } from '../types';
import type { StoredSourceUnit } from '../repository';

type Row = Record<string, unknown>;
interface Ecriture { q: string; params: unknown[] }

const etat = vi.hoisted(() => ({
  ecritures: [] as Array<{ q: string; params: unknown[] }>,
  /** Ligne de couverture servie aux lectures. */
  couverture: null as Record<string, unknown> | null,
  unites: [] as Array<Record<string, unknown>>,
  /** Réponse de la file T1 à la prochaine mise en file (objet) ou erreur levée. */
  file: { status: 'ACCEPTED', jobId: 501, reason: null } as { status: string; jobId: number | null; reason: string | null } | Error,
  /** Travaux T1 vivants relus après la mise en file. */
  travaux: [{ id: 501 }] as Array<{ id: number }>,
  misesEnFile: [] as Array<{ fileIds: number[]; accountId: number; options: Record<string, unknown> }>,
  refusTransitoires: 0,
  reparations: [] as Array<{ units: string[] }>,
  anomalies: [] as Array<{ action: string; fingerprint: string }>,
}));

const requete = vi.hoisted(() => async (q: string, params: unknown[] = []) => {
  const x = q.replace(/\s+/g, ' ').trim();
  etat.ecritures.push({ q: x, params });
  // Sondes de schéma : couche A, diagnostics (0329) et provenance (1665) présents.
  if (/to_regclass\('document_source_units'\)/.test(x)) return [{ a: true, b: true, c: true, d: true }];
  if (/information_schema\.columns/.test(x) && /repair_state/.test(x)) return [{ n: 5 }];
  if (/information_schema\.columns/.test(x)) return [{ n: 2 }];
  // Reprise planifiée : réservation par bail, puis lignes réservées.
  if (/FOR UPDATE OF c SKIP LOCKED/.test(x)) return etat.couverture ? [{ file_id: etat.couverture.fileId }] : [];
  if (/a\.owner_user_id/.test(x)) {
    const c = etat.couverture!;
    return [{ file_id: c.fileId, account_id: c.accountId, extraction_id: null, retry_attempts: c.retryAttempts, quality_state: c.qualityState, asset_id: null, linked_asset_id: null, title: 'document', owner_user_id: 5 }];
  }
  if (/SELECT facts_count, truncated_sections_count/.test(x)) return [{ facts_count: 2, truncated_sections_count: 0, batched_sections_count: 0, repair_pass_count: 0, chunk_count: 0, anomalies: etat.couverture?.anomalies ?? [] }];
  if (/SELECT retry_attempts, to_jsonb\(c\) -> 'verification' ->> 'continuationRuns'/.test(x)) {
    return etat.couverture ? [{ retry_attempts: etat.couverture.retryAttempts, runs: String((etat.couverture.verification as Row | null)?.continuationRuns ?? 0) }] : [];
  }
  // Remise en file : travail vivant relu, refus transitoires déjà subis.
  if (/FROM ai_job_queue/.test(x)) return etat.travaux;
  if (/'requeue' ->> 'transientRefusals'/.test(x)) return [{ refus: String(etat.refusTransitoires) }];
  return [];
});

vi.mock('@/db', () => {
  const pgClient = { unsafe: requete, begin: async (fn: (tx: { unsafe: typeof requete }) => Promise<unknown>) => fn({ unsafe: requete }) };
  return { pgClient, db: {} };
});
vi.mock('../../queue/t1-handler', async (orig) => ({
  ...(await orig<typeof import('../../queue/t1-handler')>()),
  enqueueFileAnalysesDetailed: async (fileIds: number[], accountId: number, options: Record<string, unknown>) => {
    etat.misesEnFile.push({ fileIds, accountId, options });
    if (etat.file instanceof Error) throw etat.file;
    return fileIds.map((fileId) => ({ fileId, ...(etat.file as { status: string; jobId: number | null; reason: string | null }) }));
  },
}));
vi.mock('@/services/admin/anomaly.service', () => ({
  reportAnomaly: async (p: { fingerprint: string }) => { etat.anomalies.push({ action: 'report', fingerprint: p.fingerprint }); return 1; },
  autoResolveAnomaly: async (fingerprint: string) => { etat.anomalies.push({ action: 'resolve', fingerprint }); return true; },
}));
vi.mock('../../../business-execution/repository', () => ({ latestT1ExecutionIdForFile: async () => null }));
// Lecture de la couche A : servie par le double ; l'ÉCRITURE (`writeSourceLayer`) reste la vraie.
vi.mock('../repository', async (orig) => ({
  ...(await orig<typeof import('../repository')>()),
  sourceLayerReady: async () => true,
  loadDocumentSourceUnits: async () => etat.unites,
  loadDocumentCoverage: async () => etat.couverture,
  loadUnresolvedDocumentFacts: async () => [],
}));
// Passe de réparation (le SEUL chemin d'appel modèle de la reprise) : comptée, jamais exécutée.
vi.mock('../repair', async (orig) => ({
  ...(await orig<typeof import('../repair')>()),
  runRepairPass: async (p: { units: Array<{ sourceUnitId: string }> }) => {
    etat.reparations.push({ units: p.units.map((u) => u.sourceUnitId) });
    return { facts: [], attempted: p.units.map((u) => u.sourceUnitId), failed: new Map(), calls: 1, outOfScope: 0, notAttempted: [], links: new Map(), decisions: [], decisionsDropped: { schemaInvalid: 0, unitNotFound: 0 } };
  },
}));
vi.mock('../../pipeline', () => ({ loadAnalysisContext: async () => ({}) }));
vi.mock('@/services/account-capabilities.service', () => ({ getAccountCapabilities: async () => ({}) }));
vi.mock('../../master/rubric-rules', () => ({ loadAssetFamilies: async () => [] }));
vi.mock('../../steps/analyze-document.step', () => ({ callAnalyzeDocument: async () => { throw new Error('appel modèle interdit dans ce test'); } }));

const jobs = await import('../jobs');
const repo = await import('../repository');
const { buildCompletenessReport } = await import('../coverage');
const { reconcileStoredDocumentCoverage } = await import('../stored-reconciliation');
const { SOURCE_LAYER_VERSION } = await import('../types');

const FICHIER = 42;
const COMPTE = 7;
const TEXTES = ['Référence dossier : AB-2291', 'Montant restant dû : 132,00 €', 'Échéance du 14/02/2026', 'Numéro de police : 778899', 'Franchise : 250,00 €'];

const stockee = (n: number, over: Partial<StoredSourceUnit> = {}): StoredSourceUnit => ({
  fileId: FICHIER, accountId: COMPTE, sourceUnitId: `page:1:block:${n}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null,
  text: TEXTES[n - 1], label: null, value: null, payload: {}, location: {}, origin: 'PASS_1', salient: true,
  coverageStatus: 'UNRESOLVED', coverageReason: 'not_extracted', factCount: 0, repairAttempts: 0, repairState: null, coverageProvenance: null, residualPolicy: null, ...over,
});
const couverteStockee = (n: number) => stockee(n, { coverageStatus: 'COVERED', coverageReason: 'fact', factCount: 1 });
const enAttente = (n: number) => stockee(n, { repairState: 'PENDING', residualPolicy: 'REPAIR_PENDING' });

const poser = (p: { qualityState: string; retryAttempts?: number; nextRetryAt?: string | null; anomalies?: string[]; verification?: Row; unites: StoredSourceUnit[] }) => {
  etat.unites = p.unites as unknown as Array<Record<string, unknown>>;
  etat.couverture = {
    fileId: FICHIER, accountId: COMPTE, extractionId: null, qualityState: p.qualityState, anomalies: p.anomalies ?? [], retryAttempts: p.retryAttempts ?? 0,
    nextRetryAt: p.nextRetryAt === undefined ? '2026-01-15T10:00:00.000Z' : p.nextRetryAt, verification: p.verification ?? {},
    factsCount: 2, truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0, lastRetryResult: null,
  };
};
const pagesManquantes = { sourceVerification: 'PARTIAL', verificationReason: 'pages_missing', pagesExpected: 3, pagesVerified: 2, pagesMissing: [2], pagesUnverified: [], pagesScanned: [] };

/** Dernière écriture de la ligne de couverture par `writeSourceLayer` (null : rien écrit). */
const ecrite = () => {
  const ins = [...etat.ecritures].reverse().find((e: Ecriture) => e.q.startsWith('INSERT INTO document_extraction_coverage'));
  if (!ins) return null;
  const unites = etat.ecritures.filter((e: Ecriture) => e.q.startsWith('INSERT INTO document_source_units')).flatMap((e: Ecriture) => JSON.parse(String(e.params[3])) as Array<Record<string, unknown>>);
  const diag = [...etat.ecritures].reverse().find((e: Ecriture) => /SET source_verification = \$2, verification = \$3::jsonb/.test(e.q));
  return {
    quality: ins.params[16] as string, anomalies: ins.params[17] as string[], retryAttempts: ins.params[20] as number, nextRetryAt: ins.params[21] as string | null,
    unites, verification: diag ? JSON.parse(String(diag.params[2])) as Record<string, unknown> : null, retryResult: diag ? diag.params[3] as string | null : null,
  };
};
/** Mise à jour de la couverture par la remise en file (UPDATE principal). */
const majRemiseEnFile = () => {
  const u = etat.ecritures.find((e: Ecriture) => /SET retry_attempts = CASE WHEN \$3::boolean/.test(e.q));
  const r = etat.ecritures.find((e: Ecriture) => /SET last_retry_at = NOW\(\), last_retry_result = \$3, verification = jsonb_set/.test(e.q));
  return u ? { consomme: u.params[2] as boolean, tentative: u.params[3] as number, garder: u.params[4] as boolean, prochaine: u.params[5] as string | null, erreur: u.params[6] as string | null, resultat: r?.params[2] as string, trace: r ? JSON.parse(String(r.params[3])) as Row : null } : null;
};
/** Reporte la dernière écriture dans les données servies (pour rejouer). */
const reporter = () => {
  const e = ecrite()!;
  const parId = new Map(etat.unites.map((u) => [u.sourceUnitId, u]));
  etat.unites = e.unites.map((u) => ({ ...parId.get(u.id)!, coverageStatus: u.status, coverageReason: u.reason, repairAttempts: u.attempts, repairState: u.repair, residualPolicy: u.policy, coverageProvenance: u.cprov }));
  etat.couverture = { ...etat.couverture!, qualityState: e.quality, anomalies: e.anomalies, retryAttempts: e.retryAttempts, nextRetryAt: e.nextRetryAt, verification: e.verification ?? {} };
};

beforeEach(() => {
  etat.ecritures = []; etat.couverture = null; etat.unites = []; etat.file = { status: 'ACCEPTED', jobId: 501, reason: null }; etat.travaux = [{ id: 501 }];
  etat.misesEnFile = []; etat.refusTransitoires = 0; etat.reparations = []; etat.anomalies = [];
  repo.__resetCoverageProvenanceProbeForTests();
});

describe('L114H-B01 — R4 : garde finale de `writeSourceLayer`, toutes origines', () => {
  const unite = (n: number, over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
    sourceUnitId: `page:1:block:${n}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null, text: TEXTES[n - 1], payload: {}, location: {},
    origin: 'PASS_1', salient: true, status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0, repairAttempts: 0, repairState: null, ...over,
  });
  const couche = (units: CoveredSourceUnit[]): SourceLayer => ({
    layerVersion: SOURCE_LAYER_VERSION, units, unresolvedFacts: [], retryable: true,
    report: buildCompletenessReport(units, { factsCount: 1, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 1, chunkCount: 0, warningCodes: [], retryAllowed: true }),
  });
  const ecrire = (layer: SourceLayer, over: Record<string, unknown> = {}) => repo.writeSourceLayer({ unsafe: requete } as never, { accountId: COMPTE, fileId: FICHIER, extractionId: null, layer, ...over } as never);

  it('ANALYSE avec reprises déjà consommées : échec « réessayable » → INCOMPLETE_FINAL, aucune échéance (règle conservée)', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 2, unites: [] });
    const layer = couche([unite(1, { status: 'FAILED', reason: 'repair_failed:retryable', repairAttempts: 1 })]);
    expect(layer.report.qualityState).toBe('INCOMPLETE_RETRYABLE');
    await ecrire(layer);
    expect(ecrite()).toMatchObject({ quality: 'INCOMPLETE_FINAL', nextRetryAt: null, retryAttempts: 2 });
    // L'appelant relit le rapport de la couche (Supervision) : il est à jour.
    expect(layer.report.qualityState).toBe('INCOMPLETE_FINAL');
  });

  it('ANALYSE, première fois : unités en attente → reprise programmée (comportement conservé)', async () => {
    const layer = couche([unite(1, { repairState: 'PENDING' })]);
    await ecrire(layer);
    const e = ecrite()!;
    expect(e.quality).toBe('INCOMPLETE_RETRYABLE');
    expect(e.nextRetryAt).not.toBeNull();
  });

  it('REPRISE qui annonce encore une échéance sans action admissible : échéance refusée, attente levée (chemin RETRY non couvert avant)', async () => {
    const layer = couche([unite(1, { status: 'COVERED', reason: 'fact', factCount: 1 }), unite(2, { repairState: 'PENDING' })]);
    (layer.report.diagnostics as unknown as Row).continuationRuns = 20;
    await ecrire(layer, { origin: 'RETRY', retryAttempts: 2, nextRetryAt: new Date('2026-01-15T10:00:00.000Z') });
    const e = ecrite()!;
    expect(e).toMatchObject({ quality: 'COMPLETE_WITH_UNRESOLVED', nextRetryAt: null, retryAttempts: 2 });
    expect(e.anomalies).not.toContain('REPAIR_PENDING');
    expect(e.unites.find((u) => u.id === 'page:1:block:2')).toMatchObject({ status: 'UNRESOLVED', repair: null, policy: 'REPAIR_NOT_RUN:RETRY_CAP_REACHED' });
  });

  it('reprises désactivées (0) : unités en attente → jamais « en reprise », jamais d’échéance', async () => {
    const layer = couche([unite(1, { repairState: 'PENDING' })]);
    await ecrire(layer, { env: { T1_COMPLETENESS_MAX_RETRIES: '0' } });
    expect(ecrite()).toMatchObject({ quality: 'COMPLETE_WITH_UNRESOLVED', nextRetryAt: null });
  });

  it('échéance DEMANDÉE (réparation IA optionnelle de la reprise historique) : gardée tant qu’une reprise reste, refusée au plafond', async () => {
    const quand = new Date('2026-01-15T10:00:00.000Z');
    await ecrire(couche([unite(1)]), { origin: 'BACKFILL', nextRetryAt: quand });
    expect(ecrite()!.nextRetryAt).toBe(quand.toISOString());
    etat.ecritures = [];
    await ecrire(couche([unite(1)]), { origin: 'RETRY', retryAttempts: 2, nextRetryAt: quand });
    expect(ecrite()!.nextRetryAt).toBeNull();
  });
});

describe('L114H-B02 — R5 : remise en file T1, issue réelle et tentatives exactes', () => {
  const demander = (over: Record<string, unknown> = {}) => jobs.requeueDocumentForRereadDetailed({
    fileId: FICHIER, accountId: COMPTE, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1', scheduled: true, env: {}, ...over,
  });

  it('acceptée : travail créé relu en base, reprise consommée, « REQUEUED_T1 », ancienne alerte résolue', async () => {
    const r = await demander();
    expect(r).toMatchObject({ status: 'ACCEPTED', queued: true, jobId: 501, attemptConsumed: true, result: 'REQUEUED_T1', reason: null });
    expect(etat.misesEnFile).toHaveLength(1);
    expect(etat.misesEnFile[0].options).toMatchObject({ billable: false, processingVisibility: 'TECHNICAL', resume: true });
    expect(majRemiseEnFile()).toMatchObject({ consomme: true, tentative: 1, garder: false, prochaine: null, erreur: null, resultat: 'REQUEUED_T1' });
    expect(etat.anomalies).toEqual([{ action: 'resolve', fingerprint: 'ai:t1-requeue:42' }]);
  });

  it('déjà vivante (travail en attente ou en cours du même document) : confirmée, AUCUNE reprise consommée', async () => {
    etat.file = { status: 'ALREADY_RUNNING', jobId: 498, reason: 'DUPLICATE_RUNNING' };
    etat.travaux = [{ id: 498 }];
    const r = await demander();
    expect(r).toMatchObject({ status: 'ALREADY_RUNNING', queued: true, jobId: 498, attemptConsumed: false, result: 'REQUEUE_ALREADY_RUNNING' });
    expect(majRemiseEnFile()).toMatchObject({ consomme: false, garder: false, prochaine: null, resultat: 'REQUEUE_ALREADY_RUNNING' });
  });

  it('deux demandes concurrentes : une seule reprise consommée', async () => {
    const premiere = await demander();
    etat.file = { status: 'ALREADY_RUNNING', jobId: 501, reason: 'DUPLICATE_PENDING' };
    const seconde = await demander({ attempt: 1 });
    expect([premiere.attemptConsumed, seconde.attemptConsumed]).toEqual([true, false]);
    expect([premiere.queued, seconde.queued]).toEqual([true, true]);
  });

  it('compte non éligible : non confirmée, rien consommé, demande planifiée laissée DUE (reprise à la réactivation)', async () => {
    etat.file = { status: 'ACCOUNT_NOT_ELIGIBLE', jobId: null, reason: 'ACCOUNT_INELIGIBLE' };
    const r = await demander();
    expect(r).toMatchObject({ status: 'ACCOUNT_NOT_ELIGIBLE', queued: false, attemptConsumed: false, result: 'REQUEUE_ACCOUNT_NOT_ELIGIBLE', reason: 'ACCOUNT_INELIGIBLE' });
    const m = majRemiseEnFile()!;
    expect(m).toMatchObject({ consomme: false, garder: false, resultat: 'REQUEUE_ACCOUNT_NOT_ELIGIBLE' });
    expect(m.prochaine).not.toBeNull();
    expect(m.erreur).toContain('compte non éligible');
    expect(etat.anomalies).toEqual([]);
  });

  it('refus transitoire : non confirmée, rien consommé, échéance reposée ; la demande n’est pas perdue', async () => {
    etat.file = new Error('connexion à la file perdue');
    const r = await demander();
    expect(r).toMatchObject({ status: 'REJECTED_TRANSIENT', queued: false, attemptConsumed: false, result: 'REQUEUE_REJECTED_TRANSIENT', reason: 'ENQUEUE_ERROR' });
    const m = majRemiseEnFile()!;
    expect(m.consomme).toBe(false);
    expect(m.prochaine).not.toBeNull();
    expect(m.trace).toMatchObject({ status: 'REJECTED_TRANSIENT', transientRefusals: 1, attemptConsumed: false });
    expect(etat.anomalies).toEqual([]);
  });

  it('refus transitoires répétés au plafond de reprises : reprise consommée, plus d’échéance, Supervision', async () => {
    etat.file = new Error('connexion à la file perdue');
    etat.refusTransitoires = jobs.REQUEUE_TRANSIENT_MAX;
    const r = await demander({ attempt: 2 });
    expect(r).toMatchObject({ queued: false, attemptConsumed: true });
    expect(majRemiseEnFile()).toMatchObject({ consomme: true, tentative: 2, prochaine: null });
    expect(etat.anomalies).toEqual([{ action: 'report', fingerprint: 'ai:t1-requeue:42' }]);
  });

  it('refus définitif : statut explicite, rien consommé, aucune échéance, Supervision', async () => {
    etat.file = { status: 'REJECTED_FINAL', jobId: null, reason: 'CROSS_ACCOUNT_SCOPE' };
    const r = await demander();
    expect(r).toMatchObject({ status: 'REJECTED_FINAL', queued: false, attemptConsumed: false, result: 'REQUEUE_REJECTED_FINAL', reason: 'CROSS_ACCOUNT_SCOPE' });
    expect(majRemiseEnFile()).toMatchObject({ consomme: false, garder: false, prochaine: null });
    expect(etat.anomalies).toEqual([{ action: 'report', fingerprint: 'ai:t1-requeue:42' }]);
  });

  it('« acceptée » mais travail INTROUVABLE après l’opération : jamais une réussite', async () => {
    etat.travaux = [];
    const r = await demander();
    expect(r).toMatchObject({ status: 'REJECTED_TRANSIENT', queued: false, reason: 'JOB_NOT_FOUND_AFTER_ENQUEUE', attemptConsumed: false });
    expect(majRemiseEnFile()!.resultat).toBe('REQUEUE_REJECTED_TRANSIENT');
  });

  it('demande manuelle (BO, contrôle de cohérence) refusée : l’échéance existante n’est pas touchée ; forme booléenne = « travail confirmé »', async () => {
    etat.file = { status: 'ACCOUNT_NOT_ELIGIBLE', jobId: null, reason: 'ACCOUNT_INELIGIBLE' };
    await demander({ scheduled: false, result: 'REQUEUED_T1_ADMIN' });
    expect(majRemiseEnFile()).toMatchObject({ consomme: false, garder: true });
    const p = { fileId: FICHIER, accountId: COMPTE, attempt: 1, origin: 'coherence-control', result: 'REQUEUED_T1_COHERENCE' };
    expect(await jobs.requeueDocumentForReread(p)).toBe(false);
    etat.file = { status: 'ALREADY_RUNNING', jobId: 501, reason: 'DUPLICATE_PENDING' };
    expect(await jobs.requeueDocumentForReread(p)).toBe(true);
  });
});

describe('L114H-B03 — R4 : `runCompletenessRetry`, aucun appel IA après la limite, aucune boucle', () => {
  it('plafond de reprises ET de continuation atteints, unités en attente : 0 appel, 0 mise en file, échéance retirée, tentative NON consommée', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 2, anomalies: ['COVERAGE_INCOMPLETE', 'REPAIR_PENDING'], verification: { continuationRuns: 20 }, unites: [couverteStockee(1), enAttente(2), enAttente(3)] });
    const r = await jobs.runCompletenessRetry({ env: {} });
    expect(r).toMatchObject({ examined: 1, failed: 0, requeued: 0, notQueued: 0 });
    expect(etat.reparations).toEqual([]);
    expect(etat.misesEnFile).toEqual([]);
    const e = ecrite()!;
    expect(e).toMatchObject({ quality: 'COMPLETE_WITH_UNRESOLVED', nextRetryAt: null, retryAttempts: 2, retryResult: 'RETRY_NOT_ADMISSIBLE:CONTINUATION_CAP_REACHED' });
    expect(e.anomalies).not.toContain('REPAIR_PENDING');
    expect(e.unites.filter((u) => u.repair === 'PENDING')).toEqual([]);
    expect(e.unites.filter((u) => u.policy === 'REPAIR_NOT_RUN:RETRY_CAP_REACHED')).toHaveLength(2);
    // Aucune boucle : la tâche ne reprend que les lignes dont l'échéance est posée.
    expect(etat.ecritures.find((x: Ecriture) => /FOR UPDATE OF c SKIP LOCKED/.test(x.q))!.q).toContain('c.next_retry_at IS NOT NULL AND c.next_retry_at <= NOW()');
    // Rejouée (comme le ferait un second passage forcé) : toujours aucun appel, même état.
    reporter();
    etat.ecritures = [];
    await jobs.runCompletenessRetry({ env: {} });
    expect(etat.reparations).toEqual([]);
    expect(ecrite()).toMatchObject({ quality: 'COMPLETE_WITH_UNRESOLVED', nextRetryAt: null, retryAttempts: 2 });
  });

  it('plafond à 0 : page manquante + unités en attente → 0 appel, 0 mise en file, lacune DÉFINITIVE visible, jamais COMPLETE', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 0, verification: pagesManquantes, unites: [couverteStockee(1), enAttente(2)] });
    await jobs.runCompletenessRetry({ env: { T1_COMPLETENESS_MAX_RETRIES: '0' } });
    expect(etat.reparations).toEqual([]);
    expect(etat.misesEnFile).toEqual([]);
    const e = ecrite()!;
    expect(e).toMatchObject({ quality: 'INCOMPLETE_FINAL', nextRetryAt: null, retryAttempts: 0, retryResult: 'RETRY_NOT_ADMISSIBLE:RETRIES_DISABLED' });
    expect(e.anomalies).toEqual(expect.arrayContaining(['COVERAGE_INCOMPLETE', 'PAGE_MISSING']));
    expect(etat.anomalies).toContainEqual({ action: 'report', fingerprint: 'ai:t1-completeness:42' });
  });

  it('plafond dépassé (valeur réduite après coup) : page manquante → rien n’est rejoué', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 4, verification: pagesManquantes, unites: [couverteStockee(1)] });
    await jobs.runCompletenessRetry({ env: { T1_COMPLETENESS_MAX_RETRIES: '1' } });
    expect(etat.misesEnFile).toEqual([]);
    expect(ecrite()).toMatchObject({ quality: 'INCOMPLETE_FINAL', nextRetryAt: null, retryAttempts: 4 });
  });

  it('continuation au-delà du plafond de reprises : seules les unités EN ATTENTE sont soumises, sans consommer de reprise ; passage compté', async () => {
    poser({
      qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 2, verification: { continuationRuns: 3 },
      unites: [couverteStockee(1), enAttente(2), enAttente(3), stockee(4, { repairAttempts: 1, repairState: 'ATTEMPTED_FAILED' })],
    });
    await jobs.runCompletenessRetry({ env: {} });
    expect(etat.reparations).toEqual([{ units: ['page:1:block:2', 'page:1:block:3'] }]);
    const e = ecrite()!;
    expect(e.retryAttempts).toBe(2);
    expect(e.verification).toMatchObject({ continuationRuns: 4 });
    // Plus rien en attente après ce passage : aucune nouvelle échéance.
    expect(e).toMatchObject({ quality: 'COMPLETE_WITH_UNRESOLVED', nextRetryAt: null });
  });

  it('reprise ordinaire admissible (échec transitoire, reprise restante) : un appel, une reprise consommée', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 0, unites: [couverteStockee(1), stockee(2, { coverageStatus: 'FAILED', coverageReason: 'repair_failed:retryable', repairAttempts: 1 })] });
    await jobs.runCompletenessRetry({ env: {} });
    expect(etat.reparations).toEqual([{ units: ['page:1:block:2'] }]);
    expect(ecrite()!.retryAttempts).toBe(1);
  });
});

describe('L114H-B04 — R5 : reprise planifiée, jamais « requeued » sans travail confirmé', () => {
  const pageManquante = () => poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 0, verification: pagesManquantes, unites: [couverteStockee(1)] });

  it('page manquante, reprise restante, file qui accepte : remise en file confirmée (action réelle — auparavant aucune)', async () => {
    pageManquante();
    const r = await jobs.runCompletenessRetry({ env: {} });
    expect(r).toMatchObject({ requeued: 1, notQueued: 0 });
    expect(etat.misesEnFile).toHaveLength(1);
    expect(majRemiseEnFile()).toMatchObject({ consomme: true, tentative: 1, resultat: 'REQUEUED_T1' });
    expect(etat.reparations).toEqual([]);
  });

  it.each([
    ['refus transitoire', new Error('file indisponible'), 'REQUEUE_REJECTED_TRANSIENT'],
    ['compte non éligible', { status: 'ACCOUNT_NOT_ELIGIBLE', jobId: null, reason: 'ACCOUNT_INELIGIBLE' }, 'REQUEUE_ACCOUNT_NOT_ELIGIBLE'],
    ['refus définitif', { status: 'REJECTED_FINAL', jobId: null, reason: 'CROSS_ACCOUNT_SCOPE' }, 'REQUEUE_REJECTED_FINAL'],
  ])('%s : compté « non mis en file », jamais « requeued », aucune reprise consommée', async (_nom, reponse, resultat) => {
    pageManquante();
    etat.file = reponse as typeof etat.file;
    const r = await jobs.runCompletenessRetry({ env: {} });
    expect(r).toMatchObject({ requeued: 0, notQueued: 1, failed: 0 });
    expect(majRemiseEnFile()).toMatchObject({ consomme: false, resultat });
    expect(etat.ecritures.some((x: Ecriture) => x.params.includes('REQUEUED_T1'))).toBe(false);
  });

  it('source momentanément illisible (vérification incomplète) : même garde', async () => {
    poser({ qualityState: 'VERIFICATION_INCOMPLETE', retryAttempts: 0, verification: { sourceVerification: 'UNVERIFIABLE', verificationReason: 'source_unreadable' }, unites: [couverteStockee(1)] });
    etat.file = new Error('file indisponible');
    expect(await jobs.runCompletenessRetry({ env: {} })).toMatchObject({ requeued: 0, notQueued: 1 });
    etat.ecritures = []; etat.file = { status: 'ACCEPTED', jobId: 501, reason: null };
    expect(await jobs.runCompletenessRetry({ env: {} })).toMatchObject({ requeued: 1, notQueued: 0 });
  });
});

describe('L114H-B05 — P1-C : réconciliation du stock avec la règle des reprises', () => {
  const reconcilier = (apply = true) => reconcileStoredDocumentCoverage({ accountId: COMPTE, fileId: FICHIER, apply, origin: 'test' });

  it('« reprise programmée » sans reprise possible (plafond atteint) : état recalculé, échéance retirée, puis INCHANGÉE au rejeu', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 2, anomalies: ['COVERAGE_INCOMPLETE', 'REPAIR_PENDING'], verification: { continuationRuns: 20 }, unites: [couverteStockee(1), enAttente(2)] });
    const simule = await reconcilier(false);
    expect(simule.outcome).toBe('SIMULATED');
    expect(ecrite()).toBeNull();
    const r = await reconcilier();
    expect(r).toMatchObject({
      outcome: 'APPLIED', requalified: [], before: { qualityState: 'INCOMPLETE_RETRYABLE' }, after: { qualityState: 'COMPLETE_WITH_UNRESOLVED' },
      retry: { scheduledBefore: true, scheduledAfter: false, pendingReleased: 1, actions: [], blocked: 'CONTINUATION_CAP_REACHED', stateChanged: true },
    });
    expect(ecrite()).toMatchObject({ quality: 'COMPLETE_WITH_UNRESOLVED', nextRetryAt: null, retryAttempts: 2, retryResult: 'RECONCILED_POLICIES' });
    // Les compteurs de reprise survivent au recalcul (jamais remis à zéro).
    expect(ecrite()!.verification).toMatchObject({ continuationRuns: 20 });
    reporter();
    etat.ecritures = [];
    expect((await reconcilier()).outcome).toBe('UNCHANGED');
    expect(ecrite()).toBeNull();
  });

  it('lacune réparable restée SANS échéance (ancien refus de remise en file) : échéance reposée, sans appel', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 0, nextRetryAt: null, anomalies: ['COVERAGE_INCOMPLETE', 'PAGE_MISSING'], verification: pagesManquantes, unites: [couverteStockee(1)] });
    const r = await reconcilier();
    expect(r).toMatchObject({ outcome: 'APPLIED', after: { qualityState: 'INCOMPLETE_RETRYABLE' }, retry: { scheduledBefore: false, scheduledAfter: true, actions: ['REQUEUE_T1'] } });
    expect(ecrite()!.nextRetryAt).not.toBeNull();
    expect(etat.misesEnFile).toEqual([]);
    expect(etat.reparations).toEqual([]);
  });

  it('page manquante au plafond : lacune DÉFINITIVE (jamais « reprise programmée », jamais COMPLETE)', async () => {
    poser({ qualityState: 'INCOMPLETE_RETRYABLE', retryAttempts: 2, anomalies: ['COVERAGE_INCOMPLETE', 'PAGE_MISSING'], verification: pagesManquantes, unites: [couverteStockee(1)] });
    const r = await reconcilier();
    expect(r).toMatchObject({ outcome: 'APPLIED', after: { qualityState: 'INCOMPLETE_FINAL' }, retry: { scheduledAfter: false, blocked: 'RETRY_CAP_REACHED' } });
    expect(ecrite()).toMatchObject({ quality: 'INCOMPLETE_FINAL', nextRetryAt: null });
  });

  it('image / scan avec observation incertaine, sans échéance : AUCUNE relance posée par le recalcul (pas de relance de masse)', async () => {
    const observation = stockee(2, { kind: 'VISUAL_OBSERVATION', coverageStatus: 'UNCERTAIN', coverageReason: 'observation_conflictual', repairState: 'NEEDS_SOURCE', residualPolicy: 'NEEDS_SOURCE', text: 'tampon partiellement lisible', payload: { confidence: 'conflictual' } });
    poser({
      qualityState: 'VERIFICATION_INCOMPLETE', retryAttempts: 0, nextRetryAt: null, anomalies: ['PAGE_UNVERIFIED', 'COVERAGE_UNVERIFIED'],
      verification: { sourceVerification: 'UNVERIFIABLE', verificationReason: 'image_not_checkable', pagesExpected: 1, pagesVerified: 0, pagesMissing: [], pagesUnverified: [1], pagesScanned: [1] },
      unites: [couverteStockee(1), observation],
    });
    const r = await reconcilier();
    expect(r.outcome).toBe('UNCHANGED');
    expect(r.retry).toMatchObject({ scheduledBefore: false, scheduledAfter: false, stateChanged: false });
    expect(ecrite()).toBeNull();
  });
});
