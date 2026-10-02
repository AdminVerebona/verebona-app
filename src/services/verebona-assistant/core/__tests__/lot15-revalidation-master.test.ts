/**
 * CDC 15 lot 15 — revalidation : branche REVALIDATE du master (§24),
 * VISUAL_RECHECK (T2-30, P-T2-04), aucune écriture hors pipeline protégé et
 * trace d'impact (T2-27), propagation T3 → T4 par la projection (T2-28).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sql: [] as Array<{ q: string; params: unknown[] }>,
  fact: null as Record<string, unknown> | null,
  projectKnowledge: vi.fn(async (_p: Record<string, unknown>) => 3),
}));

vi.mock('@/db', () => {
  const run = async (q: string, params: unknown[] = []) => {
    h.sql.push({ q, params });
    if (/FROM document_facts f/.test(q)) return h.fact ? [h.fact] : [];
    if (/FROM verebona_fact_revalidations/.test(q)) return [];
    if (/INSERT INTO verebona_fact_revalidations/.test(q)) return [{ id: 900 }];
    if (/INSERT INTO t1_quality_signals/.test(q)) return [{ id: 50 }];
    if (/INSERT INTO document_facts/.test(q)) return [{ id: 1001 }];
    return [];
  };
  return {
    pgClient: { unsafe: vi.fn(run), begin: vi.fn(async (cb: (tx: unknown) => unknown) => cb({ unsafe: run })) },
    db: {},
  };
});
vi.mock('@/services/ai/knowledge/document-knowledge.service', () => ({
  projectDocumentKnowledgeToAsset: (p: Record<string, unknown>) => h.projectKnowledge(p),
}));

const { revalidateFact, fromT2Revalidate, defaultRevalidationDeps } = await import('../revalidation.service');
type Deps = import('../revalidation.service').RevalidationDeps;

const textFact = {
  id: 11, accountId: 1, fileId: 55, extractionId: 5, factKey: 'mileage', subject: 'Clio', attribute: 'Kilométrage', label: null,
  valueText: '48 250 km', valueNumber: null, valueUnit: null, confidence: 'probable', excerpt: 'Kilométrage : 48 250 km',
  location: { page: 2 }, fullText: 'Contrôle technique. Kilométrage : 48 250 km.', extractionVersion: 'v1', t1Model: 'm', t1PromptVersion: 'p',
  analysisRunId: null, assetId: 10, evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null,
};
const visualFact = {
  ...textFact, id: 12, factKey: 'heatingType', attribute: 'Chaudière', valueText: 'murale', excerpt: null, fullText: null,
  evidenceOrigin: 'VISUAL_ANALYSIS', visualEvidence: { description: 'chaudière murale visible', page: 1 }, location: { page: 1 },
};

const deps = (over: Partial<Deps> = {}): Deps & { calls: Array<Record<string, unknown>> } => {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    callModel: vi.fn(async (req) => { calls.push(req as unknown as Record<string, unknown>); return null; }),
    sourceUrl: vi.fn(async () => ({ url: 'https://s3/x', mimeType: 'image/jpeg' })),
    project: vi.fn(async () => 2),
    replaceEvidence: vi.fn(async (p) => { await p.project(); return { mode: 'enabled' as const, superseded: 1, projected: true }; }),
    ...over,
  } as Deps & { calls: Array<Record<string, unknown>> };
};

/** Écritures SQL : seules la connaissance documentaire et les traces sont permises (T2-27). */
const ecritures = () => h.sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.q))
  .map((s) => /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/i.exec(s.q)?.[1]);

