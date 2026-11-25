/**
 * Carte Trello #837 (D3) — classement par issue du BO : une erreur SQL AU MILIEU
 * de la lecture, ou un écart avec le total de la période, rend le rapport
 * INCOMPLETE (cause, progression, curseur) — jamais « total exhaustif ».
 * Base simulée ; le volume réel (> 5 000 documents) et l'échéance sont prouvés
 * par le scénario PostgreSQL `c837-t1-residus-115h.e2e.ts` (C837-E08).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const etat = vi.hoisted(() => ({ total: 5, pages: [] as unknown[][], erreurPage: -1, appelsPage: 0 }));

vi.mock('@/db', () => {
  const unsafe = async (q: string) => {
    const x = q.replace(/\s+/g, ' ');
    if (/to_regclass\('document_source_units'\)/.test(x)) return [{ a: true, b: true, c: true, d: true }];
    if (/SELECT COUNT\(\*\)::int AS n FROM document_extraction_coverage c/.test(x)) return [{ n: etat.total }];
    if (/ORDER BY c.updated_at DESC, c.file_id DESC/.test(x)) {
      const i = etat.appelsPage++;
      if (i === etat.erreurPage) throw new Error('connexion perdue au milieu de la lecture');
      return etat.pages[i] ?? [];
    }
    return [];
  };
  return { db: {}, pgClient: { unsafe, begin: async (_o: unknown, fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => fn({ unsafe }) } };
});
vi.mock('../repository', async (o) => ({ ...(await o<typeof import('../repository')>()), sourceLayerReady: async () => true }));

const ligne = (id: number) => ({ fileId: id, updatedAt: `2026-11-25 10:00:00.00012${id}+00`, qualityState: 'COMPLETE', anomalies: [], nextRetryAt: null, retryAttempts: 0, verification: null });

beforeEach(() => { etat.total = 5; etat.pages = []; etat.erreurPage = -1; etat.appelsPage = 0; });

describe('C837-D3 — rapport tronqué ou en erreur : INCOMPLETE, jamais exhaustif', () => {
  it('erreur SQL à la deuxième page : cause, progression et curseur de reprise rendus', async () => {
    const { getT1CompletenessOverview } = await import('../monitoring');
    etat.pages = [[ligne(5), ligne(4)], [ligne(3), ligne(2)], [ligne(1)]];
    etat.erreurPage = 1;
    const v = await getT1CompletenessOverview({ days: 1, issueScan: { pageSize: 2 } });
    expect(v.byIssueStatus).toBe('INCOMPLETE');
    expect(v.byIssueTruncated).toBe(true);
    expect(v.byIssueIncomplete).toMatchObject({ cause: 'SQL_ERROR', scanned: 2, expected: 5, cursor: { fileId: 4, updatedAt: ligne(4).updatedAt } });
    expect(v.byIssueScanned).toBe(2);
  });
  it('lecture complète : COMPLETE ; nombre classé ≠ total (suppressions, écart) : INCOMPLETE COUNT_MISMATCH', async () => {
    const { getT1CompletenessOverview } = await import('../monitoring');
    etat.pages = [[ligne(5), ligne(4)], [ligne(3), ligne(2)], [ligne(1)]];
    const ok = await getT1CompletenessOverview({ days: 1, issueScan: { pageSize: 2 } });
    expect(ok).toMatchObject({ byIssueStatus: 'COMPLETE', byIssueTruncated: false, byIssueScanned: 5, byIssueExpected: 5 });
    etat.appelsPage = 0;
    etat.total = 7;
    const ecart = await getT1CompletenessOverview({ days: 1, issueScan: { pageSize: 2 } });
    expect(ecart.byIssueIncomplete).toMatchObject({ cause: 'COUNT_MISMATCH', scanned: 5, expected: 7 });
  });
  it('le curseur garde la précision de la base (microsecondes) : aucun document de la même milliseconde sauté', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/services/ai/source-analysis/source-units/monitoring.ts', 'utf8');
    expect(src).toContain('c.updated_at::text AS "updatedAt"');
    expect(src).not.toContain('new Date(dernier.updatedAt).toISOString()');
  });
});
