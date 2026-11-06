/**
 * Lot 113K (Trello #699, recette KO du 06/11/2026) : la page BO disait
 * « Worker disponible : app-preprod-web-1:23 » pour une demande bloquée par
 * DIAG_JOB_WORKER_DISABLED. Le libellé suit maintenant l'état réel.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { workerHeadline } from '../wait';

const v = (o: Partial<Parameters<typeof workerHeadline>[0]> = {}) => ({ state: 'STARTED', alive: true, aliveWorkers: 1, disabledReason: null, lane: null, ...o });

describe('113K — libellé du worker vu pour une demande', () => {
  it('cas de la préproduction du 06/11 : processus désactivé → « Worker désactivé (variable) », jamais « disponible »', () => {
    const h = workerHeadline(v({ state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED', aliveWorkers: 0 }), 'QUEUED');
    expect(h).toEqual({ code: 'DISABLED', label: 'Worker désactivé (DIAG_JOB_WORKER_DISABLED)', problem: true });
    expect(workerHeadline(v({ state: 'DISABLED', disabledReason: 'EXPORTS_WORKER_DISABLED', aliveWorkers: 0 }), 'QUEUED').label).toBe('Worker désactivé (EXPORTS_WORKER_DISABLED)');
  });
  it('processus sans worker, arrêté, battement périmé : état nommé, signalé', () => {
    expect(workerHeadline(v({ state: 'NOT_THIS_PROCESS', aliveWorkers: 0 }), 'QUEUED')).toMatchObject({ code: 'NO_WORKER_IN_PROCESS', label: 'Processus sans worker', problem: true });
    expect(workerHeadline(v({ state: 'STOPPED', alive: false, aliveWorkers: 0 }), 'QUEUED')).toMatchObject({ code: 'STOPPED', problem: true });
    expect(workerHeadline(v({ alive: false, aliveWorkers: 0 }), 'QUEUED')).toMatchObject({ code: 'OFFLINE', label: 'Worker hors ligne (battement périmé)', problem: true });
  });
  it('« Worker disponible » seulement si démarré, vivant et au moins un worker vivant', () => {
    expect(workerHeadline(v(), 'QUEUED')).toEqual({ code: 'AVAILABLE', label: 'Worker disponible', problem: false });
    expect(workerHeadline(v({ aliveWorkers: 0 }), 'QUEUED').code).toBe('UNKNOWN');
  });
  it('demande en cours : « Worker qui exécute » pour le worker vivant qui la porte', () => {
    expect(workerHeadline(v({ lane: 'targeted' }), 'RUNNING')).toMatchObject({ code: 'EXECUTING', label: 'Worker qui exécute', problem: false });
    expect(workerHeadline(v({ lane: 'main', alive: false }), 'RUNNING').code).toBe('OFFLINE');
  });
  it('page BO : plus de libellé « Worker disponible » codé en dur ; DTO avec la variable en cause', () => {
    const page = readFileSync('src/app/admin/diagnostics/page.tsx', 'utf8');
    expect(page).not.toMatch(/'Worker disponible : '/);
    expect(page).toMatch(/workerHeadline\(v\.workerView, j\.status\)/);
    const sup = readFileSync('src/services/admin/diagnostic-jobs/supervision.ts', 'utf8');
    expect(sup).toMatch(/disabledReason: pick\.disabledReason \?\? null/);
  });
});
