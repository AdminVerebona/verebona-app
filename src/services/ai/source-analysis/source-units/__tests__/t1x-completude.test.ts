/**
 * Lot 34F — ticket « T1 — Garantir une extraction exhaustive, persistée et
 * réexploitable » : cas obligatoires T1X-01 à T1X-08 (unitaires).
 *
 * Passerelle RÉELLE (master `t1_master_v1.txt` du dépôt, inchangé ; TASK
 * injectée ; lecture tolérante ; validation) ; seul le fournisseur est
 * simulé. Les mêmes cas sont rejoués sur base réelle dans
 * `src/test/e2e/scenarios/l34f-t1-extraction-exhaustive.e2e.ts`.
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
  verifyCandidates: async (_e: string, candidates: LinkCandidate[]) => ({
    candidates: candidates.map((c) => ({ ...c, verified: c.entityId === 12 })), warnings: [],
  }),
}));
vi.mock('../../master/rubric-rules', async (orig) => ({
  ...(await orig<typeof import('../../master/rubric-rules')>()),
  loadAssetFamilies: async () => ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT'],
}));
/** PDF servi au découpage par pages (aucun réseau). */
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
const { buildSourceUnits, fullTextOf, cellUnitId } = await import('../build-units');
const { buildCompletenessReport, computeCoverage, selectRepairUnits, SourceUnitLinker } = await import('../coverage');
const { mergeFacts, factFingerprint } = await import('../merge');
const { planChunks, isSaturated } = await import('../page-chunks');
const { completenessLogLine } = await import('../monitoring');
const { buildKnowledgeFromSourceAnalysis } = await import('../../../knowledge/document-knowledge');

let fake: InstanceType<typeof FakeProvider>;

const ctx: AnalysisContext = { accountId: 1, userId: 1, assets: [], rooms: [], equipments: [], existingTitles: [], linkedAssetId: null };
const input = (over: Partial<SourceInput> = {}): SourceInput => ({
  sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 1, mimeTypes: ['application/pdf'], displayNames: ['document.pdf'], ...over,
});

type Fait = Record<string, unknown>;
const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const sortie = (p: { transcription?: string; facts?: Fait[]; tables?: unknown[]; observations?: unknown[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: { title: { value: 'Relevé de test', confidence: 'certain', evidence: { excerpt: 'Relevé de test', page: 1 } } },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  ...(p.observations ? { visual: { observations: p.observations } } : {}),
  tables: p.tables ?? [],
  facts: p.facts ?? [],
  hasExploitableContent: true,
});

const repondre = (fn: (i: ProviderCallInput) => { output: unknown; outputTokens?: number } | Error) => {
  fake.on('m-a', (i) => {
    const r = fn(i);
    if (r instanceof Error) throw r;
    return { rawText: JSON.stringify(r.output), inputTokens: 100, outputTokens: r.outputTokens ?? 50 };
  });
};
const estReparation = (i: ProviderCallInput) => /\[page:\d+:(?:field|block|form):\d+\]/.test(i.prompt);
const analyser = (over: Partial<SourceInput> = {}) => analyseGroupWithMaster(input(over), [0], ctx, emptyTrace());

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  __setConfigForTests({
    versionId: 1,
    entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: null, fallback2: null, promptArchitecture: 'master' }],
  });
  pdf.bytes = null;
  pdf.fetched = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  delete process.env.T1_MAX_REPAIR_PASSES;
});
afterEach(() => { __setConfigForTests(null); vi.restoreAllMocks(); });

// ══ Couche A : identifiants stables, découpage sans perte ═══════════════════

