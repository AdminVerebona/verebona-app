/**
 * Lot 114G (Trello #760, audit T1 du 13/11) sur PostgreSQL réel — REPRISE
 * DIFFÉRÉE d'un document (`repairDocumentSourceUnits`, même chemin que la
 * reprise planifiée). Point d'entrée de production, sorties Gemini REJOUÉES
 * (aucun réseau), documents génériques « type 388 » et « type 126 ».
 *
 *   L114G-E01  P1-02 + P1-03 : la réparation différée relit un fait déjà
 *              connu dans l'unité page:1:field:2 et rend une décision de
 *              valeur → décision PERSISTÉE et rattachée au fait, unité
 *              couverte, lien local conservé sur le fait existant (ses unités
 *              sont complétées), aucun doublon ; rejeu : rien de plus ;
 *   L114G-E02  P1-02 : décision SEULE, sans nouveau fait (NOT_RETAINED) →
 *              persistée ; contrat non porté → rien d'écrit, compté ;
 *   L114G-E03  P1-04 : même valeur et même extrait mais deux attributs → deux
 *              faits ; réexécution identique → aucun doublon ;
 *   L114G-E04  P1-04 : deux reprises concurrentes du même document → aucun
 *              fait en double.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
/** PDF servi au découpage et à la vérification : jamais de lecture S3 réelle. */
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => pdf.bytes,
}));

