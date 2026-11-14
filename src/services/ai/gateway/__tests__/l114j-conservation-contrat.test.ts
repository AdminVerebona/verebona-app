/**
 * Lot 114 (carte #776 — travaux 6 et 7 ; AC03, AC05, AC07, AC08) —
 * CONSERVATION des branches du contrat T1 v7 à travers la passerelle, quel
 * que soit le mode réel : schéma imposé accepté, ou refusé (HTTP 400) puis
 * réponse sans schéma. Le même contrat runtime valide les deux ; la sortie
 * métier rendue est IDENTIQUE — le repli ne coûte aucune donnée ni preuve.
 *
 * Passerelle réelle, fournisseur simulé. Sortie de départ : la fixture T1 du
 * dépôt, complétée d'un fait HORS CATALOGUE (clé canonique nulle), d'une
 * période facturée, des coordonnées du fournisseur, d'une transcription et de
 * décisions de valeurs (dont une valeur non retenue).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { capture.traces.push(t); return capture.traces.length; }),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { clearSchemaRejections } = await import('../output-resolution/provider-schema');
const { T1AnalyzeDocumentOutput } = await import('../../source-analysis/master/t1-contract');
const { t1TestVariables } = await import('./t1-master-request');

type Json = Record<string, any>;
type Trace = { status: string; providerMeta?: { structuredOutput?: string }; runtimeContract?: { contractId: string; contractVersion: number; schemaHash: string; schemaVersion: string } };

/** Sortie T1 v7 portant toutes les familles du contrat. */
function sortieComplete(): Json {
  const ex = JSON.parse(readFileSync(join(process.cwd(), 'src/services/ai/source-analysis/__fixtures__/compat/t1-analyze-document.lot33-example.json'), 'utf8')) as Json;
  ex.document.supplier.contacts = { phone: '01 02 03 04 05', email: 'contact@magasin-exemple.test', city: 'Lyon', postalCode: '69001' };
  ex.document.billingPeriod = { start: '2026-04-01', end: '2026-04-30', principalMonth: '2026-04', principalMonthBasis: 'MAJORITY_OF_PERIOD', confidence: 'probable', evidence: { excerpt: 'Période du 01/04/2026 au 30/04/2026', page: 1 } };
  ex.transcription = 'DRAISIENNE BOIS 12 POUCES\nCouleur du cadre : vert sapin\nTOTAL 129,00 EUR';
  // Attribut ABSENT du FIELD_CATALOG : fait générique — clé canonique nulle, libellé et valeur d'origine, preuve.
  ex.facts.push({
    canonicalKey: null, rawKey: 'couleur du cadre', label: 'Couleur du cadre', subject: 'Draisienne', attribute: 'couleur du cadre',
    rawValue: 'vert sapin', normalizedValue: 'vert sapin', valueType: 'string', canonicalUnit: null,
    target: { type: 'GENERIC', entityId: null, rawLabel: 'Draisienne', confidence: 'probable', evidenceSignals: [] },
    provenance: 'TEXT_EXTRACTION', confidence: 'probable', evidence: { excerpt: 'Couleur du cadre : vert sapin', page: 1 },
  });
  ex.valueDecisions = [
    { value: '129,00 EUR', kind: 'AMOUNT', normalizedValue: 12900, decision: 'STRUCTURED', reason: 'Total payé, repris dans le montant du document.', evidence: { excerpt: 'TOTAL 129,00 EUR', page: 1 }, relatedFactIndexes: [0], relatedCandidateKeys: [], confidence: 'certain' },
    { value: 'TKT-000123', kind: 'IDENTIFIER', decision: 'NOT_RETAINED', reason: 'Numéro de ticket de caisse, sans attribut correspondant sur le bien.', evidence: { excerpt: 'TKT-000123', page: 1 }, relatedFactIndexes: [], relatedCandidateKeys: [], confidence: 'probable' },
  ];
  return ex;
}

const invalidArgument = () => Object.assign(
  new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { name: 'ClientError', status: 400 },
);
const requete = () => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: 't1_analyze_document', accountId: 1,
  promptVariables: t1TestVariables('ticket'), outputSchema: T1AnalyzeDocumentOutput, idempotencyKey: `l114j-c-${Math.random()}`,
});

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  capture.traces.length = 0;
  clearSchemaRejections();
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});

