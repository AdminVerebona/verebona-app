/**
 * Lot 33D — ticket « garantir la réussite des exécutions malgré les
 * désalignements prompt / schéma / code ». Tests REPAIR-xx (cas 1 à 8 du
 * ticket, §2 à §28).
 *
 *  · REPAIR-01 (cas 1) date {jour, mois, année} → ISO ;
 *  · REPAIR-02 (cas 2) énumération synonyme (table centralisée) ;
 *  · REPAIR-03 (cas 3) JSON entouré de texte ;
 *  · REPAIR-04 (cas 4) 4 champs valides conservés, le 5e réparé (champs verrouillés) ;
 *  · REPAIR-05 (cas 5) réparation ciblée sans nouvel appel complet ;
 *  · REPAIR-06 (cas 6) réparation insuffisante → repli INFORMÉ → normalisation → réussite ;
 *  · REPAIR-07 (cas 7) ancien format T1 v1 → adaptateur versionné ;
 *  · REPAIR-08 à REPAIR-18 : noms alternatifs (lot 34D : plus aucun
 *    rapprochement heuristique), types, réparation JSON, audit
 *    T1 (null pour un champ absent), structured output, cohérence, élagage,
 *    discriminant, tables non ambiguës.
 * Le cas 8 (rejeu automatique) : REPAIR-17 (décision) et E2E
 * `l33d-diagnostic-reparation.e2e.ts` (base réelle).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const { parseModelOutput } = await import('../output-resolution/json-repair');
const { normalizeToSchema, textDateToIso, numericString } = await import('../output-resolution/normalize');
const { ENUM_SYNONYMS, matchEnum, caseFold } = await import('../output-resolution/normalization-tables');
const { asTestContract } = await import('../output-resolution/runtime-contract');
const { applyCompatAdapters, outputSchemaRef, T1_V1_TO_V2 } = await import('../output-resolution/contracts');
const { providerJsonSchema, clearSchemaRejections } = await import('../output-resolution/provider-schema');
const { pruneInvalidFields } = await import('../output-resolution/field-validation');
const { mergeRepair, buildRepairPrompt } = await import('../output-resolution/repair-pass');
const { validateOutput } = await import('../output-validator');
const { T1AnalyzeDocumentOutput } = await import('../../source-analysis/master/t1-contract');
const { T1AnalyzeDocumentTolerantOutput } = await import('../../source-analysis/master/tolerant-output');
const { MASTER_OUTPUT_SCHEMAS } = await import('../master-output-schemas');
const { describe: describeSchema } = await import('../output-resolution/schema-introspect');
const { checkOutputCoherence, branchSection, jsonExamples } = await import('../../governance/output-coherence');
const { decideReplay, legacySignature } = await import('../../source-analysis/invalid-output-replay.job');
const { T1_TEST_OPERATION, t1TestVariables } = await import('./t1-master-request');

const repo = (code: string) => readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis', `${code}.txt`), 'utf8');
const cdc15T1 = () => readFileSync(join(process.cwd(), 'src/services/ai/source-analysis/__fixtures__/compat/t1_master_v1.cdc15-v2.txt'), 'utf8');
/** Lot 34D : l'exemple JSON complet n'est plus dans le prompt (contrat runtime) — conservé en fixture. */
const exempleT1 = () => JSON.parse(readFileSync(join(process.cwd(), 'src/services/ai/source-analysis/__fixtures__/compat/t1-analyze-document.lot33-example.json'), 'utf8')) as Record<string, unknown>;

const Doc = z.object({
  title: z.string(),
  vendor: z.string(),
  amount: z.number(),
  documentType: z.enum(['INVOICE', 'RECEIPT', 'CONTRACT', 'OTHER']),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  assetCandidate: z.string(),
});
const resolve = (raw: unknown, schema: z.ZodType = Doc, extra: Record<string, unknown> = {}) =>
  resolveOutput({ raw: typeof raw === 'string' ? raw : JSON.stringify(raw), schema, operationCode: 'op', allowPruning: true, ...extra });

const valide = { title: 'Facture', vendor: 'Darty', amount: 1299, documentType: 'INVOICE', purchaseDate: '2026-04-24', assetCandidate: 'Lave-linge' };

