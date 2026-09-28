/**
 * Déclencheurs appliqués au runtime — §15.1, T1-UI-08, T3-UI-04/05, T4-UI-04,
 * T3-003, T3-006.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  activeTriggerCodes, isTriggerActive, shortestSchedule, isScheduleDue, runDueSchedules,
  schedulableTreatments, __setTriggerConfigLoader, DEFAULT_TRIGGERS,
} from '../triggers';
import { isTriggerApplicable } from '../../config/config-validation.service';

afterEach(() => __setTriggerConfigLoader(null));

describe('liste vide = défauts du code ; liste renseignée = elle fait foi', () => {
  it('versions antérieures (liste vide) : comportement historique conservé', () => {
    expect([...activeTriggerCodes('T3', [])]).toEqual([...DEFAULT_TRIGGERS.T3]);
    expect(activeTriggerCodes('T4', null).has('source_analyzed')).toBe(true);
  });
  it('liste renseignée : seuls les actifs', () => {
    const codes = activeTriggerCodes('T3', [
      { kind: 'event', code: 'asset_updated', active: false },
      { kind: 'schedule', code: 'schedule_weekly', active: true },
    ]);
    expect([...codes]).toEqual(['schedule_weekly']);
  });
  it('tout inactif = manuel uniquement', () => {
    expect(activeTriggerCodes('T1', [{ kind: 'event', code: 'source_uploaded', active: false }]).size).toBe(0);
  });
  it('lecture impossible : défauts du code (fail-open)', async () => {
    __setTriggerConfigLoader(async () => { throw new Error('base'); });
    expect(await isTriggerActive('T1', 'source_uploaded')).toBe(true);
  });
  it('version effective lue', async () => {
    __setTriggerConfigLoader(async () => ({ triggers: [{ kind: 'event', code: 'source_uploaded', active: false }] }));
    expect(await isTriggerActive('T1', 'source_uploaded')).toBe(false);
  });
});

describe('planifications simples (T3-006)', () => {
  it('la plus fréquente l’emporte', () => {
    expect(shortestSchedule(new Set(['schedule_weekly', 'schedule_6h', 'asset_updated']))).toEqual({ code: 'schedule_6h', periodHours: 6 });
    expect(shortestSchedule(new Set(['asset_updated']))).toBeNull();
  });
  it('échéance', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(isScheduleDue(null, 24, now)).toBe(true);
    expect(isScheduleDue(new Date('2026-09-26T00:00:00Z'), 24, now)).toBe(false);
    expect(isScheduleDue(new Date('2026-09-25T11:59:00Z'), 24, now)).toBe(true);
  });
  it('seuls T1 et T3 ont un périmètre planifié ; T4 refuse une planification', () => {
    expect(schedulableTreatments().sort()).toEqual(['T1', 'T3']);
    expect(isTriggerApplicable('schedule_daily', 'T4')).toBe(false);
    expect(isTriggerApplicable('schedule_daily', 'T3')).toBe(true);
    expect(isTriggerApplicable('asset_updated', 'T1')).toBe(false);
  });
  it('met en file un passage global échu, pas un passage récent', async () => {
    const enqueueScheduled = vi.fn(async () => {});
    const fired = await runDueSchedules(new Date('2026-09-26T12:00:00Z'), {
      loadTriggers: async (t) => (t === 'T3' ? [] : null), // T3 : défaut quotidien ; T1 : aucun
      lastScheduledAt: async () => new Date('2026-09-25T06:00:00Z'),
      enqueueScheduled,
    });
    expect(fired).toEqual([{ treatment: 'T3', triggerCode: 'schedule_daily' }]);
    expect(enqueueScheduled).toHaveBeenCalledWith('T3', 'schedule_daily');

    enqueueScheduled.mockClear();
    await runDueSchedules(new Date('2026-09-26T12:00:00Z'), {
      loadTriggers: async () => [],
      lastScheduledAt: async () => new Date('2026-09-26T11:00:00Z'),
      enqueueScheduled,
    });
    expect(enqueueScheduled).not.toHaveBeenCalled();
  });
  it('une erreur de planification n’interrompt pas les autres traitements', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fired = await runDueSchedules(new Date(), {
      loadTriggers: async () => [{ kind: 'schedule', code: 'schedule_hourly', active: true }],
      lastScheduledAt: async (t) => { if (t === 'T1') throw new Error('x'); return null; },
      enqueueScheduled: async () => {},
    });
    expect(fired.map((f) => f.treatment)).toEqual(['T3']);
  });
});