describe('L114J-CONS — le mode réel (schéma imposé ou repli JSON) ne change pas la donnée conservée', () => {
  it('L114J-CONS-01 — la sortie de référence est conforme au contrat T1 v7 et porte toutes ses familles', () => {
    const v = T1AnalyzeDocumentOutput.safeParse(sortieComplete());
    expect(v.success, JSON.stringify(v.error?.issues?.slice(0, 3))).toBe(true);
    const d = v.data as Json;
    for (const k of ['document', 'entities', 'facts', 'tables', 'visual', 'transcription', 'businessOperationCandidates', 'valueDecisions']) expect(d[k], k).toBeDefined();
    expect(d.document.supplier.contacts).toBeDefined();
    expect(d.document.billingPeriod).toBeDefined();
  });

  it('L114J-CONS-02 — schéma accepté puis schéma refusé : DEUX modes, UNE même sortie métier, UN même contrat runtime', async () => {
    const brut = JSON.stringify(sortieComplete());
    // Mode 1 : le fournisseur accepte la requête portant le schéma.
    fake.onAny(() => ({ rawText: brut, inputTokens: 100, outputTokens: 50 }));
    const structure = await AiGateway.execute(requete());
    expect(fake.calls.map((c) => c.responseSchema !== undefined)).toEqual([true]);
    // Mode 2 : il la refuse (400 générique), puis répond au même modèle sans schéma.
    clearSchemaRejections();
    fake.reset();
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: brut, inputTokens: 100, outputTokens: 50 };
    });
    const repli = await AiGateway.execute(requete());
    expect(fake.calls.map((c) => c.responseSchema !== undefined)).toEqual([true, false]);
    expect(fake.calls[1].model).toBe(fake.calls[0].model);

    const [t1, t2] = capture.traces as Trace[];
    expect(t1.providerMeta?.structuredOutput).toBe('requested_schema');
    expect(t2.providerMeta?.structuredOutput).toBe('schema_rejected_retried_without');
    // AC03 : même contrat (identifiant, version, empreinte) pour les deux générations et leur validation.
    expect(t1.runtimeContract).toMatchObject({ contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7, schemaVersion: 't1_analyze_document@v7' });
    expect(t2.runtimeContract).toMatchObject({ contractId: t1.runtimeContract!.contractId, contractVersion: 7, schemaHash: t1.runtimeContract!.schemaHash });
    // Le contrat est joint au prompt de l'essai sans schéma, en mode JSON.
    expect(fake.calls[1].jsonResponse).toBe(true);
    expect(fake.calls[1].prompt).toContain(t1.runtimeContract!.schemaHash);

    // AC07 : la donnée rendue est la même, branche par branche.
    expect(repli.data).toEqual(structure.data);
    const d = repli.data as Json;
    expect(d.document.supplier).toMatchObject({ name: 'Magasin Exemple', contacts: { phone: '01 02 03 04 05', email: 'contact@magasin-exemple.test', city: 'Lyon', postalCode: '69001' } });
    expect(d.document.billingPeriod).toMatchObject({ start: '2026-04-01', end: '2026-04-30', principalMonth: '2026-04', principalMonthBasis: 'MAJORITY_OF_PERIOD' });
    expect(d.transcription).toContain('Couleur du cadre : vert sapin');
    expect(d.tables.length).toBeGreaterThan(0);
    expect(d.visual).toBeDefined();
    expect(d.entities.assets.length).toBeGreaterThan(0);
    expect(Array.isArray(d.businessOperationCandidates)).toBe(true);
    expect(d.valueDecisions.map((x: Json) => [x.value, x.kind, x.decision])).toEqual([['129,00 EUR', 'AMOUNT', 'STRUCTURED'], ['TKT-000123', 'IDENTIFIER', 'NOT_RETAINED']]);
    expect(d.facts).toHaveLength(sortieComplete().facts.length);
  });

  it('L114J-CONS-03 — AC08 : un attribut hors FIELD_CATALOG reste un fait GÉNÉRIQUE — aucune clé inventée, aucun rattachement au bien, valeur d’origine et preuve conservées', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: JSON.stringify(sortieComplete()), inputTokens: 100, outputTokens: 50 };
    });
    const res = await AiGateway.execute(requete());
    const faits = (res.data as Json).facts as Json[];
    const generique = faits.find((f) => f.rawKey === 'couleur du cadre')!;
    expect(generique).toMatchObject({
      canonicalKey: null, rawKey: 'couleur du cadre', label: 'Couleur du cadre', rawValue: 'vert sapin', normalizedValue: 'vert sapin',
      target: { type: 'GENERIC', entityId: null }, provenance: 'TEXT_EXTRACTION', evidence: { excerpt: 'Couleur du cadre : vert sapin', page: 1 },
    });
    // Les faits catalogués gardent valeur brute ET normalisée.
    expect(faits[0]).toMatchObject({ canonicalKey: 'acquisitionDate', rawValue: '24/04/2026', normalizedValue: '2026-04-24', target: { type: 'ASSET', entityId: 184 } });
  });

  it('L114J-CONS-04 — AC05 : en repli, un fait NON CONFORME au contrat n’est jamais rendu tel quel — il est écarté, COMPTÉ, et son original conservé (existant #741)', async () => {
    process.env.AI_OUTPUT_REPAIR_PASS = 'off';
    const ampute = sortieComplete();
    const total = (ampute.facts as Json[]).length;
    // Champ obligatoire retiré de chaque fait : aucun n'est conforme au contrat v7.
    for (const f of ampute.facts as Json[]) delete f.target;
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: JSON.stringify(ampute), inputTokens: 100, outputTokens: 50 };
    });
    const res = await AiGateway.execute(requete());
    const d = res.data as Json;
    // Aucun fait non conforme dans la sortie validée…
    expect(d.facts).toEqual([]);
    // … et aucune disparition silencieuse : compteur et originaux (valeur d'origine comprise) conservés pour la
    // couverture T1 (anomalie FACT_INVALID_DROPPED, complétude T1 — cartes #741 / #760).
    expect(d._normalisation.droppedFacts).toBe(total);
    expect(d._normalisation.dropped).toHaveLength(total);
    for (const x of d._normalisation.dropped as Json[]) expect(x.reason).toBe('INVALID_SCHEMA');
    expect((d._normalisation.dropped as Json[]).map((x) => x.payload.rawValue)).toEqual(expect.arrayContaining(['24/04/2026', 'vert sapin']));
    // Les autres branches ne sont pas touchées par l'écart des faits.
    expect(d.document.billingPeriod).toBeDefined();
    expect(d.valueDecisions).toHaveLength(2);
  });
});