describe('REPAIR-01 (cas 1) — date sous mauvais format', () => {
  it('{day, month, year} → 2026-04-24, exécution réussie, règle consignée', () => {
    const r = resolve({ ...valide, purchaseDate: { day: 24, month: 4, year: 2026 } });
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as { purchaseDate: string }).purchaseDate).toBe('2026-04-24');
    expect(r.repairs.map((x) => x.rule)).toContain('date_object_to_iso');
    expect(r.controls.schema).toBe('repaired');
  });
  it('dates textuelles non ambiguës uniquement ; date inexistante jamais convertie', () => {
    expect(textDateToIso('24/04/2026')).toBe('2026-04-24');
    expect(textDateToIso('2026-04-24T10:00:00Z')).toBe('2026-04-24');
    expect(textDateToIso('31/02/2026')).toBeNull();
    expect(resolve({ ...valide, purchaseDate: { day: 31, month: 2, year: 2026 } }).ok).toBe(false);
  });
});

describe('REPAIR-02 (cas 2) — enum synonyme', () => {
  it('PURCHASE_RECEIPT → RECEIPT par la table centralisée', () => {
    const r = resolve({ ...valide, documentType: 'PURCHASE_RECEIPT' });
    expect(r.ok && (r.data as { documentType: string }).documentType).toBe('RECEIPT');
    expect(r.repairs).toContainEqual(expect.objectContaining({ rule: 'enum_synonym', path: '$.documentType' }));
  });
  it('lot 34D : casse seule en normalisation ; synonyme EXPLICITE en mapping de compatibilité ; aucune ressemblance', () => {
    expect(matchEnum('invoice', ['INVOICE', 'RECEIPT'])).toEqual({ value: 'INVOICE', rule: 'enum_case' });
    expect(matchEnum('PURCHASE_RECEIPT', ['INVOICE', 'RECEIPT'])).toBeNull();
    expect(matchEnum('purchase_receipt', ['INVOICE', 'RECEIPT'], { synonyms: true })).toEqual({ value: 'RECEIPT', rule: 'enum_synonym' });
    // Séparateurs différents : plus de rapprochement par ressemblance.
    expect(matchEnum('purchase-receipt', ['INVOICE', 'RECEIPT'], { synonyms: true })).toBeNull();
    expect(matchEnum('BANANE', ['INVOICE', 'RECEIPT'], { synonyms: true })).toBeNull();
  });
});

describe('REPAIR-03 (cas 3) — JSON avec texte parasite', () => {
  it('JSON extrait → validé → appliqué', () => {
    const r = resolve(`Voici le résultat :\n\n${JSON.stringify(valide)}\n\nBonne journée.`);
    expect(r.ok).toBe(true);
    expect(r.repairs.map((x) => x.rule)).toContain('text_around_json_removed');
    expect(r.controls.json).toBe('repaired');
  });
});

describe('REPAIR-10 — réparation JSON déterministe, jamais d’invention', () => {
  it('bloc Markdown, virgule finale, commentaires, littéraux Python, guillemets typographiques, JSON encodé', () => {
    expect(parseModelOutput('```json\n{"a":1}\n```')).toMatchObject({ ok: true, value: { a: 1 } });
    expect(parseModelOutput('{"a":[1,2,],}')).toMatchObject({ ok: true, value: { a: [1, 2] } });
    expect(parseModelOutput('{"a":1 // note\n, "b": /* x */ 2}')).toMatchObject({ ok: true, value: { a: 1, b: 2 } });
    expect(parseModelOutput('{"a": True, "b": None}')).toMatchObject({ ok: true, value: { a: true, b: null } });
    expect(parseModelOutput('{“a”: “x”}')).toMatchObject({ ok: true, value: { a: 'x' } });
    expect(parseModelOutput(JSON.stringify(JSON.stringify({ a: 1 })))).toMatchObject({ ok: true, value: { a: 1 } });
    // Une accolade dans une chaîne ne trompe pas l'extraction.
    expect(parseModelOutput('x {"a":"} {","b":2} y')).toMatchObject({ ok: true, value: { a: '} {', b: 2 } });
  });
  it('structure incomplète : jamais refermée artificiellement', () => {
    expect(parseModelOutput('{"title":"Facture",')).toMatchObject({ ok: false, incomplete: true });
  });
});

