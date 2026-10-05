/**
 * Lancement manuel batch — WF-11, OPS-016, T1-021, T3-UI-08, T4-UI-07.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  launchManual, ManualLaunchRefused, MANUAL_LAUNCH_MAX_JOBS, type ManualLaunchDeps,
} from '../manual-launch';

function deps(over: Partial<ManualLaunchDeps> = {}) {
  let n = 100;
  const enqueue = vi.fn(async () => ({ jobId: ++n, decision: 'create' as const }));
  const d: ManualLaunchDeps = {
    emergencyStopActive: async () => false,
    canStart: async () => true,
    listFiles: async (ids) => (ids ?? [1, 2]).flatMap((a) => [{ id: a * 10, accountId: a }, { id: a * 10 + 1, accountId: a }]),
    listAccounts: async (ids) => ids ?? [1, 2, 3],
    listT4Sources: async (_ids, _l, withCandidates) => [
      { fileId: 70, accountId: 7, assetId: 3, userId: 5, ...(withCandidates ? { candidates: [{ title: 'Entretien chaudière' }] } : {}) },
      { fileId: 71, accountId: 7, assetId: 3, userId: 5, ...(withCandidates ? { candidates: [] } : {}) },
    ],
    enqueue: enqueue as unknown as ManualLaunchDeps['enqueue'],
    ...over,
  };
  return { d, enqueue };
}

describe('launchManual', () => {
  it('estimation (dryRun) : rien n’est créé', async () => {
    const { d, enqueue } = deps();
    const r = await launchManual('T1', { accountIds: [4] }, 9, { dryRun: true }, d);
    expect(r).toMatchObject({ dryRun: true, objects: 2, accounts: 1, jobIds: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('T1 : un job manuel par fichier, non facturé, sans déduplication', async () => {
    const { d, enqueue } = deps();
    const r = await launchManual('T1', { accountIds: [4, 4, -1] }, 9, {}, d);
    expect(r.objects).toBe(2);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T1', origin: 'manual', triggerCode: 'manual',
      scope: { accountId: 4, targetType: 'asset_file', targetId: 40 },
      payload: expect.objectContaining({ fileId: 40, billable: false, requestedByUserId: 9 }),
    }));
  });

  it('T3 « tout le périmètre » : un contrôle complet par compte pertinent', async () => {
    const { d, enqueue } = deps();
    const r = await launchManual('T3', { all: true }, 9, {}, d);
    expect(r).toMatchObject({ objects: 3, accounts: 3 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T3', origin: 'manual', scope: { accountId: 1 },
      payload: { kind: 'account', scope: 'full', requestedByUserId: 9 },
    }));
  });

  it('arrêt d’urgence : refus explicite (précondition WF-11)', async () => {
    const { d } = deps({ emergencyStopActive: async () => true });
    await expect(launchManual('T3', { all: true }, 9, {}, d)).rejects.toMatchObject({ code: 'EMERGENCY_STOP' });
  });

  it('traitement désactivé : accepté, en attente de réactivation (WF-07)', async () => {
    const { d } = deps({ canStart: async () => false });
    await expect(launchManual('T3', { accountIds: [1] }, 9, {}, d)).resolves.toMatchObject({ waitsForReactivation: true });
  });

  it('T4 : nouveau passage manuel sur les candidats T1 persistés, sans déduplication (T4-016, T4-UI-07)', async () => {
    const { d, enqueue } = deps();
    const estimation = await launchManual('T4', { accountIds: [7] }, 9, { dryRun: true }, d);
    expect(estimation).toMatchObject({ dryRun: true, objects: 2, accounts: 1 });
    const r = await launchManual('T4', { accountIds: [7] }, 9, {}, d);
    expect(r.jobIds).toHaveLength(1); // document sans candidat ignoré
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T4', origin: 'manual', triggerCode: 'manual',
      scope: { accountId: 7, targetType: 'asset_file', targetId: 70 },
      payload: expect.objectContaining({ assetId: 3, userId: 5, leadSourceId: 70, candidates: [{ title: 'Entretien chaudière' }], requestedByUserId: 9 }),
    }));
  });

  it('T2 non batch, périmètre vide ou trop large : refus', async () => {
    const { d } = deps({ listAccounts: async () => Array.from({ length: MANUAL_LAUNCH_MAX_JOBS + 1 }, (_, i) => i + 1) });
    await expect(launchManual('T2', { all: true }, 9, {}, d)).rejects.toBeInstanceOf(ManualLaunchRefused);
    await expect(launchManual('T3', { accountIds: [] }, 9, {}, d)).rejects.toMatchObject({ code: 'EMPTY_SCOPE' });
    await expect(launchManual('T3', { all: true }, 9, {}, d)).rejects.toMatchObject({ code: 'SCOPE_TOO_LARGE' });
  });
});
