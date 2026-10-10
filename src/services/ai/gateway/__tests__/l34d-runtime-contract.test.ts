/**
 * Lot 34D — ticket « faire du contrat runtime la source unique de vérité
 * pour génération, validation, réparation et fallback ». Cas RTC-01 à RTC-07
 * du ticket, plus l'audit T1 (RTC-T1-xx) et la consigne de priorité.
 *
 *  · RTC-01 (cas 1) exécution standard : contrat → schéma fournisseur dérivé → validation, même empreinte ;
 *  · RTC-02 (cas 2) réparation avec le contrat EXACT, revalidée avec lui ;
 *  · RTC-03 (cas 3) replis : même contrat pour tous les modèles ;
 *  · RTC-04 (cas 4) nouvelle version active pendant l'exécution : l'exécution garde la sienne ;
 *  · RTC-05 (cas 5) ancien format connu : mapping explicite versionné, sinon réparation ;
 *  · RTC-06 (cas 6) champ inconnu (`datePurchase`) : jamais deviné, réparation ;
 *  · RTC-07 (cas 7) génération ≠ validation : RUNTIME_CONTRACT_MISMATCH, BO seulement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const capture = vi.hoisted(() => ({ diags: [] as Array<Record<string, unknown>>, traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async (r: Record<string, unknown>) => { capture.diags.push(r); }),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { capture.traces.push(t); return capture.traces.length; }),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { resolveOutput } = await import('../output-resolution/resolve-output');
const rc = await import('../output-resolution/runtime-contract');
const { FIELD_COMPAT_MAPPINGS, COMPAT_TABLE_VERSION, applyFieldCompatMappings } = await import('../output-resolution/compat-mappings');
const { providerJsonSchema, clearSchemaRejections } = await import('../output-resolution/provider-schema');
const { isInternalAiErrorCode } = await import('../errors');
const { MASTER_OUTPUT_SCHEMAS } = await import('../master-output-schemas');
const { T1GroupUploadOutput, T1AnalyzeDocumentOutput } = await import('../../source-analysis/master/t1-contract');
const { T1AnalyzeDocumentTolerantOutput } = await import('../../source-analysis/master/tolerant-output');
const { T1_TEST_OPERATION, t1TestVariables } = await import('./t1-master-request');

type Trace = { runtimeContract?: { contractId: string; contractVersion: number; schemaHash: string; schemaVersion: string; structuredOutput: boolean; providerSchemaHash: string | null; mismatch?: unknown }; transformations?: { compatMappings: string[]; normalizations: string[]; repair: string | null }; callKind?: string; status?: string; errorCode?: string };

let fake: InstanceType<typeof FakeProvider>;
const groupOk = (o: Record<string, unknown> = {}) => JSON.stringify({ task: 'GROUP_UPLOAD', groups: [[0]], reason: 'un seul fichier', ...o });
const requete = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 1,
  promptVariables: t1TestVariables('facture'), outputSchema: T1GroupUploadOutput,
  idempotencyKey: `l34d-${Math.random()}`, ...over,
});
const contratGroupe = () => rc.resolveRuntimeContract({ schemaName: 'T1GroupUploadOutput', operationCode: T1_TEST_OPERATION, callerSchema: T1GroupUploadOutput }).contract;
const traces = () => capture.traces as Trace[];

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  capture.diags.length = 0;
  capture.traces.length = 0;
  clearSchemaRejections();
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});
afterEach(() => {
  rc.__setActiveContractVersionForTests('T1GroupUploadOutput', null);
  rc.__unregisterContractVersionForTests('T1GroupUploadOutput', 99);
});

describe('RTC-01 (cas 1) — exécution standard : un contrat, une empreinte', () => {
  it('contrat résolu avant l’appel → schéma fournisseur DÉRIVÉ → validation avec le même contrat → SUCCESS', async () => {
    fake.onAny(() => ({ rawText: groupOk(), inputTokens: 1, outputTokens: 1 }));
    const c = contratGroupe();
    expect(c).toMatchObject({ contractId: 'T1_GROUP_UPLOAD', contractVersion: 1, schemaVersion: 't1_group_upload@v1', source: 'registry' });
    expect(Object.isFrozen(c)).toBe(true);
    const res = await AiGateway.execute(requete());
    expect(res.data).toEqual({ task: 'GROUP_UPLOAD', groups: [[0]], reason: 'un seul fichier' });
    // Schéma fournisseur = dérivation du contrat (aucune copie indépendante).
    expect(fake.calls[0].responseSchema).toEqual(providerJsonSchema(c.canonical).schema);
    const t = traces()[0].runtimeContract!;
    expect(t).toMatchObject({ contractId: 'T1_GROUP_UPLOAD', contractVersion: 1, schemaVersion: 't1_group_upload@v1', schemaHash: c.schemaHash, structuredOutput: true });
    expect(t.providerSchemaHash).toBe(rc.providerSchemaHash(providerJsonSchema(c.canonical).schema));
    expect(capture.diags).toHaveLength(0);
  });

  it('consigne commune : « le contrat runtime est prioritaire », sans recopier le schéma quand le structured output est transmis', async () => {
    fake.onAny(() => ({ rawText: groupOk(), inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(requete());
    const p = fake.calls[0].prompt;
    expect(p).toContain('CONTRAT RUNTIME (fourni par le serveur)');
    expect(p).toContain('LE CONTRAT RUNTIME EST PRIORITAIRE.');
    expect(p).toContain(`T1_GROUP_UPLOAD v1 · schéma t1_group_upload@v1 · empreinte ${contratGroupe().schemaHash}`);
    expect(p).not.toContain(rc.contractJsonSchemaText(contratGroupe()));
  });

  it('sans structured output (AI_STRUCTURED_OUTPUT=off) : le schéma DÉRIVÉ du contrat est joint au prompt', async () => {
    process.env.AI_STRUCTURED_OUTPUT = 'off';
    fake.onAny(() => ({ rawText: groupOk(), inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(requete());
    expect(fake.calls[0].responseSchema).toBeUndefined();
    expect(fake.calls[0].prompt).toContain(rc.contractJsonSchemaText(contratGroupe()));
    expect(traces()[0].runtimeContract).toMatchObject({ structuredOutput: false, providerSchemaHash: null });
  });
});

describe('RTC-02 (cas 2) — réparation avec le contrat runtime exact', () => {
  it('sortie invalide → validation FAILED → réparation (contrat exact) → validation SUCCESS, aucun changement de contrat', async () => {
    fake.onAny((input) => (input.callKind === 'repair'
      ? { rawText: groupOk(), inputTokens: 1, outputTokens: 1 }
      : { rawText: groupOk({ groups: 'tous ensemble' }), inputTokens: 1, outputTokens: 1 }));
    const c = contratGroupe();
    const res = await AiGateway.execute(requete());
    expect(res.data).toMatchObject({ groups: [[0]] });
    const repair = fake.calls.find((x) => x.callKind === 'repair')!;
    expect(repair.prompt).toContain(`CONTRAT RUNTIME (T1_GROUP_UPLOAD v1 · t1_group_upload@v1 · ${c.schemaHash})`);
    expect(repair.prompt).toContain(rc.contractJsonSchemaText(c));
    expect(repair.prompt).toMatch(/\$\.groups/);
    expect(new Set(traces().map((t) => t.runtimeContract!.schemaHash))).toEqual(new Set([c.schemaHash]));
    expect(traces().map((t) => t.callKind)).toEqual(['analysis', 'repair']);
    expect(traces()[0].transformations).toMatchObject({ repair: 'SUCCESS' });
  });
});

describe('RTC-03 (cas 3) — replis : même contrat pour tous les modèles', () => {
  it('modèle principal, repli 1, repli 2 : même contractId / version / empreinte ; seul l’adaptateur varie', async () => {
    const mauvais = () => ({ rawText: 'pas du JSON', inputTokens: 1, outputTokens: 1 });
    fake.on('gemini-3.1-flash-lite', mauvais);
    fake.on('gemini-3.5-flash', mauvais);
    fake.onAny(() => ({ rawText: groupOk(), inputTokens: 1, outputTokens: 1 }));
    const res = await AiGateway.execute(requete());
    expect(res.usedFallback).toBe(true);
    const modeles = [...new Set(fake.calls.map((x) => x.model))];
    expect(modeles.length).toBe(3);
    const c = contratGroupe();
    for (const t of traces()) expect(t.runtimeContract).toMatchObject({ contractId: 'T1_GROUP_UPLOAD', contractVersion: 1, schemaHash: c.schemaHash });
    const schemas = new Set(fake.calls.filter((x) => (x.callKind ?? 'analysis') === 'analysis').map((x) => JSON.stringify(x.responseSchema ?? null)));
    expect(schemas.size).toBe(1);
  });
});

describe('RTC-04 (cas 4) — nouvelle version activée pendant l’exécution', () => {
  const V99 = z.object({ task: z.literal('GROUP_UPLOAD'), groups: z.array(z.array(z.number().int())), lot: z.string() });

  it('l’exécution commencée en v1 reste en v1 jusqu’à son terme ; la suivante résout v99', async () => {
    rc.__registerContractVersionForTests({ schemaName: 'T1GroupUploadOutput', label: 't1_group_upload', version: 99, schema: V99 });
    rc.__setActiveContractVersionForTests('T1GroupUploadOutput', 1);
    let n = 0;
    fake.onAny((input) => {
      n++;
      // V99 devient ACTIVE pendant le premier appel du modèle principal.
      if (n === 1) rc.__setActiveContractVersionForTests('T1GroupUploadOutput', 99);
      return input.callKind === 'repair' || input.model !== 'gemini-3.1-flash-lite'
        ? { rawText: groupOk(), inputTokens: 1, outputTokens: 1 }
        : { rawText: groupOk({ groups: 'mauvais' }), inputTokens: 1, outputTokens: 1 };
    });
    const res = await AiGateway.execute(requete());
    expect(res.data).toMatchObject({ groups: [[0]] });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(traces().every((t) => t.runtimeContract!.contractVersion === 1 && t.runtimeContract!.schemaVersion === 't1_group_upload@v1')).toBe(true);

    // Exécution suivante : v99 (contrat de l'appelant aligné sur v99).
    capture.traces.length = 0;
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'GROUP_UPLOAD', groups: [[0]], lot: 'A' }), inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(requete({ outputSchema: V99 }));
    expect(traces()[0].runtimeContract).toMatchObject({ contractVersion: 99, schemaVersion: 't1_group_upload@v99' });
  });

  it('version demandée inexistante : refus AVANT appel (CONTRACT_VERSION_NOT_FOUND)', () => {
    expect(() => rc.resolveRuntimeContract({ schemaName: 'T1GroupUploadOutput', operationCode: 'x', callerSchema: T1GroupUploadOutput, requestedVersion: 42 }))
      .toThrow(/v42 introuvable/);
  });
});

/** Exemple complet d'une sortie T1 conforme (fixture du lot 33, hors prompt depuis le lot 34D). */
const exempleT1 = () => JSON.parse(readFileSync(join(process.cwd(), 'src/services/ai/source-analysis/__fixtures__/compat/t1-analyze-document.lot33-example.json'), 'utf8')) as Record<string, Record<string, unknown>>;
const contratT1 = () => rc.resolveRuntimeContract({ schemaName: 'T1AnalyzeDocumentOutput', operationCode: 't1_analyze_document', callerSchema: T1AnalyzeDocumentTolerantOutput }).contract;