describe('REPAIR-08 — noms de champs alternatifs (§3), revu au lot 34D (RTC-06)', () => {
  it('purchase_date, date_achat, PURCHASE-DATE, datePurchase : JAMAIS renommés (aucun mapping déclaré)', () => {
    for (const k of ['purchase_date', 'date_achat', 'PURCHASE-DATE', 'datePurchase']) {
      const { purchaseDate, ...rest } = valide;
      const r = resolve({ ...rest, [k]: purchaseDate }, Doc, { allowPruning: false });
      expect(r.ok, k).toBe(false);
      expect(r.repairs.some((x) => x.rule === 'field_alias')).toBe(false);
      // Le champ inconnu est signalé : la passe de réparation décidera, avec le contrat.
      expect((r as { allPaths: string[] }).allPaths).toContain(`$.${k}`);
    }
  });
  it('clé déjà présente : aucun renommage, la valeur valide reste', () => {
    const report: never[] = [];
    const out = normalizeToSchema({ ...valide, purchase_date: '2020-01-01' }, Doc, report) as Record<string, unknown>;
    expect(out.purchaseDate).toBe('2026-04-24');
    expect(out.purchase_date).toBe('2020-01-01');
  });
});

describe('REPAIR-09 — types convertibles, explicites et déterministes (§4)', () => {
  const S = z.object({
    n: z.number(), i: z.number().int(), b: z.boolean(), s: z.string(), list: z.array(z.string()),
    nul: z.string().nullable(), opt: z.string().optional(),
  });
  it('"1250" → 1250, "true" → true, 12 → "12", valeur unique → liste, [] → null, null facultatif → absent', () => {
    const r = resolve({ n: '1250.5', i: '12900', b: 'oui', s: 12, list: 'x', nul: [], opt: null }, S);
    expect(r.ok && r.data).toEqual({ n: 1250.5, i: 12900, b: true, s: '12', list: ['x'], nul: null });
    expect(new Set(r.repairs.map((x) => x.rule))).toEqual(new Set([
      'numeric_string', 'boolean_string', 'number_to_string', 'single_value_to_array', 'empty_array_to_null', 'null_as_absent',
    ]));
  });
  it('conversion ambiguë jamais appliquée (« 1,250 » : millier ou décimale ?)', () => {
    expect(numericString('1,250')).toBeNull();
    expect(numericString('12,50')).toBe(12.5);
    expect(resolve({ n: '1,250', i: 1, b: true, s: 'a', list: [], nul: null }, S, { allowPruning: false }).ok).toBe(false);
  });
  it('enveloppe `{ "result": { … } }` et tableau d’un seul objet', () => {
    expect(resolve({ result: valide }).ok).toBe(true);
    expect(resolve([valide]).ok).toBe(true);
  });
});

describe('REPAIR-16 — validation champ par champ (§12, §13)', () => {
  const S = z.object({
    task: z.literal('A'),
    title: z.string(),
    note: z.string().max(5).optional(),
    items: z.array(z.object({ v: z.number() })).default([]),
  });
  it('champ facultatif invalide retiré, éléments invalides retirés seuls, champs valides intacts', () => {
    const report: never[] = [];
    const r = pruneInvalidFields({ task: 'A', title: 'ok', note: 'beaucoup trop long', items: [{ v: 1 }, { v: 'x' }, { v: 3 }] }, S, report);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ task: 'A', title: 'ok', items: [{ v: 1 }, { v: 3 }] });
    expect((report as Array<{ rule: string }>).map((x) => x.rule).sort()).toEqual(['array_element_pruned', 'field_pruned_invalid']);
  });
  it('champ OBLIGATOIRE invalide : jamais retiré, la sortie reste invalide', () => {
    expect(pruneInvalidFields({ task: 'A', title: 3 }, S, []).success).toBe(false);
  });
});