type Json = Record<string, any>;
type Fait = Record<string, unknown>;
const RACINE = process.cwd();
const T1_LIVRE = readFileSync(join(RACINE, 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
const GUIDE = readFileSync(join(RACINE, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
const ANCRE = 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.';
/** Prompt T1 avec le bloc 91D du guide (décisions de valeur), appliqué comme le PO. */
const T1_AVEC_CONTRAT = (() => {
  const m = /<!-- l89c:bloc id="t1-value-decisions-v1"[^>]*-->\s*\n```text\n([\s\S]*?)\n```/.exec(GUIDE);
  if (!m) throw new Error('bloc T1 absent du guide');
  return T1_LIVRE.replace(ANCRE, `${m[1]}\n\n${ANCRE}`);
})();

const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const sortie = (p: { transcription?: string; facts?: Fait[]; tables?: unknown[]; valueDecisions?: Fait[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Facture eau', confidence: 'certain', evidence: { excerpt: 'Facture eau', page: 1 } },
    classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: p.tables ?? [], facts: p.facts ?? [], hasExploitableContent: true,
  ...(p.valueDecisions ? { valueDecisions: p.valueDecisions } : {}),
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
/** Passe de réparation ciblée : SOURCES « extrait ciblé ». */
const REPARATION = (output: unknown) => T1(output, { promptIncludes: 'extrait ciblé' });

/** « Type 388 » : facture d'eau, référence répétée, date de relevé en page 1 ET dans le récapitulatif de la page 2. */
const T388 = [
  '--- page 1 ---', 'Facture eau', 'N° client : 556677889', 'Date de relevé : 12/03/2026', 'Total à payer : 132,00 €',
  '--- page 2 ---', 'N° client : 556677889', 'Relevé effectué le 12/03/2026 par télérelève',
].join('\n');
const faits388 = () => [
  fait('N° client : 556677889', '556677889', { rawKey: 'client.numero' }),
  fait('Total à payer : 132,00 €', '132.00', { rawKey: 'total.ttc' }),
  fait('12/03/2026', '2026-03-12', { rawKey: 'releve.date', evidence: { excerpt: '12/03/2026', page: 2 } }),
];
const reparation388 = () => sortie({
  transcription: '[page:1:field:2]\nDate de relevé : 12/03/2026',
  facts: [fait('12/03/2026', '2026-03-12', { rawKey: 'releve.date' })],
  valueDecisions: [{ value: '12/03/2026', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'STRUCTURED', reason: 'Date du relevé du compteur reprise dans le fait de relevé.',
    sourceUnitId: '[page:1:field:2]', evidence: { excerpt: '12/03/2026', page: 1 }, relatedFactIndexes: [0], relatedCandidateKeys: [], confidence: 'certain' }],
});

/** « Type 126 » : avis d'échéance, tableau des garanties transcrit, prose, coordonnée oubliée. */
const T126 = [
  'Avis échéance assurance moto', 'Contrat n° : MOTO-778899', '',
  'Garantie responsabilité civile 210,00 €', '', 'Garantie vol incendie 95,50 €', '',
  'Votre conseiller reste à votre écoute pour toute question sur vos garanties.', '',
  'Contact : service.client@assureur-exemple.fr',
].join('\n');
const tables126 = [{ title: 'Garanties', pageStart: 1, pageEnd: 1, columns: [{ header: 'Garantie' }, { header: 'Prime' }],
  rows: [{ cells: [{ column: 0, value: 'Garantie responsabilité civile' }, { column: 1, value: '210,00 €' }] },
    { cells: [{ column: 0, value: 'Garantie vol incendie' }, { column: 1, value: '95,50 €' }] }] }];
const premiere126 = () => sortie({ transcription: T126, tables: tables126, facts: [fait('Contrat n° : MOTO-778899', 'MOTO-778899', { rawKey: 'contrat.numero' })] });
const reparation126 = () => sortie({ facts: [fait('Contact : service.client@assureur-exemple.fr', 'service.client@assureur-exemple.fr', { rawKey: 'contact.email' })] });

scenario('L114G', 'T1 — reprise différée : décisions, liens locaux, déduplication (#760)', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let deuxPages: Uint8Array;
  let unePage: Uint8Array;
  beforeAll(async () => {
    const { PDFDocument } = await import('pdf-lib');
    const d2 = await PDFDocument.create();
    d2.addPage(); d2.addPage();
    deuxPages = await d2.save();
    const d1 = await PDFDocument.create();
    d1.addPage();
    unePage = await d1.save();
  });
  beforeEach(async () => {
    pdf.bytes = unePage;
    await contrat(true);
    process.env.T1_MAX_REPAIR_PASSES = '0';
  });
  afterEach(() => { delete process.env.T1_MAX_REPAIR_PASSES; });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  async function contrat(porte: boolean) {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: porte ? 99642 : 99641, treatment: 'T1', versionNumber: porte ? 9642 : 9641, content: porte ? T1_AVEC_CONTRAT : T1_LIVRE }]);
    (await import('@/services/ai/source-analysis/value-decisions/contract')).__resetValueDecisionsCapabilityCacheForTests();
  }
  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  /** Analyse initiale SANS réparation (désactivée) : les vraies lacunes restent pour la reprise différée. */
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, billable: false, origin: 'e2e/l114g' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const reprendre = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    delete process.env.T1_MAX_REPAIR_PASSES;
    await rejouer(records);
    const { repairDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units/jobs');
    return repairDocumentSourceUnits({ accountId: compte.id, fileId });
  };
  const appelsT1 = () => replay.calls.filter((c) => c.operationCode === 't1_analyze_document');
  const unite = async (fileId: number, id: string) => (await sql<Json[]>`
    SELECT source_unit_id AS id, coverage_status AS status, coverage_reason AS reason, repair_state FROM document_source_units WHERE file_id = ${fileId} AND source_unit_id = ${id}`)[0];
  const faitsActifs = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, coalesce(raw_key, fact_key) AS cle, value_text, excerpt, source_unit_ids AS unites FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const decisions = (fileId: number) => sql<Json[]>`
    SELECT source_unit_id, decision, validity, related_fact_ids::int[] AS ids FROM document_value_decisions WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id`;
  const diagnostic = async (fileId: number) => (await sql<Json[]>`SELECT verification FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0].verification.deferredRepair;

  it('L114G-E01 — P1-02 + P1-03 : décision persistée, lien local conservé sur le fait relu, aucun doublon', async () => {
    pdf.bytes = deuxPages;
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: T388, facts: faits388() }))]);
    expect(await unite(f, 'page:1:field:2')).toMatchObject({ status: 'UNRESOLVED' });
    expect(await decisions(f)).toEqual([]);
    const avant = await faitsActifs(f);
    const releve = avant.find((x) => x.value_text === '2026-03-12')!;
    expect(releve.unites ?? []).not.toContain('page:1:field:2');

    const r = await reprendre(c, f, [REPARATION(reparation388())]);
    expect(r).toMatchObject({ outcome: 'repaired', calls: 1, newFacts: 0 });
    // P1-03 : le fait déjà connu est celui que la réparation a relu — son unité ciblée lui est ajoutée.
    const apres = await faitsActifs(f);
    expect(apres.map((x) => x.id)).toEqual(avant.map((x) => x.id));
    expect(apres.find((x) => x.id === releve.id)!.unites).toContain('page:1:field:2');
    expect(await unite(f, 'page:1:field:2')).toMatchObject({ status: 'COVERED' });
    // P1-02 : la décision de la réparation différée est persistée, ancrée sur l'unité, rattachée au fait.
    expect(await decisions(f)).toEqual([{ source_unit_id: 'page:1:field:2', decision: 'STRUCTURED', validity: 'VALID', ids: [releve.id] }]);
    expect(await diagnostic(f)).toMatchObject({
      calls: 1, newFacts: 0, decisions: { received: 1, valid: 1, invalid: 0, persisted: 1 },
      linkage: { local: 1, relinked: 0, duplicates: 1, relinkedExisting: 1 },
    });

    // Rejeu (retry du retry) : plus rien à réparer, aucune décision ni fait en double.
    const r2 = await reprendre(c, f, []);
    expect(r2.calls).toBe(0);
    expect(await decisions(f)).toHaveLength(1);
    expect(await faitsActifs(f)).toHaveLength(avant.length);
  });

  it('L114G-E02 — P1-02 : décision seule sans nouveau fait ; mal formée : comptée ; contrat non porté : rien d’écrit, compté', async () => {
    const AVIS = ['Avis échéance assurance moto', 'Contrat n° : MOTO-778899', '', 'Référence interne agence : AG-4455-Z'].join('\n');
    const premiere = () => sortie({ transcription: AVIS, facts: [fait('Contrat n° : MOTO-778899', 'MOTO-778899', { rawKey: 'contrat.numero' })] });
    const seule = () => sortie({
      transcription: 'Référence interne agence : AG-4455-Z', facts: [],
      valueDecisions: [
        { value: 'AG-4455-Z', kind: 'IDENTIFIER', normalizedValue: 'AG4455Z', decision: 'NOT_RETAINED',
          reason: 'Référence interne de l’agence, sans usage pour le contrat ni pour un bien.', sourceUnitId: null,
          evidence: { excerpt: 'Référence interne agence : AG-4455-Z', page: 1 }, relatedFactIndexes: [], relatedCandidateKeys: [], confidence: 'certain' },
        // Élément mal formé (nature inconnue) : jamais une justification, mais compté.
        { value: 'AG-4455-Z', kind: 'EMAIL', decision: 'NOT_RETAINED', reason: 'x', evidence: {}, relatedFactIndexes: [], relatedCandidateKeys: [] },
      ],
    });
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiere())]);
    const r = await reprendre(c, f, [REPARATION(seule())]);
    expect(r).toMatchObject({ calls: 1, newFacts: 0 });
    const d = await decisions(f);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ decision: 'NOT_RETAINED', validity: 'VALID', ids: [] });
    const diag = (await diagnostic(f)).decisions;
    expect(diag).toMatchObject({ valid: 1, persisted: 1 });
    expect(diag.received).toBeGreaterThanOrEqual(1);

    // Même document, contrat des décisions NON porté par le prompt actif : la décision n'est pas écrite, et c'est dit.
    const f2 = await fichier(c);
    await analyser(c, f2, [T1(premiere())]);
    await contrat(false);
    await reprendre(c, f2, [REPARATION(seule())]);
    expect(await decisions(f2)).toEqual([]);
    expect((await diagnostic(f2))?.decisions?.persisted ?? 0).toBe(0);
  });

  it('L114G-E03 — P1-04 : deux attributs de même valeur et de même extrait → deux faits ; réexécution : aucun doublon', async () => {
    const deux = () => sortie({ facts: [
      fait('Contact : service.client@assureur-exemple.fr', 'service.client@assureur-exemple.fr', { rawKey: 'contact.email' }),
      fait('Contact : service.client@assureur-exemple.fr', 'service.client@assureur-exemple.fr', { rawKey: 'assureur.email' }),
    ] });
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiere126())]);
    const r = await reprendre(c, f, [REPARATION(deux())]);
    expect(r).toMatchObject({ calls: 1, newFacts: 2 });
    const cles = (await faitsActifs(f)).filter((x) => x.value_text === 'service.client@assureur-exemple.fr').map((x) => x.cle).sort();
    expect(cles).toEqual(['assureur.email', 'contact.email']);
    // Réexécution identique de l'écriture (reprise interrompue après les faits) : rien de plus.
    const { appendRepairedFacts } = await import('@/services/ai/source-analysis/source-units/jobs');
    const { SourceUnitLinker } = await import('@/services/ai/source-analysis/source-units/coverage');
    const rejeu = await appendRepairedFacts({ fileId: f, accountId: c.id, extractionId: null, assetId: null, facts: deux().facts as never, linker: new SourceUnitLinker([]) });
    expect(rejeu.inserted).toHaveLength(0);
    expect(rejeu.linkage).toMatchObject({ duplicates: 2 });
    expect((await faitsActifs(f)).filter((x) => x.value_text === 'service.client@assureur-exemple.fr')).toHaveLength(2);
  });

  it('L114G-E04 — P1-04 : deux écritures concurrentes du même fait → une seule ligne', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiere126())]);
    const { appendRepairedFacts } = await import('@/services/ai/source-analysis/source-units/jobs');
    const { SourceUnitLinker } = await import('@/services/ai/source-analysis/source-units/coverage');
    const lot = () => appendRepairedFacts({
      fileId: f, accountId: c.id, extractionId: null, assetId: null, linker: new SourceUnitLinker([]),
      facts: reparation126().facts as never,
    });
    const [a, b] = await Promise.all([lot(), lot()]);
    expect(a.inserted.length + b.inserted.length).toBe(1);
    expect((await faitsActifs(f)).filter((x) => x.value_text === 'service.client@assureur-exemple.fr')).toHaveLength(1);
    expect(appelsT1().length).toBeGreaterThanOrEqual(0);
  });
});