describe('RTC-05 (cas 5) — ancien format connu : mapping explicite versionné, sinon réparation', () => {
  it('table versionnée : chaque ligne est explicite (contrat, chemin, versions source → cible)', () => {
    expect(COMPAT_TABLE_VERSION).toBe(2);
    expect(FIELD_COMPAT_MAPPINGS.map((m) => m.id)).toEqual(['t1_document_date_to_documentDate']);
    for (const m of FIELD_COMPAT_MAPPINGS) {
      expect(m.contracts.length).toBeGreaterThan(0);
      expect(m.parentPath).toMatch(/^\$/);
      expect(m.fromSchemaVersion).not.toBe(m.toSchemaVersion);
    }
  });

  it('document.date (CDC historique) → document.documentDate : migration déclarée, validation SUCCESS, consignée', () => {
    const ex = exempleT1();
    ex.document.date = ex.document.documentDate;
    delete ex.document.documentDate;
    const c = contratT1();
    const r = resolveOutput({ raw: JSON.stringify(ex), schema: c.schema, contract: c, generationStamp: rc.contractStamp(c), operationCode: 't1_analyze_document', expectedTask: 'ANALYZE_DOCUMENT', allowPruning: false });
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as { document: { documentDate: { value: string } } }).document.documentDate.value).toBe('2026-04-24');
    expect(r.repairs).toContainEqual(expect.objectContaining({ stage: 'compat_mapping', rule: 't1_document_date_to_documentDate', path: '$.document.documentDate' }));
  });

  it('mapping jamais appliqué hors de son contrat ni de son chemin ; jamais d’écrasement', () => {
    const report: never[] = [];
    expect(applyFieldCompatMappings({ document: { date: 'x' } }, 'T1GroupUploadOutput', report)).toEqual({ document: { date: 'x' } });
    expect(applyFieldCompatMappings({ date: 'x' }, 'T1AnalyzeDocumentOutput', report)).toEqual({ date: 'x' });
    expect(applyFieldCompatMappings({ document: { date: 'a', documentDate: 'b' } }, 'T1AnalyzeDocumentOutput', report)).toEqual({ document: { date: 'a', documentDate: 'b' } });
    expect(report).toEqual([]);
  });

  it('énumération : PURCHASE_RECEIPT → RECEIPT seulement par la table explicite, à l’étape de compatibilité', () => {
    const Doc = rc.asTestContract(z.object({ documentType: z.enum(['INVOICE', 'RECEIPT']) }));
    const r = resolveOutput({ raw: '{"documentType":"PURCHASE_RECEIPT"}', schema: Doc, operationCode: 'op', allowPruning: false });
    expect(r.ok && r.data).toEqual({ documentType: 'RECEIPT' });
    expect(r.repairs).toContainEqual(expect.objectContaining({ stage: 'compat_mapping', rule: 'enum_synonym' }));
    // Valeur inconnue sans ligne de table : jamais l'énumération « la plus proche ».
    expect(resolveOutput({ raw: '{"documentType":"PURCHASE-RECEIPTS"}', schema: Doc, operationCode: 'op', allowPruning: false }).ok).toBe(false);
  });

  it('ancien nom SANS mapping déclaré : aucune migration, la sortie part en réparation', () => {
    const ex = exempleT1();
    ex.document.dateDocument = ex.document.documentDate;
    delete ex.document.documentDate;
    const c = contratT1();
    const r = resolveOutput({ raw: JSON.stringify(ex), schema: c.schema, contract: c, operationCode: 't1_analyze_document', expectedTask: 'ANALYZE_DOCUMENT', allowPruning: false });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.repairable).toBe(true);
    expect(!r.ok && r.allPaths).toContain('$.document.dateDocument');
    expect(!r.ok && r.optionalPaths).toContain('$.document.documentDate');
    expect(r.repairs.some((x) => x.stage === 'compat_mapping')).toBe(false);
  });
});