describe('REPAIR-07 (cas 7) — ancien format compatible : adaptateur versionné t1_v1_to_v2', () => {
  const v1 = {
    title: { value: 'Facture chaudière', confidence: 'certain', excerpt: 'FACTURE', page: 1 },
    documentDate: { value: '14/03/2026', confidence: 'certain', excerpt: '14/03/2026' },
    supplier: { name: 'Chauffage Pro', siret: '12345678901234', confidence: 'certain', excerpt: 'SIRET' },
    amountCents: { value: 12900, confidence: 'certain', excerpt: '129,00' },
    transcription: 'FACTURE …',
    fields: [
      { fieldKey: 'acquisitionPrice', provenance: 'TEXT_EXTRACTION', value: 129, unit: 'EUR', confidence: 'certain', excerpt: 'TOTAL 129,00', page: 1 },
      { fieldKey: 'boilerPower', subject: 'Chaudière', attribute: 'puissance', value: 24, unit: 'kW', confidence: 'certain', excerpt: 'Puissance 24 kW' },
    ],
    hasExploitableContent: true,
  };
  it('v1 → v2 puis contrat v3 valide : faits ciblés, preuves, date normalisée', () => {
    const report: Array<{ rule: string; detail?: string }> = [];
    const migre = applyCompatAdapters(v1, 'T1AnalyzeDocumentOutput', report as never) as Record<string, unknown>;
    expect(report).toContainEqual(expect.objectContaining({ rule: 't1_v1_to_v2', detail: 't1_analyze_document v1 → v2' }));
    expect(T1_V1_TO_V2.detect(migre)).toBe(false);
    const r = resolve(v1, T1AnalyzeDocumentTolerantOutput, { schemaName: 'T1AnalyzeDocumentOutput', expectedTask: 'ANALYZE_DOCUMENT' });
    expect(r.ok).toBe(true);
    const d = (r as { data: { document: { documentDate: { value: string } }; facts: Array<{ canonicalKey: string | null; target: { type: string } }> } }).data;
    expect(d.document.documentDate.value).toBe('2026-03-14');
    expect(d.facts.map((f) => [f.canonicalKey, f.target.type])).toEqual([['acquisitionPrice', 'ASSET'], ['boilerPower', 'GENERIC']]);
  });
  it('une sortie déjà au format courant n’est pas adaptée', () => {
    const report: never[] = [];
    expect(applyCompatAdapters({ task: 'ANALYZE_DOCUMENT', document: {}, facts: [] }, 'T1AnalyzeDocumentOutput', report)).toEqual({ task: 'ANALYZE_DOCUMENT', document: {}, facts: [] });
    expect(report).toEqual([]);
  });
  it('contrat versionné et empreinte (lien code / prompt / configuration / schéma)', () => {
    const ref = outputSchemaRef('T1AnalyzeDocumentOutput', T1AnalyzeDocumentOutput, 't1_analyze_document');
    expect(ref.version).toBe('t1_analyze_document@v3');
    expect(ref.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(outputSchemaRef('T1AnalyzeDocumentOutput', T1AnalyzeDocumentOutput, 'x').hash).toBe(ref.hash);
  });
});

/**
 * AUDIT T1 (§27, §28) — appel 2644, t1_master_v1@pv10, configuration #4.
 * Le prompt (texte du dépôt comme gabarit CDC 15 v2 collé au BO) montre la
 * structure COMPLÈTE ; en mode JSON, les modèles écrivent `null` pour un
 * champ absent du document. Le schéma T1 déclarait ces champs `.optional()`
 * (absent SEULEMENT) : `null` était rejeté sur toute la sortie, pour les trois
 * modèles — même règle, même signature.
 */
describe('REPAIR-11 — audit T1 : `null` pour un champ absent, `entityId` omis', () => {
  const exempleDuPrompt = (text: string) => {
    const section = branchSection(text, 'ANALYZE_DOCUMENT', 'TASK')!;
    return jsonExamples(section).find((e) => (e as { task?: string }).task === 'ANALYZE_DOCUMENT') as Record<string, unknown>;
  };
  /** Sortie « à la Gemini » : champs absents du document rendus `null`. */
  const sortieAvecNulls = () => {
    const ex = structuredClone(exempleT1());
    const doc = ex.document as Record<string, unknown>;
    doc.supplier = null; doc.amountCents = null; doc.description = null;
    ex.visual = null;
    (ex.entities as { assets: Array<Record<string, unknown>> }).assets[0].reason = null;
    delete (ex.entities as { assets: Array<Record<string, unknown>> }).assets[0].entityId;
    (ex.tables as Array<Record<string, unknown>>)[0].uncertaintyNote = null;
    return ex;
  };

  it('l’exemple du lot 33 (désormais fixture, hors prompt) est conforme au contrat ; le prompt du dépôt n’en contient plus', () => {
    expect(T1AnalyzeDocumentOutput.safeParse(exempleT1()).success).toBe(true);
    expect(exempleDuPrompt(repo('t1_master_v1'))).toBeUndefined();
  });
  it('cause de l’incident reproduite : le contrat strict rejette `null` sur les champs absents', () => {
    const strict = T1AnalyzeDocumentOutput.safeParse(sortieAvecNulls());
    expect(strict.success).toBe(false);
    const chemins = strict.error!.issues.map((i) => i.path.join('.'));
    expect(chemins).toEqual(expect.arrayContaining(['document.supplier', 'document.amountCents', 'visual']));
  });
  it('corrigé : la même sortie est acceptée (null = absent, entityId omis = null), rien d’inventé', () => {
    const r = resolve(sortieAvecNulls(), T1AnalyzeDocumentTolerantOutput, { schemaName: 'T1AnalyzeDocumentOutput', expectedTask: 'ANALYZE_DOCUMENT' });
    expect(r.ok).toBe(true);
    const d = (r as { data: Record<string, any> }).data;
    expect(d.document.supplier).toBeUndefined();
    expect(d.visual).toBeUndefined();
    expect(d.entities.assets[0].entityId).toBeNull();
    expect(d.facts.length).toBe(4);
    expect(r.repairs.filter((x) => x.rule === 'null_as_absent').map((x) => x.path)).toEqual(expect.arrayContaining(['$.document.supplier', '$.visual']));
  });
  it('le texte BO (gabarit CDC 15 v2, `{...}`) est absorbé : même résolution pour les deux textes', () => {
    const txt = cdc15T1();
    expect(branchSection(txt, 'ANALYZE_DOCUMENT', 'TASK')).not.toBeNull();
    // Le gabarit conceptuel n'est pas un JSON complet : le contrôle le signale sans bloquer.
    const report = checkOutputCoherence({ repoText: () => repo('t1_master_v1'), activeTexts: { t1_analyze_document: txt } });
    const t1 = report.find((o) => o.operationCode === 't1_analyze_document')!;
    expect(t1.findings.filter((f) => f.code === 'PROMPT_EXAMPLE_INVALID')).toEqual([]);
    expect(t1.contract).toMatch(/^t1_analyze_document@v3 · [0-9a-f]{12}$/);
  });
  it('lot 34D : le prompt du dépôt renvoie au contrat runtime, garde les règles de contenu (omission, dates ISO)', () => {
    const t = repo('t1_master_v1');
    expect(t).toMatch(/fixée par le contrat runtime joint à l’appel/);
    expect(t).toMatch(/OMIS/);
    expect(t).toMatch(/AAAA-MM-JJ/);
    expect(t).not.toMatch(/FORMAT STRICT DE LA SORTIE/);
  });
});

describe('REPAIR-14 — validateur de cohérence au démarrage (diagnostic, ne bloque pas)', () => {
  it('toutes les opérations master ont un contrat ; aucun exemple de prompt du dépôt invalide', () => {
    const report = checkOutputCoherence({
      repoText: (code) => { try { return readFileSync(join(process.cwd(), 'src/services/ai/prompts', ({ t1_master_v1: 'source-analysis', t2_master_v1: 'assistant' } as Record<string, string>)[code] ?? '', `${code}.txt`), 'utf8'); } catch { return null; } },
    });
    expect(report.length).toBeGreaterThan(10);
    expect(report.flatMap((o) => o.findings).filter((f) => f.code === 'SCHEMA_MISSING')).toEqual([]);
    expect(report.flatMap((o) => o.findings).filter((f) => f.code === 'PROMPT_EXAMPLE_INVALID' && f.source === 'repo')).toEqual([]);
  });
  it('désalignement détecté et décrit (prompt : objet ; schéma : chaîne), sans lever', () => {
    const faux = 'BRANCHE TASK = ANALYZE_DOCUMENT\n{\n "task": "ANALYZE_DOCUMENT",\n "document": {"documentDate": {"value": {"day": "x"}, "confidence": "certain"}},\n "inconnu": 1\n}';
    const report = checkOutputCoherence({ repoText: () => faux });
    const t1 = report.find((o) => o.operationCode === 't1_analyze_document')!;
    expect(t1.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['PROMPT_FIELD_NOT_IN_SCHEMA']));
  });
});

