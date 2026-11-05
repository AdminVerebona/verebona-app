/**
 * Lot 111M (ticket « budgets IA », P1 T1) — saturation jugée par rapport à la
 * limite RÉELLEMENT appliquée, saturation dès la première génération, lots
 * redécoupés, couverture vérifiée indépendamment de la validité du JSON.
 *
 * Passerelle RÉELLE (master T1 du dépôt), fournisseur simulé, PDF réel
 * (pdf-lib) servi sans réseau.
 *
 *  L111M-T1-01  cause de saturation : MAX_TOKENS, proportion du plafond transmis, surcharge explicite, repli
 *  L111M-T1-02  plafond BO élevé : 31 000 jetons ne déclenchent plus de découpage inutile (ancien seuil fixe)
 *  L111M-T1-03  saturation INITIALE (aucune sortie exploitable) : reprise par pages dès la page 1, couverture complète
 *  L111M-T1-04  lot de pages lui-même tronqué : redécoupé en moitiés, aucune lacune
 *  L111M-T1-05  saturation initiale, continuation impossible (non PDF / tous les lots en échec) : échec explicite
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LinkCandidate, SourceInput, AnalysisContext } from '../../types';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';

vi.mock('@/services/account-capabilities.service', async (orig) => ({
  ...(await orig<object>()), getAccountCapabilities: async () => ({ rooms: true, equipments: true }),
}));
vi.mock('@/services/ai/telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/telemetry/ai-trace.service')>()),
  recordCallTrace: async () => {},
}));
vi.mock('../../identifier-verifier', () => ({
  verifyCandidates: async (_e: string, candidates: LinkCandidate[]) => ({ candidates: candidates.map((c) => ({ ...c, verified: false })), warnings: [] }),
}));
vi.mock('../../master/rubric-rules', async (orig) => ({
  ...(await orig<typeof import('../../master/rubric-rules')>()),
  loadAssetFamilies: async () => ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT'],
}));
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null, fetched: 0 }));
vi.mock('../page-chunks', async (orig) => ({
  ...(await orig<typeof import('../page-chunks')>()),
  fetchSourceBytes: async () => { pdf.fetched++; return pdf.bytes; },
}));

const { FakeProvider, setAiProvider } = await import('@/services/ai/gateway/providers');
const { __setConfigForTests } = await import('@/services/ai/config/config-resolver');
const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
const { analyseGroupWithMaster } = await import('../../master/analyse-group-master');
const { emptyTrace } = await import('../../trace');
const { saturationCause } = await import('../page-chunks');

let fake: InstanceType<typeof FakeProvider>;
const ctx: AnalysisContext = { accountId: 1, userId: 1, assets: [], rooms: [], equipments: [], existingTitles: [], linkedAssetId: null };
const input = (over: Partial<SourceInput> = {}): SourceInput => ({
  sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 1, mimeTypes: ['application/pdf'], displayNames: ['document.pdf'],
  contentUrls: ['https://s3.example/doc.pdf?sig=1'], ...over,
});
const fait = (excerpt: string, value: string, page = 1) => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page },
});
const sortie = (transcription: string, facts: unknown[]) => ({
  task: 'ANALYZE_DOCUMENT',
  document: { title: { value: 'Règlement', confidence: 'certain', evidence: { excerpt: 'Règlement', page: 1 } } },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  transcription, tables: [], facts, hasExploitableContent: true,
});
/** Lot de pages k..l : une ligne « Article p : REF-p » par page (numérotée 1…n dans le lot). */
const lot = (a: number, b: number) => {
  const pages = Array.from({ length: b - a + 1 }, (_, k) => a + k);
  return sortie(pages.map((p, k) => `--- page ${k + 1} ---\nArticle ${p} : REF-${p}`).join('\n'),
    pages.map((p, k) => fait(`Article ${p} : REF-${p}`, `REF-${p}`, k + 1)));
};
const pagesDuLot = (i: ProviderCallInput) => {
  const m = /pages (\d+) à (\d+)/.exec(i.attachments[0]?.displayName ?? '');
  return m ? [Number(m[1]), Number(m[2])] as const : null;
};
const TRONQUE = (i: ProviderCallInput) => ({ rawText: '{"task":"ANALYZE_DOCUMENT","transcription":"Article 1', inputTokens: 100, outputTokens: i.maxOutputTokens ?? 1000, meta: { finishReason: 'MAX_TOKENS' } });
const pdfDe = async (n: number) => {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage();
  pdf.bytes = await doc.save();
};
const config = (p: Record<string, unknown> = {}) => __setConfigForTests({
  versionId: 1, entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: null, fallback2: null, promptArchitecture: 'master', ...p }],
});

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  config();
  pdf.bytes = null;
  pdf.fetched = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  process.env.T1_CHUNK_PAGES = '2';
});
afterEach(() => { __setConfigForTests(null); vi.restoreAllMocks(); delete process.env.T1_CHUNK_PAGES; });