describe('couche A — unités de la source', () => {
  it('identifiants stables : blocs, couples libellé / valeur, formulaire, tableau / ligne / cellule, observation, métadonnée, page', () => {
    const t = '--- page 1 ---\nFACTURE N° F-2026-118\n\nKilométrage : 78 000 km\n☒ Contrôle technique effectué\n--- page 2 ---\nTravaux réalisés sur le véhicule.';
    const units = buildSourceUnits({
      segments: [{ text: t, pageOffset: 0, origin: 'PASS_1' }],
      tables: [{ index: 1, title: 'Pièces', pageStart: 5, pageEnd: 5, columns: [{ header: 'Réf', path: ['Réf'] }], rowCount: 1, columnCount: 1,
        cells: [{ row: 0, column: 0, rowHeader: null, columnHeader: 'Réf', columnPath: ['Réf'], value: 'KIT-1', normalized: null, valueType: null, colspan: 1, rowspan: 1, page: 5, confidence: 'certain' }],
        confidence: 'certain', uncertain: false, issues: [] }],
      visual: { observations: [{ description: 'Chaudière murale', confidence: 'probable', page: 7 }] },
      document: { title: { value: 'Facture', confidence: 'certain', evidence: {} } },
    });
    expect(units.map((u) => u.sourceUnitId)).toEqual([
      'doc:meta:title', 'page:1:block:1', 'page:1:field:1', 'page:1:form:1', 'page:2:block:1',
      'page:5:table:2', 'page:5:table:2:row:1', 'page:7:visual:1',
    ]);
    expect(units.find((u) => u.kind === 'LABEL_VALUE')).toMatchObject({ label: 'Kilométrage', value: '78 000 km', salient: true });
    expect(units.find((u) => u.kind === 'FORM_FIELD')?.payload).toEqual({ checked: true });
    expect(cellUnitId({ index: 1, pageStart: 5 }, 0, 0)).toBe('page:5:table:2:row:1:cell:1');
    // Même contenu ⇒ mêmes identifiants (fusion idempotente).
    expect(buildSourceUnits({ segments: [{ text: t, pageOffset: 0, origin: 'PASS_1' }] }).map((u) => u.sourceUnitId))
      .toEqual(buildSourceUnits({ segments: [{ text: t, pageOffset: 0, origin: 'PASS_1' }] }).map((u) => u.sourceUnitId));
  });

  it('pied de page « Page N/M » : unité non informative, page suivante ; lot de pages décalé', () => {
    const units = buildSourceUnits({ segments: [
      { text: 'Bloc A\nPage 1/2\nBloc B', pageOffset: 0, origin: 'PASS_1' },
      { text: 'Bloc C', pageOffset: 10, origin: 'CHUNK' },
    ] });
    expect(units.map((u) => [u.sourceUnitId, u.text])).toEqual([
      ['page:1:block:1', 'Bloc A'], ['page:1:block:2', 'Page 1/2'], ['page:2:block:1', 'Bloc B'], ['page:11:block:1', 'Bloc C'],
    ]);
    const cov = computeCoverage(units, { facts: [] });
    expect(cov.find((u) => u.text === 'Page 1/2')?.status).toBe('NON_INFORMATIONAL');
  });
});

// ══ T1X-01 — document simple ════════════════════════════════════════════════

describe('T1X-01 — document simple (20 informations)', () => {
  it('20 informations conservées, couverture complète, aucune reprise (un seul appel)', async () => {
    const lignes = Array.from({ length: 20 }, (_, i) => `Référence ${i + 1} : REF-${1000 + i}`);
    repondre(() => ({ output: sortie({
      transcription: ['Relevé de test', ...lignes].join('\n'),
      facts: lignes.map((l, i) => fait(l, `REF-${1000 + i}`)),
    }) }));
    const m = await analyser();
    expect(fake.calls).toHaveLength(1);
    expect(m.facts).toHaveLength(20);
    const r = m.sourceLayer!.report;
    expect(r).toMatchObject({ factsCount: 20, repairPassCount: 0, qualityState: 'COMPLETE', coverageRatio: 1, anomalies: [] });
    expect(r.coveredUnits + r.nonInformationalUnits + r.unresolvedUnits + r.uncertainUnits + r.failedUnits).toBe(r.totalSourceUnits);
    // Provenance : fait → unité.
    expect(m.facts[0].sourceUnitIds).toEqual(['page:1:field:1']);
    expect(m.result.extractedFields[19].sourceUnitIds).toEqual(['page:1:field:20']);
    expect(m.result.warnings.map((w) => w.code)).not.toContain('COVERAGE_INCOMPLETE');
  });
});