describe('REPAIR-15 — table d’équivalences centralisée, jamais ambiguë', () => {
  it('aucun synonyme ne désigne deux valeurs d’une même énumération des contrats', () => {
    const enums: string[][] = [];
    const walk = (d: ReturnType<typeof describeSchema>, depth = 0) => {
      if (depth > 12) return;
      const n = d.node;
      if (n.kind === 'enum') enums.push(n.values);
      if (n.kind === 'object') for (const f of Object.values(n.shape)) walk(f, depth + 1);
      if (n.kind === 'array') walk(n.element, depth + 1);
      if (n.kind === 'union') n.options.forEach((o) => walk(o, depth + 1));
    };
    for (const s of Object.values(MASTER_OUTPUT_SCHEMAS)) walk(describeSchema(s));
    expect(enums.length).toBeGreaterThan(5);
    for (const values of enums) {
      for (const [canonique, syns] of Object.entries(ENUM_SYNONYMS)) {
        if (!values.includes(canonique)) continue;
        for (const syn of syns) {
          // Valeur autorisée telle quelle : elle prime (aucune équivalence appliquée).
          if (values.some((v) => caseFold(v) === caseFold(syn))) {
            expect(matchEnum(syn, values, { synonyms: true })?.rule).toBe('enum_case');
            continue;
          }
          const cibles = values.filter((v) => (ENUM_SYNONYMS[v] ?? []).some((x) => caseFold(x) === caseFold(syn)));
          // Un synonyme ambigu dans une énumération n'est jamais appliqué (matchEnum rend null).
          if (cibles.length > 1) expect(matchEnum(syn, values, { synonyms: true })).toBeNull();
          else expect(matchEnum(syn, values, { synonyms: true })).toEqual({ value: canonique, rule: 'enum_synonym' });
        }
      }
    }
  });
});

