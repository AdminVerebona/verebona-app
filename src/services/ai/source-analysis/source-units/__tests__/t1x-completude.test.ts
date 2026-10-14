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
const { buildCompletenessReport, computeCoverage, selectRepairUnits, SourceUnitLinker, withRepairStates, needsSourceUnits } = await import('../coverage');
const sv = await import('../source-verification');
const { backfillLayer } = await import('../jobs');
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
  delete process.env.T1_REPAIR_MAX_CALLS;
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
    // Texte rendu en entier par le modèle : pas une saturation, aucun découpage
    // (lot 49B : le PDF est lu une fois pour VÉRIFIER la couverture, sans appel IA).
    expect(pdf.fetched).toBe(1);
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

// ══════════════════════════════════════════════════════════════════════════
// Lot 49B — ticket « T1 — Garantir la couverture réelle des documents et
// corriger les pertes résiduelles d'extraction » : TC01 à TC12 (unitaires ;
// TC08, TC09, TC11, TC12 aussi sur base réelle :
// `src/test/e2e/scenarios/l49b-t1-couverture-reelle.e2e.ts`).
// ══════════════════════════════════════════════════════════════════════════

/** PNG 1×1 (page « scannée » : image seule, aucun texte). */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SUFFIXES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett'];
const THEMES = ['', 'chaudiere', 'radiateur', 'thermostat', 'ventilation', 'plomberie', 'electricite', 'toiture', 'isolation', 'fenetre', 'charpente'];
/** Texte d'une page : dix mots distinctifs propres à la page. */
const textePage = (n: number) => SUFFIXES.map((x) => `${THEMES[n]}${x}`).join(' ');
/** PDF réel : texte par page (police simple) ; pages listées dans `scannees` : image seule. */
const pdfReel = async (pages: Array<string | null>, scannees: number[] = []) => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = scannees.length ? await doc.embedPng(Buffer.from(PNG_1PX, 'base64')) : null;
  pages.forEach((t, i) => {
    const page = doc.addPage([600, 800]);
    if (scannees.includes(i + 1)) page.drawImage(png!, { x: 0, y: 0, width: 600, height: 800 });
    else if (t) page.drawText(t, { x: 30, y: 760, size: 9, font });
  });
  return doc.save();
};
const URL_PDF = { contentUrls: ['https://s3.example/doc.pdf?sig=1'] };
/** Appel d'un lot de pages (pièce jointe en ligne) : « pages A à B ». */
const lotDePages = (i: ProviderCallInput) => {
  const nom = i.attachments[0]?.data ? i.attachments[0].displayName ?? '' : '';
  const m = /pages (\d+) à (\d+)/.exec(nom);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
};
const reparationCiblee = (i: ProviderCallInput) => /\[page:\d+:/.test(i.prompt);

describe('TC01 — omission silencieuse (DEV-01)', () => {
  it('PDF de 10 pages, réponse T1 limitée aux pages 1 à 7 sans saturation : pages 8 à 10 détectées puis reprises (lot ciblé), jamais COMPLETE prématurément', async () => {
    pdf.bytes = await pdfReel(Array.from({ length: 10 }, (_, k) => textePage(k + 1)));
    repondre((i) => {
      const lot = lotDePages(i);
      if (lot) {
        const pages = Array.from({ length: lot.end - lot.start + 1 }, (_, k) => lot.start + k);
        return { output: sortie({ transcription: pages.map((p) => textePage(p)).join('\n\n') }) };
      }
      return { output: sortie({ transcription: [1, 2, 3, 4, 5, 6, 7].map((p) => textePage(p)).join('\n\n') }) };
    });
    const m = await analyser(URL_PDF);
    expect(pdf.fetched).toBe(1);
    const lots = fake.calls.map(lotDePages).filter(Boolean);
    // Reprise CIBLÉE des seules pages omises (aucune relecture des pages 1 à 7).
    expect(lots).toEqual([{ start: 8, end: 10 }]);
    const d = m.sourceLayer!.report.diagnostics!;
    expect(d).toMatchObject({ sourceVerification: 'VERIFIED', pagesExpected: 10, pagesVerified: 10, pagesMissing: [], pagesReread: [8, 9, 10] });
    expect(m.result.document.transcription).toContain(textePage(10));
  });

  it('reprise des pages omises en échec : lacune FAILED « page:8:gap:10 », PAGE_MISSING, INCOMPLETE_RETRYABLE (jamais COMPLETE)', async () => {
    pdf.bytes = await pdfReel(Array.from({ length: 10 }, (_, k) => textePage(k + 1)));
    repondre((i) => (lotDePages(i)
      ? Object.assign(new Error('fournisseur indisponible'), { status: 503 })
      : { output: sortie({ transcription: [1, 2, 3, 4, 5, 6, 7].map((p) => textePage(p)).join('\n\n') }) }));
    const m = await analyser(URL_PDF);
    const r = m.sourceLayer!.report;
    expect(m.sourceLayer!.units.find((u) => u.kind === 'PAGE_GAP')).toMatchObject({ sourceUnitId: 'page:8:gap:10', status: 'FAILED' });
    expect(r.qualityState).toBe('INCOMPLETE_RETRYABLE');
    expect(r.anomalies).toEqual(expect.arrayContaining(['PAGE_MISSING', 'COVERAGE_INCOMPLETE']));
    expect(r.diagnostics).toMatchObject({ sourceVerification: 'PARTIAL', pagesMissing: [8, 9, 10] });
  });

  it('lecture paginée (marques « --- page N --- ») d’un PDF de 10 pages illisibles, marques 1 à 7 : pages 8 à 10 manquantes (pur)', () => {
    const probe = { pageCount: 10, pages: Array.from({ length: 10 }, (_, k) => ({ page: k + 1, kind: 'UNKNOWN' as const, sample: null })) };
    const transcription = [1, 2, 3, 4, 5, 6, 7].map((p) => `--- page ${p} ---\nContenu`).join('\n');
    const v = sv.verifyPdfCoverage({ probe, cited: sv.citedPages({ facts: [], tables: [], transcription }), transcription, hasContent: true });
    // Lot 54G (TC14) : une marque de page sans échantillon lisible ne VÉRIFIE plus la page — citée ≠ couverte.
    expect(v).toMatchObject({ status: 'PARTIAL', missing: [8, 9, 10], verified: [], unverified: [1, 2, 3, 4, 5, 6, 7], citedUnverified: [1, 2, 3, 4, 5, 6, 7] });
    expect(sv.pageRanges(v.missing)).toEqual([{ start: 8, end: 10 }]);
  });
});

describe('TC02 — page 1 non vérifiée (DEV-01)', () => {
  it('sortie saturée sans aucune page citée : la reprise commence à la page 1 (jamais réputée lue)', async () => {
    pdf.bytes = await pdfReel([null, null, null]);
    repondre((i) => (lotDePages(i)
      ? { output: sortie({ transcription: 'Suite du document' }) }
      : { outputTokens: 31_000, output: sortie({ transcription: 'Début : A-0001', facts: [fait('Début : A-0001', 'A-0001', { evidence: { excerpt: 'Début : A-0001' } })] }) }));
    await analyser(URL_PDF);
    expect(fake.calls.map(lotDePages).filter(Boolean)[0]).toMatchObject({ start: 1 });
  });

  it('PDF scanné de 3 pages, numérotation absente, sortie non saturée : pages non vérifiées (dont la page 1), PAGE_UNVERIFIED, jamais COMPLETE, aucun appel IA de plus', async () => {
    pdf.bytes = await pdfReel([null, null, null], [1, 2, 3]);
    repondre(() => ({ output: sortie({ transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1', { evidence: { excerpt: 'Référence : REF-1' } })] }) }));
    const m = await analyser(URL_PDF);
    expect(fake.calls).toHaveLength(1);
    const r = m.sourceLayer!.report;
    expect(r.diagnostics).toMatchObject({ sourceVerification: 'PARTIAL', pagesUnverified: [1, 2, 3], pagesScanned: [1, 2, 3], pagesVerified: 0 });
    expect(r.qualityState).not.toBe('COMPLETE');
    expect(r.anomalies).toContain('PAGE_UNVERIFIED');
  });

  it('source illisible (téléchargement impossible) : NON VÉRIFIABLE, SOURCE_UNREADABLE, jamais COMPLETE', async () => {
    pdf.bytes = null;
    repondre(() => ({ output: sortie({ transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1')] }) }));
    const m = await analyser(URL_PDF);
    // Lot 53 (D19) : jamais « complète » — vérification incomplète.
    expect(m.sourceLayer!.report).toMatchObject({ qualityState: 'VERIFICATION_INCOMPLETE', diagnostics: { sourceVerification: 'UNVERIFIABLE' } });
    expect(m.sourceLayer!.report.anomalies).toContain('SOURCE_UNREADABLE');
  });

  it('image seule : couverture non vérifiable, incertitude conservée (pur)', () => {
    expect(sv.verifyNonPdf({ mimeTypes: ['image/jpeg'], textSource: false, hasContent: true })).toMatchObject({ status: 'UNVERIFIABLE', scanned: [1], unverified: [1] });
    expect(sv.verifyNonPdf({ mimeTypes: ['text/html'], textSource: true, hasContent: true }).status).toBe('NOT_APPLICABLE');
  });

  it('sonde : texte d’un flux (chaînes littérales et hexadécimales), page scannée, police illisible écartée (pur)', () => {
    expect(sv.readContentStream('BT /F1 9 Tf (Bonjour le monde) Tj ET').text).toBe('Bonjour le monde');
    expect(sv.readContentStream('BT <48656C6C6F> Tj ET')).toMatchObject({ textOps: 1, text: 'Hello' });
    expect(sv.readContentStream('q /Im1 Do Q')).toMatchObject({ textOps: 0, doOps: 1 });
    expect(sv.readableSample('\u0000\u0012\u0003'.repeat(30))).toBeNull();
  });
});

describe('TC03 — texte incertain (DEV-02)', () => {
  const premier = () => sortie({
    transcription: 'Relevé de test\nN° de série : SN-12345',
    facts: [fait('N° de série : SN-12345', 'SN-12345', { confidence: 'conflictual' })],
  });

  it('UNCERTAIN déclenche une vérification ciblée ; relecture certaine (preuve) → COVERED, réparation réussie', async () => {
    repondre((i) => (reparationCiblee(i) ? { output: sortie({ facts: [fait('N° de série : SN-12345', 'SN-12345')] }) } : { output: premier() }));
    const m = await analyser();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].prompt).toContain('[page:1:field:1]');
    expect(m.sourceLayer!.units.find((u) => u.sourceUnitId === 'page:1:field:1')).toMatchObject({ status: 'COVERED', repairState: 'SUCCEEDED' });
  });

  it('sans preuve suffisante : UNCERTAIN maintenu (jamais promu), réparation tentée sans succès', async () => {
    repondre((i) => (reparationCiblee(i) ? { output: sortie({ facts: [] }) } : { output: premier() }));
    const m = await analyser();
    expect(m.sourceLayer!.units.find((u) => u.sourceUnitId === 'page:1:field:1')).toMatchObject({ status: 'UNCERTAIN', repairAttempts: 1, repairState: 'ATTEMPTED_FAILED' });
    expect(m.sourceLayer!.report.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
  });
});

describe('TC04 — tableau incertain (DEV-02)', () => {
  const tableau = {
    title: 'Pièces', pageStart: 1, uncertain: true, uncertaintyNote: 'colonnes ambiguës',
    columns: [{ header: 'Réf' }, { header: 'Prix' }],
    rows: [{ cells: [{ column: 0, value: 'KIT-778' }, { column: 1, value: '24,90 €' }] }, { cells: [{ column: 0, value: 'JOINT-12' }, { column: 1, value: '3,50 €' }] }],
  };

  it('contrôle ciblé des cellules : ligne confirmée cellule par cellule → COVERED ; ligne partiellement confirmée → UNCERTAIN ; aucune ligne perdue', async () => {
    repondre((i) => (reparationCiblee(i)
      ? { output: sortie({ facts: [fait('KIT-778', 'KIT-778'), fait('24,90 €', '24,90 €'), fait('JOINT-12', 'JOINT-12')] }) }
      : { output: sortie({ transcription: 'Relevé de test', tables: [tableau] }) }));
    const m = await analyser();
    const rep = fake.calls.find(reparationCiblee)!;
    expect(rep.prompt).toContain('[page:1:table:1:row:1]');
    const lignes = m.sourceLayer!.units.filter((u) => u.kind === 'TABLE_ROW');
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatchObject({ status: 'COVERED', reason: 'table_verified' });
    expect(lignes[1]).toMatchObject({ status: 'UNCERTAIN', reason: 'table_uncertain' });
  });

  it('sélection : ligne de tableau incertaine éligible ; observation visuelle incertaine NON (relecture du fichier nécessaire) (pur)', () => {
    const u = buildSourceUnits({
      segments: [],
      tables: [{ index: 0, title: 'T', pageStart: 1, pageEnd: 1, columns: [{ header: 'A', path: ['A'] }], rowCount: 1, columnCount: 1,
        cells: [{ row: 0, column: 0, rowHeader: null, columnHeader: 'A', columnPath: ['A'], value: 'X-1', normalized: null, valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'probable' }],
        confidence: 'probable', uncertain: true, issues: [] }],
      visual: { observations: [{ description: 'Fissure', confidence: 'conflictual', page: 1 }] },
    });
    const cov = computeCoverage(u, { facts: [] });
    expect(selectRepairUnits(cov, 1).map((x) => x.kind)).toEqual(['TABLE_ROW']);
    expect(needsSourceUnits(cov).map((x) => x.kind)).toEqual(['VISUAL_OBSERVATION']);
  });
});

describe('TC05 — observation visuelle incertaine (DEV-02 ; lot 54G : cycle complet NEEDS_SOURCE → relecture du fichier)', () => {
  it('aucune relecture TEXTUELLE ; NEEDS_SOURCE → relecture du FICHIER (pages concernées, même contrat) → SUCCEEDED → couverture recalculée', async () => {
    repondre((i) => (estRelectureFichier(i)
      ? { output: sortie({ observations: [{ description: 'Trace d’humidité au plafond', confidence: 'certain', page: 1 }] }) }
      : { output: sortie({
        transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1')],
        observations: [{ description: 'Trace d’humidité au plafond', confidence: 'conflictual', page: 1 }],
      }) }));
    const m = await analyser();
    expect(fake.calls).toHaveLength(1);
    expect(m.sourceLayer!.units.find((u) => u.kind === 'VISUAL_OBSERVATION')).toMatchObject({ status: 'UNCERTAIN', repairState: 'NEEDS_SOURCE' });
    expect(m.sourceLayer!.report.diagnostics).toMatchObject({ needsSourceUnits: 1 });
    expect(m.sourceLayer!.report.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    // Reprise : relecture du FICHIER (pièce jointe : la page concernée), jamais du texte déjà extrait.
    const cycle = await relireFichier(m.sourceLayer!.units);
    expect(cycle.r.calls).toBe(1);
    const appel = fake.calls.find(estRelectureFichier)!;
    expect(appel.attachments[0]).toMatchObject({ mimeType: 'application/pdf', displayName: expect.stringContaining('pages 1 à 1') });
    expect(cycle.units.find((u) => u.kind === 'VISUAL_OBSERVATION')).toMatchObject({ status: 'COVERED', reason: 'observation_verified', repairState: 'SUCCEEDED', repairAttempts: 1 });
    expect(cycle.report.diagnostics).toMatchObject({ needsSourceUnits: 0, uncertainUnits: 0 });
  });
});

describe('TC06 / TC07 — pertes de normalisation (DEV-03)', () => {
  it('TC06 — chaîne longue : valeur réduite dans le contrat, original INTÉGRAL conservé (VALUE_TRUNCATED) ; troncatures = originaux', async () => {
    const long = `Libellé ${'très '.repeat(80)}long`;
    expect(long.length).toBeGreaterThan(200);
    repondre(() => ({ output: sortie({
      transcription: 'Relevé de test\nRéférence : REF-1',
      facts: [fait('Référence : REF-1', 'REF-1', { label: long })],
    }) }));
    const m = await analyser();
    expect(String(m.facts[0].label).length).toBe(200);
    const rec = m.sourceLayer!.unresolvedFacts.find((f) => f.reason === 'VALUE_TRUNCATED');
    expect(rec).toMatchObject({ status: 'RETAINED', rawKey: 'facts[0].label', rawValue: long, sourceUnitIds: ['page:1:field:1'] });
    expect((rec!.originalPayload as { original: string }).original).toBe(long);
    expect(m.sourceLayer!.report.diagnostics).toMatchObject({ truncations: 1, originalsPreserved: 1, normalisationLosses: 0 });
    expect(m.sourceLayer!.report.anomalies).not.toContain('NORMALISATION_LOSS');
  });

  it('TC07 — champ invalide (date non ISO, code trop long) : valeur originale conservée avec le motif du retrait', async () => {
    repondre(() => ({ output: {
      ...sortie({ transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1')] }),
      document: {
        title: { value: 'Relevé de test', confidence: 'certain', evidence: { excerpt: 'Relevé de test', page: 1 } },
        documentDate: { value: 'courant du trimestre prochain', confidence: 'probable', evidence: {} },
        classification: { canonicalType: 'X'.repeat(70), rubricCode: null, documentTypeCode: null, confidence: 0.9, evidence: {} },
      },
    } }));
    const m = await analyser();
    const retraits = m.sourceLayer!.unresolvedFacts.filter((f) => f.reason === 'VALUE_NOT_NORMALIZABLE' && f.status === 'UNRESOLVED');
    expect(retraits.map((r) => r.rawKey).sort()).toEqual(['document.classification.canonicalType', 'document.documentDate']);
    expect(retraits.find((r) => r.rawKey === 'document.documentDate')).toMatchObject({ detail: expect.stringContaining('retirée par la normalisation') });
    expect(JSON.stringify(retraits.find((r) => r.rawKey === 'document.documentDate')!.originalPayload)).toContain('courant du trimestre prochain');
    expect(m.sourceLayer!.report.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
  });

  it('perte non compensée (champ retiré par la validation : chemin seul) : NORMALISATION_LOSS (pur)', () => {
    const units = buildSourceUnits({ segments: [{ text: 'Réf : A-1', pageOffset: 0, origin: 'PASS_1' }] });
    const cov = computeCoverage(units, { facts: [{ unitIds: ['page:1:field:1'], confidence: 'certain' }] });
    const r = buildCompletenessReport(cov, {
      factsCount: 1, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0, warningCodes: [], retryAllowed: true,
      normalisation: { truncations: 2, originalsPreserved: 1, losses: 1 },
    });
    expect(r).toMatchObject({ qualityState: 'COMPLETE_WITH_UNRESOLVED', diagnostics: { normalisationLosses: 1 } });
    expect(r.anomalies).toContain('NORMALISATION_LOSS');
  });
});

describe('TC08 / TC09 — budget et plafond de réparation (DEV-04)', () => {
  it('TC08 — budget épuisé : unités hors budget PENDING (jamais « non interprétables »), REPAIR_PENDING, reprise programmée (INCOMPLETE_RETRYABLE)', async () => {
    process.env.T1_REPAIR_MAX_CALLS = '1';
    const lignes = Array.from({ length: 130 }, (_, i) => `Compteur ${i + 1} : CPT-${10_000 + i}`);
    repondre((i) => (reparationCiblee(i) ? { output: sortie({ facts: [] }) } : { output: sortie({ transcription: ['Relevé de test', ...lignes].join('\n') }) }));
    const m = await analyser();
    expect(fake.calls.filter(reparationCiblee)).toHaveLength(1);
    const l = m.sourceLayer!;
    const etats = l.units.filter((u) => u.kind === 'LABEL_VALUE').map((u) => u.repairState);
    expect(etats.filter((x) => x === 'ATTEMPTED_FAILED')).toHaveLength(120);
    expect(etats.filter((x) => x === 'PENDING')).toHaveLength(10);
    expect(l.report).toMatchObject({ qualityState: 'INCOMPLETE_RETRYABLE', diagnostics: { pendingRepairUnits: 10 } });
    expect(l.report.anomalies).toContain('REPAIR_PENDING');
    expect(l.retryable).toBe(true);
  });

  it('TC09 — plafond de tentatives : EXHAUSTED, plus jamais sélectionnée (aucune boucle) ; échec définitif non rejoué (pur)', () => {
    const units = buildSourceUnits({ segments: [{ text: 'Réf : A-123456\nCode : B-654321', pageOffset: 0, origin: 'PASS_1' }] });
    const cov = computeCoverage(units, {
      facts: [], repairAttempts: new Map([['page:1:field:1', 3], ['page:1:field:2', 1]]),
      failed: new Map([['page:1:field:2', { reason: 'repair_failed:final', retryable: false }]]),
    });
    const etats = withRepairStates(cov, { attempted: new Set(['page:1:field:1', 'page:1:field:2']), cap: 3 });
    expect(etats.map((u) => u.repairState)).toEqual(['EXHAUSTED', 'EXHAUSTED']);
    expect(selectRepairUnits(etats, 3)).toEqual([]);
    const r = buildCompletenessReport(etats, {
      factsCount: 0, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 1, chunkCount: 0, warningCodes: [], retryAllowed: true,
    });
    expect(r.anomalies).toContain('REPAIR_EXHAUSTED');
  });

  it('les unités en attente passent en tête de la sélection suivante (pur)', () => {
    const units = buildSourceUnits({ segments: [{ text: 'Réf : A-123456\nCode : B-654321', pageOffset: 0, origin: 'PASS_1' }] });
    const cov = computeCoverage(units, { facts: [] }).map((u) => (u.sourceUnitId === 'page:1:field:2' ? { ...u, repairState: 'PENDING' as const } : u));
    expect(selectRepairUnits(cov, 3).map((u) => u.sourceUnitId)).toEqual(['page:1:field:2', 'page:1:field:1']);
  });
});

describe('TC10 — document complet', () => {
  it('PDF d’une page vérifié, toutes les unités couvertes : COMPLETE, aucun appel IA supplémentaire', async () => {
    const lignes = ['Reference : REF-1001', 'Compteur : CPT-2002'];
    pdf.bytes = await pdfReel([`${lignes[0]} ${lignes[1]} maintenancealpha maintenancebravo`]);
    repondre(() => ({ output: sortie({ transcription: ['Relevé de test', ...lignes, 'maintenancealpha maintenancebravo Page 1/1'].join('\n'), facts: [fait(lignes[0], 'REF-1001'), fait(lignes[1], 'CPT-2002')] }) }));
    const m = await analyser(URL_PDF);
    expect(fake.calls).toHaveLength(1);
    expect(m.sourceLayer!.report).toMatchObject({ diagnostics: { sourceVerification: 'VERIFIED', pagesExpected: 1, pagesVerified: 1 } });
  });
});

describe('TC12 — document historique (reprise sans réanalyse)', () => {
  it('couverture RECONSTRUITE (jamais vérifiée sur l’original) : jamais COMPLETE, aucun appel', () => {
    const b = backfillLayer({
      extraction: {
        id: 1, account_id: 1, file_id: 1, full_text: 'Référence : REF-1', title: null, description: null, document_date: null, supplier_name: null,
        supplier_siret: null, amount_cents: null, document_type_code: null, rubric_code: null, visual_summary: null, visual_observations: null, structural_evidence: null,
      },
      tables: [],
      facts: [{ id: 1, confidence: 'certain', excerpt: 'Référence : REF-1', location: { page: 1 }, evidence_origin: 'TEXT_EXTRACTION', visual_evidence: null, value_text: 'REF-1', normalized_value: 'REF-1', label: null, attribute: null, fact_key: 'info.ref' }],
    });
    // Lot 53 (D19) : couverture reconstruite, jamais vérifiée → vérification incomplète.
    expect(b.layer.report).toMatchObject({ qualityState: 'VERIFICATION_INCOMPLETE', diagnostics: { sourceVerification: 'RECONSTRUCTED' } });
    expect(fake.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Lot 54G — ticket « T1 : finaliser la couverture réelle des documents et
// supprimer les pertes résiduelles d'extraction » : TC13 à TC19 (unitaires ;
// sur base réelle : `src/test/e2e/scenarios/l54g-t1-couverture.e2e.ts`).
// ══════════════════════════════════════════════════════════════════════════

/** Appel de relecture du FICHIER (reprise NEEDS_SOURCE) : déclencheur et SOURCES dédiés. */
const estRelectureFichier = (i: ProviderCallInput) => i.prompt.includes('relecture ciblée');
const rapportMinimal = {
  factsCount: 1, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0,
  warningCodes: [], retryAllowed: true,
} as const;

/** Une passe de relecture du fichier (même enchaînement que `t1-completeness-retry`, sans base). */
const relireFichier = async (units: Parameters<typeof selectSourceRereadUnits>[0], sourceCap = 2) => {
  pdf.bytes = pdf.bytes ?? await pdfReel(['Releve de test humidite plafond reference']);
  const { runSourceReread, applySourceReread } = await import('../source-reread');
  const step = await import('../../steps/analyze-document.step');
  const cibles = selectSourceRereadUnits(units, sourceCap);
  const r = await runSourceReread({
    input: input(URL_PDF), ctx, capabilities: { rooms: true, equipments: true } as never, v2Families: ['IMMOBILIER'] as never,
    targets: cibles, maxCalls: 3, chunkPages: 20, call: (c) => step.callAnalyzeDocument(c),
  });
  const apres = withRepairStates(applySourceReread(units, r), { attempted: new Set(r.attempted), cap: 3, sourceCap });
  const report = buildCompletenessReport(apres, { ...rapportMinimal, sourceReread: { runs: 1, failed: r.resolved.length < r.attempted.length ? 1 : 0, resolved: r.resolved.length } });
  return { r, cibles, units: apres, report };
};
const { selectSourceRereadUnits, resolveTableParents } = await import('../coverage');

describe('TC13 — page partiellement extraite (lot 54G, point 1)', () => {
  it('une citation (evidence.page) ne vérifie pas une page dont l’échantillon source démontre une omission : MANQUANTE (pur)', () => {
    const probe = { pageCount: 2, pages: [{ page: 1, kind: 'TEXT' as const, sample: textePage(1) }, { page: 2, kind: 'TEXT' as const, sample: textePage(2) }] };
    const transcription = textePage(1);
    // Un seul fait extrait de la page 2 (un seul mot de la page) : la page est citée.
    const cited = sv.citedPages({ facts: [fait('radiateuralpha', 'radiateuralpha', { evidence: { excerpt: 'radiateuralpha', page: 2 } })] as never, tables: [], transcription });
    expect(cited.pages.has(2)).toBe(true);
    const v = sv.verifyPdfCoverage({ probe, cited, transcription: `${transcription}\nradiateuralpha`, hasContent: true });
    expect(v).toMatchObject({ status: 'PARTIAL', verified: [1], missing: [2], citedUnverified: [2], reason: 'pages_missing' });
  });

  it('analyse : page citée par un seul fait mais omise de la transcription → reprise CIBLÉE de cette page, jamais COMPLETE avant', async () => {
    pdf.bytes = await pdfReel([textePage(1), textePage(2)]);
    repondre((i) => {
      if (lotDePages(i)) return { output: sortie({ transcription: textePage(2) }) };
      return { output: sortie({
        transcription: `Relevé de test\n${textePage(1)}\nRéférence : radiateuralpha`,
        facts: [fait('Référence : radiateuralpha', 'radiateuralpha', { evidence: { excerpt: 'Référence : radiateuralpha', page: 2 } })],
      }) };
    });
    const m = await analyser(URL_PDF);
    expect(fake.calls.map(lotDePages).filter(Boolean)).toEqual([{ start: 2, end: 2 }]);
    expect(m.sourceLayer!.report.diagnostics).toMatchObject({ sourceVerification: 'VERIFIED', pagesVerified: 2, pagesReread: [2], pagesMissing: [] });
  });

  it('cas objectivement vérifiables non dégradés : texte retrouvé, page vide, correspondance partielle complétée par une citation (pur)', () => {
    const probe = {
      pageCount: 3,
      pages: [
        { page: 1, kind: 'TEXT' as const, sample: textePage(1) },
        { page: 2, kind: 'EMPTY' as const, sample: null },
        { page: 3, kind: 'TEXT' as const, sample: textePage(3) },
      ],
    };
    // Page 3 : 4 mots sur 10 retrouvés (zone 30-50 %) + citation → vérifiée ; sans citation → non vérifiée.
    const partiel = SUFFIXES.slice(0, 4).map((x) => `thermostat${x}`).join(' ');
    const transcription = `${textePage(1)}\n${partiel}`;
    const avec = sv.verifyPdfCoverage({ probe, cited: { pages: new Set([3]), markers: false }, transcription, hasContent: true });
    expect(avec).toMatchObject({ status: 'VERIFIED', verified: [1, 2, 3] });
    const sans = sv.verifyPdfCoverage({ probe, cited: { pages: new Set(), markers: false }, transcription, hasContent: true });
    expect(sans).toMatchObject({ status: 'PARTIAL', verified: [1, 2], unverified: [3] });
  });
});

describe('TC13 — non-dégradation des pages objectivement vérifiables (lot 54G)', () => {
  it('page au texte vide → EMPTY (vérifiée) ; page courte lisible → échantillon comparé, vérifiée si retrouvée (sonde réelle)', async () => {
    const probe = (await sv.probePdf(await pdfReel(['', 'Facture FAC-778'])))!;
    expect(probe.pages.map((p) => p.kind)).toEqual(['EMPTY', 'TEXT']);
    expect(probe.pages[1].sample).toBe('Facture FAC-778');
    const v = sv.verifyPdfCoverage({ probe, cited: { pages: new Set(), markers: false }, transcription: 'Facture FAC-778', hasContent: true });
    expect(v).toMatchObject({ status: 'VERIFIED', verified: [1, 2] });
  });
});

describe('TC14 — page scannée citée (lot 54G, point 1)', () => {
  it('observation sur une page scannée : page citée ≠ page VERIFIED (pur, PDF d’une page)', () => {
    const probe = { pageCount: 1, pages: [{ page: 1, kind: 'SCANNED' as const, sample: null }] };
    const out = { facts: [], tables: [], visual: { observations: [{ description: 'Fissure en façade', confidence: 'certain' as const, page: 1 }] }, transcription: '' };
    const v = sv.verifyPdfCoverage({ probe, cited: sv.citedPages(out), transcription: '', hasContent: true });
    expect(v).toMatchObject({ status: 'PARTIAL', verified: [], unverified: [1], scanned: [1], citedUnverified: [1] });
  });

  it('analyse d’un PDF scanné de 2 pages avec observation et fait visuel page 1 : aucune page vérifiée, VERIFICATION_INCOMPLETE, jamais COMPLETE', async () => {
    pdf.bytes = await pdfReel([null, null], [1, 2]);
    repondre(() => ({ output: sortie({
      transcription: 'Relevé de test',
      observations: [{ description: 'Fissure en façade', confidence: 'certain', page: 1 }],
      facts: [fait('', 'fissure', { provenance: 'VISUAL_ANALYSIS', evidence: { page: 1 }, visualEvidence: { description: 'Fissure en façade', page: 1 } })],
    }) }));
    const m = await analyser(URL_PDF);
    const r = m.sourceLayer!.report;
    expect(r.diagnostics).toMatchObject({ sourceVerification: 'PARTIAL', pagesVerified: 0, pagesUnverified: [1, 2], pagesCitedUnverified: [1], pagesScanned: [1, 2] });
    expect(r.qualityState).toBe('VERIFICATION_INCOMPLETE');
    expect(r.anomalies).toEqual(expect.arrayContaining(['PAGE_UNVERIFIED', 'COVERAGE_UNVERIFIED']));
  });
});

describe('TC15 — NEEDS_SOURCE résolu (lot 54G, point 2)', () => {
  it('observation incertaine → relecture du fichier → observation confirmée (non conflictuelle, même page) → SUCCEEDED, couverture recalculée, COMPLETE possible', async () => {
    repondre((i) => (estRelectureFichier(i)
      ? { output: sortie({ observations: [{ description: 'Trace d’humidité au plafond de la cuisine', confidence: 'certain', page: 1 }] }) }
      : { output: sortie({
        transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1')],
        observations: [{ description: 'Trace d’humidité au plafond', confidence: 'conflictual', page: 1 }],
      }) }));
    const m = await analyser();
    const cycle = await relireFichier(m.sourceLayer!.units);
    expect(cycle.cibles.map((u) => u.kind)).toEqual(['VISUAL_OBSERVATION']);
    expect(cycle.r).toMatchObject({ resolved: [cycle.cibles[0].sourceUnitId], failed: false, pages: [1] });
    expect(cycle.units.find((u) => u.kind === 'VISUAL_OBSERVATION')).toMatchObject({ status: 'COVERED', repairState: 'SUCCEEDED' });
    expect(cycle.report).toMatchObject({ qualityState: 'COMPLETE', diagnostics: { needsSourceUnits: 0, sourceRereads: 1, sourceRereadResolved: 1 } });
    // Télémétrie : relecture du fichier distincte d'une réparation textuelle (déclencheur dédié).
    const { SOURCE_REREAD_TRIGGER } = await import('../source-reread');
    expect(SOURCE_REREAD_TRIGGER).toBe('t1_source_reread');
    expect(fake.calls.filter(estRelectureFichier)).toHaveLength(1);
    expect(fake.calls.filter(estRelectureFichier)[0].attachments).toHaveLength(1);
  });

  it('correspondance de description (pure) : inclusion ou mots communs ; jamais une observation d’une autre page ni conflictuelle', async () => {
    const { sameObservation, resolveFromReread } = await import('../source-reread');
    expect(sameObservation('Trace d’humidité au plafond', 'Trace d humidite au plafond de la cuisine')).toBe(true);
    expect(sameObservation('Fissure en façade', 'Trace d’humidité au plafond')).toBe(false);
    const u = buildSourceUnits({ segments: [], visual: { observations: [{ description: 'Fissure en façade', confidence: 'conflictual', page: 2 }] } });
    const cov = withRepairStates(computeCoverage(u, { facts: [] }), { cap: 3 });
    expect(resolveFromReread(cov, { facts: [], visual: { observations: [{ description: 'Fissure en façade', confidence: 'certain', page: 1 }] } }).resolved).toEqual([]);
    expect(resolveFromReread(cov, { facts: [], visual: { observations: [{ description: 'Fissure en façade', confidence: 'conflictual', page: 2 }] } }).resolved).toEqual([]);
    expect(resolveFromReread(cov, { facts: [], visual: { observations: [{ description: 'Fissure en façade', confidence: 'probable', page: 2 }] } }).resolved).toHaveLength(1);
  });
});

describe('TC16 — NEEDS_SOURCE non résolu (lot 54G, point 2)', () => {
  it('relecture sans preuve suffisante : UNCERTAIN maintenu → tentatives bornées → EXHAUSTED → plus jamais relue, jamais COMPLETE', async () => {
    repondre((i) => (estRelectureFichier(i)
      ? { output: sortie({ observations: [{ description: 'Trace d’humidité au plafond', confidence: 'conflictual', page: 1 }] }) }
      : { output: sortie({
        transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1')],
        observations: [{ description: 'Trace d’humidité au plafond', confidence: 'conflictual', page: 1 }],
      }) }));
    const m = await analyser();
    const t1 = await relireFichier(m.sourceLayer!.units, 2);
    expect(t1.units.find((u) => u.kind === 'VISUAL_OBSERVATION')).toMatchObject({ status: 'UNCERTAIN', repairState: 'NEEDS_SOURCE', repairAttempts: 1 });
    expect(t1.report.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    const t2 = await relireFichier(t1.units, 2);
    expect(t2.units.find((u) => u.kind === 'VISUAL_OBSERVATION')).toMatchObject({ status: 'UNCERTAIN', repairState: 'EXHAUSTED', repairAttempts: 2 });
    expect(t2.report).toMatchObject({ qualityState: 'COMPLETE_WITH_UNRESOLVED', diagnostics: { needsSourceUnits: 0, needsSourceExhausted: 1 } });
    expect(t2.report.anomalies).toContain('REPAIR_EXHAUSTED');
    // Plafond atteint : plus aucune relecture (aucune boucle).
    expect(selectSourceRereadUnits(t2.units, 2)).toEqual([]);
    expect(fake.calls.filter(estRelectureFichier)).toHaveLength(2);
  });

  it('fichier illisible : relecture en échec, tentative comptée, incertitude maintenue', async () => {
    repondre(() => ({ output: sortie({ transcription: 'Relevé de test', observations: [{ description: 'Tache', confidence: 'conflictual', page: 1 }] }) }));
    const m = await analyser();
    pdf.bytes = null;
    const { runSourceReread } = await import('../source-reread');
    const r = await runSourceReread({
      input: input(URL_PDF), ctx, capabilities: {} as never, v2Families: [], targets: selectSourceRereadUnits(m.sourceLayer!.units, 2),
      maxCalls: 1, chunkPages: 20, call: async () => { throw new Error('jamais appelé'); },
    });
    expect(r).toMatchObject({ failed: true, resolved: [], calls: 0 });
    expect(r.attempted).toHaveLength(1);
  });
});

describe('TC17 — champ pruné par la validation de la passerelle (lot 54G, point 3)', () => {
  it('valeur rejetée : FIELD_PRUNED avec original intégral, élément englobant, motif ; rattachée à son unité ; NORMALISATION_LOSS = 0', async () => {
    const region = { x1: 'gauche', y1: 0.1, x2: 0.5, y2: 0.6 };
    repondre(() => ({ output: sortie({
      transcription: 'Relevé de test\nRéférence : REF-1', facts: [fait('Référence : REF-1', 'REF-1')],
      observations: [{ description: 'Fissure en façade', confidence: 'certain', page: 1, region }],
    }) }));
    const m = await analyser();
    const rec = m.sourceLayer!.unresolvedFacts.filter((f) => f.reason === 'FIELD_PRUNED');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      status: 'UNRESOLVED', rawKey: 'visual.observations[0].region', rawValue: JSON.stringify(region),
      sourceUnitIds: [m.sourceLayer!.units.find((u) => u.kind === 'VISUAL_OBSERVATION')!.sourceUnitId],
    });
    expect(rec[0].originalPayload).toMatchObject({
      originalValue: region, preserved: true, path: '$.visual.observations[0].region',
      container: { path: '$.visual.observations[0]', value: expect.objectContaining({ description: 'Fissure en façade', region }) },
      reason: expect.stringContaining('expected number'),
    });
    expect(m.sourceLayer!.report.diagnostics).toMatchObject({ normalisationLosses: 0, prunedFields: 1, prunedOriginalsPreserved: 1 });
    expect(m.sourceLayer!.report.anomalies).not.toContain('NORMALISATION_LOSS');
    // L'observation elle-même est conservée (seul le champ invalide est retiré).
    expect(m.sourceLayer!.units.find((u) => u.kind === 'VISUAL_OBSERVATION')).toMatchObject({ status: 'COVERED' });
  });

  it('contrat de pruning (pur) : chaque retrait rend chemin, valeur originale, motif ; seul un retrait SANS original est une perte', async () => {
    const { pruneInvalidFields } = await import('@/services/ai/gateway/output-resolution/field-validation');
    const { z } = await import('zod');
    const S = z.object({ a: z.string(), b: z.number().optional(), l: z.array(z.object({ v: z.number() })) });
    const r = pruneInvalidFields({ a: 'ok', b: 'douze', l: [{ v: 1 }, { v: 'x' }] }, S, []);
    expect(r.success).toBe(true);
    expect(r.removed).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$.b', originalValue: 'douze', rule: 'field_pruned_invalid', container: null }),
      expect.objectContaining({ path: '$.l[1]', originalValue: { v: 'x' }, rule: 'array_element_pruned' }),
    ]));
    const { normalisationBalance } = await import('../complete-extraction');
    const base = { extras: { truncatedStrings: 0 } as never };
    const conserve = { reason: 'FIELD_PRUNED' as const, status: 'UNRESOLVED' as const, sourceUnitIds: [], rawKey: 'b', canonicalKey: null, rawValue: 'douze', originalPayload: { preserved: true }, pass: 'PASS_1' as const };
    expect(normalisationBalance({ ...base, unresolved: [conserve] })).toMatchObject({ losses: 0, prunedFields: 1, prunedOriginalsPreserved: 1 });
    expect(normalisationBalance({ ...base, unresolved: [{ ...conserve, rawValue: null, originalPayload: { path: '$.b', preserved: false } }] })).toMatchObject({ losses: 1 });
  });
});

describe('TC18 / TC19 — parent TABLE résolu par ses lignes (lot 54G, point 4)', () => {
  const tableau = {
    title: 'Pièces', pageStart: 1, uncertain: true, uncertaintyNote: 'colonnes ambiguës',
    columns: [{ header: 'Réf' }, { header: 'Prix' }],
    rows: [{ cells: [{ column: 0, value: 'KIT-778' }, { column: 1, value: '24,90 €' }] }, { cells: [{ column: 0, value: 'JOINT-12' }, { column: 1, value: '3,50 €' }] }],
  };

  it('TC18 — toutes les cellules confirmées : TABLE_ROW → COVERED, TABLE → COVERED / table_verified (payload.uncertain inchangé)', async () => {
    repondre((i) => (reparationCiblee(i)
      ? { output: sortie({ facts: [fait('KIT-778', 'KIT-778'), fait('24,90 €', '24,90 €'), fait('JOINT-12', 'JOINT-12'), fait('3,50 €', '3,50 €')] }) }
      : { output: sortie({ transcription: 'Relevé de test', tables: [tableau] }) }));
    const m = await analyser();
    const l = m.sourceLayer!;
    expect(l.units.filter((u) => u.kind === 'TABLE_ROW').map((u) => [u.status, u.reason])).toEqual([['COVERED', 'table_verified'], ['COVERED', 'table_verified']]);
    const t = l.units.find((u) => u.kind === 'TABLE')!;
    expect(t).toMatchObject({ status: 'COVERED', reason: 'table_verified' });
    expect(t.payload.uncertain).toBe(true);
    expect(l.report.diagnostics).toMatchObject({ tablesUncertain: 0, tablesResolved: 1 });
  });

  it('TC19 — une ligne reste incertaine : TABLE reste UNCERTAIN, document jamais COMPLETE', async () => {
    repondre((i) => (reparationCiblee(i)
      ? { output: sortie({ facts: [fait('KIT-778', 'KIT-778'), fait('24,90 €', '24,90 €'), fait('JOINT-12', 'JOINT-12')] }) }
      : { output: sortie({ transcription: 'Relevé de test', tables: [tableau] }) }));
    const m = await analyser();
    const l = m.sourceLayer!;
    expect(l.units.find((u) => u.kind === 'TABLE')).toMatchObject({ status: 'UNCERTAIN', reason: 'table_uncertain' });
    expect(l.report.qualityState).not.toBe('COMPLETE');
    expect(l.report.diagnostics).toMatchObject({ tablesUncertain: 1, tablesResolved: 0 });
  });

  it('dérivation pure : contradiction structurelle (lignes manquantes) ou aucune ligne informative → UNCERTAIN ; tableau non incertain intact', () => {
    const u = buildSourceUnits({
      segments: [],
      tables: [{ index: 0, title: 'T', pageStart: 1, pageEnd: 1, columns: [{ header: 'A', path: ['A'] }], rowCount: 1, columnCount: 1,
        cells: [{ row: 0, column: 0, rowHeader: null, columnHeader: 'A', columnPath: ['A'], value: 'X-1', normalized: null, valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'probable' }],
        confidence: 'probable', uncertain: true, issues: [] }],
    });
    const cov = computeCoverage(u, { facts: [{ unitIds: [cellUnitId({ index: 0, pageStart: 1 }, 0, 0)], confidence: 'certain', repair: true }] });
    expect(cov.find((x) => x.kind === 'TABLE')).toMatchObject({ status: 'COVERED', reason: 'table_verified' });
    // Structure contradictoire : la table annonce 2 lignes, une seule est présente.
    const contradictoire = cov.map((x) => (x.kind === 'TABLE' ? { ...x, payload: { ...x.payload, rowCount: 2 } } : x));
    expect(resolveTableParents(contradictoire).find((x) => x.kind === 'TABLE')).toMatchObject({ status: 'UNCERTAIN', reason: 'table_uncertain' });
    const sansLigne = cov.filter((x) => x.kind === 'TABLE').map((x) => ({ ...x, payload: { ...x.payload, rowCount: 0 } }));
    expect(resolveTableParents(sansLigne)[0]).toMatchObject({ status: 'UNCERTAIN' });
  });
});

describe('§5 — états de qualité (lot 54G)', () => {
  it('jamais COMPLETE avec NEEDS_SOURCE, réparation tentée sans succès ou tableau incertain, même si les compteurs de couverture sont pleins (pur)', () => {
    const units = buildSourceUnits({ segments: [{ text: 'Réf : A-1', pageOffset: 0, origin: 'PASS_1' }] });
    const cov = computeCoverage(units, { facts: [{ unitIds: ['page:1:field:1'], confidence: 'certain' }] });
    expect(buildCompletenessReport(cov, rapportMinimal).qualityState).toBe('COMPLETE');
    for (const etat of ['NEEDS_SOURCE', 'ATTEMPTED_FAILED'] as const) {
      const x = cov.map((u) => ({ ...u, repairState: etat }));
      expect(buildCompletenessReport(x, rapportMinimal).qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    }
  });

  it('BO › Exécutions IA : diagnostics de la ligne et totaux de la période, compteurs seulement (desktop et mobile : même composant)', async () => {
    const { diagnosticsText, totalsText } = await import('@/app/admin/ai-executions/_components/T1CompletenessPanel');
    const t = diagnosticsText({
      sourceVerification: 'PARTIAL', lastRetryAt: null, lastRetryResult: null,
      verification: { pagesExpected: 3, pagesVerified: 1, pagesReread: [2], pagesCitedUnverified: [3], needsSourceUnits: 1, sourceRereads: 2, sourceRereadsFailed: 1, needsSourceExhausted: 1, prunedFields: 2, prunedOriginalsPreserved: 2, tablesUncertain: 1, tablesResolved: 1 },
    });
    expect(t).toContain('1 page(s) relue(s)');
    expect(t).toContain('1 citée(s) non vérifiée(s)');
    expect(t).toContain('2 relecture(s) du fichier dont 1 sans levée');
    expect(t).toContain('2 champ(s) retiré(s) par la validation, 2 original(aux) conservé(s)');
    expect(t).toContain('1 tableau(x) incertain(s)');
    const lignes = totalsText({
      documents: 4, pagesExpected: 10, pagesVerified: 7, pagesMissing: 1, pagesUnverified: 2, pagesReread: 1, pagesCitedUnverified: 2,
      needsSourceUnits: 1, sourceRereads: 3, sourceRereadsFailed: 1, sourceRereadResolved: 2, needsSourceExhausted: 1,
      pendingRepairUnits: 0, exhaustedRepairUnits: 1, prunedFields: 2, prunedOriginalsPreserved: 2, normalisationLosses: 0, tablesUncertain: 1, tablesResolved: 2,
    });
    expect(lignes).toHaveLength(5);
    expect(lignes.join('\n')).toContain('3 relecture(s) exécutée(s)');
    expect(totalsText(null)).toEqual([]);
  });
});
