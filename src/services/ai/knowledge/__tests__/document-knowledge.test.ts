/**
 * T1 — représentation durable du document (contenu source, faits génériques,
 * preuves), indépendante du rattachement à un bien.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeFromSourceAnalysis,
  factsToExtractedFields,
  splitValueAndUnit,
  toFact,
} from '../document-knowledge';
import { snippetAround } from '../document-knowledge.service';
import type { SourceAnalysisResult } from '../../source-analysis/types';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

function result(over: Partial<SourceAnalysisResult> = {}): SourceAnalysisResult {
  return {
    sourceGroup: { sourceIds: [7], leadSourceId: 7 },
    document: {
      title: { value: 'Facture remplacement chaudière', confidence: 'certain', excerpt: 'FACTURE', location: {} },
      description: { value: 'Remplacement chaudière gaz', confidence: 'probable', excerpt: 'Remplacement', location: {} },
      date: { value: '2026-03-14', confidence: 'certain', excerpt: '14/03/2026', location: {} },
      supplier: { value: { name: 'Thermo Services', siret: '12345678901234', supplierId: null }, confidence: 'certain', excerpt: 'Thermo', location: {} },
      amountCents: { value: 489000, confidence: 'certain', excerpt: '4 890,00 €', location: {} },
      transcription: 'Chaudière Vitodens. Puissance nominale : 24 kW.',
    },
    assetCandidates: [],
    roomCandidates: [],
    equipmentCandidates: [],
    extractedFields: [
      { fieldKey: 'boilerPower', subject: 'Chaudière', attribute: 'puissance', value: 24, unit: 'kW', confidence: 'certain', excerpt: 'Puissance nominale : 24 kW', page: 1 },
    ],
    agendaCandidates: [],
    warnings: [],
    operationTrace: { traceIds: ['t'], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['gemini-2.5-flash'] },
    ...over,
  } as SourceAnalysisResult;
}

const ctx = { accountId: 1, fileId: 7, analysisRunId: 3, assetIdAtAnalysis: null, sourceType: 'asset_file' as const };

describe('niveau 1 — contenu source', () => {
  it('conserve texte, description, titre, date, émetteur, montant et leurs preuves', () => {
    const { extraction } = buildKnowledgeFromSourceAnalysis(result(), ctx);
    expect(extraction.fullText).toContain('24 kW');
    expect(extraction.title).toBe('Facture remplacement chaudière');
    expect(extraction.description).toBe('Remplacement chaudière gaz');
    expect(extraction.documentDate).toBe('2026-03-14');
    expect(extraction.supplierName).toBe('Thermo Services');
    expect(extraction.amountCents).toBe(489000);
    expect(extraction.structuralEvidence.title.excerpt).toBe('FACTURE');
    expect(extraction.model).toBe('gemini-2.5-flash');
  });

  it('fonctionne sans aucun bien identifié', () => {
    const k = buildKnowledgeFromSourceAnalysis(result(), { ...ctx, assetIdAtAnalysis: null });
    expect(k.extraction.assetIdAtAnalysis).toBeNull();
    expect(k.facts).toHaveLength(1);
  });
});

describe('niveau 2 — faits génériques', () => {
  it('Chaudière / puissance / 24 / kW, avec preuve et localisation', () => {
    const [fact] = buildKnowledgeFromSourceAnalysis(result(), ctx).facts;
    expect(fact).toMatchObject({
      factKey: 'boilerPower', subject: 'Chaudière', attribute: 'puissance',
      valueNumber: 24, valueUnit: 'kW', confidence: 'certain',
      excerpt: 'Puissance nominale : 24 kW', location: { page: 1 },
    });
  });

  it('sépare l’unité laissée dans la valeur par un ancien prompt', () => {
    expect(splitValueAndUnit('24 kW')).toEqual({ number: 24, unit: 'kW' });
    expect(splitValueAndUnit('1 250,50 €')).toEqual({ number: 1250.5, unit: '€' });
    expect(splitValueAndUnit('82 m²')).toEqual({ number: 82, unit: 'm²' });
    expect(splitValueAndUnit('3 portes')).toBeNull();
    expect(splitValueAndUnit('1.250')).toBeNull(); // ambigu (millier ou décimale)
    expect(splitValueAndUnit('1.250.000,5 €')).toEqual({ number: 1250000.5, unit: '€' });
    expect(splitValueAndUnit('12.5 kW')).toEqual({ number: 12.5, unit: 'kW' });
    expect(toFact({ fieldKey: 'k', value: '24 kW', confidence: 'certain', excerpt: 'e' }).valueUnit).toBe('kW');
  });

  it('conserve les périodes et les informations sans colonne métier', () => {
    const f = toFact({ fieldKey: 'boiler.serialNumber', value: '7723001', confidence: 'certain', excerpt: 'N° 7723001', periodStart: '2026-03-14', periodEnd: 'mars 2031' });
    expect(f.subject).toBe('boiler');
    expect(f.attribute).toBe('serialNumber');
    expect(f.periodStart).toBe('2026-03-14');
    expect(f.periodEnd).toBeNull(); // date non ISO refusée plutôt que devinée
    // Un identifiant sans unité reste du texte, jamais une quantité.
    expect(f.valueNumber).toBeNull();
    expect(f.valueText).toBe('7723001');
    expect(toFact({ fieldKey: 'cp', value: '06120', confidence: 'certain', excerpt: 'e', unit: 'kg' }).valueNumber).toBeNull();
  });

  it('un fait sans extrait justificatif n’est pas conservé', () => {
    const k = buildKnowledgeFromSourceAnalysis(result({
      extractedFields: [{ fieldKey: 'x', value: 'y', confidence: 'probable', excerpt: '' }],
    }), ctx);
    expect(k.facts).toHaveLength(0);
  });
});

describe('niveau 3 — projections sans relecture', () => {
  it('les faits persistés redeviennent des champs pour les preuves du bien', () => {
    const [field] = factsToExtractedFields([{
      factKey: 'boilerPower', valueJson: 24, normalizedValue: '24', confidence: 'certain', excerpt: 'e', location: { page: 2 },
    }]);
    expect(field).toMatchObject({ fieldKey: 'boilerPower', value: 24, page: 2 });
  });

  it('le rattachement à un bien projette depuis T1 au lieu de relancer l’analyse', () => {
    const route = read('src/app/api/documents/[id]/route.ts');
    expect(route).toContain('projectDocumentKnowledgeToAsset');
    expect(read('src/app/api/documents/bulk-move/route.ts')).toContain('projectDocumentKnowledgeToAsset');
    // Projection seulement s'il existe des faits actifs ; sinon (ou 0 preuve), réanalyse.
    expect(route).toContain('hasProjectableKnowledge');
    expect(route).toMatch(/preuves === 0\) reanalyser\(\)/);
    // Toute autre modification envoyée (description, montant…) force la réanalyse.
    expect(route).toContain('autresChampsModifies');
  });

  it('le pipeline T1 écrit la représentation durable pour tout document', () => {
    const pipeline = read('src/services/ai/source-analysis/pipeline.ts');
    const i = pipeline.indexOf('persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis');
    expect(i).toBeGreaterThan(0);
    // Écrite AVANT et indépendamment de la condition « un bien est déterminé ».
    expect(i).toBeLessThan(pipeline.indexOf('await persistEvidence({'));
    expect(pipeline.indexOf('if (assetId) {')).toBeLessThan(pipeline.indexOf('await persistEvidence({'));
  });
});

describe('recherche', () => {
  it('extrait autour du terme, insensible aux accents', () => {
    const s = snippetAround('Début. Chaudière Vitodens puissance 24 kW. Fin.', ['chaudiere']);
    expect(s).toContain('Chaudière Vitodens');
  });
});