describe('REPAIR-18 — discriminant imposé par le serveur', () => {
  const U = z.discriminatedUnion('task', [z.object({ task: z.literal('A'), a: z.number() }), z.object({ task: z.literal('B') })]);
  it('absent → rétabli ; casse différente → normalisée ; autre branche → toujours refusée', () => {
    expect(validateOutput('{"a":1}', U, 'op', 'json', { expectedTask: 'A' })).toEqual({ task: 'A', a: 1 });
    expect(validateOutput('{"task":"a","a":1}', U, 'op', 'json', { expectedTask: 'A' })).toEqual({ task: 'A', a: 1 });
    expect(() => validateOutput('{"task":"B"}', U, 'op', 'json', { expectedTask: 'A' })).toThrow(/branche/);
  });
});

describe('REPAIR-17 (cas 8) — rejeu automatique : décision et signature (pure)', () => {
  it('sortie invalide de forme → rejouée ; tronquée, vide, autre famille, signature non résolue → non', () => {
    const base = { fileId: 1, accountId: 2, failReason: null };
    expect(decideReplay({ ...base, family: 'INVALID_OUTPUT', subtype: 'SCHEMA_VALIDATION_FAILED', signature: 's1' }, new Set())).toMatchObject({ replay: true, signature: 's1' });
    expect(decideReplay({ ...base, family: 'INVALID_OUTPUT', subtype: 'OUTPUT_TRUNCATED', signature: 's2' }, new Set()).replay).toBe(false);
    expect(decideReplay({ ...base, family: 'TIMEOUT', subtype: null, signature: 's3' }, new Set()).replay).toBe(false);
    expect(decideReplay({ ...base, family: 'INVALID_OUTPUT', subtype: 'INVALID_TYPE', signature: 's4' }, new Set(['s4'])).replay).toBe(false);
  });
  it('échecs antérieurs au lot 33 : motif enregistré ; même signature pour la même règle sur deux documents', () => {
    const motif = (n: number) => `Analyse impossible (prompt maître T1) : Tous les modèles ont échoué. gemini-2.5-pro : Sortie non conforme au schéma. document.supplier : Invalid input: expected object, received null | entities.assets.${n}.reason : Invalid input`;
    const a = decideReplay({ fileId: 1, accountId: 2, failReason: motif(0), family: null, subtype: null, signature: null }, new Set());
    const b = decideReplay({ fileId: 3, accountId: 2, failReason: motif(4), family: null, subtype: null, signature: null }, new Set());
    expect(a).toMatchObject({ replay: true, source: 'fail_reason' });
    expect(a.signature).toBe(b.signature);
    expect(legacySignature('x')).toMatch(/^[0-9a-f]{16}$/);
    expect(decideReplay({ fileId: 1, accountId: 2, failReason: 'Sortie non parsable : Structure JSON incomplète. Extrait : {', family: null, subtype: null, signature: null }, new Set()).replay).toBe(false);
    expect(decideReplay({ fileId: 1, accountId: 2, failReason: 'Délai dépassé', family: null, subtype: null, signature: null }, new Set()).replay).toBe(false);
  });
});

