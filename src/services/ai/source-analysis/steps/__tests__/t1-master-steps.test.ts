/**
 * Étapes T1 master de bout en bout — CDC 15 §23, §30 (P-T1-01 à P-T1-05),
 * D-08 (corpus synthétique).
 *
 * Passerelle RÉELLE (chargement du master `t1_master_v1.txt` du dépôt,
 * injection de TASK, validation discriminée) ; seul le fournisseur est simulé
 * et rend la sortie enregistrée de la fixture. La base est remplacée par le
 * contexte de la fixture (identifiants vérifiés, familles).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { loadT1Fixture, fixtureAnalysisContext, type T1Fixture } from '../../__fixtures__/t1/load';
import type { LinkCandidate, SourceInput } from '../../types';

// Compte Premium : pièces et équipements autorisés (capacités du compte).
vi.mock('@/services/account-capabilities.service', async (orig) => ({
  ...(await orig<object>()), getAccountCapabilities: async () => ({ rooms: true, equipments: true }),
}));
vi.mock('@/services/ai/telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/telemetry/ai-trace.service')>()),
  recordCallTrace: async () => {},
}));

/** Identifiants existant dans le compte simulé (remplace la base). */
const existants: Record<string, Set<number>> = { asset: new Set(), room: new Set(), equipment: new Set(), supplier: new Set() };
vi.mock('../../identifier-verifier', () => ({
  verifyCandidates: async (entity: string, candidates: LinkCandidate[]) => {
    const warnings: Array<{ code: string; message: string; target: string }> = [];
    return {
      candidates: candidates.map((c) => {
        if (c.entityId === null) return { ...c, verified: false };
        if (existants[entity].has(c.entityId)) return { ...c, verified: true };
        warnings.push({ code: 'UNVERIFIED_IDENTIFIER', message: `${entity} #${c.entityId} introuvable`, target: `${entity}:${c.entityId}` });
        return { ...c, entityId: null, verified: false };
      }),
      warnings,
    };
  },
}));
vi.mock('../../master/rubric-rules', async (orig) => ({
  ...(await orig<typeof import('../../master/rubric-rules')>()),
  loadAssetFamilies: async () => ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT'],
}));

const { FakeProvider, setAiProvider } = await import('@/services/ai/gateway/providers');
const { __setConfigForTests } = await import('@/services/ai/config/config-resolver');
const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
const { analyzeDocument } = await import('../analyze-document.step');
const { groupUpload } = await import('../group-upload.step');
const { analyseGroupWithMaster } = await import('../../master/analyse-group-master');
const { emptyTrace } = await import('../../trace');

let fake: InstanceType<typeof FakeProvider>;

function installer(f: T1Fixture, output: unknown = f.recording.output) {
  for (const k of Object.keys(existants)) existants[k].clear();
  const v = f.context.verified ?? {};
  (v.ASSET ?? []).forEach((id) => existants.asset.add(id));
  (v.ROOM ?? []).forEach((id) => existants.room.add(id));
  (v.EQUIPMENT ?? []).forEach((id) => existants.equipment.add(id));
  (v.SUPPLIER ?? []).forEach((id) => existants.supplier.add(id));
  fake.on('m-a', () => ({ rawText: JSON.stringify(output), inputTokens: 100, outputTokens: 50 }));
}

function sourceInput(f: T1Fixture, count = 1): SourceInput {
  return {
    sourceType: 'file',
    sourceIds: Array.from({ length: count }, (_, i) => 1000 + i),
    accountId: 1, userId: 1,
    mimeTypes: f.context.mimeTypes ?? ['application/pdf'],
    displayNames: f.context.displayNames ?? ['document.pdf'],
    linkedAssetId: f.context.linkedAssetId ?? null,
  };
}

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  __setConfigForTests({
    versionId: 1,
    entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: null, fallback2: null, promptArchitecture: 'master' }],
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => __setConfigForTests(null));

