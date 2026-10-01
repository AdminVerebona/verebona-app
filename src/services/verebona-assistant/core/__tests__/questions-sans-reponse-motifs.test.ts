/**
 * CDC Assistant §32.5 (lot 19) — demandes non résolues regroupées par
 * intention et motif : aucune donnée, ambiguïté, absence d'article d'aide,
 * action non supportée, incident technique, hors périmètre. Compteurs
 * seulement, aucun texte.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));
const lecture = vi.fn();
vi.mock('@/services/ai/telemetry/observability.repository', () => ({
  readOnlyObservabilityQuery: (q: string, p: unknown[]) => lecture(q, p),
}));

const { classifyUnanswered, aggregateUnanswered, listUnansweredByMotive } = await import('../unanswered-help.repository');

const g = (over: Record<string, unknown>) => ({
  intent: 'ACCOUNT_FACT_ASSET', status: 'ok', error_code: null, state: 'READY', strategy: 'structured.asset_field',
  no_source: false, ambiguous_ref: false, ...over,
});

describe('motif d’une demande non résolue', () => {
  it.each([
    [{ status: 'error', error_code: 'ASSISTANT_UNAVAILABLE' }, 'incident_technique'],
    [{ status: 'error', error_code: 'REQUEST_TIMEOUT' }, 'incident_technique'],
    [{ strategy: 'timeout.partial' }, 'incident_technique'],
    [{ intent: 'OUT_OF_SCOPE', strategy: null, no_source: true }, 'hors_perimetre'],
    [{ intent: 'SENSITIVE_ADVICE', strategy: null, no_source: true }, 'hors_perimetre'],
    [{ status: 'error', error_code: 'UNSAFE_REQUEST' }, 'hors_perimetre'],
    [{ intent: 'UNSUPPORTED_ACTION', strategy: 'template.unsupported', no_source: true }, 'action_non_supportee'],
    [{ status: 'error', error_code: 'INVALID_ACTION' }, 'action_non_supportee'],
    [{ state: 'CLARIFYING', strategy: 'clarification.asset', no_source: true }, 'ambiguite'],
    [{ ambiguous_ref: true }, 'ambiguite'],
    [{ intent: 'PRODUCT_HELP_HOW_TO', strategy: 'fallback.sources', no_source: true }, 'absence_article_aide'],
    [{ strategy: 'fallback.sources', no_source: true }, 'aucune_donnee'],
    [{ status: 'error', error_code: 'NO_RELEVANT_SOURCE' }, 'aucune_donnee'],
  ])('%o → %s', (over, attendu) => {
    expect(classifyUnanswered(g(over))).toBe(attendu);
  });

  it.each([
    [{}],
    [{ intent: 'GREETING', strategy: 'template.greeting', no_source: true }],
    [{ status: 'error', error_code: 'RATE_LIMITED' }],
    [{ status: 'error', error_code: 'REQUEST_CANCELLED' }],
    [{ state: 'CANCELLED' }],
    [{ status: 'error', error_code: 'PLAN_NOT_ELIGIBLE' }],
  ])('résolue ou hors décompte : %o', (over) => {
    expect(classifyUnanswered(g(over))).toBeNull();
  });
});

describe('regroupements', () => {
  it('par motif (les six, même à zéro) et par intention × motif', () => {
    const r = aggregateUnanswered([
      { ...g({ strategy: 'fallback.sources', no_source: true }), n: 4 },
      { ...g({ intent: 'ACCOUNT_SEARCH_DOCUMENT', strategy: 'fallback.sources', no_source: true }), n: 2 },
      { ...g({ state: 'CLARIFYING', strategy: 'clarification.asset' }), n: 3 },
      { ...g({}), n: 50 },
    ], 30);
    expect(r.total).toBe(9);
    expect(r.byMotive).toHaveLength(6);
    expect(r.byMotive.find((m) => m.motive === 'aucune_donnee')).toEqual({ motive: 'aucune_donnee', label: 'Aucune donnée', count: 6 });
    expect(r.byMotive.find((m) => m.motive === 'hors_perimetre')?.count).toBe(0);
    expect(r.byIntent[0]).toEqual({ intent: 'ACCOUNT_FACT_ASSET', motive: 'aucune_donnee', label: 'Aucune donnée', count: 4 });
    expect(JSON.stringify(r)).not.toMatch(/content|account_id|user/);
  });

  it('lecture : une requête groupée en session lecture seule, sur la période', async () => {
    lecture.mockResolvedValueOnce([{ ...g({ intent: 'OUT_OF_SCOPE', no_source: true }), n: 2 }]);
    const r = await listUnansweredByMotive({ days: 500 });
    expect(r.days).toBe(90);
    expect(r.byMotive.find((m) => m.motive === 'hors_perimetre')?.count).toBe(2);
    const [sql, params] = lecture.mock.calls[0];
    expect(sql).toMatch(/GROUP BY 1, 2, 3, 4, 5, 6, 7/);
    expect(sql).not.toMatch(/content/);
    expect(params).toEqual([90]);
  });
});