beforeEach(() => { h.sql = []; h.fact = null; h.projectKnowledge.mockClear(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('fromT2Revalidate (P-T2-04)', () => {
  it('VISUAL : l’extrait est retiré, la preuve visuelle conservée', () => {
    const o = fromT2Revalidate({
      status: 'confirmed', value: 'murale', confidence: 'certain',
      evidence: { provenance: 'VISUAL_ANALYSIS', excerpt: 'texte inventé', page: 1, visualEvidence: 'chaudière murale' },
    }, 'VISUAL');
    expect(o).toMatchObject({ excerpt: null, visualEvidence: { description: 'chaudière murale', page: 1 } });
  });
  it('TEXT : extrait conservé, aucune preuve visuelle', () => {
    const o = fromT2Revalidate({
      status: 'corrected', value: '52 000 km', confidence: 'certain',
      evidence: { provenance: 'TEXT_EXTRACTION', excerpt: 'Kilométrage : 52 000 km', page: 2 },
    }, 'TEXT');
    expect(o).toMatchObject({ excerpt: 'Kilométrage : 52 000 km', visualEvidence: null, page: 2 });
  });
});

describe('revalidateFact — branche REVALIDATE du master T2 (seul moteur, lot 16b-2)', () => {
  it('fait LU : branche REVALIDATE, PROVENANCE_MODE=TEXT', async () => {
    h.fact = { ...textFact };
    const d = deps();
    await revalidateFact({ accountId: 1, userId: 3, factId: 11, question: 'kilométrage ?', trigger: 'CONFLICT' }, d);
    expect(d.calls[0]).toMatchObject({ provenance: 'TEXT', mode: 'PERSISTED_CONTENT' });
    expect(d.calls[0]).not.toHaveProperty('architecture');
    // Les observations visuelles sont chargeables (VISUAL_RECHECK).
    expect(h.sql[0].params[2]).toBe(true);
  });

  it('VISUAL_RECHECK : relue sur la source, jamais d’extrait, jamais « certaine », réinjectée en VISUAL_ANALYSIS', async () => {
    h.fact = { ...visualFact };
    const d = deps({
      callModel: vi.fn(async () => ({
        output: { status: 'confirmed' as const, value: 'murale', confidence: 'certain' as const, excerpt: null, page: 1,
          visualEvidence: { description: 'chaudière murale au mur de la cuisine', page: 1 } },
        model: 'm', costMicros: 1,
      })),
    });
    const r = await revalidateFact({ accountId: 1, userId: 3, factId: 12, question: 'type de chaudière ?', trigger: 'LOW_CONFIDENCE' }, d);
    expect(r).toMatchObject({ mode: 'VISUAL_RECHECK', status: 'CONFIRMED', confidence: 'probable', excerpt: null, reinjectedFactId: 1001 });
    expect(d.sourceUrl).toHaveBeenCalled();
    const insert = h.sql.find((s) => /INSERT INTO document_facts/.test(s.q))!;
    expect(insert.q).toMatch(/'VISUAL_ANALYSIS'/);
    expect(insert.q).toMatch(/\$13,NULL,/);
    expect(JSON.parse(String(insert.params[16]))).toEqual({ description: 'chaudière murale au mur de la cuisine', page: 1 });
    // T2-27 : impact tracé, aucune écriture sur le bien hors projection.
    expect(r?.impact).toEqual({
      assetId: 10, projected: true, projectedFields: 2, supersededEvidence: 1, evidenceMode: 'enabled', t4Effects: 'enabled', directAssetWrites: 0,
    });
    const signal = h.sql.find((s) => /INSERT INTO t1_quality_signals/.test(s.q))!;
    expect(JSON.parse(String(signal.params[7]))).toMatchObject({ mode: 'VISUAL_RECHECK', architecture: 'master', impact: { projected: true } });
    expect(new Set(ecritures())).toEqual(new Set(['verebona_fact_revalidations', 'document_facts', 't1_quality_signals']));
  });

  it('VISUAL_RECHECK sans preuve visuelle : ambigu, rien de réinjecté ni projeté', async () => {
    h.fact = { ...visualFact };
    const d = deps({
      callModel: vi.fn(async () => ({ output: { status: 'corrected' as const, value: 'au sol', confidence: 'probable' as const, visualEvidence: null }, model: 'm', costMicros: 0 })),
    });
    const r = await revalidateFact({ accountId: 1, userId: 3, factId: 12, question: 'q', trigger: 'CONFLICT' }, d);
    expect(r).toMatchObject({ status: 'AMBIGUOUS', reinjectedFactId: null, impact: null });
    expect(d.project).not.toHaveBeenCalled();
  });
});

describe('T2-28 — propagation T3 → T4 par la projection du rattachement tardif', () => {
  it('la projection par défaut est projectDocumentKnowledgeToAsset (preuves, T3, candidats agenda T4)', async () => {
    const n = await defaultRevalidationDeps.project({ accountId: 1, userId: 3, fileId: 55, assetId: 10 });
    expect(h.projectKnowledge).toHaveBeenCalledWith({ accountId: 1, userId: 3, fileId: 55, assetId: 10 });
    expect(n).toBe(3);
  });
});
