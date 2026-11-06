/**
 * Lot 113H (#707, écart B) — supervision du référentiel des e-mails jetables
 * raccordée au balayage de Supervision existant (anomalies « Autres
 * traitements techniques »), sans tableau de bord parallèle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportAnomaly = vi.fn(async (_i: Record<string, unknown>) => 1);
const autoResolveAnomaly = vi.fn(async (_f: string, _o: Record<string, unknown>) => true);
vi.mock('@/services/admin/anomaly.service', () => ({
  reportAnomaly: (i: Record<string, unknown>) => reportAnomaly(i),
  autoResolveAnomaly: (f: string, o: Record<string, unknown>) => autoResolveAnomaly(f, o),
  buildFingerprint: (...p: string[]) => p.join(':'),
}));
const open = new Set<string>();
vi.mock('@/db', () => ({
  pgClient: (_s: TemplateStringsArray, fp: string) => Promise.resolve(open.has(fp) ? [{ one: 1 }] : []),
}));

import { disposableListStatus, type DisposableListStatus } from '@/lib/auth/disposable-email';
import source from '@/lib/auth/disposable-email/data/source.json';
import { disposableListConditions, syncDisposableListAnomalies } from '../disposable-list-supervision';

const at = (days: number) => new Date(new Date(source.fetchedAt).getTime() + days * 86_400_000);
const fresh = (): DisposableListStatus => disposableListStatus(at(5));

beforeEach(() => { reportAnomaly.mockClear(); autoResolveAnomaly.mockClear(); open.clear(); });

describe('L113H — conditions d’alerte', () => {
  it('à jour ou « mise à jour mensuelle à prévoir » : aucune alerte ; > 90 jours, indisponible, incohérent : alerte', () => {
    expect(disposableListConditions(fresh())).toEqual([]);
    expect(disposableListConditions(disposableListStatus(at(60)))).toEqual([]);
    expect(disposableListConditions(disposableListStatus(at(91)))).toEqual(['stale']);
    expect(disposableListConditions({ ...fresh(), available: false })).toEqual(['unavailable']);
    // Indisponible ET (forcément) incohérent : une seule anomalie, la plus grave.
    expect(disposableListConditions({ ...fresh(), available: false, integrity: 'mismatch' })).toEqual(['unavailable']);
    expect(disposableListConditions({ ...fresh(), available: false, integrity: 'mismatch', stale: true })).toEqual(['unavailable', 'stale']);
    expect(disposableListConditions({ ...fresh(), integrity: 'mismatch', stale: true })).toEqual(['integrity', 'stale']);
  });
});

describe('L113H — anomalies de Supervision', () => {
  it('> 90 jours : anomalie actionnable (version, date, âge, seuils, commande), jamais la liste ; une seule tant qu’elle reste ouverte', async () => {
    const st = disposableListStatus(at(120));
    const r = await syncDisposableListAnomalies(st);
    expect(r).toMatchObject({ conditions: ['stale'], reported: ['stale'] });
    const arg = reportAnomaly.mock.calls[0][0] as { domain: string; fingerprint: string; title: string; detail: Record<string, unknown> };
    expect(arg).toMatchObject({ domain: 'other', fingerprint: 'other:disposable-email-list:stale' });
    expect(arg.title).toBe(`E-mails jetables : référentiel périmé (120 jours > 90, version ${source.version})`);
    expect(arg.detail).toMatchObject({ version: source.version, ref: source.ref, fetchedAt: source.fetchedAt, ageDays: 120, maxAgeDays: 90, updateTargetDays: 31, count: source.count });
    expect(String(arg.detail.action)).toContain('npm run disposable-domains:update');
    expect(JSON.stringify(arg)).not.toMatch(/yopmail|mailinator|@/);
    // Les autres conditions absentes sont résolues automatiquement.
    expect(autoResolveAnomaly.mock.calls.map((c) => c[0]).sort()).toEqual(['other:disposable-email-list:integrity', 'other:disposable-email-list:unavailable']);

    open.add('other:disposable-email-list:stale');
    reportAnomaly.mockClear();
    expect((await syncDisposableListAnomalies(st)).reported).toEqual([]);
    expect(reportAnomaly).not.toHaveBeenCalled();
  });

  it('liste indisponible : anomalie avec nombres lus / attendus et repli explicite ; retour à la normale : résolution automatique', async () => {
    const st = { ...fresh(), available: false, count: 0, loadedCount: 12, state: 'unavailable' as const };
    await syncDisposableListAnomalies(st);
    const arg = reportAnomaly.mock.calls[0][0] as { fingerprint: string; title: string; detail: Record<string, unknown> };
    expect(arg.fingerprint).toBe('other:disposable-email-list:unavailable');
    expect(arg.title).toContain('indisponible ou tronqué (12 domaines');
    expect(arg.detail).toMatchObject({ loadedCount: 12, expectedCount: source.count, available: false });
    expect(String(arg.detail.action)).toContain('DISPOSABLE_EMAIL_EXTRA_BLOCKLIST');

    autoResolveAnomaly.mockClear();
    const ok = await syncDisposableListAnomalies(fresh());
    expect(ok.conditions).toEqual([]);
    expect(autoResolveAnomaly).toHaveBeenCalledWith('other:disposable-email-list:unavailable', expect.objectContaining({ origin: 'disposable_list_check' }));
  });

  it('ne lève jamais (base injoignable)', async () => {
    reportAnomaly.mockRejectedValueOnce(new Error('base injoignable'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(syncDisposableListAnomalies(disposableListStatus(at(200)))).resolves.toMatchObject({ conditions: ['stale'] });
    spy.mockRestore();
  });
});