describe('RTC-06 (cas 6) — nom de champ inconnu : jamais deviné, réparation conforme au contrat', () => {
  const Achat = rc.asTestContract(z.object({ task: z.literal('GROUP_UPLOAD'), title: z.string(), purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
  const sortie = (o: Record<string, unknown>) => JSON.stringify({ task: 'GROUP_UPLOAD', title: 'Ticket', ...o });

  it('datePurchase (aucun mapping) : le moteur ne décide pas seul ; la réparation produit purchaseDate', async () => {
    fake.onAny((input) => (input.callKind === 'repair'
      ? { rawText: sortie({ purchaseDate: '2026-04-24' }), inputTokens: 1, outputTokens: 1 }
      : { rawText: sortie({ datePurchase: '2026-04-24' }), inputTokens: 1, outputTokens: 1 }));
    const res = await AiGateway.execute(requete({ outputSchema: Achat }));
    expect(res.data).toEqual({ task: 'GROUP_UPLOAD', title: 'Ticket', purchaseDate: '2026-04-24' });
    const repair = fake.calls.find((x) => x.callKind === 'repair')!;
    expect(repair).toBeDefined();
    expect(repair.prompt).toMatch(/\$\.datePurchase/);
    expect(repair.prompt).toMatch(/non déclaré par le contrat/);
    expect(res.outputRepairs?.some((r) => r.rule === 'field_alias')).toBe(false);
  });

  it('sans réparation possible : la valeur n’est jamais reportée sur purchaseDate (champ ignoré, consigné)', () => {
    const r = resolveOutput({ raw: sortie({ datePurchase: '2026-04-24' }), schema: Achat, operationCode: 'op', allowPruning: true });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toEqual({ task: 'GROUP_UPLOAD', title: 'Ticket' });
    expect(r.repairs).toContainEqual(expect.objectContaining({ rule: 'unknown_field_dropped', path: '$.datePurchase' }));
  });
});

describe('RTC-07 (cas 7) — génération ≠ validation : RUNTIME_CONTRACT_MISMATCH', () => {
  it('empreinte de génération A ≠ empreinte de validation B : erreur technique dédiée', () => {
    const c = contratGroupe();
    const r = resolveOutput({
      raw: groupOk(), schema: c.schema, contract: c, operationCode: T1_TEST_OPERATION,
      generationStamp: { ...rc.contractStamp(c), schemaHash: 'aaaaaaaaaaaa' }, allowPruning: false,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.subtype).toBe('RUNTIME_CONTRACT_MISMATCH');
    expect(!r.ok && r.contractMismatch).toMatchObject({ generation: { schemaHash: 'aaaaaaaaaaaa' }, validation: { schemaHash: c.schemaHash } });
  });

  it('schéma de l’appelant ≠ contrat du registre : refus AVANT tout appel fournisseur, diagnostiqué au BO', async () => {
    fake.onAny(() => ({ rawText: groupOk(), inputTokens: 1, outputTokens: 1 }));
    const Autre = z.object({ task: z.literal('GROUP_UPLOAD'), groupes: z.array(z.number()) });
    await expect(AiGateway.execute(requete({ outputSchema: Autre }))).rejects.toMatchObject({ code: 'RUNTIME_CONTRACT_MISMATCH', recoverable: false });
    expect(fake.calls).toHaveLength(0);
    expect(traces()[0]).toMatchObject({ status: 'error', errorCode: 'RUNTIME_CONTRACT_MISMATCH' });
    expect(traces()[0].runtimeContract?.mismatch).toMatchObject({ generationHash: contratGroupe().schemaHash });
    expect(capture.diags[0].diagnostic).toMatchObject({ family: 'INTERNAL_ERROR', subtype: 'RUNTIME_CONTRACT_MISMATCH', stage: 'request_build' });
  });

  it('jamais exposé à l’utilisateur final : code interne (message générique côté utilisateur)', async () => {
    expect(isInternalAiErrorCode('RUNTIME_CONTRACT_MISMATCH')).toBe(true);
    expect(isInternalAiErrorCode('INVALID_OUTPUT')).toBe(false);
    const { userFacingFailReason } = await import('../../source-analysis/failure-policy');
    expect(userFacingFailReason({ code: 'RUNTIME_CONTRACT_MISMATCH', message: 'RUNTIME_CONTRACT_MISMATCH : schéma transmis t1@v1 (abc) ≠ …' }))
      .not.toMatch(/RUNTIME_CONTRACT_MISMATCH|schéma|abc/);
  });

  it('chaque opération de production : le schéma de l’appelant EST le contrat du registre (aucun désaccord)', () => {
    for (const [name, schema] of Object.entries(MASTER_OUTPUT_SCHEMAS)) {
      expect(rc.resolveRuntimeContract({ schemaName: name, operationCode: name, callerSchema: schema }).mismatch, name).toBeNull();
    }
    // Lecture tolérante T1 (préparation déclarée du contrat) : admise.
    expect(rc.resolveRuntimeContract({ schemaName: 'T1AnalyzeDocumentOutput', operationCode: 't1_analyze_document', callerSchema: T1AnalyzeDocumentTolerantOutput }).mismatch).toBeNull();
  });
});

// ── Audit T1 (ticket, « Cas spécifique T1 actuel ») ─────────────────────────

type Json = { type?: string; properties?: Record<string, Json>; required?: string[]; anyOf?: Json[] };
const props = (j: Json | undefined): Record<string, Json> => j?.properties ?? j?.anyOf?.find((x) => x.properties)?.properties ?? {};

describe('RTC-T1 — audit document.title / description / documentDate / supplier / amountCents, EvidenceValue', () => {
  const c = contratT1();
  const fournisseur = providerJsonSchema(c.canonical).schema as Json;
  const document = props(props(fournisseur).document);
  const EVIDENCE_KEYS = ['excerpt', 'page', 'section', 'table'];

  it.each(['title', 'description', 'documentDate', 'amountCents'])('document.%s : { value, confidence, evidence } — schéma fournisseur = schéma de validation', (k) => {
    expect(Object.keys(props(document[k])).sort()).toEqual(['confidence', 'evidence', 'value']);
    expect(Object.keys(props(props(document[k]).evidence)).sort()).toEqual([...EVIDENCE_KEYS].sort());
    // La validation accepte exactement cette représentation (evidence objet, jamais un extrait à plat).
    const ex = exempleT1();
    expect(T1AnalyzeDocumentOutput.safeParse(ex).success).toBe(true);
    const plat = structuredClone(ex);
    (plat.document as Record<string, unknown>)[k] = { value: (ex.document[k] as { value: unknown }).value, confidence: 'certain', excerpt: 'à plat' };
    const v = T1AnalyzeDocumentOutput.safeParse(plat);
    // `excerpt` à plat n'est pas la forme du contrat : retiré (clé non déclarée), jamais pris pour la preuve.
    expect(v.success && (v.data.document as Record<string, { evidence: object }>)[k].evidence).toEqual({});
  });

  it('document.supplier : { name, siret, confidence, evidence } côté fournisseur et validation', () => {
    expect(Object.keys(props(document.supplier)).sort()).toEqual(['confidence', 'evidence', 'name', 'siret']);
    expect(Object.keys(props(props(document.supplier).evidence)).sort()).toEqual([...EVIDENCE_KEYS].sort());
  });

  it('documentDate est le nom du contrat (v2+) ; `document.date` du CDC historique = format domaine, migré par mapping explicite', async () => {
    expect(Object.keys(document)).toContain('documentDate');
    expect(Object.keys(document)).not.toContain('date');
    // Mapper aval : documentDate (contrat modèle) → document.date (SourceAnalysisResult, domaine).
    const src = readFileSync(join(process.cwd(), 'src/services/ai/source-analysis/master/to-source-analysis-result.ts'), 'utf8');
    expect(src).toContain('date: toEvidence(d.documentDate)');
    // Prompt actif : aucune logique de choix entre les deux noms.
    const prompt = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
    expect(prompt).toContain('`documentDate`');
    expect(prompt).not.toMatch(/document\.date\b|`date`/);
  });

  it('le schéma de validation et le schéma fournisseur ont la même empreinte de contrat (une seule source)', () => {
    expect(c.schemaHash).toBe(rc.contractStamp(c).schemaHash);
    expect(c.schemaVersion).toMatch(/^t1_analyze_document@v\d+$/);
    expect(JSON.parse(rc.contractJsonSchemaText(c)).properties.document).toBeDefined();
  });
});
