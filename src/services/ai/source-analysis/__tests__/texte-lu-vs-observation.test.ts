/**
 * T1 — ce qui est LU (TEXT_EXTRACTION) n'est jamais confondu avec ce qui est
 * OBSERVÉ (VISUAL_ANALYSIS) : sortie modèle, faits, preuves, réponses T2.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { t1Fact, type T1Fact } from '../master/t1-contract';
import { checkFactEvidence } from '../master/fact-evidence';
import { buildAgendaCandidates } from '../steps/build-agenda-candidates.step';
import { buildKnowledgeFromSourceAnalysis, factsToExtractedFields, toFact } from '../../knowledge/document-knowledge';
import { evidenceText, type FactHit } from '@/services/verebona-assistant/core/data-answer.service';
import type { SourceAnalysisResult } from '../types';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

// Sortie ANALYZE_DOCUMENT du master T1 (seul moteur depuis le lot 16b-3).
const fait = (f: Record<string, unknown>) => t1Fact.parse({ target: { type: 'EQUIPMENT', entityId: null }, ...f });
const faitsChaudiere: T1Fact[] = [
  fait({ canonicalKey: null, rawKey: 'boilerPower', provenance: 'TEXT_EXTRACTION', subject: 'Chaudière', attribute: 'puissance',
    normalizedValue: 24, canonicalUnit: 'kW', confidence: 'certain', evidence: { excerpt: '24 kW', page: 1 } }),
  fait({ canonicalKey: null, rawKey: 'boilerInstallation', provenance: 'VISUAL_ANALYSIS', subject: 'Chaudière', attribute: 'installation',
    normalizedValue: 'murale', confidence: 'probable',
    // Faux extrait fourni par le modèle : il doit disparaître.
    evidence: { excerpt: 'chaudière murale' },
    visualEvidence: { description: 'Appareil fixé au mur', page: 1, imageIndex: 0, region: { x1: 0.2, y1: 0.1, x2: 0.7, y2: 0.6 } } }),
  fait({ canonicalKey: null, rawKey: 'couleur', provenance: 'VISUAL_ANALYSIS', normalizedValue: 'blanche', confidence: 'certain' }),
  fait({ canonicalKey: null, rawKey: 'serie', normalizedValue: 'X1', confidence: 'certain' }),
];
const observations = [{ description: 'Chaudière fixée au mur, au-dessus d’un évier', subject: 'Chaudière', confidence: 'probable' as const, page: 1 }];

/** Tri des faits par leur preuve (`checkFactEvidence`, comme `analyze-document.step`). */
function trier(faits: T1Fact[]) {
  const kept: T1Fact[] = [];
  const rejected: string[] = [];
  for (const f of faits) {
    const r = checkFactEvidence(f);
    if (r.ok) kept.push(r.fact); else rejected.push(f.rawKey ?? '?');
  }
  return { kept, rejected };
}

describe('sortie T1', () => {
  it('schéma : provenance par défaut TEXT_EXTRACTION', () => {
    expect(faitsChaudiere[3].provenance).toBe('TEXT_EXTRACTION');
  });

  it('chaque information garde la preuve de SA provenance, ou est écartée', () => {
    const { kept, rejected } = trier(faitsChaudiere);
    expect(rejected).toEqual(['couleur', 'serie']);
    const visuel = kept.find((f) => f.rawKey === 'boilerInstallation')!;
    expect(visuel.evidence.excerpt).toBeUndefined();
    expect(visuel.visualEvidence?.description).toBe('Appareil fixé au mur');
    expect(kept.find((f) => f.rawKey === 'boilerPower')!.evidence.excerpt).toBe('24 kW');
  });

  it('une date observée ne crée aucune échéance', () => {
    expect(buildAgendaCandidates([{ fieldKey: 'maintenanceDueDate', value: '2026-11-15', confidence: 'certain', provenance: 'VISUAL_ANALYSIS', visualEvidence: { description: 'étiquette' } }])).toEqual([]);
  });
});

describe('représentation durable', () => {
  const result = {
    document: { transcription: 'Modèle ABC\n24 kW', visual: { summary: 'Chaudière murale blanche.', observations } },
    extractedFields: trier(faitsChaudiere).kept.map((f) => ({
      fieldKey: f.rawKey!, value: f.normalizedValue, confidence: f.confidence, provenance: f.provenance,
      excerpt: f.evidence.excerpt, visualEvidence: f.visualEvidence, subject: f.subject ?? undefined,
      attribute: f.attribute ?? undefined, unit: f.canonicalUnit ?? undefined, page: f.evidence.page ?? f.visualEvidence?.page,
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
  it('prompt maître T1 : lu / observé, zéro invention, pas de faux extrait', () => {
    const p = src('src/services/ai/prompts/source-analysis/t1_master_v1.txt');
    expect(p).toMatch(/explicitement LISIBLE ou directement OBSERVABLE/);
    expect(p).toMatch(/Aucun faux extrait : `evidence\.excerpt` est ABSENT/);
    expect(src('src/services/ai/registry/operations.ts')).toMatch(/promptCode: T1_MASTER, masterPromptCode: T1_MASTER, task: 'ANALYZE_DOCUMENT'/);
  });
  it('base : contraintes lu/vu, observation visuelle plafonnée en réconciliation', () => {
    const m = src('src/db/migrations/0161_t1_text_vs_visual_provenance.sql');
    expect(m).toMatch(/evidence_origin = 'VISUAL_ANALYSIS' AND excerpt IS NULL/);
    expect(m).toMatch(/evidence_origin = 'VISUAL_ANALYSIS' AND evidence_excerpt IS NULL/);
    expect(src('src/services/ai/reconciliation/evidence-collector.ts')).toMatch(/VISUAL_ANALYSIS' && e.confidence === 'certain' \? 'probable'/);
  });
});
