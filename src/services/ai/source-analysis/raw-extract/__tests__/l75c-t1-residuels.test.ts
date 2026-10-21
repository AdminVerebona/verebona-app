/**
 * Lot 75C — ticket « [P1] T1 — écarts résiduels » : fonctions pures.
 * (Le comportement sur base réelle est couvert par `l75c-t1-residuels.e2e.ts`.)
 *
 * T1-FIX-01 : extract non enregistré → phase d'extraction FAILED, persistance bloquée.
 * T1-FIX-02 : pages sans couche texte → texte reconnu par page, provenance distincte, zones à part.
 * T1-FIX-03 : troncature, page illisible, transcription non paginée / groupe → lacunes visibles.
 * T1-FIX-04 / 05 : preuves et couche source obligatoires → persistance FAILED ; attributs → PARTIAL.
 * T1-FIX-06 : faits fiables (certains, preuve écrite, sans conflit) seuls candidats à l'écriture directe.
 * T1-FIX-09 : identifiant de trace porté par une erreur (et sa cause).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));

const { buildOcrPages, ocrGaps, transcriptionByPage } = await import('../ocr-pages');
const { persistenceOutcome } = await import('../raw-extract.service');
const { t1Phases, traceIdsOfError } = await import('../../../execution-report/t1-report');
const { reliableCandidates } = await import('../../steps/apply-reliable-facts.step');
const { describeEvidenceWriteErrors } = await import('../../steps/persist-evidence.step');
import type { RawExtractSummary } from '../raw-extract.service';
import type { ProjectedFact } from '../../master/t1-contract';

const unite = (id: string, kind: string, page: number | null, text: string | null, ordinal: number, location: Record<string, unknown> = {}) =>
  ({ sourceUnitId: id, kind, page, text, ordinal, location, payload: {} });

describe('T1-FIX-02 — transcription des pages sans couche texte (aucun appel IA)', () => {
  it('T1-FIX-02 : texte reconnu PAR PAGE, provenance MODEL_TRANSCRIPTION, unités source ; observation visuelle en zone, jamais en texte', () => {
    const r = buildOcrPages({
      pagesWithoutText: [2], pageCount: 2, groupSize: 1, scannedPages: [2],
      units: [
        unite('page:1:block:1', 'TEXT_BLOCK', 1, 'FACTURE FA-1', 0),
        unite('page:2:block:1', 'TEXT_BLOCK', 2, 'Relevé compteur n° 778899', 1),
        unite('page:2:field:1', 'LABEL_VALUE', 2, 'Index : 4512 kWh', 2),
        unite('page:2:block:2', 'TEXT_BLOCK', 2, 'Index : 4512 kWh', 3),
        unite('page:2:visual:1', 'VISUAL_OBSERVATION', 2, 'Tampon « payé » en bas à droite', 4, { region: 'bas-droite' }),
      ],
    });
    expect(r).toMatchObject({ status: 'COMPLETE', recognized: [2], unreadable: [] });
    expect(r.pages[0]).toMatchObject({ page: 2, status: 'RECOGNIZED', provenance: 'MODEL_TRANSCRIPTION',
      text: 'Relevé compteur n° 778899\n\nIndex : 4512 kWh', sourceUnitIds: ['page:2:block:1', 'page:2:field:1', 'page:2:block:2'] });
    expect(r.pages[0].zones).toEqual([{ sourceUnitId: 'page:2:visual:1', region: 'bas-droite', description: 'Tampon « payé » en bas à droite' }]);
    expect(r.pages[0].text).not.toContain('Tampon');
    expect(r.chars).toBe(r.pages[0].text!.length);
  });

  it('T1-FIX-02 : toutes les pages ont une couche texte → NOT_REQUIRED ; repli sur la transcription paginée sans couche A', () => {
    expect(buildOcrPages({ pagesWithoutText: [], pageCount: 3, groupSize: 1 }).status).toBe('NOT_REQUIRED');
    const r = buildOcrPages({ pagesWithoutText: [2], pageCount: 2, groupSize: 1, transcription: '--- page 1 ---\nA\n--- page 2 ---\nTexte scanné lu' });
    expect(r.pages[0]).toMatchObject({ status: 'RECOGNIZED', text: 'Texte scanné lu' });
    expect(transcriptionByPage('sans marque').paginated).toBe(false);
  });

  it('T1-FIX-02 : image seule (une page) → page 1 reconnue même sans marque', () => {
    const r = buildOcrPages({ pagesWithoutText: [1], pageCount: 1, groupSize: 1, units: [unite('page:1:block:1', 'TEXT_BLOCK', 1, 'Ticket de caisse 12,50 €', 0)] });
    expect(r).toMatchObject({ status: 'COMPLETE', recognized: [1] });
  });
});

describe('T1-FIX-03 — lacunes de reconnaissance explicites, jamais inventées', () => {
  it('T1-FIX-03 : page scannée sans texte reconnu → UNREADABLE ; page blanche (sonde) → EMPTY ; statut PARTIAL', () => {
    const r = buildOcrPages({
      pagesWithoutText: [2, 3, 4], pageCount: 4, groupSize: 1, scannedPages: [2, 3],
      units: [unite('page:1:block:1', 'TEXT_BLOCK', 1, 'Titre', 0), unite('page:3:block:1', 'TEXT_BLOCK', 3, 'Annexe lue', 1)],
    });
    expect(r.pages.map((x) => [x.page, x.status])).toEqual([[2, 'UNREADABLE'], [3, 'RECOGNIZED'], [4, 'EMPTY']]);
    expect(r).toMatchObject({ status: 'PARTIAL', recognized: [3], unreadable: [2] });
    expect(ocrGaps(r)).toEqual(['page 2 sans couche texte : aucun texte reconnu']);
    expect(r.pages[0].text).toBeNull();
  });

  it('T1-FIX-03 : transcription non paginée d’un document multipage, ou groupe de fichiers → UNATTRIBUTED (rien n’est attribué au hasard)', () => {
    const np = buildOcrPages({ pagesWithoutText: [3], pageCount: 3, groupSize: 1, units: [unite('page:1:block:1', 'TEXT_BLOCK', 1, 'Tout le texte', 0)] });
    expect(np).toMatchObject({ status: 'UNATTRIBUTED', recognized: [] });
    expect(np.pages[0].text).toBeNull();
    const g = buildOcrPages({ pagesWithoutText: [1], pageCount: 1, groupSize: 2, units: [unite('page:1:block:1', 'TEXT_BLOCK', 1, 'x y z', 0)] });
    expect(g.status).toBe('UNATTRIBUTED');
    expect(ocrGaps(g)).toEqual(['page 1 sans couche texte : transcription non attribuable']);
  });
});

const resume = (over: Partial<RawExtractSummary> = {}): RawExtractSummary => ({
  id: 1, fileId: 9, status: 'COMPLETE', method: 'PDF_TEXT_LAYER', pageCount: 2, pagesWithText: 2, pagesWithoutText: [], truncated: false,
  truncationReason: null, chars: 100, fullTextSha256: 'x', reused: false, error: null, sourceSha256: 's', identity: 'NEW', ...over,
});
const ok = (step: string) => ({ step, status: 'OK' as const, error: null });
const ko = (step: string, error = 'panne') => ({ step, status: 'FAILED' as const, error });

describe('Phases T1 — extraction, structuration, persistance (T1-FIX-01, 03)', () => {
  it('T1-FIX-01 : extract non enregistré → extraction FAILED (lacune nommée), persistance FAILED', () => {
    const ph = t1Phases({ steps: [ko('RAW_EXTRACT', 'fichier 9 : écriture refusée'), ok('MASTER'), ok('KNOWLEDGE')], rawExtracts: [], failure: null });
    expect(ph.extraction.state).toBe('FAILED');
    expect(ph.extraction.detail.gaps).toEqual(['extract brut non enregistré : fichier 9 : écriture refusée']);
    expect(ph.persistence.state).toBe('FAILED');
  });

  it('T1-FIX-02 : pages scannées toutes reconnues et enregistrées → extraction SUCCEEDED', () => {
    const raw = resume({ status: 'PARTIAL_OCR_REQUIRED', pagesWithoutText: [2] });
    const ocr = new Map([[9, { persisted: true, result: buildOcrPages({ pagesWithoutText: [2], pageCount: 2, groupSize: 1, transcription: '--- page 2 ---\nlu' }) }]]);
    expect(t1Phases({ steps: [ok('MASTER')], rawExtracts: [raw], failure: null, ocr }).extraction.state).toBe('SUCCEEDED');
    // Sans transcription disponible, ou non enregistrée : PARTIAL, jamais réussi.
    expect(t1Phases({ steps: [ok('MASTER')], rawExtracts: [raw], failure: null }).extraction.state).toBe('PARTIAL');
    const nonEcrite = new Map([[9, { ...ocr.get(9)!, persisted: false }]]);
    expect(t1Phases({ steps: [ok('MASTER')], rawExtracts: [raw], failure: null, ocr: nonEcrite }).extraction.detail.gaps)
      .toEqual(['fichier 9 : transcription des pages sans couche texte non enregistrée']);
  });

  it('T1-FIX-03 : extract tronqué, identité invérifiable, type non lu → PARTIAL avec lacunes ; texte absent ≠ erreur technique', () => {
    const ph = t1Phases({ steps: [], failure: null, rawExtracts: [
      resume({ status: 'TRUNCATED', truncated: true, truncationReason: 'pages 3 à 3 non extraites' }),
      resume({ fileId: 10, identity: 'UNVERIFIED' }), resume({ fileId: 11, status: 'NOT_SUPPORTED', method: 'NONE' }),
    ] });
    expect(ph.extraction.state).toBe('PARTIAL');
    expect(ph.extraction.detail.gaps).toEqual([
      'fichier 9 : extract tronqué — pages 3 à 3 non extraites',
      'fichier 10 : identité du contenu réutilisé non vérifiable',
      'fichier 11 : type sans lecture déterministe (lecture par le modèle seule)',
    ]);
    expect(t1Phases({ steps: [], failure: null, rawExtracts: [resume({ status: 'FAILED', error: 'PDF illisible' })] }).extraction.state).toBe('FAILED');
  });
});

describe('Persistance — écritures obligatoires et secondaires (T1-FIX-01, 04, 05)', () => {
  it.each(['RAW_EXTRACT', 'EVIDENCE', 'SOURCE_LAYER', 'OCR', 'KNOWLEDGE'])('T1-FIX-04/05 : %s en échec → FAILED (jamais réussi)', (step) => {
    expect(persistenceOutcome([ok('MASTER'), ko(step)])).toMatchObject({ status: 'FAILED', error: `${step} : panne` });
  });
  it('T1-FIX-06 : attributs métier en échec → PARTIAL (T3 programmé rattrape), jamais SUCCEEDED', () => {
    expect(persistenceOutcome([ok('EVIDENCE'), ko('ATTRIBUTES')]).status).toBe('PARTIAL');
    expect(persistenceOutcome([ok('EVIDENCE'), ok('ATTRIBUTES')]).status).toBe('SUCCEEDED');
  });
  it('T1-FIX-04 : résumé des écritures de preuve en échec, borné', () => {
    const t = describeEvidenceWriteErrors([{ stage: 'RECORD', key: 'mileage@ASSET:1', message: 'refusé' }, { stage: 'SUPERSEDE', key: null, message: 'verrou' }]);
    expect(t).toBe('2 écriture(s) de preuve en échec — RECORD mileage@ASSET:1 : refusé · SUPERSEDE : verrou');
  });
});

const fait = (over: Partial<ProjectedFact>): ProjectedFact => ({
  canonicalKey: 'acquisitionDate', rawKey: null, label: null, subject: null, attribute: null, rawValue: '2025-03-10', value: '2025-03-10',
  valueType: 'date', canonicalUnit: null, target: { targetType: 'EQUIPMENT', targetEntityId: 7, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Date d’achat : 10/03/2025', page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null, ...over,
} as ProjectedFact);

describe('T1-FIX-06 — faits fiables candidats à l’écriture directe', () => {
  it('T1-FIX-06 : certain + preuve écrite sur SA cible → éligible ; sans preuve écrite → ignoré ; probable / visuel / contradiction → non éligible', () => {
    const asset = { targetType: 'ASSET' as const, targetEntityId: 3, targetEntityLabel: null, targetConfidence: 'certain' as const };
    const c = reliableCandidates({
      facts: [
        fait({}),
        fait({ canonicalKey: 'acquisitionPrice', value: 499, confidence: 'probable' }),
        fait({ canonicalKey: 'serialNumber', value: 'A' }), fait({ canonicalKey: 'serialNumber', value: 'B' }),
        fait({ canonicalKey: 'brand', value: 'iRobot', provenance: 'VISUAL_ANALYSIS' }),
        fait({ canonicalKey: 'mileage', value: 1, target: asset }), // preuve non écrite
        fait({ canonicalKey: null, value: 'libre' }),
      ],
      evidenceIds: new Map([
        ['acquisitionDate@EQUIPMENT:7', 1], ['acquisitionPrice@EQUIPMENT:7', 2], ['serialNumber@EQUIPMENT:7', 3], ['brand@EQUIPMENT:7', 4],
      ]),
    });
    expect(c.map((x) => [x.key, x.type, x.entityId, x.eligible, x.reasonCode])).toEqual([
      ['acquisitionDate', 'EQUIPMENT', 7, true, null],
      ['acquisitionPrice', 'EQUIPMENT', 7, false, 'NOT_CERTAIN'],
      ['serialNumber', 'EQUIPMENT', 7, false, 'INTRA_DOCUMENT_CONFLICT'],
      ['brand', 'EQUIPMENT', 7, false, 'VISUAL_ONLY'],
    ]);
    expect(c[0].evidenceIds).toEqual([1]);
  });
});

describe('T1-FIX-09 — trace d’un appel en échec', () => {
  it('T1-FIX-09 : identifiant porté par l’erreur et par sa cause', () => {
    const cause = Object.defineProperty(new Error('ByteString'), 'traceId', { value: 't-cause', enumerable: false });
    const e = Object.assign(new Error('master'), { cause });
    Object.defineProperty(e, 'traceId', { value: 't-1', enumerable: false });
    expect(traceIdsOfError(e)).toEqual(['t-1', 't-cause']);
    expect(traceIdsOfError(null)).toEqual([]);
  });
});
