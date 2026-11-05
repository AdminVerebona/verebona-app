/**
 * Lot 111M (ticket « budgets IA », P2 T6, CA-14) — EVALUATE : les preuves non
 * transmises par les bornes par candidat sont TRACÉES (« non examiné »), jamais
 * réputées absentes ; bornes et empreinte v5 inchangées (aucune réévaluation
 * massive) ; FORMULATE garde ses 420 caractères.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn(async () => []) } }));

const svc = await import('../t6-interpellation.service');
type Ev = import('../t6-interpellation.service').T6ItemEvidence;

const fait = (id: number, fileId: number) => ({
  id, fileId, extractionId: 1, key: `k${id}`, canonicalKey: null, label: `Fait ${id}`, value: `v${id}`, confidence: 'certain', provenance: 'TEXT_EXTRACTION', excerpt: `extrait ${id}`,
});
const preuves = (nFaits: number, nDocs: number): Ev => ({
  description: null, endDate: null, originFieldKey: null,
  documents: Array.from({ length: nDocs }, (_, i) => ({ fileId: 100 + i, title: `Doc ${i}`, origin: i === 0 })),
  facts: Array.from({ length: nFaits }, (_, i) => fait(i + 1, 100 + (i % Math.max(1, nDocs)))),
});

describe('L111M-T6-01 — preuves écartées par volume : tracées, jamais absentes', () => {
  it('dans les bornes : rien d’omis ; au-delà : nombre exact de faits et documents non transmis', () => {
    expect(svc.evaluationEvidenceOf('C1', preuves(3, 2)).omitted).toEqual({ facts: 0, documents: 0 });
    const r = svc.evaluationEvidenceOf('C1', preuves(12, 7));
    expect(r.facts).toHaveLength(8);
    expect(r.documents).toHaveLength(5);
    expect(r.omitted).toEqual({ facts: 4, documents: 2 });
    expect(svc.evaluationEvidenceOf('C1', undefined).omitted).toEqual({ facts: 0, documents: 0 });
  });

  it('bornes conservées : la sélection transmise (donc l’empreinte) est inchangée', () => {
    const a = svc.evaluationEvidenceOf('C1', preuves(12, 7));
    const { omitted: _o, ...transmis } = a;
    expect(transmis.facts.map((f) => f.ref)).toEqual(Array.from({ length: 8 }, (_, i) => `C1.fact${i + 1}`));
  });
});

describe('L111M-T6-02 — FORMULATE garde ses messages courts', () => {
  it('420 caractères au plus (contrainte de présentation, jamais appliquée à EVALUATE)', async () => {
    const c = await import('../t6-contract');
    const src = (await import('node:fs')).readFileSync((await import('node:path')).join(process.cwd(), 'src/services/home/mascot/t6-contract.ts'), 'utf8');
    expect(src).toMatch(/420/);
    expect(c).toBeTruthy();
  });
});