// ══ T1X-02 — plus de 300 faits ══════════════════════════════════════════════

describe('T1X-02 — document dépassant 300 facts', () => {
  it('350 faits persistés, aucune perte, lot de débordement automatique, aucune troncature définitive', async () => {
    const lignes = Array.from({ length: 350 }, (_, i) => `Compteur ${i + 1} : CPT-${10_000 + i}`);
    repondre(() => ({ output: sortie({
      transcription: lignes.join('\n'),
      facts: lignes.map((l, i) => fait(l, `CPT-${10_000 + i}`)),
    }) }));
    const m = await analyser();
    expect(fake.calls).toHaveLength(1);
    expect(m.facts).toHaveLength(350);
    expect(m.result.warnings.map((w) => w.code)).not.toContain('FACTS_TRUNCATED');
    expect(m.sourceLayer!.report).toMatchObject({ factsCount: 350, truncatedSectionsCount: 0, qualityState: 'COMPLETE' });
    expect(m.sourceLayer!.report.batchedSectionsCount).toBeGreaterThanOrEqual(1);
    expect(m.facts[349].sourceUnitIds).toEqual(['page:1:field:350']);
    // Persistance : les 350 faits partent dans la base de connaissance.
    const k = buildKnowledgeFromSourceAnalysis(m.result, { accountId: 1, fileId: 1000, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file', sourceLayer: m.sourceLayer });
    expect(k.facts).toHaveLength(350);
    expect(k.facts[349].sourceUnitIds).toEqual(['page:1:field:350']);
    expect(k.sourceLayer?.report.factsCount).toBe(350);
  });
});

// ══ T1X-03 — document très long ═════════════════════════════════════════════

describe('T1X-03 — document très long', () => {
  it('transcription > 200 000 caractères : 100 % du texte conservé et découpé en unités', async () => {
    const lignes = Array.from({ length: 6_000 }, (_, i) => `Paragraphe numéro ${i} du règlement de copropriété, sans valeur structurée ici.`);
    const texte = lignes.join('\n');
    expect(texte.length).toBeGreaterThan(200_000);
    repondre(() => ({ output: sortie({ transcription: texte }) }));
    const m = await analyser({ contentUrls: ['https://s3.example/doc.pdf?sig=1'] });
    expect(m.result.document.transcription).toBe(texte);
    // Texte rendu en entier par le modèle : pas une saturation, aucun découpage.
    expect(pdf.fetched).toBe(0);
    expect(fake.calls).toHaveLength(1);
    const blocs = m.sourceLayer!.units.filter((u) => u.kind === 'TEXT_BLOCK');
    // Aucun caractère perdu : la concaténation des blocs redonne le texte.
    expect(blocs.map((u) => u.text).join('\n')).toBe(texte);
    expect(m.sourceLayer!.report.truncatedSectionsCount).toBe(0);
    expect(m.sourceLayer!.report.batchedSectionsCount).toBeGreaterThanOrEqual(1);
  });

  it('sortie saturée d’un long PDF : poursuite par lots de pages, fusion, pages réelles, plusieurs chunks', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 6; i++) doc.addPage();
    pdf.bytes = await doc.save();
    process.env.T1_CHUNK_PAGES = '2';
    try {
      repondre((i) => {
        const lot = i.attachments[0]?.data ? i.attachments[0].displayName ?? '' : '';
        if (!lot) {
          return { outputTokens: 31_000, output: sortie({
            transcription: '--- page 1 ---\nIntroduction : SYND-001\n--- page 2 ---\nArticle 2 : SYND-002',
            facts: [fait('Introduction : SYND-001', 'SYND-001'), fait('Article 2 : SYND-002', 'SYND-002', { evidence: { excerpt: 'Article 2 : SYND-002', page: 2 } })],
          }) };
        }
        const m = /pages (\d+) à (\d+)/.exec(lot)!;
        const a = Number(m[1]);
        const b = Number(m[2]);
        const pages = Array.from({ length: b - a + 1 }, (_, k) => a + k);
        return { output: sortie({
          transcription: pages.map((p, k) => `--- page ${k + 1} ---\nArticle ${p} : SYND-00${p}`).join('\n'),
          facts: pages.map((p, k) => fait(`Article ${p} : SYND-00${p}`, `SYND-00${p}`, { evidence: { excerpt: `Article ${p} : SYND-00${p}`, page: k + 1 } })),
        }) };
      });
      const m = await analyser({ contentUrls: ['https://s3.example/doc.pdf?sig=1'] });
      expect(pdf.fetched).toBe(1);
      // Pages 2-3, 4-5, 6 : trois lots (la page 2, peut-être coupée, est relue).
      expect(fake.calls.filter((c) => c.attachments[0]?.data)).toHaveLength(3);
      const r = m.sourceLayer!.report;
      expect(r.chunkCount).toBe(3);
      expect(r.qualityState).toBe('COMPLETE');
      // Fusion idempotente : SYND-002 (page relue) une seule fois ; pages réelles.
      expect(m.facts.map((f) => f.value).sort()).toEqual(['SYND-001', 'SYND-002', 'SYND-003', 'SYND-004', 'SYND-005', 'SYND-006']);
      expect(m.facts.find((f) => f.value === 'SYND-006')?.sourceUnitIds).toEqual(['page:6:field:1']);
      expect(m.result.document.transcription).toContain('Article 6 : SYND-006');
    } finally {
      delete process.env.T1_CHUNK_PAGES;
    }
  });

  it('lot de pages en échec : lacune FAILED (jamais silencieuse), état INCOMPLETE_RETRYABLE, anomalies', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage();
    pdf.bytes = await doc.save();
    repondre((i) => (i.attachments[0]?.data
      ? Object.assign(new Error('fournisseur indisponible'), { status: 503 })
      : { outputTokens: 31_000, output: sortie({ transcription: 'Début : A-0001', facts: [fait('Début : A-0001', 'A-0001')] }) }));
    const m = await analyser({ contentUrls: ['https://s3.example/doc.pdf?sig=1'] });
    const lacune = m.sourceLayer!.units.find((u) => u.kind === 'PAGE_GAP');
    expect(lacune).toMatchObject({ sourceUnitId: 'page:2:gap:3', status: 'FAILED' });
    expect(m.sourceLayer!.report).toMatchObject({ failedUnits: 1, qualityState: 'INCOMPLETE_RETRYABLE' });
    expect(m.sourceLayer!.report.anomalies).toEqual(expect.arrayContaining(['SOURCE_UNIT_FAILED', 'COVERAGE_INCOMPLETE']));
    expect(m.result.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['SOURCE_UNIT_FAILED', 'COVERAGE_INCOMPLETE']));
  });

  it('saturation sans découpage possible (image) : section tronquée signalée, INCOMPLETE_FINAL, FACTS_TRUNCATED', async () => {
    repondre(() => ({ outputTokens: 31_000, output: sortie({ transcription: 'Ligne : B-0001', facts: [fait('Ligne : B-0001', 'B-0001')] }) }));
    const m = await analyser({ mimeTypes: ['image/jpeg'], contentUrls: ['https://s3.example/x.jpg'] });
    expect(m.sourceLayer!.report).toMatchObject({ truncatedSectionsCount: 1, qualityState: 'INCOMPLETE_FINAL' });
    expect(m.sourceLayer!.report.anomalies).toEqual(expect.arrayContaining(['FACTS_TRUNCATED', 'COVERAGE_INCOMPLETE']));
    expect(m.result.warnings.map((w) => w.code)).toContain('FACTS_TRUNCATED');
  });
});

