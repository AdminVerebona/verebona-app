/**
 * Lot 111Q — diagnostic CIBLÉ en file : règles PURES (capacité des voies,
 * raison d'attente d'un ciblé, métriques séparées, catégories d'état,
 * profilage) et lecture BO sous session (MISSING_TOKEN), plus contrôles
 * statiques (aucun `fetch` nu sur la page, migration additive, journaux
 * corrélables, remplacement 111C limité aux globaux).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagJobSettings, laneCapacity } from '../state';
import { diagnoseWait, type DiagWorkerBeat, type WaitInput } from '../wait';
import { createPhaseProfiler, diagMetrics, DIAG_STATE_CATEGORY_LABELS, formatDuration, stateCategory } from '../metrics';
import { boGet, describeReadFailure, freshnessLabel, reconnectHref, stopsPolling } from '@/app/admin/diagnostics/_lib/bo-read';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const NOW = new Date('2026-11-05T14:49:42Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function beat(p: Partial<DiagWorkerBeat> = {}): DiagWorkerBeat {
  return {
    instanceId: 'web-1:42:abcd1234', processType: 'web', placement: 'web', state: 'STARTED', disabledReason: null, buildCommit: 'c0ffee', startedAt: ago(3600), seenAt: ago(10),
    lastTickAt: ago(5), lastTickOkAt: ago(5), tickRunningSince: null, lastClaimAt: null, currentJobId: null, waitReason: 'NO_ELIGIBLE_JOB', lastError: null, lastErrorAt: null, intervalMs: 10_000,
    laneJobId: null, laneWaitReason: null, laneCapacity: 1, ...p,
  };
}
const GLOBAL = 'c229c2fd-3c08-4d12-842e-800652b778f8';
function input(p: Partial<WaitInput> = {}, job: Partial<WaitInput['job']> = {}): WaitInput {
  return {
    job: { id: 'f191d635-b4f1-4040-9dba-d04852da161a', scope: 'account', startedAt: ago(30), nextAttemptAt: null, ...job },
    beats: [beat()], running: [], globalConcurrency: 1, targetedConcurrency: 1, stallAlertSeconds: 300, now: NOW, ...p,
  };
}
const runningGlobal = (p: Partial<WaitInput['running'][number]> = {}) => ({ id: GLOBAL, scope: 'global', leaseAlive: true, cancelRequested: false, cancelReason: null, ...p });

describe('L111Q-U01 capacité : voie commune + places réservées aux ciblés', () => {
  it('DIAG_JOB_TARGETED_CONCURRENCY : défaut 1, 0 accepté (comportement 111C)', () => {
    expect(diagJobSettings({}).targetedConcurrency).toBe(1);
    expect(diagJobSettings({ DIAG_JOB_TARGETED_CONCURRENCY: '0' }).targetedConcurrency).toBe(0);
    expect(diagJobSettings({ DIAG_JOB_TARGETED_CONCURRENCY: '2' }).targetedConcurrency).toBe(2);
    expect(diagJobSettings({ DIAG_JOB_TARGETED_CONCURRENCY: 'x' }).targetedConcurrency).toBe(1);
  });
  it('un global en cours (même annulé / en arrêt) n’empêche jamais un ciblé ; deux globaux jamais ensemble', () => {
    const s = { globalConcurrency: 1, targetedConcurrency: 1 };
    expect(laneCapacity({ total: 0, global: 0 }, s)).toEqual({ globalAllowed: true, targetedAllowed: true });
    expect(laneCapacity({ total: 1, global: 1 }, s)).toEqual({ globalAllowed: false, targetedAllowed: true });
    expect(laneCapacity({ total: 2, global: 1 }, s)).toEqual({ globalAllowed: false, targetedAllowed: false });
    // Un ciblé en cours occupe la voie commune : le global attend (prudence mémoire, règle 111C conservée).
    expect(laneCapacity({ total: 1, global: 0 }, s)).toEqual({ globalAllowed: false, targetedAllowed: true });
    expect(laneCapacity({ total: 1, global: 1 }, { globalConcurrency: 1, targetedConcurrency: 0 })).toEqual({ globalAllowed: false, targetedAllowed: false });
    expect(laneCapacity({ total: 1, global: 1 }, { globalConcurrency: 3, targetedConcurrency: 0 }).globalAllowed).toBe(false);
  });
});

describe('L111Q-U02 raison d’attente d’un diagnostic CIBLÉ', () => {
  it('worker désactivé / sans conteneur / absent : mêmes raisons que le global (dès la demande)', () => {
    expect(diagnoseWait(input({ beats: [beat({ state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED' })] }))).toMatchObject({ reason: 'WORKER_DISABLED', alert: true });
    expect(diagnoseWait(input({ beats: [beat({ state: 'NOT_THIS_PROCESS', placement: 'worker' })] }))).toMatchObject({ reason: 'NO_WORKER_CONTAINER', alert: true });
    expect(diagnoseWait(input({ beats: [] }, { startedAt: ago(381) }))).toMatchObject({ reason: 'WORKER_UNAVAILABLE', alert: true, waitedSeconds: 381 });
  });
  it('global en cours, annulé ou remplacé en cours d’arrêt : le ciblé n’est PAS bloqué (voie réservée)', () => {
    const busy = [beat({ currentJobId: GLOBAL })];
    expect(diagnoseWait(input({ beats: busy, running: [runningGlobal()] })).reason).toBe('PICKUP_PENDING');
    expect(diagnoseWait(input({ beats: busy, running: [runningGlobal({ cancelRequested: true, cancelReason: 'REPLACED_BY_NEW_REQUEST' })] })).reason).toBe('PICKUP_PENDING');
    expect(diagnoseWait(input({ beats: busy, running: [runningGlobal({ cancelRequested: true, cancelReason: 'ADMIN_CANCELLED' })] })).reason).toBe('PICKUP_PENDING');
    // Orphelin (bail expiré) : ignoré.
    expect(diagnoseWait(input({ running: [runningGlobal({ leaseAlive: false })] })).reason).toBe('PICKUP_PENDING');
  });
  it('voie réservée pleine ou absente : « autre diagnostic en cours » avec la référence ; mémoire : admission', () => {
    const other = 'aaaaaaaa-0000-0000-0000-000000000001';
    expect(diagnoseWait(input({ running: [runningGlobal(), { ...runningGlobal(), id: other, scope: 'account' }] }))).toMatchObject({ reason: 'OTHER_DIAGNOSTIC_RUNNING', blockingJobId: other });
    expect(diagnoseWait(input({ beats: [beat({ currentJobId: GLOBAL, laneCapacity: null })], running: [runningGlobal()] }))).toMatchObject({ reason: 'OTHER_DIAGNOSTIC_RUNNING', blockingJobId: GLOBAL });
    expect(diagnoseWait(input({ beats: [beat({ currentJobId: GLOBAL, laneJobId: other })], running: [runningGlobal()] }))).toMatchObject({ reason: 'OTHER_DIAGNOSTIC_RUNNING', blockingJobId: other });
    expect(diagnoseWait(input({ beats: [beat({ currentJobId: GLOBAL, laneWaitReason: 'MEMORY_ADMISSION' })], running: [runningGlobal()] })).reason).toBe('MEMORY_ADMISSION');
  });
  it('DIAG_JOB_TARGETED_CONCURRENCY=0 : règle 111C (le ciblé attend le global)', () => {
    expect(diagnoseWait(input({ targetedConcurrency: 0, running: [runningGlobal()] }))).toMatchObject({ reason: 'OTHER_DIAGNOSTIC_RUNNING', blockingJobId: GLOBAL });
  });
  it('au-delà du seuil d’alerte (DIAG_JOB_STALL_ALERT_SECONDS) sans cause : anomalie, jamais « en file » indéfiniment', () => {
    expect(diagnoseWait(input({}, { startedAt: ago(252) }))).toMatchObject({ reason: 'PICKUP_PENDING', alert: false });
    expect(diagnoseWait(input({}, { startedAt: ago(381) }))).toMatchObject({ reason: 'UNEXPLAINED_WAIT', alert: true });
    expect(diagnoseWait(input({ stallAlertSeconds: 120 }, { startedAt: ago(252) }))).toMatchObject({ reason: 'UNEXPLAINED_WAIT', alert: true });
  });
});

describe('L111Q-U03 métriques séparées et catégories d’état', () => {
  it('jamais démarré : temps en file = total ; exécution nulle', () => {
    const m = diagMetrics({ status: 'QUEUED', startedAt: ago(381), now: NOW });
    expect(m).toMatchObject({ started: false, queueWaitMs: 381_000, executionMs: null, totalElapsedMs: 381_000 });
  });
  it('démarré puis terminé : attente, exécution (somme des tentatives), total distincts', () => {
    const m = diagMetrics({
      status: 'COMPLETE', startedAt: ago(1000), firstRunStartedAt: ago(990), runStartedAt: ago(500), finishedAt: ago(100),
      attemptsLog: [{ startedAt: ago(990), endedAt: ago(900) }, { startedAt: ago(500), endedAt: ago(100) }], now: NOW,
    });
    expect(m).toMatchObject({ started: true, queueWaitMs: 10_000, executionMs: 490_000, totalElapsedMs: 900_000, firstStartAt: ago(990) });
    // Repli sans colonne 1280 : première tentative journalisée.
    expect(diagMetrics({ status: 'RUNNING', startedAt: ago(100), attemptsLog: [{ startedAt: ago(40), endedAt: null }], now: NOW })).toMatchObject({ queueWaitMs: 60_000, executionMs: 40_000 });
    expect(formatDuration(252_000)).toBe('4 min 12 s');
    expect(formatDuration(null)).toBe('—');
  });
  it('libellés du ticket', () => {
    expect(DIAG_STATE_CATEGORY_LABELS).toMatchObject({ ATTENTE_RESSOURCE: 'Attente de ressource', WORKER_INDISPONIBLE: 'Worker indisponible', GENERATION_EN_COURS: 'Génération en cours', ECHEC: 'Échec', TERMINE: 'Terminé', ANNULE: 'Annulé' });
    expect(stateCategory('QUEUED', 'WORKER_DISABLED')).toBe('WORKER_INDISPONIBLE');
    expect(stateCategory('QUEUED', 'NO_WORKER_CONTAINER')).toBe('WORKER_INDISPONIBLE');
    expect(stateCategory('QUEUED', 'UNEXPLAINED_WAIT')).toBe('WORKER_INDISPONIBLE');
    expect(stateCategory('QUEUED', 'MEMORY_ADMISSION')).toBe('ATTENTE_RESSOURCE');
    expect(stateCategory('QUEUED', 'OTHER_DIAGNOSTIC_RUNNING')).toBe('ATTENTE_RESSOURCE');
    expect(stateCategory('QUEUED', 'PICKUP_PENDING')).toBe('EN_FILE');
    expect(stateCategory('QUEUED', null, true)).toBe('ANNULE');
    expect(stateCategory('RUNNING', null)).toBe('GENERATION_EN_COURS');
    expect(stateCategory('PARTIAL', null)).toBe('TERMINE');
    expect(stateCategory('FAILED', null)).toBe('ECHEC');
    expect(stateCategory('CANCELLED', null)).toBe('ANNULE');
  });
  it('profilage : durée de chaque étape, fichiers les plus lents bornés, métriques finales', () => {
    let t = 0;
    const p = createPhaseProfiler({ attempt: 1, lane: 'targeted', now: () => t });
    t = 50; p.enter('INSTANTANE');
    t = 80; p.enter('INVENTAIRE');
    t = 380; expect(p.enter('EXTRACTION')).toEqual({ left: 'INVENTAIRE', ms: 300 });
    for (let i = 0; i < 30; i++) p.file(`donnees/t${i}.json`, i, 10);
    t = 1000; p.enter('VALIDATION');
    t = 1100;
    const snap = p.snapshot({ queueWaitMs: 1, executionMs: 2, totalElapsedMs: 3, zipFiles: 30, bytes: 300, compressedBytes: 100, status: 'COMPLETE' });
    expect(snap.phases).toEqual({ NETTOYAGE: 50, INSTANTANE: 30, INVENTAIRE: 300, EXTRACTION: 620, VALIDATION: 100 });
    expect(snap.slowestFiles).toHaveLength(12);
    expect(snap.slowestFiles[0]).toMatchObject({ path: 'donnees/t29.json', ms: 29 });
    expect(snap).toMatchObject({ files: 30, lane: 'targeted', current: null, final: { status: 'COMPLETE' } });
    p.counter('writes', 12);
    expect(p.snapshot().counters).toEqual({ writes: 12 });
  });
});

describe('L111Q-U04 lecture BO sous session (anomalie « Unauthorized (MISSING_TOKEN) »)', () => {
  const e = (status: number, code: string, requestId?: string) => Object.assign(new Error('x'), { status, code, requestId });
  it('session expirée : message français, reconnexion, suivi arrêté ; jamais le code brut dans le message', () => {
    const f = describeReadFailure(e(401, 'UNAUTHORIZED', 'req-12345678'));
    expect(f).toMatchObject({ kind: 'SESSION_EXPIRED', code: 'UNAUTHORIZED', requestId: 'req-12345678' });
    expect(f.message).toMatch(/session a expiré/);
    expect(f.message).not.toMatch(/MISSING_TOKEN|Unauthorized/);
    expect(stopsPolling(f)).toBe(true);
    expect(describeReadFailure(e(401, 'MISSING_TOKEN')).message).not.toContain('MISSING_TOKEN');
  });
  it('MFA exigée, droits refusés, introuvable : actions distinctes ; réseau / serveur : nouvel essai automatique', () => {
    expect(describeReadFailure(e(403, 'MFA_REQUIRED')).kind).toBe('MFA_REQUIRED');
    expect(describeReadFailure(e(403, 'INSUFFICIENT_PERMISSIONS'))).toMatchObject({ kind: 'FORBIDDEN' });
    expect(describeReadFailure(e(404, 'NOT_FOUND')).kind).toBe('NOT_FOUND');
    const net = describeReadFailure(e(0, 'NETWORK_ERROR'));
    expect(net.kind).toBe('NETWORK');
    expect(stopsPolling(net)).toBe(false);
    expect(stopsPolling(describeReadFailure(e(503, 'SERVICE_UNAVAILABLE')))).toBe(false);
  });
  it('âge de la dernière lecture réussie (jamais un état périmé présenté comme frais) ; retour à la page après reconnexion', () => {
    const t = NOW.getTime();
    expect(freshnessLabel(null, t)).toBe('aucune lecture réussie');
    expect(freshnessLabel(t - 2_000, t)).toBe('à l’instant');
    expect(freshnessLabel(t - 125_000, t)).toBe('il y a 2 min 05 s');
    expect(freshnessLabel(t - 16 * 60_000, t)).toBe('il y a 16 min 00 s');
    expect(reconnectHref('f191d635-b4f1-4040-9dba-d04852da161a')).toBe(`/login?reason=session_expired&returnUrl=${encodeURIComponent('/admin/diagnostics?job=f191d635-b4f1-4040-9dba-d04852da161a')}`);
  });
  it('page Diagnostics : plus aucun fetch nu (toutes les lectures par apiClient, avec renouvellement)', () => {
    const page = read('src/app/admin/diagnostics/page.tsx');
    expect(page).not.toMatch(/\bawait fetch\(/);
    expect(page).toMatch(/boGet<JobView>\(`\/api\/admin\/diagnostics\/jobs\/\$\{id\}`\)/);
    expect(page).toMatch(/ensureFreshSession\(\)/);
    const lib = read('src/app/admin/diagnostics/_lib/bo-read.ts');
    expect(lib).toMatch(/onAuthFailure: 'silent'/);
    // Garde serveur inchangée : détail toujours réservé aux administrateurs.
    expect(read('src/app/api/admin/diagnostics/jobs/[id]/route.ts')).toMatch(/guardAdmin\(\(\) => requireAdmin\(request\)\)/);
  });
});

describe('L111Q-U06 suivi au-delà de 15 min : jeton d’accès expiré → renouvellement puis rejeu', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  it('401 MISSING_TOKEN (cookie access_token expiré) : /api/auth/refresh puis même lecture rejouée, sans erreur affichée', async () => {
    const calls: string[] = [];
    let refreshed = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/auth/refresh') { refreshed = true; return json(200, { ok: true }); }
      return refreshed ? json(200, { job: { id: 'j1', status: 'QUEUED' } }) : json(401, { error: 'Unauthorized', code: 'MISSING_TOKEN', message: 'Authentication required' });
    }));
    const r = await boGet<{ job: { id: string } }>('/api/admin/diagnostics/jobs/j1');
    expect(r).toEqual({ ok: true, data: { job: { id: 'j1', status: 'QUEUED' } } });
    expect(calls).toEqual(['/api/admin/diagnostics/jobs/j1', '/api/auth/refresh', '/api/admin/diagnostics/jobs/j1']);
  });
  it('renouvellement refusé (session réellement terminée) : SESSION_EXPIRED, aucune redirection imposée', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/auth/refresh' ? json(401, { code: 'REFRESH_INVALID' }) : json(401, { error: 'Unauthorized', code: 'MISSING_TOKEN' }))));
    const r = await boGet('/api/admin/diagnostics/jobs/j2');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('SESSION_EXPIRED');
      expect(r.failure.message).not.toMatch(/MISSING_TOKEN/);
    }
  });
});

describe('L111Q-U05 contrôles statiques', () => {
  it('migration 1280 additive, idempotente', () => {
    const m = read('src/db/migrations/1280_l111q_diagnostic_cible_file.sql').split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect(m).not.toMatch(/DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN/i);
    for (const l of m.split(';').map((x) => x.trim()).filter((x) => /^ALTER TABLE .* ADD COLUMN/.test(x))) expect(l).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(m).toMatch(/first_run_started_at/);
    expect(m).toMatch(/lane_job_id/);
  });
  it('prise : ciblés d’abord, premier démarrage conservé, remplacement 111C limité aux globaux', () => {
    const repo = read('src/services/admin/diagnostic-jobs/repository.ts');
    expect(repo).toMatch(/ORDER BY \(\$\{tx\.unsafe\(IS_GLOBAL_SQL\('t'\)\)\}\) ASC, t\.started_at, t\.id/);
    expect(repo).toMatch(/first_run_started_at = coalesce\(first_run_started_at, now\(\)\)/);
    expect(repo).toMatch(/if \(global\) \{\n\s+const label = `\$\{DIAG_JOB_ERROR_LABELS\.REPLACED_BY_NEW_REQUEST\}/);
  });
  it('traitements redondants supprimés sans rien retirer : mesure mémoire bornée, appartenance en O(1) dans la fermeture', () => {
    const runner = read('src/services/admin/diagnostic-jobs/runner.ts');
    expect(runner).toMatch(/export const MEMORY_SAMPLE_MS = 200;/);
    expect(runner).toMatch(/const r = stopReason\(true\);/);
    const engine = read('src/services/admin/diagnostics-export/engine.ts');
    expect(engine).not.toMatch(/out\.(fermeture|absentes)\.includes\(/);
    expect(engine).toMatch(/seen\.fermeture\.has\(v\)/);
    // Aucune borne nouvelle sur le contenu : limites du ZIP inchangées.
    expect(read('src/services/admin/diagnostics-export/model.ts')).toMatch(/modelOutputTraces: 10,/);
  });
  it('journaux corrélables : travail, demande, périmètre, worker, version, étape, cause', () => {
    const runner = read('src/services/admin/diagnostic-jobs/runner.ts');
    expect(runner).toMatch(/jobId: job\.id, requestId: job\.requestId, scope: job\.request\.scope, targetId: job\.request\.id/);
    expect(runner).toMatch(/commit: build\.commit, version: build\.version/);
    expect(runner).toMatch(/cause: code, phase, step/);
  });
});
