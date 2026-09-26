/**
 * Planification des tâches quotidiennes du lot : impayé, purge des exports
 * RGPD, ancienneté des sauvegardes. Même modèle que la sauvegarde de nuit
 * (fenêtre à Paris + bail en base), démarré par `instrumentation.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lock = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@/lib/job-lock', () => ({
  acquireJobLock: lock.acquire,
  releaseJobLock: lock.release,
}));

import {
  dailyTasks,
  dansLaFenetre,
  tour,
  unpaidSweepMode,
  type DailyTask,
} from '@/services/scheduling/daily-maintenance-scheduler';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** 09:30 à Paris (heure d'été : UTC+2). */
const MATIN = new Date('2026-09-26T07:30:00Z');

beforeEach(() => {
  lock.acquire.mockReset().mockImplementation(async (name: string) => ({ name, owner: 'test' }));
  lock.release.mockReset().mockResolvedValue(undefined);
});

describe('mode du balayage d’impayés', () => {
  it('live par défaut, off explicite, toute autre valeur ⇒ simulation', () => {
    expect(unpaidSweepMode(undefined)).toBe('live');
    expect(unpaidSweepMode('live')).toBe('live');
    expect(unpaidSweepMode('off')).toBe('off');
    expect(unpaidSweepMode('dry')).toBe('dry');
    // Faute de frappe : jamais de suppression par surprise.
    expect(unpaidSweepMode('lvie')).toBe('dry');
  });
});

describe('tâches planifiées', () => {
  it('impayé, purge RGPD et ancienneté des sauvegardes, chacune avec son bail', () => {
    const locks = dailyTasks({} as NodeJS.ProcessEnv).map((t) => t.lock);
    expect(locks).toEqual(['daily-billing-unpaid', 'daily-gdpr-exports-purge', 'daily-backup-freshness']);
  });

  it('BILLING_UNPAID_SWEEP=off retire l’impayé ; BACKUP_DISABLED retire le contrôle de sauvegarde', () => {
    const locks = dailyTasks({ BILLING_UNPAID_SWEEP: 'off', BACKUP_DISABLED: 'true' } as unknown as NodeJS.ProcessEnv)
      .map((t) => t.lock);
    expect(locks).toEqual(['daily-gdpr-exports-purge']);
  });

  it('fenêtres hors de la sauvegarde de nuit (1 h – 5 h)', () => {
    for (const t of dailyTasks({} as NodeJS.ProcessEnv)) {
      expect(t.window[0]).toBeGreaterThanOrEqual(5);
      expect(t.window[1]).toBeGreaterThan(t.window[0]);
    }
    expect(dansLaFenetre(8, [8, 12])).toBe(true);
    expect(dansLaFenetre(12, [8, 12])).toBe(false);
  });
});

describe('un tour', () => {
  const tache = (over: Partial<DailyTask> = {}): DailyTask => ({
    lock: 't', window: [9, 10], run: vi.fn().mockResolvedValue(undefined), ...over,
  });

  it('exécute une tâche dans sa fenêtre et conserve le bail (une fois par jour)', async () => {
    const t = tache();
    await tour([t], MATIN);
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(lock.acquire).toHaveBeenCalledWith('t', 20 * 60 * 60 * 1000);
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('hors fenêtre : rien, pas même la prise de bail', async () => {
    const t = tache({ window: [14, 16] });
    await tour([t], MATIN);
    expect(t.run).not.toHaveBeenCalled();
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it('bail détenu ailleurs : on passe son tour', async () => {
    lock.acquire.mockResolvedValue(null);
    const t = tache();
    await tour([t], MATIN);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('échec : bail rendu pour réessayer, et les autres tâches tournent quand même', async () => {
    const ko = tache({ lock: 'ko', run: vi.fn().mockRejectedValue(new Error('boum')) });
    const ok = tache({ lock: 'ok' });
    await tour([ko, ok], MATIN);
    expect(lock.release).toHaveBeenCalledWith({ name: 'ko', owner: 'test' });
    expect(ok.run).toHaveBeenCalledTimes(1);
  });
});

describe('câblage', () => {
  it('le planificateur est démarré au lancement du serveur', () => {
    expect(read('src/instrumentation.ts')).toMatch(/startDailyMaintenanceScheduler\(\)/);
  });

  it('la purge RGPD a sa route de déclenchement, protégée même sans secret configuré', () => {
    const src = read('src/app/api/cron/gdpr-exports-purge/route.ts');
    expect(src).toMatch(/if \(!secret \|\| req\.headers\.get\('authorization'\) !== `Bearer \$\{secret\}`\)/);
    expect(src).toMatch(/purgeAllExpiredExports\(\)/);
  });

  it('les secrets de planification sont documentés', () => {
    const env = read('.env.example');
    expect(env).toMatch(/^CRON_SECRET=/m);
    expect(env).toMatch(/BILLING_UNPAID_SWEEP/);
    expect(env).toMatch(/\/api\/cron\/billing-unpaid/);
    expect(env).toMatch(/^EMAIL_VERIFICATION_SECRET=/m);
  });
});

describe('toutes les routes planifiées exigent un CRON_SECRET configuré', () => {
  it('aucune ne s’ouvre quand le secret est absent (« Bearer undefined »)', async () => {
    const { readdirSync } = await import('node:fs');
    const routes = [
      ...readdirSync(join(process.cwd(), 'src/app/api/cron'), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('route.ts'))
        .map((f) => `src/app/api/cron/${f}`),
      'src/app/api/purge-pending-uploads/route.ts',
    ];
    expect(routes.length).toBeGreaterThan(20);
    const ouvertes = routes.filter((p) => {
      const src = read(p);
      if (!/CRON_SECRET/.test(src)) return false; // route protégée autrement
      return /if \(authHeader !== `Bearer \$\{process\.env\.CRON_SECRET\}`\)/.test(src)
        || /if \(cronSecret && /.test(src);
    });
    expect(ouvertes).toEqual([]);
  });
});