// ══ T1X-04 — fait invalide ══════════════════════════════════════════════════

describe('T1X-04 — fait invalide', () => {
  it('donnée hors schéma : pas perdue → faits non résolus (charge d’origine), unité source conservée, UNRESOLVED', async () => {
    repondre((i) => (estReparation(i)
      ? { output: sortie({ facts: [] }) }
      : { output: sortie({
          transcription: 'Relevé de test\nPuissance souscrite : 9 kVA',
          facts: [fait('Puissance souscrite : 9 kVA', '9 kVA', { target: { type: 'BATIMENT' } })],
        }) }));
    const m = await analyser();
    const l = m.sourceLayer!;
    const rec = l.unresolvedFacts.find((f) => f.reason === 'INVALID_SCHEMA');
    expect(rec).toMatchObject({ status: 'UNRESOLVED', sourceUnitIds: ['page:1:field:1'], rawValue: '9 kVA', pass: 'PASS_1' });
    expect((rec!.originalPayload as { target: unknown }).target).toEqual({ type: 'BATIMENT' });
    expect(l.units.find((u) => u.sourceUnitId === 'page:1:field:1')).toMatchObject({ status: 'UNRESOLVED', reason: 'fact_dropped', text: 'Puissance souscrite : 9 kVA' });
    expect(l.report).toMatchObject({ droppedFactsCount: 1, qualityState: 'COMPLETE_WITH_UNRESOLVED', repairPassCount: 1 });
    expect(l.report.anomalies).toContain('FACT_INVALID_DROPPED');
  });

  it('fait sans preuve : conservé (NO_EVIDENCE) ; retrouvé par la réparation ciblée → RECOVERED', async () => {
    repondre((i) => (estReparation(i)
      ? { output: sortie({ facts: [fait('N° compteur : PDL-123456', 'PDL-123456')] }) }
      : { output: sortie({
          transcription: 'Relevé de test\nN° compteur : PDL-123456',
          facts: [fait('N° compteur : PDL-123456', 'PDL-123456', { evidence: {} })],
        }) }));
    const m = await analyser();
    const rec = m.sourceLayer!.unresolvedFacts.find((f) => f.reason === 'NO_EVIDENCE');
    expect(rec).toMatchObject({ status: 'RECOVERED', sourceUnitIds: ['page:1:field:1'], rawValue: 'PDL-123456' });
    expect(m.facts.map((f) => f.value)).toEqual(['PDL-123456']);
    expect(m.sourceLayer!.units.find((u) => u.sourceUnitId === 'page:1:field:1')?.status).toBe('COVERED');
  });

  it('fait mal formé retrouvé par la réparation : statut RECOVERED, plus de fait écarté compté', async () => {
    repondre((i) => (estReparation(i)
      ? { output: sortie({ facts: [fait('Puissance souscrite : 9 kVA', '9 kVA')] }) }
      : { output: sortie({
          transcription: 'Relevé de test\nPuissance souscrite : 9 kVA',
          facts: [fait('Puissance souscrite : 9 kVA', '9 kVA', { confidence: 'sûr' })],
        }) }));
    const m = await analyser();
    expect(m.sourceLayer!.unresolvedFacts.find((f) => f.reason === 'INVALID_SCHEMA')?.status).toBe('RECOVERED');
    expect(m.sourceLayer!.report).toMatchObject({ droppedFactsCount: 0, qualityState: 'COMPLETE' });
  });
});