// ── Passerelle : réparation ciblée, repli informé, structured output ───────

const Schema = asTestContract(z.object({
  task: z.literal('GROUP_UPLOAD'),
  title: z.string(), vendor: z.string(), amount: z.number(), documentType: z.string(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
}));
const sortie = (o: Record<string, unknown>) => JSON.stringify({ task: 'GROUP_UPLOAD', title: 'Facture', vendor: 'Darty', amount: 1299, documentType: 'INVOICE', ...o });
let fake: InstanceType<typeof FakeProvider>;
const requete = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 1,
  promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l33d-${Math.random()}`, ...over,
});

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  capture.diags.length = 0;
  capture.traces.length = 0;
  clearSchemaRejections();
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});

describe('REPAIR-04 / REPAIR-05 (cas 4, 5) — réparation ciblée, champs valides verrouillés, aucun nouvel appel complet', () => {
  it('4 champs conservés, le 5e réparé ; la réparation ne peut pas modifier un champ valide', async () => {
    fake.onAny((input) => (input.callKind === 'repair'
      // La réparation tente aussi de changer `amount` : verrouillé, ignoré.
      ? { rawText: sortie({ purchaseDate: '2026-04-24', amount: 1 }), inputTokens: 50, outputTokens: 20 }
      : { rawText: sortie({ purchaseDate: 'le vingt-quatre avril' }), inputTokens: 1000, outputTokens: 80 }));
    const res = await AiGateway.execute(requete());
    expect(res.data).toMatchObject({ title: 'Facture', vendor: 'Darty', amount: 1299, documentType: 'INVOICE', purchaseDate: '2026-04-24' });
    expect(res.usedFallback).toBe(false);
    // Un seul appel complet (avec le document) + une réparation sans pièce jointe.
    expect(fake.calls.map((c) => c.callKind ?? 'analysis')).toEqual(['analysis', 'repair']);
    expect(fake.calls[1].attachments).toEqual([]);
    expect(fake.calls[1].prompt).toMatch(/\$\.purchaseDate/);
    expect(fake.calls[1].prompt).toMatch(/N’ajoute aucune information/);
    expect(res.outputRepairs?.map((r) => r.rule)).toContain('targeted_repair');
    const analyse = capture.diags.find((d) => (d.diagnostic as { callKind: string }).callKind === 'analysis')!;
    expect(analyse.diagnostic).toMatchObject({ outcome: 'REPAIRED', family: 'INVALID_OUTPUT', subtype: 'SCHEMA_VALIDATION_FAILED' });
    expect(capture.traces.map((t) => [t.callKind, t.status])).toEqual([['analysis', 'success'], ['repair', 'success']]);
  });
  it('mergeRepair : seuls les chemins en erreur sont repris', () => {
    const m = mergeRepair({ a: 1, b: { c: 'x', d: 'faux' } }, { a: 99, b: { c: 'y', d: 'vrai' } }, ['$.b.d']);
    expect(m.value).toEqual({ a: 1, b: { c: 'x', d: 'vrai' } });
  });
  it('prompt de réparation : erreurs, schéma, aucune pièce jointe', () => {
    const p = buildRepairPrompt({ previousOutput: '{}', issues: [{ subtype: 'INVALID_TYPE', path: '$.x', expected: 'string', received: 'object', receivedValue: null, message: 'm' }], schemaJson: '{"type":"object"}', malformedJson: false });
    expect(p).toMatch(/\$\.x : INVALID_TYPE ; attendu string ; reçu object/);
    expect(p).toMatch(/SCHÉMA ATTENDU/);
  });
});

describe('REPAIR-06 (cas 6) — réparation insuffisante → repli informé → normalisation → réussite', () => {
  it('le repli reçoit l’erreur exacte ; sa sortie passe par la même chaîne', async () => {
    fake.on('gemini-3.1-flash-lite', (input) => (input.callKind === 'repair'
      ? { rawText: sortie({ purchaseDate: 'toujours faux' }), inputTokens: 10, outputTokens: 5 }
      : { rawText: sortie({ purchaseDate: 'le vingt-quatre avril' }), inputTokens: 1000, outputTokens: 80 }));
    // Repli : texte autour + date française → normalisée.
    fake.onAny(() => ({ rawText: `Résultat :\n${sortie({ purchaseDate: '24/04/2026' })}`, inputTokens: 900, outputTokens: 70 }));
    const res = await AiGateway.execute(requete());
    expect(res.usedFallback).toBe(true);
    expect((res.data as { purchaseDate: string }).purchaseDate).toBe('2026-04-24');
    const repli = fake.calls.find((c) => c.model !== 'gemini-3.1-flash-lite' && (c.callKind ?? 'analysis') === 'analysis')!;
    expect(repli.prompt).toMatch(/REPRISE APRÈS SORTIE INVALIDE/);
    expect(repli.prompt).toMatch(/\$\.purchaseDate/);
    // §13 : la cause initiale n'est pas masquée par le repli.
    const outcomes = capture.diags.map((d) => [(d.diagnostic as { callKind: string }).callKind, (d.diagnostic as { outcome: string }).outcome]);
    expect(outcomes).toEqual([['analysis', 'FAILED'], ['repair', 'FAILED'], ['analysis', 'REPAIRED']]);
    expect((capture.diags[2].diagnostic as { informedOfPreviousError: boolean }).informedOfPreviousError).toBe(true);
  });
  it('sans réparation (AI_OUTPUT_REPAIR_PASS=off) : validation champ par champ puis repli', async () => {
    process.env.AI_OUTPUT_REPAIR_PASS = 'off';
    fake.onAny(() => ({ rawText: sortie({ purchaseDate: 'faux' }), inputTokens: 1, outputTokens: 1 }));
    await expect(AiGateway.execute(requete())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' });
    expect(fake.calls.every((c) => (c.callKind ?? 'analysis') === 'analysis')).toBe(true);
  });
});

describe('REPAIR-13 — structured output (schéma fournisseur réduit), refus rattrapé', () => {
  it('schéma réduit : motifs, longueurs et défauts retirés (vérifiés par Verebona)', () => {
    const ps = providerJsonSchema(T1AnalyzeDocumentOutput);
    expect(ps.schema).not.toBeNull();
    const txt = JSON.stringify(ps.schema);
    expect(txt).not.toMatch(/"pattern"|"maxLength"|"default"|"\$schema"/);
    expect(ps.dropped).toEqual(expect.arrayContaining(['pattern', 'maxLength']));
  });
  it('opération master : schéma transmis ; refus du schéma → même modèle sans schéma, refus mémorisé', async () => {
    let n = 0;
    fake.onAny((input) => {
      n++;
      if (input.responseSchema) throw Object.assign(new Error('Invalid JSON payload: response_schema is too complex'), { status: 400 });
      return { rawText: JSON.stringify({ task: 'GROUP_UPLOAD', groups: [[0]] }), inputTokens: 1, outputTokens: 1 };
    });
    const { T1GroupUploadOutput } = await import('../../source-analysis/master/t1-contract');
    const res = await AiGateway.execute(requete({ outputSchema: T1GroupUploadOutput }));
    expect(res.data).toEqual({ task: 'GROUP_UPLOAD', groups: [[0]] });
    expect(res.usedFallback).toBe(false);
    expect(n).toBe(2);
    expect(fake.calls[0].responseSchema).toBeDefined();
    expect(fake.calls[1].responseSchema).toBeUndefined();
    // Appel suivant : le refus est mémorisé, plus de schéma pour ce modèle.
    await AiGateway.execute(requete({ outputSchema: T1GroupUploadOutput }));
    expect(fake.calls[2].responseSchema).toBeUndefined();
  });
  it('AI_STRUCTURED_OUTPUT=off : aucun schéma transmis', async () => {
    process.env.AI_STRUCTURED_OUTPUT = 'off';
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'GROUP_UPLOAD', groups: [[0]] }), inputTokens: 1, outputTokens: 1 }));
    const { T1GroupUploadOutput } = await import('../../source-analysis/master/t1-contract');
    await AiGateway.execute(requete({ outputSchema: T1GroupUploadOutput }));
    expect(fake.calls[0].responseSchema).toBeUndefined();
  });
});
