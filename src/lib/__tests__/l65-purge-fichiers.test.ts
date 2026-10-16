/**
 * Lot 65A — purge des fichiers supprimés branchée sur une tâche planifiée
 * interne ; suspension BO et compte rendu des tâches (unitaires, S3 simulé).
 *
 * L65-PURGE-01  Tâche `deleted-files-purge` au catalogue : quotidienne (6 h 25,
 *               hors fenêtre de sauvegarde), non critique, délai borné ; appelle
 *               la purge avec l'échéance ; documentée dans l'en-tête.
 * L65-PURGE-02  Mode sûr : stockage non configuré → rien n'est supprimé (pas
 *               même une ligne) ; objet absent (404 / NoSuchKey) = acquis ; toute
 *               autre erreur ne l'est pas.
 * L65-PURGE-03  Compte rendu : court, sans clé de stockage ni donnée personnelle.
 * L65-PURGE-04  Code : relecture verrouillée (SKIP LOCKED), ligne supprimée AVANT
 *               l'objet, garde-fou « clé encore référencée », lots bornés,
 *               plus de purge de l'historique de l'assistant (tâche
 *               `assistant-purge` existante) ni de route admin.
 * L65-PURGE-05  Moteur : une tâche suspendue depuis le BO n'est ni prise ni
 *               exécutable à la main ; une tâche critique ne se suspend pas ;
 *               le compte rendu est consigné ; vue BO (champs 65A).
 * L65-PURGE-06  File `pending_blob_deletions` : objet encore référencé → demande
 *               close sans suppression (garde-fou commun, purge de compte).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/s3-config', () => ({
  isS3Configured: () => false,
  getS3Bucket: () => { throw new Error('non configuré'); },
  getS3Client: () => { throw new Error('non configuré'); },
}));
const dbCalls: string[] = [];
vi.mock('@/db', () => ({
  db: new Proxy({}, { get: (_t, p) => { dbCalls.push(String(p)); throw new Error(`accès base inattendu : ${String(p)}`); } }),
  pgClient: { unsafe: async () => [] },
}));

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('L65-PURGE-01 — tâche planifiée interne', () => {
  it('quotidienne, non critique, bornée, documentée', async () => {
    const { SCHEDULED_TASKS, isTaskEnabled, taskEnvVar } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = SCHEDULED_TASKS.find((x) => x.code === 'deleted-files-purge');
    expect(t).toBeTruthy();
    expect(t!.schedule).toEqual({ kind: 'daily', at: [6, 25], graceMs: 6 * 60 * 60 * 1000 });
    expect(t!.critical).toBeUndefined();
    expect(t!.timeoutMs).toBe(20 * 60 * 1000);
    expect(taskEnvVar('deleted-files-purge')).toBe('SCHEDULED_TASK_DELETED_FILES_PURGE');
    expect(isTaskEnabled('deleted-files-purge', { SCHEDULED_TASK_DELETED_FILES_PURGE: 'off' })).toBe(false);
    const cat = read('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(cat).toMatch(/deleted-files-purge {13}chaque jour à 6 h 25/);
    expect(cat).toMatch(/runCleanupJob\(\{ deadline: Math\.min\(deadline, Date\.now\(\) \+ 18 \* MIN\) \}\)/);
  });
});

describe('L65-PURGE-02 — mode sûr', () => {
  it('stockage non configuré : aucune lecture ni suppression', async () => {
    const { runCleanupJob } = await import('../cleanup-job');
    const r = await runCleanupJob();
    expect(r).toMatchObject({ success: false, storageUnavailable: true, filesDeletedFromDB: 0, filesDeletedFromS3: 0 });
    expect(dbCalls).toEqual([]);
  });

  it('objet déjà absent = acquis ; panne ≠ acquis', async () => {
    const { isAlreadyGone } = await import('../cleanup-job');
    expect(isAlreadyGone({ name: 'NoSuchKey' })).toBe(true);
    expect(isAlreadyGone({ Code: 'NoSuchKey' })).toBe(true);
    expect(isAlreadyGone({ name: 'NotFound' })).toBe(true);
    expect(isAlreadyGone({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isAlreadyGone({ $metadata: { httpStatusCode: 503 } })).toBe(false);
    expect(isAlreadyGone({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isAlreadyGone(new Error('timeout'))).toBe(false);
  });
});

describe('L65-PURGE-03 — compte rendu', () => {
  it('court, chiffré, sans clé', async () => {
    const { cleanupNote } = await import('../cleanup-job');
    const base = {
      success: false, filesProcessed: 5, filesDeletedFromS3: 3, filesDeletedFromDB: 4, filesRetained: 1, objectsKeptShared: 1,
      filesSkipped: 0, more: false, errors: ['Fichier 9 : ServiceUnavailable'], startedAt: '', completedAt: '', duration: 1,
    };
    const n = cleanupNote(base, { eligibleForCleanup: 1, overduePurges: 1 });
    expect(n).toBe('4 fichier(s) purgé(s) ; 3 objet(s) supprimé(s) du stockage ; 1 objet(s) conservé(s) car encore utilisé(s) ailleurs ; '
      + '1 en échec S3 (conservé(s), nouvelle tentative au prochain passage) ; reste éligible : 1, en échec répété : 1');
    expect(cleanupNote({ ...base, storageUnavailable: true })).toMatch(/non configuré/);
  });
});

describe('L65-PURGE-04 — garanties visibles dans le code', () => {
  const src = read('src/lib/cleanup-job.ts');
  it('verrou par fichier, ligne avant objet, garde-fou de référence, lots bornés', () => {
    expect(src).toContain(".for('update', { skipLocked: true })");
    const del = src.indexOf('await tx.delete(assetFiles).where(eq(assetFiles.id, id));');
    const ref = src.indexOf('if (await isStorageKeyReferenced(tx, key))');
    const s3 = src.indexOf('await deleteObject(target, key);');
    expect(del).toBeGreaterThan(0);
    expect(ref).toBeGreaterThan(del);
    expect(s3).toBeGreaterThan(ref);
    expect(src).toMatch(/EXISTS \(SELECT 1 FROM asset_files WHERE s3_key = /);
    expect(src).toMatch(/EXISTS \(SELECT 1 FROM document_versions WHERE s3_key = /);
    expect(src).toMatch(/FROM assets WHERE thumbnail_url = /);
    expect(src).toMatch(/export const PURGE_BATCH_SIZE = 100;/);
    expect(src).toMatch(/export const PURGE_MAX_BATCHES = 20;/);
    expect(src).toMatch(/export const SOFT_DELETE_RETENTION_DAYS = 30;/);
    // Retenté au passage suivant seulement.
    expect(src).toMatch(/or\(isNull\(assetFiles\.purgeLastAttemptAt\), lt\(assetFiles\.purgeLastAttemptAt, startedAt\)\)/);
  });
  it('plus de purge assistant (doublon de `assistant-purge`) ; la purge de compte confie aussi versions, exports, vignettes', () => {
    expect(src).not.toContain('purgeExpired(');
    const del = read('src/services/account/scheduled-deletion.service.ts');
    expect(del).toMatch(/FROM document_versions v JOIN asset_files f ON f\.id = v\.file_id/);
    expect(del).toMatch(/SELECT output_payload FROM export_generation WHERE account_id IN/);
    expect(del).toMatch(/SELECT thumbnail_url FROM assets WHERE account_id IN/);
  });
});

describe('L65-PURGE-05 — moteur : suspension BO, compte rendu, vue', () => {
  type Row = import('@/services/scheduling/scheduled-task-state').TaskStateRow;
  function store() {
    const rows = new Map<string, Row>();
    const notes: Array<[string, string | null]> = [];
    const s: import('@/services/scheduling/scheduled-task-state').TaskStateStore = {
      async ensure(regs) {
        for (const g of regs) if (!rows.has(g.code)) rows.set(g.code, {
          code: g.code, scheduleSignature: g.signature, nextRunAt: g.firstRunAt, runningRunId: null, runningBy: null, runningUntil: null,
          lastTrigger: null, lastStartedAt: null, lastFinishedAt: null, lastDurationMs: null, lastStatus: null, lastError: null,
          lastInstance: null, lastSuccessAt: null, consecutiveFailures: 0, createdAt: new Date(), running: false, adminDisabled: false,
        });
      },
      async due() { return [...rows.values()].filter((r) => !r.adminDisabled && r.nextRunAt).map((r) => ({ code: r.code, nextRunAt: r.nextRunAt! })); },
      async claim(code, runId) {
        const r = rows.get(code);
        if (!r || r.adminDisabled || r.runningRunId) return false;
        r.runningRunId = runId;
        return true;
      },
      async reschedule() { return true; },
      async finish(code, runId, rec) {
        const r = rows.get(code)!;
        if (r.runningRunId !== runId) return null;
        Object.assign(r, { lastStatus: rec.status, lastError: rec.error, runningRunId: null });
        return { consecutiveFailures: 0 };
      },
      async release() { /* rien */ },
      async renew() { return true; },
      async list() { return [...rows.values()]; },
      async recordNote(code, runId, note) {
        if (rows.get(code)?.runningRunId === runId) { rows.get(code)!.lastNote = note; notes.push([code, note]); }
      },
      async setAdminDisabled(code, disabled) {
        const r = rows.get(code);
        if (!r) return false;
        r.adminDisabled = disabled;
        r.adminDisabledAt = disabled ? new Date() : null;
        return true;
      },
    };
    return { s, rows, notes };
  }

  it('suspendue : ni prise par le tour, ni exécutable à la main ; réactivée : exécutée, compte rendu consigné', async () => {
    const { tick, drainInFlight, runTaskNow, setTaskAdminDisabled, listScheduledTasks, registerTasks } = await import('@/services/scheduling/scheduled-task-runner');
    const { s, rows, notes } = store();
    const run = vi.fn(async () => ({ note: '2 fichier(s) purgé(s)' }));
    const tasks = [
      { code: 'purge', label: 'Purge', schedule: { kind: 'interval' as const, everyMs: 60_000 }, timeoutMs: 5_000, startupDelayMs: 0, run },
      { code: 'critique', label: 'Critique', schedule: { kind: 'interval' as const, everyMs: 60_000 }, timeoutMs: 5_000, critical: { staleAfterMs: 1e9 }, run },
    ];
    const deps = {
      store: s, tasks, env: {}, owner: 'test', now: () => new Date(),
      alerts: { report: vi.fn(async () => undefined), resolve: vi.fn(async () => undefined), isOpen: vi.fn(async () => false) },
      watchdogLock: async () => null,
    };
    await registerTasks(deps, { boot: false });
    for (const r of rows.values()) r.nextRunAt = new Date(Date.now() - 1000);

    expect(await setTaskAdminDisabled('purge', true, 7, deps)).toEqual({ status: 'ok', changed: true, adminDisabled: true });
    expect(await setTaskAdminDisabled('purge', true, 7, deps)).toEqual({ status: 'ok', changed: false, adminDisabled: true });
    expect(await setTaskAdminDisabled('critique', true, 7, deps)).toEqual({ status: 'critical' });
    expect(await setTaskAdminDisabled('inconnue', true, 7, deps)).toEqual({ status: 'not_found' });

    const lances = await tick(deps);
    await drainInFlight();
    expect(lances).not.toContain('purge');
    expect(await runTaskNow('purge', { waitMs: 1_000 }, deps)).toEqual({ status: 'admin_disabled' });
    const vue = (await listScheduledTasks(deps)).find((t) => t.code === 'purge')!;
    expect(vue).toMatchObject({ enabled: false, envDisabled: false, adminDisabled: true, adminToggle: true });
    expect((await listScheduledTasks(deps)).find((t) => t.code === 'critique')).toMatchObject({ adminToggle: false });

    await setTaskAdminDisabled('purge', false, 7, deps);
    const r = await runTaskNow('purge', { waitMs: 1_000 }, deps);
    expect(r).toMatchObject({ status: 'finished', outcome: { status: 'ok', note: '2 fichier(s) purgé(s)' } });
    // Seule la tâche active (`critique`) a tourné au tour ; `purge` une fois, à la main.
    expect(notes.filter(([c]) => c === 'purge')).toEqual([['purge', '2 fichier(s) purgé(s)']]);
    expect((await listScheduledTasks(deps)).find((t) => t.code === 'purge')).toMatchObject({ enabled: true, lastNote: '2 fichier(s) purgé(s)' });
  });

  it('PostgreSQL : suspension lue sans dépendre de la colonne 0463 ; prise refusée', () => {
    const st = read('src/services/scheduling/scheduled-task-state.ts');
    expect(st).toContain("COALESCE((to_jsonb(scheduled_task_state) ->> 'admin_disabled')::boolean, false) = false");
    expect(st.match(/\$\{NOT_ADMIN_DISABLED\}/g)).toHaveLength(2); // due() + claim()
    const mig = read('src/db/migrations/0463_deleted_files_purge.sql');
    for (const c of ['last_note text', 'admin_disabled boolean NOT NULL DEFAULT false', 'admin_disabled_at timestamptz', 'admin_disabled_by integer']) {
      expect(mig).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
    }
    expect(read('src/db/migrations/0463_deleted_files_purge_idx_1.sql')).toMatch(/^-- verebona:optional-index[\s\S]*CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_files_s3_key_idx/);
  });
});

