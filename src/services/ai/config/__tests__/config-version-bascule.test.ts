/**
 * WF-03 — bascules d'Active : ordre des écritures (correctif du défaut CTE).
 *
 * Le défaut reproduit sur PostgreSQL 16 : la CTE `promue` s'exécutait avant
 * `ancienne`, et l'index « une seule Active » rejetait la validation dès
 * qu'une Active existait. Ces tests figent l'ordre des instructions dans la
 * transaction : verrou, relecture, RÉTROGRADATION, puis PROMOTION.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();
const txQueries: Array<{ sql: string; params: unknown[] }> = [];
let txAnswers: Array<unknown[]> = [];

vi.mock('@/db', () => ({
  pgClient: {
    unsafe: (sql: string, params: unknown[]) => unsafe(sql, params),
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      unsafe: async (sql: string, params: unknown[]) => {
        txQueries.push({ sql, params });
        return txAnswers.shift() ?? [];
      },
    }),
  },
}));

const { validateVersion, switchActive } = await import('../config-version.repository');

const idx = (re: RegExp) => txQueries.findIndex((q) => re.test(q.sql));

beforeEach(() => {
  unsafe.mockReset();
  txQueries.length = 0;
  txAnswers = [];
});

describe('validateVersion (WF-03)', () => {
  it('rétrograde l’ancienne Active AVANT de promouvoir, dans une transaction', async () => {
    unsafe.mockResolvedValueOnce([{ status: 'TO_TEST', environment: 'preprod' }]);
    txAnswers = [
      [],                               // verrou consultatif
      [{ status: 'TO_TEST' }],          // relecture sous verrou
      [{ id: 3 }],                      // ancienne Active rétrogradée
      [{ visible_number: 4 }],          // promotion + numéro
      [],                               // brouillons obsolètes
    ];

    const r = await validateVersion(7, 1);
    expect(r).toEqual({ status: 'ACTIVE', visibleNumber: 4 });

    const verrou = idx(/pg_advisory_xact_lock/);
    const retro = idx(/SET status = 'VALIDATED'/);
    const promo = idx(/visible_number = \(/);
    const perimes = idx(/is_stale = TRUE/);
    expect(verrou).toBe(0);
    expect(retro).toBeGreaterThan(verrou);
    expect(promo).toBeGreaterThan(retro);
    expect(perimes).toBeGreaterThan(promo);
    // Plus aucune CTE modifiante : l'ordre ne dépend plus de l'optimiseur.
    expect(txQueries.some((q) => /WITH\s+\w+\s+AS\s*\(\s*UPDATE/i.test(q.sql))).toBe(false);
    // Les brouillons marqués sont ceux de l'ancienne Active.
    expect(txQueries[perimes].params).toEqual([[3]]);
  });

  it('première validation (aucune Active) : pas de marquage de brouillons', async () => {
    unsafe.mockResolvedValueOnce([{ status: 'TO_TEST', environment: 'preprod' }]);
    txAnswers = [[], [{ status: 'TO_TEST' }], [], [{ visible_number: 1 }]];
    await expect(validateVersion(7, 1)).resolves.toEqual({ status: 'ACTIVE', visibleNumber: 1 });
    expect(idx(/is_stale = TRUE/)).toBe(-1);
  });

  it('refuse si la version a changé de statut entre la lecture et le verrou', async () => {
    unsafe.mockResolvedValueOnce([{ status: 'TO_TEST', environment: 'preprod' }]);
    txAnswers = [[], [{ status: 'DRAFT' }]];
    await expect(validateVersion(7, 1)).rejects.toThrow(/Transition refusée/);
    // Rien n'a été écrit : la transaction s'arrête avant toute mise à jour.
    expect(idx(/^\s*UPDATE/)).toBe(-1);
  });

  it('refuse une version qui n’est pas « À tester » sans ouvrir de transaction', async () => {
    unsafe.mockResolvedValueOnce([{ status: 'DRAFT', environment: 'preprod' }]);
    await expect(validateVersion(7, 1)).rejects.toThrow(/Transition refusée/);
    expect(txQueries).toHaveLength(0);
  });
});

describe('switchActive (WF-05, WF-06)', () => {
  it('même ordre : rétrograder puis promouvoir, et rend l’ancienne', async () => {
    unsafe.mockResolvedValueOnce([{ status: 'VALIDATED', environment: 'production' }]);
    txAnswers = [[], [{ status: 'VALIDATED' }], [{ id: 2 }], [{ id: 5 }]];
    const r = await switchActive(5, 1, 'activate');
    expect(r).toEqual({ status: 'ACTIVE', event: 'activate', previousId: 2 });
    expect(idx(/SET status = 'VALIDATED'/)).toBeLessThan(idx(/activated_by = \$3/));
  });
});
