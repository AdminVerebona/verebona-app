/**
 * Lot 111C — diagnostic global bloqué en file : règles PURES (variables de
 * désactivation, raisons d'attente, alertes, statuts BO explicites) et
 * contrôles statiques (remplacement atomique, publication tardive interdite,
 * interruption SQL, superviseur indépendant démarré tôt, migration additive,
 * table couverte par le diagnostic global).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAG_JOB_ERROR_LABELS, diagJobSettings, isGlobalRequest, isTransientError, workerDisabledReason, workerMode } from '../state';
import { DIAG_WAIT_ACTIONS, DIAG_WAIT_REASONS, diagnoseWait, displayStatus, isBeatAlive, waitLabel, type DiagWorkerBeat, type WaitInput } from '../wait';
import { DIAG_TABLE_COVERAGE } from '@/services/admin/diagnostics-export/coverage';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const NOW = new Date('2026-11-04T22:30:00Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function beat(p: Partial<DiagWorkerBeat> = {}): DiagWorkerBeat {
  return {
    instanceId: 'web-1:42:abcd1234', processType: 'web', placement: 'web', state: 'STARTED', disabledReason: null, buildCommit: 'c0ffee', startedAt: ago(3600), seenAt: ago(10),
    lastTickAt: ago(5), lastTickOkAt: ago(5), tickRunningSince: null, lastClaimAt: null, currentJobId: null, waitReason: 'NO_ELIGIBLE_JOB', lastError: null, lastErrorAt: null, intervalMs: 10_000, ...p,
  };
}
function input(p: Partial<WaitInput> = {}, job: Partial<WaitInput['job']> = {}): WaitInput {
  return {
    job: { id: 'c229c2fd-3c08-4d12-842e-800652b778f8', scope: 'global', startedAt: ago(7343), nextAttemptAt: null, ...job },
    beats: [beat()], running: [], globalConcurrency: 1, stallAlertSeconds: 300, now: NOW, ...p,
  };
}

describe('L111C-U01 variables de désactivation et réglages', () => {
  it('DIAG_JOB_WORKER_DISABLED : true/1/yes/on désactivé, auto = démarrage protégé par la mémoire, sinon actif', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) expect(workerMode({ DIAG_JOB_WORKER_DISABLED: v }), v).toBe('disabled');
    expect(workerMode({ DIAG_JOB_WORKER_DISABLED: 'auto' })).toBe('auto');
    for (const v of [undefined, '', 'false', '0', 'non']) expect(workerMode({ DIAG_JOB_WORKER_DISABLED: v }), String(v)).toBe('enabled');
    expect(diagJobSettings({ DIAG_JOB_WORKER_DISABLED: 'auto' })).toMatchObject({ disabled: false, memoryGate: 'strict' });
    expect(diagJobSettings({})).toMatchObject({ disabled: false, memoryGate: 'standard', stallAlertSeconds: 300, cancelPollMs: 3000 });
    expect(diagJobSettings({ DIAG_JOB_STALL_ALERT_SECONDS: '10' }).stallAlertSeconds).toBe(300);
  });
  it('variable en cause NOMMÉE (aucune valeur secrète) ; EXPORTS_WORKER_DISABLED retire aussi le worker des diagnostics', () => {
    expect(workerDisabledReason({ DIAG_JOB_WORKER_DISABLED: 'true' })).toBe('DIAG_JOB_WORKER_DISABLED');
    expect(workerDisabledReason({ EXPORTS_WORKER_DISABLED: 'true' })).toBe('EXPORTS_WORKER_DISABLED');
    expect(workerDisabledReason({ DIAG_JOB_WORKER_DISABLED: 'auto' })).toBeNull();
    expect(workerDisabledReason({})).toBeNull();
  });
  it('périmètre global seul concerné par le remplacement ; motif stable non rejoué', () => {
    expect(isGlobalRequest({ scope: 'global' })).toBe(true);
    for (const s of ['account', 'user', 'asset', 'document', 'operation']) expect(isGlobalRequest({ scope: s })).toBe(false);
    expect(DIAG_JOB_ERROR_LABELS.REPLACED_BY_NEW_REQUEST).toMatch(/remplacée/);
    expect(isTransientError('REPLACED_BY_NEW_REQUEST')).toBe(false);
  });
});

describe('L111C-U02 raison d’attente (chaque chemin où le worker ne prend rien)', () => {
  it('worker désactivé (variable nommée) : affiché ET signalé dès la demande', () => {
    const d = diagnoseWait(input({ beats: [beat({ state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED' })] }, { startedAt: ago(2) }));
    expect(d).toMatchObject({ reason: 'WORKER_DISABLED', detail: 'DIAG_JOB_WORKER_DISABLED', alert: true });
    expect(waitLabel(d)).toBe('En attente — worker désactivé (DIAG_JOB_WORKER_DISABLED)');
    expect(waitLabel(diagnoseWait(input({ beats: [beat({ state: 'DISABLED', disabledReason: 'EXPORTS_WORKER_DISABLED' })] })))).toBe('En attente — worker désactivé (EXPORTS_WORKER_DISABLED)');
  });
  it('BACKGROUND_JOBS_PROCESS=worker sans conteneur worker → NO_WORKER_CONTAINER, signalé dès la demande', () => {
    const d = diagnoseWait(input({ beats: [beat({ state: 'NOT_THIS_PROCESS', placement: 'worker' })] }, { startedAt: ago(1) }));
    expect(d).toMatchObject({ reason: 'NO_WORKER_CONTAINER', alert: true });
    expect(waitLabel(d)).toMatch(/^En attente — worker indisponible/);
  });
  it('aucun battement vivant (processus arrêté, démarrage interrompu, table absente) → worker indisponible, alerte après 5 min', () => {
    expect(diagnoseWait(input({ beats: [] }, { startedAt: ago(60) }))).toMatchObject({ reason: 'WORKER_UNAVAILABLE', alert: false, detail: 'aucun worker n’a jamais battu' });
    const old = diagnoseWait(input({ beats: [beat({ seenAt: ago(3600) })] }));
    expect(old).toMatchObject({ reason: 'WORKER_UNAVAILABLE', alert: true });
    expect(old.detail).toMatch(/dernier signe de vie/);
    expect(diagnoseWait(input({ beats: null }))).toMatchObject({ reason: 'WORKER_UNAVAILABLE' });
    expect(waitLabel(old)).toBe('En attente — worker indisponible');
    expect(isBeatAlive(beat({ seenAt: ago(80) }), NOW)).toBe(true);
    expect(isBeatAlive(beat({ seenAt: ago(100) }), NOW)).toBe(false);
    expect(isBeatAlive(beat({ state: 'STOPPED' }), NOW)).toBe(false);
  });
  it('un worker désactivé sur une instance ne masque pas un worker actif ailleurs', () => {
    const d = diagnoseWait(input({ beats: [beat({ instanceId: 'web-1:1:a', state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED' }), beat({ instanceId: 'worker-1:2:b', processType: 'worker' })] }, { startedAt: ago(20) }));
    expect(d.reason).toBe('PICKUP_PENDING');
  });
  it('boucle en échec, tour bloqué, démarrage', () => {
    expect(diagnoseWait(input({ beats: [beat({ lastError: 'relation absente', lastErrorAt: ago(5), lastTickOkAt: ago(900) })] }))).toMatchObject({ reason: 'WORKER_LOOP_FAILING', detail: 'relation absente', alert: true });
    expect(diagnoseWait(input({ beats: [beat({ lastTickAt: ago(1800), tickRunningSince: ago(1800) })] }))).toMatchObject({ reason: 'WORKER_STUCK', alert: true });
    expect(diagnoseWait(input({ beats: [beat({ lastTickAt: null, lastTickOkAt: null, startedAt: ago(10) })] }, { startedAt: ago(5) }))).toMatchObject({ reason: 'WORKER_STARTING', alert: false });
  });
  it('créneau global : autre diagnostic en cours ; ancien global en cours d’arrêt après remplacement', () => {
    const other = diagnoseWait(input({ running: [{ id: 'aaaaaaaa-0000-0000-0000-000000000000', scope: 'account', leaseAlive: true, cancelRequested: false, cancelReason: null }] }));
    expect(other).toMatchObject({ reason: 'OTHER_DIAGNOSTIC_RUNNING', blockingJobId: 'aaaaaaaa-0000-0000-0000-000000000000', alert: true });
    expect(waitLabel(other)).toBe('En attente — autre diagnostic en cours (aaaaaaaa)');
    const stop = diagnoseWait(input({ running: [{ id: 'bbbbbbbb-0000-0000-0000-000000000000', scope: 'global', leaseAlive: true, cancelRequested: true, cancelReason: 'REPLACED_BY_NEW_REQUEST' }] }, { startedAt: ago(5) }));
    expect(stop).toMatchObject({ reason: 'STOPPING_REPLACED', alert: false });
    // Un global ne démarre jamais à côté d'un autre global, même avec une concurrence de 2.
    expect(diagnoseWait(input({ globalConcurrency: 2, running: [{ id: 'cccccccc-0000-0000-0000-000000000000', scope: 'global', leaseAlive: true, cancelRequested: false, cancelReason: null }] })).reason).toBe('OTHER_DIAGNOSTIC_RUNNING');
    // Bail expiré : ne bloque plus (rattrapage au prochain tour).
    expect(diagnoseWait(input({ running: [{ id: 'dddddddd-0000-0000-0000-000000000000', scope: 'global', leaseAlive: false, cancelRequested: false, cancelReason: null }] }, { startedAt: ago(5) })).reason).toBe('PICKUP_PENDING');
  });
  it('admission mémoire, nouvelle tentative programmée, attente inexpliquée', () => {
    expect(diagnoseWait(input({ beats: [beat({ waitReason: 'MEMORY_ADMISSION' })] }))).toMatchObject({ reason: 'MEMORY_ADMISSION', alert: true });
    expect(diagnoseWait(input({}, { nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString() }))).toMatchObject({ reason: 'RETRY_SCHEDULED', alert: false });
    expect(diagnoseWait(input())).toMatchObject({ reason: 'UNEXPLAINED_WAIT', alert: true, waitedSeconds: 7343 });
    expect(diagnoseWait(input({}, { startedAt: ago(30) }))).toMatchObject({ reason: 'PICKUP_PENDING', alert: false });
  });
  it('chaque raison a un libellé « En attente — … » et une action PO', () => {
    for (const r of DIAG_WAIT_REASONS) {
      expect(waitLabel({ reason: r, detail: null, blockingJobId: null }), r).toMatch(/^En attente — /);
      expect(DIAG_WAIT_ACTIONS[r].length, r).toBeGreaterThan(20);
    }
  });
});

describe('L111C-U03 statuts BO explicites', () => {
  const base = { cancelRequested: false, cancelReason: null, replacedBy: null, errorCode: null };
  it('« Annulation demandée », « Annulé — remplacé par … », « En attente — … »', () => {
    const by = '9f1e2d3c-0000-4000-8000-000000000000';
    expect(displayStatus({ ...base, status: 'RUNNING', cancelRequested: true, cancelReason: 'ADMIN_CANCELLED' }, null)).toBe('Annulation demandée');
    expect(displayStatus({ ...base, status: 'RUNNING', cancelRequested: true, cancelReason: 'REPLACED_BY_NEW_REQUEST', replacedBy: by }, null)).toBe('Annulation demandée — remplacé par la demande 9f1e2d3c');
    expect(displayStatus({ ...base, status: 'CANCELLED', cancelRequested: true, cancelReason: 'REPLACED_BY_NEW_REQUEST', replacedBy: by, errorCode: 'REPLACED_BY_NEW_REQUEST' }, null)).toBe('Annulé — remplacé par la demande 9f1e2d3c');
    expect(displayStatus({ ...base, status: 'CANCELLED', errorCode: 'CANCELLED' }, null)).toBe('Annulé');
    expect(displayStatus({ ...base, status: 'QUEUED' }, { reason: 'WORKER_DISABLED', detail: 'DIAG_JOB_WORKER_DISABLED', blockingJobId: null })).toBe('En attente — worker désactivé (DIAG_JOB_WORKER_DISABLED)');
    expect(displayStatus({ ...base, status: 'QUEUED' }, { reason: 'OTHER_DIAGNOSTIC_RUNNING', detail: null, blockingJobId: by })).toBe('En attente — autre diagnostic en cours (9f1e2d3c)');
    expect(displayStatus({ ...base, status: 'QUEUED' }, null)).toBe('En attente');
    expect(displayStatus({ ...base, status: 'RUNNING', leaseExpired: true }, null)).toMatch(/sans signe de vie/);
  });
});

describe('L111C-U04 contrôles statiques', () => {
  const repo = read('src/services/admin/diagnostic-jobs/repository.ts');
  const runner = read('src/services/admin/diagnostic-jobs/runner.ts');
  it('remplacement dans la transaction verrouillée de la mise en file ; ciblés non touchés ; rejeu par clé avant tout', () => {
    const enq = repo.slice(repo.indexOf('export async function enqueueDiagnosticJob'), repo.indexOf('export async function retryDiagnosticJob'));
    expect(enq.indexOf('pg_advisory_xact_lock')).toBeGreaterThan(0);
    expect(enq.indexOf('idempotency_key = ${input.idempotencyKey}')).toBeLessThan(enq.indexOf("cancel_reason = 'REPLACED_BY_NEW_REQUEST'"));
    expect(enq).toMatch(/if \(global\) \{/);
    expect(enq).toMatch(/status = 'QUEUED' AND id <> \$\{id\}::uuid AND coalesce\(perimeter->>'scope', target_type, 'global'\) = 'global'/);
  });
  it('publication : vérification atomique propriété + statut + absence d’annulation', () => {
    const pub = repo.slice(repo.indexOf('export async function publishDiagnosticJob'), repo.indexOf('export async function failDiagnosticAttempt'));
    expect(pub).toMatch(/WHERE id = \$\{job\.id\}::uuid AND locked_by = \$\{workerId\} AND status = 'RUNNING' AND NOT cancel_requested/);
  });
  it('arrêt coopératif : lecture de l’annulation hors bail, interruption SQL, envois OVH incomplets abandonnés', () => {
    expect(runner).toMatch(/readDiagnosticControl\(job\.id, ctx\.workerId\)/);
    expect(runner).toMatch(/pg_cancel_backend/);
    expect(runner).toMatch(/ListMultipartUploadsCommand/);
    expect(repo).toMatch(/if \(r\.cancel_requested === true\) \{/);
  });
  it('superviseur démarré tôt dans chaque processus web, indépendant du worker ; processus sans worker le déclare', () => {
    const inst = read('src/instrumentation-node.ts');
    expect(inst.indexOf('startDiagnosticSupervisor()')).toBeGreaterThan(0);
    expect(inst.indexOf('startDiagnosticSupervisor()')).toBeLessThan(inst.indexOf('// 0. Secrets de signature'));
    expect(inst).toMatch(/else markDiagnosticWorkerNotHere\(\);/);
    expect(read('src/services/admin/diagnostic-jobs/supervision.ts')).not.toMatch(/from '\.\/worker'/);
  });
  it('migration 1200 : additive, idempotente ; table couverte par le diagnostic global et jamais restaurée', () => {
    const m = read('src/db/migrations/1200_l111c_diagnostic_file_supervision.sql').split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect(m).not.toMatch(/DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN/i);
    for (const l of m.split(';').map((x) => x.trim()).filter((x) => /^ALTER TABLE .* ADD COLUMN/.test(x))) expect(l).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS diagnostic_worker_heartbeats/);
    expect(DIAG_TABLE_COVERAGE.diagnostic_worker_heartbeats).toMatchObject({ section: 'technique', global: true });
    expect(read('src/services/backup/schema-signature.ts')).toContain("'diagnostic_worker_heartbeats'");
  });
});