describe('L65-PURGE-06 — file de purge : garde-fou', () => {
  it('objet encore référencé : demande close sans appel à S3', async () => {
    vi.resetModules();
    const updates: Array<Record<string, unknown>> = [];
    vi.doMock('@/db', () => ({
      db: {
        select: () => {
          let n = 0;
          const c: Record<string, unknown> = {
            from: () => c, where: () => c, orderBy: () => c,
            limit: async () => (n++ === 0 ? [{ id: 1, storagePath: 'k-utilise', attemptCount: 0, fileId: null }, { id: 2, storagePath: 'k-libre', attemptCount: 0, fileId: 5 }] : []),
          };
          return c;
        },
        update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
      },
    }));
    const { purgePendingBlobs, KEPT_STILL_REFERENCED } = await import('@/services/storage/blob-purge.service');
    const supprimes: string[] = [];
    const vus: Array<[string, number | null]> = [];
    const r = await purgePendingBlobs({
      deleteObject: async (k) => { supprimes.push(k); },
      isReferenced: async (k, origine) => { vus.push([k, origine]); return k === 'k-utilise'; },
    });
    expect(r).toMatchObject({ processed: 1, failed: 0, kept: 1 });
    expect(supprimes).toEqual(['k-libre']);
    expect(vus).toEqual([['k-utilise', null], ['k-libre', 5]]);
    expect(updates[0]).toMatchObject({ errorMessage: KEPT_STILL_REFERENCED });
    vi.doUnmock('@/db');
  });
});
