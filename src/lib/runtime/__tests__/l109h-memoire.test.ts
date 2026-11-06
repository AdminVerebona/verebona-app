/**
 * Lot 109H — mémoire du conteneur web Scalingo : lanceur (Procfile sans npm,
 * limite de tas paramétrable), rôle web / worker activable, préchargement
 * Next désactivé par défaut, mesure et admission mémoire.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  containerLimitMb, heapLimit, jobsPlacement as launcherPlacement, launchLogLine, planLaunch,
} from '../../../../scripts/start-server.mjs';
import { jobsPlacement, processRoleSummary, processType, runsBackgroundJobs } from '../process-role';
import {
  __resetMemoryMonitorForTests, admitHeavyTask, decideAdmission, initialAlertState, memorySettings, memorySnapshot,
  nextAlert, parseLimitMb, pressureLevel, readContainerMemory, startMemoryMonitor, statValue, trackMemory,
} from '../memory-monitor';

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const GIB = String(1024 * 1024 * 1024);

describe('L109H — Procfile', () => {
  const lines = read('Procfile').trim().split('\n');
  it('web lancé directement par node (plus de npm), worker déclaré, postdeploy inchangé', () => {
    expect(lines).toContain('web: node scripts/start-server.mjs web');
    expect(lines).toContain('worker: node scripts/start-server.mjs worker');
    expect(lines).toContain('postdeploy: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/migrate.mjs');
    expect(read('Procfile')).not.toMatch(/npm/);
    // Lot 113Q : processus dédié aux diagnostics BO (veille sans DIAG_JOB_PROCESS=diagworker).
    expect(lines).toContain('diagworker: node scripts/start-server.mjs diagworker');
    expect(lines).toHaveLength(4);
  });
});

describe('L109H — lanceur : limite du tas', () => {
  it('taille du conteneur : CONTAINER_MEMORY (octets) avant le cgroup ; « max » = inconnue', () => {
    expect(containerLimitMb({ CONTAINER_MEMORY: GIB }, '2147483648')).toEqual({ mb: 1024, source: 'CONTAINER_MEMORY' });
    expect(containerLimitMb({}, '2147483648\n')).toEqual({ mb: 2048, source: 'cgroup' });
    expect(containerLimitMb({}, 'max')).toEqual({ mb: null, source: null });
    expect(containerLimitMb({ CONTAINER_MEMORY: 'abc' }, null)).toEqual({ mb: null, source: null });
  });

  it('auto : 60 % du conteneur, marge hors tas toujours laissée ; inconnu → aucune limite (comme avant)', () => {
    expect(heapLimit({}, { mb: 1024, source: 'CONTAINER_MEMORY' }).mb).toBe(614);
    expect(heapLimit({}, { mb: 2048, source: 'cgroup' }).mb).toBe(1228);
    expect(heapLimit({}, { mb: 512, source: 'cgroup' }).mb).toBe(256);
    expect(heapLimit({ NODE_HEAP_PERCENT: '50' }, { mb: 1024, source: 'cgroup' }).mb).toBe(512);
    expect(heapLimit({ NODE_HEAP_PERCENT: '95' }, { mb: 1024, source: 'cgroup' }).mb).toBe(614);
    expect(heapLimit({}, { mb: null, source: null })).toMatchObject({ mb: null });
  });

  it('valeur explicite, off, NODE_OPTIONS déjà posé, valeur invalide', () => {
    expect(heapLimit({ NODE_MAX_OLD_SPACE_MB: '700' }, { mb: 1024, source: 'cgroup' })).toEqual({ mb: 700, reason: 'NODE_MAX_OLD_SPACE_MB' });
    expect(heapLimit({ NODE_MAX_OLD_SPACE_MB: 'off' }, { mb: 1024, source: 'cgroup' }).mb).toBeNull();
    expect(heapLimit({ NODE_OPTIONS: '--max-old-space-size=900' }, { mb: 1024, source: 'cgroup' }).mb).toBeNull();
    const bad = heapLimit({ NODE_MAX_OLD_SPACE_MB: '64' }, { mb: 1024, source: 'cgroup' });
    expect(bad.mb).toBe(614);
    expect(bad.reason).toMatch(/invalide/);
  });
});

describe('L109H — lanceur : plan web / worker', () => {
  it('défaut : web lance Next avec la limite, traitements de fond dans le web', () => {
    const p = planLaunch({ processType: 'web', env: { CONTAINER_MEMORY: GIB, PORT: '5000' } });
    expect(p).toMatchObject({ mode: 'next', placement: 'web', nodeArgs: ['--max-old-space-size=614'], nextArgs: ['start'] });
    expect(p.env).toMatchObject({ APP_PROCESS_TYPE: 'web', BACKGROUND_JOBS_PROCESS: 'web', PORT: '5000' });
    expect(launchLogLine(p)).toMatch(/^\[start\] \{.*"heapMb":614/);
  });

  it('worker sans séparation activée : veille, Next non démarré', () => {
    const p = planLaunch({ processType: 'worker', env: { CONTAINER_MEMORY: GIB } });
    expect(p.mode).toBe('idle');
    expect(p.notes.join(' ')).toMatch(/veille/);
  });

  it('séparation activée : worker lance Next en écoute locale, rôle transmis', () => {
    const p = planLaunch({ processType: 'worker', env: { BACKGROUND_JOBS_PROCESS: 'worker' } });
    expect(p).toMatchObject({ mode: 'next', placement: 'worker', nodeArgs: [], nextArgs: ['start', '-H', '127.0.0.1', '-p', '3000'] });
    expect(p.env.APP_PROCESS_TYPE).toBe('worker');
  });

  it('valeur inconnue → web (avertissement) ; type inconnu refusé', () => {
    expect(launcherPlacement({ BACKGROUND_JOBS_PROCESS: 'les-deux' })).toMatchObject({ placement: 'web' });
    expect(launcherPlacement({ BACKGROUND_JOBS_PROCESS: 'les-deux' }).warning).toMatch(/inconnu/);
    expect(() => planLaunch({ processType: 'cron', env: {} })).toThrow(/inconnu/);
  });
});

describe('L109H — rôle du processus (application)', () => {
  it('type : APP_PROCESS_TYPE, sinon CONTAINER Scalingo, sinon web', () => {
    expect(processType({ APP_PROCESS_TYPE: 'worker' })).toBe('worker');
    expect(processType({ CONTAINER: 'worker-1' })).toBe('worker');
    expect(processType({ CONTAINER: 'web-2' })).toBe('web');
    expect(processType({ CONTAINER: 'one-off-1234' })).toBe('web');
    expect(processType({})).toBe('web');
  });

  it('défaut = comportement d’avant : le web porte les traitements de fond', () => {
    expect(runsBackgroundJobs({})).toBe(true);
    expect(runsBackgroundJobs({ CONTAINER: 'web-1' })).toBe(true);
    expect(runsBackgroundJobs({ APP_PROCESS_TYPE: 'web', BACKGROUND_JOBS_PROCESS: 'worker' })).toBe(false);
    expect(runsBackgroundJobs({ APP_PROCESS_TYPE: 'worker', BACKGROUND_JOBS_PROCESS: 'worker' })).toBe(true);
    expect(processRoleSummary({ CONTAINER: 'web-1' })).toEqual({ process: 'web', placement: 'web', backgroundJobs: true, diagnostics: true, diagnosticsPlacement: 'web', container: 'web-1' });
  });

  it('même lecture de BACKGROUND_JOBS_PROCESS que le lanceur', () => {
    for (const v of ['', 'web', 'worker', 'WORKER', ' worker ', 'autre']) {
      expect(jobsPlacement({ BACKGROUND_JOBS_PROCESS: v })).toBe(launcherPlacement({ BACKGROUND_JOBS_PROCESS: v }).placement);
    }
  });

  it('instrumentation : planificateurs et files démarrés seulement par le processus des traitements', () => {
    const src = read('src/instrumentation-node.ts');
    for (const start of ['startIndexMaintenance()', 'startAnalysisRecoveryScheduler()', 'startQueueWorker()', 'startDatabaseBackupScheduler()',
      'startDailyMaintenanceScheduler()', 'startScheduledTasks()', 'startExportWorker()']) {
      expect(src, start).toContain(`if (role.backgroundJobs) ${start};`);
    }
    // Lot 113Q : diagnostics BO — avec les traitements de fond (défaut) ou dans le processus dédié (DIAG_JOB_PROCESS=diagworker).
    expect(src).toContain('if (role.diagnostics) startDiagnosticWorker();');
    // Abonnements aux événements : partout.
    expect(src).toMatch(/\n  registerReconciliationHandlers\(\);/);
    expect(src).toMatch(/\n  await registerCoherenceTriggers\(\)/);
    expect(src).toContain('startMemoryMonitor({');
    expect(src).toContain('checkBackgroundWorkerPresence()');
  });
});

describe('L109H — Next : préchargement des pages désactivé par défaut', () => {
  it('preloadEntriesOnStart suit NEXT_PRELOAD_ENTRIES (lu au démarrage)', async () => {
    expect(read('next.config.mjs')).toContain("preloadEntriesOnStart: process.env.NEXT_PRELOAD_ENTRIES === 'true',");
    const prev = process.env.NEXT_PRELOAD_ENTRIES;
    delete process.env.NEXT_PRELOAD_ENTRIES;
    const cfg = (await import('../../../../next.config.mjs')).default as { experimental: { preloadEntriesOnStart: boolean } };
    expect(cfg.experimental.preloadEntriesOnStart).toBe(false);
    if (prev !== undefined) process.env.NEXT_PRELOAD_ENTRIES = prev;
  });
});

describe('L109H — lecture du conteneur (pure)', () => {
  const files = (m: Record<string, string>) => (p: string) => { if (p in m) return m[p]; throw new Error('ENOENT'); };

  it('cgroup v2 : limite et usage hors cache récupérable', () => {
    const r = readContainerMemory({}, files({
      '/sys/fs/cgroup/memory.max': GIB,
      '/sys/fs/cgroup/memory.current': String(700 * 1024 * 1024),
      '/sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${100 * 1024 * 1024}\nactive_file 5\n`,
    }));
    expect(r).toEqual({ containerLimitMb: 1024, containerUsedMb: 600, limitSource: 'cgroup' });
  });

  it('CONTAINER_MEMORY prioritaire ; v1 lu ; rien de lisible → null', () => {
    const r = readContainerMemory({ CONTAINER_MEMORY: String(512 * 1024 * 1024) }, files({
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(512 * 1024 * 1024),
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(300 * 1024 * 1024),
      '/sys/fs/cgroup/memory/memory.stat': `total_inactive_file ${50 * 1024 * 1024}\n`,
    }));
    expect(r).toEqual({ containerLimitMb: 512, containerUsedMb: 250, limitSource: 'CONTAINER_MEMORY' });
    expect(readContainerMemory({}, files({}))).toEqual({ containerLimitMb: null, containerUsedMb: null, limitSource: null });
    // cgroup sans limite (groupe plus large que le conteneur) : usage ignoré, RSS du processus à la place.
    expect(readContainerMemory({ CONTAINER_MEMORY: GIB }, files({
      '/sys/fs/cgroup/memory.max': 'max',
      '/sys/fs/cgroup/memory.current': String(2400 * 1024 * 1024),
      '/sys/fs/cgroup/memory.stat': 'inactive_file 0\n',
    }))).toEqual({ containerLimitMb: 1024, containerUsedMb: null, limitSource: 'CONTAINER_MEMORY' });
    // usage invraisemblable (> 1,5 × la limite) : ignoré.
    expect(readContainerMemory({}, files({
      '/sys/fs/cgroup/memory.max': GIB,
      '/sys/fs/cgroup/memory.current': String(4096 * 1024 * 1024),
      '/sys/fs/cgroup/memory.stat': 'inactive_file 0\n',
    })).containerUsedMb).toBeNull();
    expect(parseLimitMb('max')).toBeNull();
    expect(statValue('inactive_file 42\n', 'inactive_file')).toBe(42);
  });
});

describe('L109H — pression, alerte, admission (pures)', () => {
  const st = memorySettings({});
  it('réglages par défaut et bornes', () => {
    expect(st).toMatchObject({ sampleMs: 60_000, alertPercent: 85, admissionPercent: 75, admissionMaxWaitMs: 600_000, disabled: false });
    expect(memorySettings({ MEMORY_ALERT_PERCENT: '10', MEMORY_ADMISSION_PERCENT: '90' })).toMatchObject({ alertPercent: 85, admissionPercent: 85 });
  });

  it('niveau rapporté à la limite (conteneur, sinon rss) ; limite inconnue → unknown', () => {
    expect(pressureLevel({ containerUsedMb: 900, rssMb: 100, containerLimitMb: 1024 }, st)).toBe('critical');
    expect(pressureLevel({ containerUsedMb: null, rssMb: 800, containerLimitMb: 1024 }, st)).toBe('high');
    expect(pressureLevel({ containerUsedMb: 300, rssMb: 300, containerLimitMb: 1024 }, st)).toBe('ok');
    expect(pressureLevel({ containerUsedMb: null, rssMb: 5000, containerLimitMb: null }, st)).toBe('unknown');
  });

  it('alerte après 2 échantillons critiques, répétée au plus toutes les 15 min, résolue après 30 min sous le seuil', () => {
    let s = initialAlertState();
    let r = nextAlert(s, 'critical', 0, st); s = r.state; expect(r.action).toBeNull();
    r = nextAlert(s, 'critical', 60_000, st); s = r.state; expect(r.action).toBe('report');
    r = nextAlert(s, 'critical', 120_000, st); s = r.state; expect(r.action).toBeNull();
    r = nextAlert(s, 'critical', 60_000 + 15 * 60_000, st); s = r.state; expect(r.action).toBe('report');
    r = nextAlert(s, 'high', 2_000_000, st); s = r.state; expect(r.action).toBeNull();
    r = nextAlert(s, 'ok', 2_100_000, st); s = r.state; expect(r.action).toBeNull();
    r = nextAlert(s, 'ok', 2_100_000 + 30 * 60_000, st); expect(r.action).toBe('resolve');
  });

  it('admission : différée sous pression, forcée après l’attente maximale (pas de famine)', () => {
    expect(decideAdmission('ok', null, 0, 1000)).toEqual({ allow: true, forced: false });
    expect(decideAdmission('unknown', null, 0, 1000)).toEqual({ allow: true, forced: false });
    expect(decideAdmission('high', null, 0, 1000)).toEqual({ allow: false, forced: false });
    expect(decideAdmission('critical', 0, 999, 1000)).toEqual({ allow: false, forced: false });
    expect(decideAdmission('critical', 0, 1000, 1000)).toEqual({ allow: true, forced: true });
  });
});

describe('L109H — mesure en cours d’exécution', () => {
  const saved = { ...process.env };
  afterEach(() => { __resetMemoryMonitorForTests(); process.env = { ...saved }; });

  it('sans démarrage du moniteur : aucune admission, trackMemory transparent', async () => {
    expect(admitHeavyTask('export:v12')).toBe(true);
    await expect(trackMemory('x', async () => 42)).resolves.toBe(42);
    await expect(trackMemory('x', async () => { throw new Error('boum'); })).rejects.toThrow('boum');
  });

  it('pic par type de tâche ; conteneur « trop petit » → admission différée puis forcée', async () => {
    process.env.CONTAINER_MEMORY = String(16 * 1024 * 1024); // 16 Mo : le processus de test dépasse forcément
    process.env.MEMORY_ADMISSION_MAX_WAIT_MS = '0';
    process.env.MEMORY_LOG_EVERY_MS = '0';
    startMemoryMonitor({ processType: 'web' });
    await trackMemory('task:essai', async () => { const b = Buffer.alloc(8 * 1024 * 1024, 1); return b.length; });
    const snap = memorySnapshot();
    expect(snap.started).toBe(true);
    expect(snap.taskPeaks.find((p) => p.kind === 'task:essai')).toMatchObject({ runs: 1 });
    expect(snap.level).toBe('critical');
    expect(admitHeavyTask('export:v12', 1_000)).toBe(false);
    expect(admitHeavyTask('export:v12', 1_001)).toBe(true);
  });
});