describe('P-T1-01 — GROUP_UPLOAD', () => {
  it('contrat 2 pages + facture distincte → [[0,1],[2]], TASK imposée par le serveur', async () => {
    const f = loadT1Fixture('p-t1-01-group-upload.json');
    installer(f);
    const r = await groupUpload(sourceInput(f, 3));
    expect(r.groups).toEqual([[0, 1], [2]]);
    expect(fake.calls[0].task).toBe('GROUP_UPLOAD');
    expect(fake.calls[0].prompt).toContain('TASK = GROUP_UPLOAD');
    expect(fake.calls[0].prompt).toContain('contrat-assurance-p2.jpg');
    expect(r.trace.operationCodes).toEqual(['t1_group_upload']);
  });

  it('sortie imparfaite : chaque index exactement une fois, aucun fichier perdu', async () => {
    const f = loadT1Fixture('p-t1-01-group-upload.json');
    installer(f, { task: 'GROUP_UPLOAD', groups: [[0, 1], [1], [7]] });
    expect((await groupUpload(sourceInput(f, 3))).groups).toEqual([[0, 1], [2]]);
  });

  it('un seul fichier : aucun appel modèle', async () => {
    const f = loadT1Fixture('p-t1-01-group-upload.json');
    installer(f);
    expect((await groupUpload(sourceInput(f, 1))).groups).toEqual([[0]]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('ANALYZE_DOCUMENT — variables structurées et contrôles serveur', () => {
  it('registre filtré par la famille du bien connu, catalogues en données, TASK injectée', async () => {
    const f = loadT1Fixture('p-t1-03-facture-reparation.json');
    installer(f);
    await analyzeDocument(sourceInput(f), [0], fixtureAnalysisContext(f));
    const { prompt, task } = fake.calls[0];
    expect(task).toBe('ANALYZE_DOCUMENT');
    expect(prompt).toContain('TASK = ANALYZE_DOCUMENT');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    // T1-01 : registre canonique d'un VÉHICULE — pas de clé immobilière.
    expect(prompt).toContain('"key":"registrationNumber"');
    expect(prompt).toContain('"key":"acquisitionPrice","label":"Prix d’achat","valueType":"money_eur","unit":"EUR"');
    expect(prompt).not.toContain('"key":"dpeDate"');
    // Lot 13 : la cible admise est exposée (bien ET équipement pour acquisitionPrice).
    expect(prompt).toMatch(/"key":"acquisitionPrice"[^}]*"targets":\["ASSET","EQUIPMENT"\]/);
    expect(prompt).toContain('"businessType":"repair"');
    expect(prompt).toContain('"code":"FACTURE"');
    expect(prompt).toContain('"type":"ASSET","entityId":12');
  });

  it('preuve obligatoire : lu sans extrait ou observé sans description → écarté, avertissement', async () => {
    const f = loadT1Fixture('p-t1-03-facture-reparation.json');
    const out = structuredClone(f.recording.output) as { facts: Array<Record<string, unknown>> };
    out.facts.push(
      { canonicalKey: 'vin', normalizedValue: 'VF1XXX', target: { type: 'ASSET', entityId: 12 }, provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: {} },
      { canonicalKey: null, rawKey: 'couleur', normalizedValue: 'rouge', target: { type: 'ASSET', entityId: 12 }, provenance: 'VISUAL_ANALYSIS', confidence: 'probable', evidence: { excerpt: 'rouge' } },
    );
    installer(f, out);
    const r = await analyzeDocument(sourceInput(f), [0], fixtureAnalysisContext(f));
    expect(r.analysis.facts.map((x) => x.canonicalKey ?? x.rawKey)).not.toContain('vin');
    expect(r.analysis.facts.map((x) => x.rawKey)).not.toContain('couleur');
    expect(r.warnings.find((w) => w.code === 'FIELD_WITHOUT_EVIDENCE')?.message).toMatch(/2 information/);
  });

  it('sortie tolérée : >300 faits traités en deux lots (lot 34F, aucune troncature), fait invalide écarté, extrait introuvable déclassé — avertissements', async () => {
    const f = loadT1Fixture('p-t1-03-facture-reparation.json');
    const out = structuredClone(f.recording.output) as { facts: Array<Record<string, unknown>> };
    const base = out.facts[1];
    out.facts = [
      { ...base, canonicalKey: 'vin', normalizedValue: 'VF1XXX', rawValue: null, evidence: { excerpt: 'VIN VF1XXX' } },
      { ...base, target: { type: 'BATIMENT' } },
      ...Array.from({ length: 305 }, () => base),
    ];
    installer(f, out);
    const r = await analyzeDocument(sourceInput(f), [0], fixtureAnalysisContext(f));
    const cibles = r.warnings.map((w) => w.target);
    expect(cibles).toEqual(expect.arrayContaining(['t1-master:facts-invalid', 't1-master:excerpt-not-found']));
    // Lot 34F : plus de FACTS_TRUNCATED — les 306 faits valides sont tous retenus.
    expect(cibles).not.toContain('t1-master:facts-truncated');
    expect(r.analysis.facts).toHaveLength(306);
    expect(r.extraction?.batchedSections).toBeGreaterThanOrEqual(1);
    expect(r.extraction?.dropped).toEqual([expect.objectContaining({ reason: 'INVALID_SCHEMA', pass: 'PASS_1' })]);
    // Codes dédiés, plus de PARTIAL_EXTRACTION générique.
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['FACT_INVALID_DROPPED', 'EXCERPT_NOT_FOUND']));
    expect(r.warnings.map((w) => w.code)).not.toContain('PARTIAL_EXTRACTION');
    expect(r.analysis.facts.find((x) => x.canonicalKey === 'vin')?.confidence).toBe('probable');
    expect(r.analysis.facts.find((x) => x.canonicalKey === 'mileage')?.confidence).toBe('certain');
  });

  it('identifiants revérifiés : un bien inexistant est neutralisé (avertissement unique)', async () => {
    const f = loadT1Fixture('t1-01-alias-libre.json');
    installer(f);
    const r = await analyzeDocument(sourceInput(f), [0], fixtureAnalysisContext(f));
    expect(r.verifiedIds.ASSET.has(999)).toBe(false);
    expect(r.warnings.filter((w) => w.code === 'UNVERIFIED_IDENTIFIER')).toHaveLength(1);
    expect(r.documentAssetId).toBe(184);
  });

  it('sortie d’une autre branche : refusée par la validation discriminée', async () => {
    const f = loadT1Fixture('p-t1-03-facture-reparation.json');
    installer(f, { task: 'GROUP_UPLOAD', groups: [[0]] });
    await expect(analyzeDocument(sourceInput(f), [0], fixtureAnalysisContext(f))).rejects.toBeTruthy();
  });
});

describe('Corpus P-T1 — analyse, projection et contrat historique', () => {
  const analyser = async (file: string) => {
    const f = loadT1Fixture(file);
    installer(f);
    return analyseGroupWithMaster(sourceInput(f), [0], fixtureAnalysisContext(f), emptyTrace());
  };

  it('P-T1-02 : acquisitionDate + acquisitionPrice (EUR) + purchase, classement V2 et type canonique', async () => {
    const m = await analyser('p-t1-02-ticket-draisienne.json');
    const champs = m.result.extractedFields;
    expect(champs.find((c) => c.fieldKey === 'acquisitionDate')).toMatchObject({
      value: '2026-04-24', canonicalKey: 'acquisitionDate', origin: 'DETERMINISTIC_RULE',
      semanticEvent: { type: 'purchase', nature: 'HISTORICAL' }, excerpt: '24/04/2026 15:42',
      target: { targetType: 'ASSET', targetEntityId: 184 },
    });
    expect(champs.find((c) => c.fieldKey === 'acquisitionPrice')).toMatchObject({ value: 129, canonicalUnit: 'EUR' });
    expect(m.result.document.amountCents?.value).toBe(12900);
    expect(m.result.document.type?.value).toBe('FACTURE');
    expect(m.result.document.rubric).toMatchObject({ rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'ACQUISITION_INVOICE' });
    // Événement historique : jamais un candidat agenda.
    expect(m.result.agendaCandidates).toEqual([]);
    expect(m.result.operationTrace.operationCodes).toEqual(['t1_analyze_document']);
  });

  it('P-T1-03 : repair, jamais acquisitionPrice ; perte signalée', async () => {
    const m = await analyser('p-t1-03-facture-reparation.json');
    expect(m.facts.some((x) => x.canonicalKey === 'acquisitionPrice')).toBe(false);
    expect(m.facts.some((x) => x.semanticEvent?.type === 'repair')).toBe(true);
    expect(m.result.warnings).toContainEqual(expect.objectContaining({
      code: 'FACT_REJECTED_BY_RULE',
      target: 'projection:FACT_REMOVED_BY_RULE:SERVICE_INVOICE_NO_ACQUISITION:acquisitionPrice',
    }));
    expect(m.result.warnings.map((w) => w.code)).not.toContain('PARTIAL_EXTRACTION');
  });

  it('P-T1-04 : faits ciblés séparément, liens N-N, aucune échéance de la Tesla sur la Clio', async () => {
    const m = await analyser('p-t1-04-facture-deux-vehicules.json');
    expect(m.result.warnings.map((w) => w.code)).toContain('MULTI_ASSET_DOCUMENT');
    expect(m.result.assetCandidates.map((c) => [c.entityId, c.verified])).toEqual([[12, true], [13, true]]);
    const km = m.result.extractedFields.filter((c) => c.fieldKey === 'mileage');
    expect(km.map((c) => [c.value, c.target?.targetEntityId, c.table])).toEqual([
      [78000, 12, { index: 0, row: 0, column: 1 }], [42000, 13, { index: 0, row: 1, column: 1 }],
    ]);
    expect(m.result.agendaCandidates.map((a) => a.date)).toEqual(['2027-11-15']);
    expect(m.result.document.tables?.[0].cells.length).toBeGreaterThan(0);
  });

  it('pertes signalées avec les codes dédiés : requalifié générique, unité incohérente', async () => {
    const f = loadT1Fixture('t1-01-alias-libre.json');
    const out = structuredClone(f.recording.output) as { facts: Array<Record<string, unknown>> };
    out.facts.push({
      canonicalKey: 'acquisitionPrice', rawValue: '749,00 €', normalizedValue: 74900, valueType: 'money_eur', canonicalUnit: 'EUR',
      target: { type: 'ASSET', entityId: 184 }, provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: '749,00 €' },
    });
    installer(f, out);
    const m = await analyseGroupWithMaster(sourceInput(f), [0], fixtureAnalysisContext(f), emptyTrace());
    expect(m.result.warnings).toContainEqual(expect.objectContaining({
      code: 'FACT_REQUALIFIED_GENERIC', target: 'projection:UNKNOWN_CANONICAL_KEY:boilerPower',
    }));
    expect(m.result.warnings).toContainEqual(expect.objectContaining({
      code: 'UNIT_MISMATCH', target: 'projection:UNIT_MISMATCH:acquisitionPrice',
    }));
    expect(m.result.warnings.map((w) => w.code)).not.toContain('PARTIAL_EXTRACTION');
  });

  it('chemin réel : extrait absent de la transcription → probable dans le résultat, avertissement', async () => {
    const f = loadT1Fixture('p-t1-03-facture-reparation.json');
    const out = structuredClone(f.recording.output) as { facts: Array<Record<string, unknown>> };
    out.facts[1] = { ...out.facts[1], evidence: { excerpt: 'Kilométrage : 87 000 km' } };
    installer(f, out);
    const m = await analyseGroupWithMaster(sourceInput(f), [0], fixtureAnalysisContext(f), emptyTrace());
    expect(m.result.extractedFields.find((c) => c.fieldKey === 'mileage')?.confidence).toBe('probable');
    expect(m.facts.find((x) => x.canonicalKey === 'mileage')?.confidence).toBe('probable');
    expect(m.result.warnings.map((w) => w.target)).toContain('t1-master:excerpt-not-found');
    // L'extrait présent dans la transcription reste certain.
    expect(m.facts.find((x) => x.subject === 'Clio' && x.attribute === 'réparation')?.confidence).toBe('certain');
  });

    it('P-T1-05 : dpeDate, aucune expiration, aucune échéance', async () => {
    const m = await analyser('p-t1-05-dpe-realise.json');
    expect(m.facts.filter((x) => x.canonicalKey === 'dpeDate')).toHaveLength(1);
    expect(m.facts.some((x) => x.canonicalKey === 'dpeExpiryDate')).toBe(false);
    expect(m.result.agendaCandidates).toEqual([]);
  });

  it('observation visuelle : aucun extrait dans le contrat historique (T1-08)', async () => {
    const m = await analyser('t1-04-equipement-chaudiere.json');
    const visuel = m.result.extractedFields.find((c) => c.provenance === 'VISUAL_ANALYSIS');
    expect(visuel?.excerpt).toBeUndefined();
    expect(visuel?.visualEvidence?.description).toBe('Appareil fixé au mur');
  });

  it('chaque fixture d’analyse respecte le schéma de sortie du contrat', async () => {
    const { T1AnalyzeDocumentOutput, T1GroupUploadOutput } = await import('../../master/t1-contract');
    const { listT1Fixtures } = await import('../../__fixtures__/t1/load');
    const { validateOutput } = await import('../../../gateway/output-validator');
    for (const file of listT1Fixtures()) {
      const f = loadT1Fixture(file);
      const schema: z.ZodTypeAny = f.recording.task === 'GROUP_UPLOAD' ? T1GroupUploadOutput : T1AnalyzeDocumentOutput;
      // Lot 33D : les fixtures `t1-33d-*` simulent des sorties FAUTIVES (null,
      // date objet, ancien format) que seule la résolution des sorties absorbe.
      if (!file.startsWith('t1-33d-')) expect(schema.safeParse(f.recording.output).success, file).toBe(true);
      expect(() => validateOutput(JSON.stringify(f.recording.output), schema, 'op', 'json', {
        expectedTask: f.recording.task, schemaName: f.recording.task === 'GROUP_UPLOAD' ? 'T1GroupUploadOutput' : 'T1AnalyzeDocumentOutput',
      }), file).not.toThrow();
    }
  });
});