describe('L111M-T1-01 — cause de saturation', () => {
  it('MAX_TOKENS du fournisseur, proportion du plafond TRANSMIS (raisonnement compris), surcharge explicite, repli historique', () => {
    expect(saturationCause({ outputTokens: 10, finishReason: 'MAX_TOKENS' })).toBe('PROVIDER_MAX_TOKENS');
    expect(saturationCause({ outputTokens: 31_000, maxOutputTokensSent: 65_536 })).toBeNull();
    expect(saturationCause({ outputTokens: 50_000, thoughtsTokens: 9_000, maxOutputTokensSent: 65_536 })).toBe('NEAR_APPLIED_LIMIT');
    expect(saturationCause({ outputTokens: 7_400, maxOutputTokensSent: 8_192 })).toBe('NEAR_APPLIED_LIMIT');
    expect(saturationCause({ outputTokens: 31_000, maxOutputTokensSent: 65_536 }, { T1_SATURATION_OUTPUT_TOKENS: '30000' })).toBe('EXPLICIT_THRESHOLD');
    expect(saturationCause({ outputTokens: 31_000 })).toBe('LEGACY_THRESHOLD');
  });
});

describe('L111M-T1-02 — plafond élevé : aucun découpage inutile', () => {
  it('BO 65 536 : une sortie complète de 31 000 jetons n’est plus « saturée » (ancien seuil fixe 30 000 : 3 lots de trop)', async () => {
    config({ maxOutputTokens: 65_536 });
    await pdfDe(6);
    fake.on('m-a', (i) => (pagesDuLot(i)
      ? { rawText: JSON.stringify(lot(...pagesDuLot(i)!)), inputTokens: 100, outputTokens: 50 }
      : { rawText: JSON.stringify(lot(1, 6)), inputTokens: 100, outputTokens: 31_000, meta: { finishReason: 'STOP' } }));
    const m = await analyseGroupWithMaster(input(), [0], ctx, emptyTrace());
    expect(fake.calls.filter((c) => pagesDuLot(c))).toHaveLength(0);
    expect(fake.calls[0].maxOutputTokens).toBe(65_536);
    expect(m.sourceLayer!.report.chunkCount).toBe(0);
    expect(m.facts.map((f) => f.value).sort()).toEqual(['REF-1', 'REF-2', 'REF-3', 'REF-4', 'REF-5', 'REF-6']);
  });
});

describe('L111M-T1-03/04 — saturation initiale et lots redécoupés', () => {
  it('passe 1 tronquée (aucun JSON exploitable) : relue par pages dès la page 1, couverture COMPLÈTE, jamais une perte silencieuse', async () => {
    await pdfDe(5);
    fake.on('m-a', (i) => (pagesDuLot(i) ? { rawText: JSON.stringify(lot(...pagesDuLot(i)!)), inputTokens: 100, outputTokens: 50 } : TRONQUE(i)));
    const m = await analyseGroupWithMaster(input(), [0], ctx, emptyTrace());
    const lots = fake.calls.filter((c) => pagesDuLot(c)).map((c) => pagesDuLot(c));
    expect(lots[0]).toEqual([1, 2]);
    expect(m.facts.map((f) => f.value).sort()).toEqual(['REF-1', 'REF-2', 'REF-3', 'REF-4', 'REF-5']);
    expect(m.sourceLayer!.report.qualityState).toBe('COMPLETE');
    expect(m.result.warnings.some((w) => w.target === 't1-master:initial-saturation')).toBe(true);
  });

  it('lot de pages tronqué : redécoupé en moitiés (borné), toutes les pages lues, aucune lacune', async () => {
    await pdfDe(4);
    process.env.T1_CHUNK_PAGES = '4';
    fake.on('m-a', (i) => {
      const p = pagesDuLot(i);
      if (!p) return { rawText: JSON.stringify(lot(1, 1)), inputTokens: 100, outputTokens: 31_000 };
      // Lot de plus de 2 pages : sortie tronquée ; moitiés : lues.
      return p[1] - p[0] + 1 > 2 ? TRONQUE(i) : { rawText: JSON.stringify(lot(...p)), inputTokens: 100, outputTokens: 50 };
    });
    const m = await analyseGroupWithMaster(input(), [0], ctx, emptyTrace());
    expect(m.facts.map((f) => f.value).sort()).toEqual(['REF-1', 'REF-2', 'REF-3', 'REF-4']);
    expect(m.sourceLayer!.units.filter((u) => u.kind === 'PAGE_GAP')).toHaveLength(0);
    expect(m.sourceLayer!.report.qualityState).toBe('COMPLETE');
  });
});

describe('L111M-T1-05 — continuation impossible : échec explicite, jamais ANALYZED', () => {
  it('image tronquée dès la passe 1 : erreur de la passerelle (cause OUTPUT_TRUNCATED) remontée', async () => {
    fake.on('m-a', TRONQUE);
    await expect(analyseGroupWithMaster(input({ mimeTypes: ['image/jpeg'], contentUrls: ['https://s3.example/x.jpg'] }), [0], ctx, emptyTrace()))
      .rejects.toMatchObject({ failureCause: 'OUTPUT_TRUNCATED' });
  });

  it('PDF tronqué dès la passe 1 et tous les lots en échec : erreur d’origine, aucune analyse vide « réussie »', async () => {
    await pdfDe(2);
    fake.on('m-a', (i) => (pagesDuLot(i) ? (() => { throw Object.assign(new Error('fournisseur indisponible'), { status: 503 }); })() : TRONQUE(i)));
    await expect(analyseGroupWithMaster(input(), [0], ctx, emptyTrace())).rejects.toMatchObject({ failureCause: 'OUTPUT_TRUNCATED' });
  });
});