// ══ T1X-05 — information non interprétée ════════════════════════════════════

describe('T1X-05 — information non interprétée', () => {
  it('clé inconnue : fait générique + trace RETAINED ; information non mappée : source conservée, UNRESOLVED, aucune perte', async () => {
    repondre((i) => (estReparation(i)
      ? { output: sortie({ facts: [] }) }
      : { output: sortie({
          transcription: 'Relevé de test\nIndice bidule : 42 XQ7\nCode chantier : ZK-4471',
          facts: [fait('Indice bidule : 42 XQ7', '42 XQ7', { canonicalKey: 'cleTotalementInconnue', target: { type: 'ASSET', entityId: null } })],
        }) }));
    const m = await analyser();
    expect(m.facts[0]).toMatchObject({ canonicalKey: null, origin: 'GENERIC', sourceUnitIds: ['page:1:field:1'] });
    const l = m.sourceLayer!;
    expect(l.unresolvedFacts.find((f) => f.reason === 'UNKNOWN_CANONICAL_KEY')).toMatchObject({
      status: 'RETAINED', canonicalKey: 'cleTotalementInconnue', sourceUnitIds: ['page:1:field:1'],
    });
    expect(l.units.find((u) => u.sourceUnitId === 'page:1:field:2')).toMatchObject({
      status: 'UNRESOLVED', text: 'Code chantier : ZK-4471', label: 'Code chantier', value: 'ZK-4471',
    });
    expect(l.report.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
  });
});

// ══ T1X-06 — oubli lors du premier passage ══════════════════════════════════

describe('T1X-06 — oubli lors du premier passage', () => {
  const premier = () => sortie({
    transcription: 'Relevé de test\nRéférence : REF-1\nN° de série : SN-778899\nMerci de votre confiance.',
    facts: [fait('Référence : REF-1', 'REF-1')],
  });

  it('le contrôle de couverture détecte l’unité oubliée → réparation ciblée (seule l’unité, sans fichier) → extraction complémentaire', async () => {
    repondre((i) => (estReparation(i) ? { output: sortie({ facts: [fait('N° de série : SN-778899', 'SN-778899')] }) } : { output: premier() }));
    const m = await analyser({ contentUrls: ['https://s3.example/doc.pdf?sig=1'] });
    expect(fake.calls).toHaveLength(2);
    const rep = fake.calls[1];
    expect(rep.attachments).toEqual([]);
    expect(rep.prompt).toContain('[page:1:field:2]');
    expect(rep.prompt).not.toContain('REF-1');
    expect(rep.prompt).not.toContain('Merci de votre confiance');
    expect(m.facts.map((f) => f.value)).toEqual(['REF-1', 'SN-778899']);
    expect(m.facts[1].sourceUnitIds).toEqual(['page:1:field:2']);
    expect(m.sourceLayer!.report).toMatchObject({ repairPassCount: 1, factsCount: 2 });
    expect(m.sourceLayer!.units.find((u) => u.sourceUnitId === 'page:1:field:2')?.status).toBe('COVERED');
  });

  it('réparation sans résultat → UNRESOLVED (contenu conservé) ; MAX_REPAIR_PASSES borne les appels', async () => {
    process.env.T1_MAX_REPAIR_PASSES = '2';
    repondre((i) => (estReparation(i) ? { output: sortie({ facts: [] }) } : { output: premier() }));
    const m = await analyser();
    // 1 analyse + au plus 1 réparation (aucun progrès : arrêt, jamais de boucle).
    expect(fake.calls.length).toBeLessThanOrEqual(3);
    expect(m.sourceLayer!.units.find((u) => u.sourceUnitId === 'page:1:field:2')).toMatchObject({ status: 'UNRESOLVED', repairAttempts: 1 });
  });

  it('réparation en échec transitoire : unité FAILED, INCOMPLETE_RETRYABLE ; un fait hors zone ciblée est ignoré', async () => {
    let n = 0;
    repondre((i) => {
      if (!estReparation(i)) return { output: premier() };
      n++;
      return Object.assign(new Error('délai dépassé'), { status: 503 });
    });
    const m = await analyser();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(m.sourceLayer!.units.find((u) => u.sourceUnitId === 'page:1:field:2')).toMatchObject({ status: 'FAILED', reason: 'repair_failed:retryable' });
    expect(m.sourceLayer!.report.qualityState).toBe('INCOMPLETE_RETRYABLE');
  });

  it('pas de deuxième passe systématique : document couvert → aucun appel de réparation', async () => {
    repondre(() => ({ output: sortie({ transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1')] }) }));
    await analyser();
    expect(fake.calls).toHaveLength(1);
  });
});

// ══ T1X-07 — tableau volumineux ═════════════════════════════════════════════

describe('T1X-07 — tableau volumineux', () => {
  it('1 500 lignes (au-delà de 1 000) : toutes les lignes et cellules conservées, aucune suppression liée au plafond', async () => {
    const rows = Array.from({ length: 1_500 }, (_, r) => ({ cells: [{ column: 0, value: `L${r}` }, { column: 1, value: `${r},00 €` }, { column: 2, value: null }] }));
    repondre(() => ({ output: sortie({
      transcription: 'Relevé de test',
      tables: [{ title: 'Consommations', pageStart: 3, columns: [{ header: 'Ligne' }, { header: 'Montant' }, { header: 'Note' }], rows }],
      facts: [fait('L1499', '1499,00 €', { evidence: { excerpt: 'L1499', page: 3, table: { index: 0, row: 1499, column: 1 } } })],
    }) }));
    const m = await analyser();
    const t = m.result.document.tables![0];
    expect(t.rowCount).toBe(1_500);
    expect(t.cells).toHaveLength(4_500);
    const l = m.sourceLayer!;
    expect(l.units.filter((u) => u.kind === 'TABLE_ROW')).toHaveLength(1_500);
    expect(l.units.find((u) => u.sourceUnitId === 'page:3:table:1:row:1500')).toMatchObject({ status: 'COVERED', factCount: 1 });
    expect(m.facts[0].sourceUnitIds).toEqual(['page:3:table:1:row:1500:cell:2']);
    expect(m.result.warnings.map((w) => w.code)).not.toContain('TABLE_STRUCTURE_UNCERTAIN');
  });
});

// ══ T1X-08 — traitement ultérieur (persistance réexploitable) ══════════════

describe('T1X-08 — traitement ultérieur', () => {
  it('l’information non comprise est dans la couche A persistée (texte, page, unité) : réinterprétable sans le fichier', async () => {
    repondre((i) => (estReparation(i) ? { output: sortie({ facts: [] }) } : { output: sortie({
      transcription: 'Relevé de test\nLieu d’intervention : 12 rue Victor Hugo, 69003 Lyon',
      facts: [],
    }) }));
    const m = await analyser();
    const u = m.sourceLayer!.units.find((x) => x.text?.includes('12 rue Victor Hugo'));
    expect(u).toMatchObject({ sourceUnitId: 'page:1:field:1', status: 'UNRESOLVED', page: 1, value: '12 rue Victor Hugo, 69003 Lyon' });
    const k = buildKnowledgeFromSourceAnalysis(m.result, { accountId: 1, fileId: 1000, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file', sourceLayer: m.sourceLayer });
    expect(k.sourceLayer?.units.some((x) => x.text?.includes('12 rue Victor Hugo'))).toBe(true);
  });
});

// ══ Contrôle de couverture, rapport, fusion, bornes (pur) ═══════════════════

describe('contrôle de couverture et rapport (pur)', () => {
  const units = buildSourceUnits({ segments: [{ text: 'A : 1234-XY\n\nTexte libre sans valeur\n\nPage 1/1', pageOffset: 0, origin: 'PASS_1' }] });

  it('chaque unité a un état ; somme = total ; règle d’état de qualité', () => {
    const cov = computeCoverage(units, { facts: [{ unitIds: ['page:1:field:1'], confidence: 'conflictual' }] });
    expect(cov.map((u) => u.status)).toEqual(['UNCERTAIN', 'UNRESOLVED', 'NON_INFORMATIONAL']);
    const r = buildCompletenessReport(cov, {
      factsCount: 1, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0, warningCodes: ['PARTIAL_EXTRACTION'], retryAllowed: true,
    });
    expect(r).toMatchObject({ totalSourceUnits: 3, uncertainUnits: 1, unresolvedUnits: 1, nonInformationalUnits: 1, qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: ['PARTIAL_EXTRACTION'] });
    expect(r.coverageRatio).toBeCloseTo(1 / 3, 3);
  });

  it('sélection de réparation : seulement les unités non couvertes porteuses d’une valeur, bornée par les tentatives', () => {
    const cov = computeCoverage(units, { facts: [] });
    expect(selectRepairUnits(cov, 1).map((u) => u.sourceUnitId)).toEqual(['page:1:field:1']);
    const tente = computeCoverage(units, { facts: [], repairAttempts: new Map([['page:1:field:1', 1]]) });
    expect(selectRepairUnits(tente, 1)).toEqual([]);
  });

  it('fusion idempotente : un même lot fusionné deux fois n’ajoute rien', () => {
    const f = fait('x', 'y') as never;
    const base: never[] = [];
    expect(mergeFacts(base, [f])).toHaveLength(1);
    expect(mergeFacts(base, [f, { ...(f as object) } as never])).toHaveLength(0);
    expect(base).toHaveLength(1);
    expect(factFingerprint(f)).toBe(factFingerprint({ ...(f as object) } as never));
  });

  it('lien d’un extrait couvrant plusieurs unités ; cellule ; observation', () => {
    const u = buildSourceUnits({
      segments: [{ text: 'Ligne une du bloc\n\nLigne deux du bloc', pageOffset: 0, origin: 'PASS_1' }],
      visual: { observations: [{ description: 'Fissure en façade', confidence: 'probable', page: 2 }] },
    });
    const l = new SourceUnitLinker(u);
    expect(l.link({ excerpt: 'Ligne une du bloc Ligne deux du bloc' })).toEqual(['page:1:block:1', 'page:1:block:2']);
    expect(l.link({ provenance: 'VISUAL_ANALYSIS', visualDescription: 'fissure en façade' })).toEqual(['page:2:visual:1']);
  });

  it('découpage par pages : plan borné, saturation détectée', () => {
    expect(planChunks(10, 3, 4, 2)).toEqual({ chunks: [{ start: 3, end: 6 }, { start: 7, end: 10 }], beyond: null });
    expect(planChunks(10, 3, 2, 2)).toEqual({ chunks: [{ start: 3, end: 4 }, { start: 5, end: 6 }], beyond: { start: 7, end: 10 } });
    expect(isSaturated({ outputTokens: 50 })).toBe(false);
    expect(isSaturated({ outputTokens: 31_000 })).toBe(true);
  });

  it('texte intégral des lots : marque de page entre segments', () => {
    expect(fullTextOf([{ text: 'A', pageOffset: 0, origin: 'PASS_1' }, { text: 'B', pageOffset: 4, origin: 'CHUNK' }])).toBe('A\n--- page 5 ---\nB');
  });
});

describe('surveillance', () => {
  it('journal T1 : champs du ticket, compteurs seulement', () => {
    const line = completenessLogLine(42, {
      totalSourceUnits: 10, coveredUnits: 7, nonInformationalUnits: 1, unresolvedUnits: 1, uncertainUnits: 0, failedUnits: 1,
      factsCount: 9, droppedFactsCount: 1, truncatedSectionsCount: 0, batchedSectionsCount: 0, coverageRatio: 0.8,
      repairPassCount: 1, chunkCount: 0, qualityState: 'INCOMPLETE_RETRYABLE', anomalies: ['SOURCE_UNIT_FAILED'],
    });
    const o = JSON.parse(line.replace('[t1-completeness] ', ''));
    for (const k of ['documentId', 'sourceUnitsCount', 'factsCount', 'coverageRatio', 'unresolvedCount', 'uncertainCount', 'failedCount', 'repairPassCount', 'factsDroppedCount', 'truncatedCount']) {
      expect(o).toHaveProperty(k);
    }
    expect(o).toMatchObject({ documentId: 42, sourceUnitsCount: 10, factsDroppedCount: 1 });
  });
});
