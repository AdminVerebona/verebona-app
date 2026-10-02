/**
 * T4-UI-06 / SCR-05 — une décision `skip_duplicate` (rapprochement certain)
 * est enregistrée comme « consolidée » sur l'échéance existante, puis
 * comptée dans les indicateurs T4.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const inserts: Array<Record<string, unknown>> = [];
// Échéance existante : source d'origine et trace déjà présente pour ce couple.
let existing: { origin_ref_type: string | null; origin_ref_id: number | null; already: boolean } | null = null;
const unsafe = vi.fn(async (..._a: unknown[]) => (existing ? [existing] : []));
vi.mock('@/db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
  },
  pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) },
}));

const { persistAgendaDecisions, CONSOLIDATED_EVENT } = await import('../agenda-persistence');
const { getTreatmentMetrics, setMetricsQueryRunner } = await import('@/services/ai/config/treatment-metrics.repository');

const decision = (over: Record<string, unknown> = {}) => ({
  action: 'skip_duplicate',
  title: 'Contrôle technique',
  date: '2026-11-15',
  category: 'action',
  confidence: 'certain',
  reasonCode: 'EXACT_DUPLICATE',
  existingItemId: 7,
  deterministic: true,
  sourceFileId: 9,
  ...over,
}) as never;

beforeEach(() => {
  inserts.length = 0;
  unsafe.mockClear();
  existing = { origin_ref_type: 'asset_file', origin_ref_id: 3, already: false };
});
afterEach(() => setMetricsQueryRunner(null));

describe('persistAgendaDecisions — consolidation', () => {
  it('doublon exact venu d’une AUTRE source : consolidation tracée sur l’échéance existante', async () => {
    await persistAgendaDecisions([decision()], 1, 2);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      agendaItemId: 7,
      accountId: 1,
      eventType: CONSOLIDATED_EVENT,
      detailJson: { reasonCode: 'EXACT_DUPLICATE', date: '2026-11-15', sourceFileId: 9 },
    });
    expect(inserts[0]).not.toHaveProperty('title');
    // Contrôle borné au compte et au couple (échéance, fichier source). Les
    // autres requêtes (colonnes 0223, plan de synchronisation de la source,
    // toujours actif depuis le lot 16b-2) ne portent pas sur la consolidation.
    const controle = unsafe.mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as unknown[]).includes(CONSOLIDATED_EVENT));
    expect(controle?.[1]).toEqual([7, 1, CONSOLIDATED_EVENT, '9']);
  });

  it('occurrences de récurrence déjà présentes : jamais comptées comme consolidations', async () => {
    await persistAgendaDecisions([
      decision({ reasonCode: 'RECURRENCE_OCCURRENCE_EXISTS' }),
      decision({ reasonCode: 'RECURRENCE_OCCURRENCE_IN_PERIOD' }),
      decision({ reasonCode: 'RECURRENCE_OCCURRENCE_USER_PROTECTED' }),
    ], 1, 2);
    expect(inserts).toHaveLength(0);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('réanalyse du document qui a créé l’échéance (même source) : rien', async () => {
    existing = { origin_ref_type: 'asset_file', origin_ref_id: 9, already: false };
    await persistAgendaDecisions([decision()], 1, 2);
    expect(inserts).toHaveLength(0);
  });

  it('couple (échéance, source) déjà tracé : pas de seconde consolidation', async () => {
    existing = { origin_ref_type: 'asset_file', origin_ref_id: 3, already: true };
    await persistAgendaDecisions([decision()], 1, 2);
    expect(inserts).toHaveLength(0);
  });

  it('sans source, sans échéance existante ou échéance hors compte : rien', async () => {
    await persistAgendaDecisions([decision({ sourceFileId: undefined }), decision({ existingItemId: undefined })], 1, 2);
    existing = null;
    await persistAgendaDecisions([decision()], 1, 2);
    expect(inserts).toHaveLength(0);
  });

  it('échéance saisie à la main (sans source) + doublon exact d’un document : consolidation', async () => {
    existing = { origin_ref_type: null, origin_ref_id: null, already: false };
    await persistAgendaDecisions([decision()], 1, 2);
    expect(inserts).toHaveLength(1);
  });
});

describe('metricsT4 — indicateur « consolidées »', () => {
  it('compte les consolidations réelles de la fenêtre', async () => {
    const sqls: string[] = [];
    setMetricsQueryRunner(async (sql) => {
      sqls.push(sql);
      if (/DUPLICATE_CONSOLIDATED/.test(sql)) return [{ total: 4 }];
      return [{}];
    });
    const m = (await getTreatmentMetrics('T4', 7)).metrics.find((x) => x.key === 'consolidated');
    expect(m).toMatchObject({ value: 4, label: 'Consolidées (doublons rattachés)' });
    const sql = sqls.find((s) => /DUPLICATE_CONSOLIDATED/.test(s))!;
    // Doublons exacts seulement, un par couple (échéance, fichier source).
    expect(sql).toMatch(/reasonCode' = 'EXACT_DUPLICATE'/);
    expect(sql).toMatch(/COUNT\(DISTINCT \(agenda_item_id, detail_json ->> 'sourceFileId'\)\)/);
  });
});
