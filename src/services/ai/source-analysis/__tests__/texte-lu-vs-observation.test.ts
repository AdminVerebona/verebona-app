/**
 * T1 — ce qui est LU (TEXT_EXTRACTION) n'est jamais confondu avec ce qui est
 * OBSERVÉ (VISUAL_ANALYSIS) : sortie modèle, faits, preuves, réponses T2.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ExtractSourceOutput } from '../schemas';
import { splitByEvidence } from '../steps/extract-source.step';
import { buildAgendaCandidates } from '../steps/build-agenda-candidates.step';
import { buildKnowledgeFromSourceAnalysis, factsToExtractedFields, toFact } from '../../knowledge/document-knowledge';
import { evidenceText, type FactHit } from '@/services/verebona-assistant/core/data-answer.service';
import type { SourceAnalysisResult } from '../types';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const sortieChaudiere = ExtractSourceOutput.parse({
  transcription: 'Modèle ABC\n24 kW',
  visual: {
    summary: 'Chaudière murale blanche installée au-dessus d’un évier.',
    observations: [{ description: 'Chaudière fixée au mur, au-dessus d’un évier', subject: 'Chaudière', confidence: 'probable', page: 1 }],
  },
  fields: [
    { fieldKey: 'boilerPower', provenance: 'TEXT_EXTRACTION', subject: 'Chaudière', attribute: 'puissance', value: 24, unit: 'kW', confidence: 'certain', excerpt: '24 kW', page: 1 },
    { fieldKey: 'boilerInstallation', provenance: 'VISUAL_ANALYSIS', subject: 'Chaudière', attribute: 'installation', value: 'murale', confidence: 'probable',
      // Faux extrait fourni par le modèle : il doit disparaître.
      excerpt: 'chaudière murale',
      visualEvidence: { description: 'Appareil fixé au mur', page: 1, imageIndex: 0, region: { x1: 0.2, y1: 0.1, x2: 0.7, y2: 0.6 } } },
    { fieldKey: 'couleur', provenance: 'VISUAL_ANALYSIS', value: 'blanche', confidence: 'certain' },
    { fieldKey: 'serie', value: 'X1', confidence: 'certain' },
  ],
});

describe('sortie T1', () => {
  it('schéma : provenance par défaut TEXT_EXTRACTION, visuel accepté sans extrait', () => {
    expect(sortieChaudiere.fields[3].provenance).toBe('TEXT_EXTRACTION');
    expect(sortieChaudiere.visual?.observations).toHaveLength(1);
  });

  it('chaque information garde la preuve de SA provenance, ou est écartée', () => {
    const { kept, rejected } = splitByEvidence(sortieChaudiere.fields);
    expect(rejected).toEqual(['couleur', 'serie']);
    const visuel = kept.find((f) => f.fieldKey === 'boilerInstallation')!;
    expect(visuel.excerpt).toBeUndefined();
    expect(visuel.visualEvidence?.description).toBe('Appareil fixé au mur');
    expect(kept.find((f) => f.fieldKey === 'boilerPower')!.excerpt).toBe('24 kW');
  });

  it('une date observée ne crée aucune échéance', () => {
    expect(buildAgendaCandidates([{ fieldKey: 'maintenanceDueDate', value: '2026-11-15', confidence: 'certain', provenance: 'VISUAL_ANALYSIS', visualEvidence: { description: 'étiquette' } }])).toEqual([]);
  });
});

describe('représentation durable', () => {
  const result = {
    document: { transcription: 'Modèle ABC\n24 kW', visual: { summary: 'Chaudière murale blanche.', observations: sortieChaudiere.visual!.observations } },
    extractedFields: splitByEvidence(sortieChaudiere.fields).kept.map((f) => ({
      fieldKey: f.fieldKey, value: f.value, confidence: f.confidence, provenance: f.provenance,
      excerpt: f.excerpt, visualEvidence: f.visualEvidence, subject: f.subject, attribute: f.attribute, unit: f.unit, page: f.page,
    })),
    warnings: [], assetCandidates: [], roomCandidates: [], equipmentCandidates: [], agendaCandidates: [],
    sourceGroup: { sourceIds: [1] }, operationTrace: { usedFallback: false, models: ['m'], traceIds: ['t'] },
  } as unknown as SourceAnalysisResult;
  const k = buildKnowledgeFromSourceAnalysis(result, { accountId: 1, fileId: 9, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file' });

  it('texte et observations conservés séparément', () => {
    expect(k.extraction.fullText).toBe('Modèle ABC\n24 kW');
    expect(k.extraction.visualSummary).toBe('Chaudière murale blanche.');
    expect(k.extraction.visualObservations).toHaveLength(1);
  });

  it('faits : provenance et preuve adaptées, jamais de faux extrait', () => {
    const lu = k.facts.find((f) => f.factKey === 'boilerPower')!;
    expect(lu).toMatchObject({ evidenceOrigin: 'TEXT_EXTRACTION', excerpt: '24 kW', visualEvidence: null });
    const vu = k.facts.find((f) => f.factKey === 'boilerInstallation')!;
    expect(vu).toMatchObject({ evidenceOrigin: 'VISUAL_ANALYSIS', excerpt: null, confidence: 'probable' });
    expect(vu.visualEvidence?.region).toEqual({ x1: 0.2, y1: 0.1, x2: 0.7, y2: 0.6 });
    const obs = k.facts.filter((f) => f.factKey.startsWith('visual.'));
    expect(obs.map((f) => f.factKey)).toEqual(['visual.observation.1', 'visual.summary']);
    expect(obs.every((f) => f.excerpt === null && f.evidenceOrigin === 'VISUAL_ANALYSIS')).toBe(true);
  });

  it('photo sans texte : aucune transcription fabriquée', () => {
    const photo = buildKnowledgeFromSourceAnalysis({ ...result, document: { visual: { summary: 'Vélo rouge contre un mur', observations: [] } }, extractedFields: [] } as unknown as SourceAnalysisResult,
      { accountId: 1, fileId: 10, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file' });
    expect(photo.extraction.fullText).toBeNull();
    expect(photo.facts).toHaveLength(1);
    expect(photo.facts[0]).toMatchObject({ factKey: 'visual.summary', valueText: 'Vélo rouge contre un mur', excerpt: null });
  });

  it('projection vers le bien : provenance transmise, observations de document exclues', () => {
    const fields = factsToExtractedFields(k.facts);
    expect(fields.map((f) => f.fieldKey)).toEqual(['boilerPower', 'boilerInstallation']);
    expect(fields[1]).toMatchObject({ provenance: 'VISUAL_ANALYSIS', excerpt: undefined });
  });

  it('un extrait fourni à tort sur un champ visuel n’est pas persisté', () => {
    expect(toFact({ fieldKey: 'x', value: 'murale', confidence: 'probable', provenance: 'VISUAL_ANALYSIS', excerpt: 'chaudière murale', visualEvidence: { description: 'd' } }).excerpt).toBeNull();
  });
});

describe('T2 : citation ≠ observation', () => {
  const hit = (o: Partial<FactHit>): FactHit => ({
    id: 1, fileId: 9, factKey: 'k', subject: 'Chaudière', attribute: 'installation', label: null, valueText: 'murale',
    valueNumber: null, valueUnit: null, confidence: 'certain', excerpt: '', documentTitle: 'Photo chaudière', matchedTerms: 2, ...o,
  });
  it('le texte lu se cite, l’observation se présente comme telle', () => {
    expect(evidenceText(hit({ excerpt: '24 kW' }))).toBe('« 24 kW »');
    const t = evidenceText(hit({ evidenceOrigin: 'VISUAL_ANALYSIS', visualDescription: 'Appareil fixé au mur', page: 1 }));
    expect(t).toBe('Observation visuelle (page 1), non écrite dans le document : Appareil fixé au mur');
    expect(t).not.toMatch(/«/);
  });
});

describe('garde-fous', () => {
  it('prompt v4 : lu / observé, zéro invention, pas de faux extrait', () => {
    const p = src('src/services/ai/prompts/source-analysis/extract_source_v4.txt');
    expect(p).toMatch(/explicitement LISIBLE ou directement OBSERVABLE/);
    expect(p).toMatch(/Ne mets PAS d'`excerpt`/);
    expect(p).toMatch(/Une photo sans texte n'a PAS de transcription/);
    expect(src('src/services/ai/registry/operations.ts')).toMatch(/promptCode: EXTRACT_SOURCE_PROMPT_VERSION/);
  });
  it('base : contraintes lu/vu, observation visuelle plafonnée en réconciliation', () => {
    const m = src('src/db/migrations/0161_t1_text_vs_visual_provenance.sql');
    expect(m).toMatch(/evidence_origin = 'VISUAL_ANALYSIS' AND excerpt IS NULL/);
    expect(m).toMatch(/evidence_origin = 'VISUAL_ANALYSIS' AND evidence_excerpt IS NULL/);
    expect(src('src/services/ai/reconciliation/evidence-collector.ts')).toMatch(/VISUAL_ANALYSIS' && e.confidence === 'certain' \? 'probable'/);
  });
});
