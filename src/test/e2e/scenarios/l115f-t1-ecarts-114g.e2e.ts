/**
 * Lot 115F (Trello #792) sur PostgreSQL réel — CLÔTURE DES ÉCARTS RÉSIDUELS DU
 * LOT 114G, par le point d'entrée de production (`repairDocumentSourceUnits`,
 * même chemin que la reprise planifiée). Sorties du fournisseur REJOUÉES :
 * aucun appel réseau, aucun appel réel à un fournisseur d'IA.
 *
 *   L115F-E01  P1-03 : extrait rendu présent dans DEUX unités ciblées, sans
 *              identifiant d'unité cité → aucun lien local inventé, ambiguïté
 *              comptée dans le diagnostic, et le fait ne reçoit pas la page
 *              d'une unité choisie arbitrairement ;
 *   L115F-E02  P1-03 : l'identifiant d'unité cité en tête de l'extrait fait
 *              foi — lien explicite, compté comme tel, `source_unit_ids`
 *              RELU en base après le commit ;
 *   L115F-E03  P1-01 : une unité COUVERTE par un fait dont UNE valeur n'est
 *              pas expliquée redevient NON RÉSOLUE, avec sa provenance ; la
 *              politique résiduelle ne promet pas une reprise ciblée
 *              impossible (P2-08) ;
 *   L115F-E04  P2-10 : appels, échecs et COÛT ventilés par famille dans le
 *              diagnostic persisté ; un coût non rendu reste inconnu, jamais
 *              zéro. Reprise rejouée : idempotente.
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

/**
 * Document à PASSAGE RÉPÉTÉ : la même ligne « Montant restant dû » figure en
 * page 1 et en page 2, sous un libellé différent du total — deux unités
 * distinctes que rien ne départage dans l'extrait seul.
 */
const REPETE = [
  '--- page 1 ---', 'Facture eau', 'N° client : 112233445', 'Montant restant du : 132,00 EUR',
  '--- page 2 ---', 'Rappel de situation', 'Montant restant du : 132,00 EUR',
].join('\n');
const PASSAGE = 'Montant restant du : 132,00 EUR';
const premiereRepete = () => sortie({ transcription: REPETE, facts: [fait('N° client : 112233445', '112233445', { rawKey: 'client.numero' })] });
/** Réparation qui rend le passage SANS désigner son unité : association ambiguë. */
const reparationAmbigue = () => sortie({ facts: [fait(PASSAGE, '132.00', { rawKey: 'montant.restant' })] });
/** Réparation qui CITE l'unité de la page 2 (`repairContent` la préfixe ainsi). */
const reparationCitee = (unitId: string) => sortie({ facts: [fait(`[${unitId}]\n${PASSAGE}`, '132.00', { rawKey: 'montant.restant' })] });

scenario('L115F', 'T1 — écarts résiduels 114G : liens exacts, couverture par valeur, coût (#792)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let deuxPages: Uint8Array;
  beforeAll(async () => {
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.create();
    d.addPage(); d.addPage();
    deuxPages = await d.save();
  });
  beforeEach(async () => {
    pdf.bytes = deuxPages;
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: 99642, treatment: 'T1', versionNumber: 9642, content: T1_AVEC_CONTRAT }]);
    (await import('@/services/ai/source-analysis/value-decisions/contract')).__resetValueDecisionsCapabilityCacheForTests();
    // Analyse initiale SANS réparation : les vraies lacunes restent pour la reprise différée.
    process.env.T1_MAX_REPAIR_PASSES = '0';
  });
  afterEach(() => { delete process.env.T1_MAX_REPAIR_PASSES; });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, billable: false, origin: 'e2e/l115f' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const reprendre = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    delete process.env.T1_MAX_REPAIR_PASSES;
    await rejouer(records);
    const { repairDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units/jobs');
    return repairDocumentSourceUnits({ accountId: compte.id, fileId });
  };
  const unites = (fileId: number) => sql<Json[]>`
    SELECT source_unit_id AS id, page, kind, coverage_status AS status, coverage_reason AS reason,
           residual_policy, coverage_provenance AS provenance
      FROM document_source_units WHERE file_id = ${fileId} ORDER BY ordinal`;
  const unite = async (fileId: number, id: string) => (await unites(fileId)).find((u) => u.id === id);
  const faitsActifs = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, coalesce(raw_key, fact_key) AS cle, value_text, source_unit_ids AS unites
      FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const diagnostic = async (fileId: number) => (await sql<Json[]>`
    SELECT verification FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0].verification.deferredRepair;

  it('L115F-E01 — P1-03 : extrait dans deux unités ciblées sans identifiant cité → aucun lien inventé, ambiguïté comptée', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiereRepete())]);
    // Les deux occurrences du passage sont des unités distinctes, non résolues.
    const cibles = (await unites(f)).filter((u) => u.status === 'UNRESOLVED' && u.kind === 'LABEL_VALUE');
    expect(cibles.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cibles.map((u) => u.page)).size).toBeGreaterThanOrEqual(2);

    const r = await reprendre(c, f, [REPARATION(reparationAmbigue())]);
    expect(r.calls).toBe(1);
    const diag = await diagnostic(f);
    // L'association est REFUSÉE : aucune unité n'est posée en lien local, et le fallback est compté.
    expect(diag.linkage).toMatchObject({ ambiguous: 1, local: 0 });
    // La page rendue par le modèle est écartée : elle ne tranche pas l'ambiguïté en aval. Le rattachement
    // recalculé porte donc les DEUX unités où le passage figure — jamais une seule, choisie au hasard.
    const ajoute = (await faitsActifs(f)).find((x) => x.cle === 'montant.restant')!;
    expect([...(ajoute.unites ?? [])].sort()).toEqual(cibles.map((u) => u.id).sort());
  });

  it('L115F-E02 — P1-03 : identifiant d’unité cité → lien explicite, et `source_unit_ids` relu en base', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiereRepete())]);
    const page2 = (await unites(f)).find((u) => u.page === 2 && u.kind === 'LABEL_VALUE' && u.status === 'UNRESOLVED')!;
    expect(page2).toBeDefined();

    const r = await reprendre(c, f, [REPARATION(reparationCitee(page2.id))]);
    expect(r.calls).toBe(1);
    const diag = await diagnostic(f);
    expect(diag.linkage).toMatchObject({ byCitedId: 1, ambiguous: 0, local: 1 });
    // Relecture APRÈS le commit : les unités prouvantes réellement enregistrées sont celles attendues.
    expect(diag.linkage.mismatched).toBe(0);
    expect(diag.linkage.verified).toBeGreaterThanOrEqual(1);
    const ajoute = (await faitsActifs(f)).find((x) => x.cle === 'montant.restant')!;
    expect(ajoute.unites).toEqual([page2.id]);
    // L'unité CITÉE est celle qui devient couverte (jamais sa jumelle de la page 1).
    expect(await unite(f, page2.id)).toMatchObject({ status: 'COVERED' });
  });

  it('L115F-E03 — P1-01 / P2-08 : valeur non expliquée → unité NON RÉSOLUE avec sa provenance, politique véridique', async () => {
    const TEXTE = ['--- page 1 ---', 'Facture eau', 'Total TTC : 120,00 EUR dont acompte 30,00 EUR'].join('\n');
    const c = await make.account();
    const f = await fichier(c);
    // Un SEUL des deux montants de la ligne est structuré : l'autre valeur reste inexpliquée.
    await analyser(c, f, [T1(sortie({
      transcription: TEXTE,
      facts: [fait('Total TTC : 120,00 EUR dont acompte 30,00 EUR', '120.00', { rawKey: 'total.ttc' })],
    }))]);
    const u = (await unites(f)).find((x) => x.kind === 'LABEL_VALUE' && String(x.id).startsWith('page:1:field:'))!;
    expect(u.status).toBe('UNRESOLVED');
    // La provenance consigne la règle, l'état d'origine et le décompte des valeurs — jamais un faux COUVERT.
    expect(u.provenance).toMatchObject({
      rule: 'covered_unit_values_partially_structured', previous: { status: 'COVERED', reason: 'fact' },
    });
    expect(u.provenance.values.total).toBeGreaterThan(u.provenance.values.represented);
    // P2-08 : le remède est le réexamen des décisions de valeur — la politique ne promet pas une reprise ciblée.
    expect(u.residual_policy).toBe('REPAIR_NOT_ELIGIBLE:VALUE_DECISION_REVIEW');
  });

  it('L115F-E04 — P2-10 : appels et coût ventilés par famille, coût non rendu laissé inconnu ; reprise rejouée idempotente', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(premiereRepete())]);
    const page2 = (await unites(f)).find((u) => u.page === 2 && u.kind === 'LABEL_VALUE' && u.status === 'UNRESOLVED')!;
    await reprendre(c, f, [REPARATION(reparationCitee(page2.id))]);

    const diag = await diagnostic(f);
    // Famille « texte ciblé » : ses propres appels, ses échecs, son coût — distincts du total.
    expect(diag.textRepair).toMatchObject({ calls: 1, callsFailed: 0 });
    // Coût et appels au coût inconnu sont PERSISTÉS, chacun pour sa famille : ici la passerelle rejouée rend
    // un coût (nul, aucune consommation réelle), donc aucun appel au coût inconnu. Un coût NON rendu ne serait
    // jamais compté zéro : il alimenterait `costUnknownCalls` (prouvé sur la passe elle-même, tests unitaires).
    expect(typeof diag.textRepair.costMicros).toBe('number');
    expect(diag.textRepair.costUnknownCalls).toBeLessThanOrEqual(diag.textRepair.calls);
    // Famille « relecture du fichier » : comptée à part, aucune ici.
    expect(diag.sourceReread).toMatchObject({ calls: 0, callsFailed: 0 });
    expect(diag.calls).toBeGreaterThanOrEqual(diag.textRepair.calls);

    // Reprise rejouée : aucun fait ni aucune unité dupliqués.
    // Carte #853 (P1-01 #835, AC04) — ASSERTION ADAPTÉE : « 0 appel » reposait sur la promotion de la page 1 par
    // la règle « texte identique à une unité couverte ». La page 1 porte le MÊME montant sur une AUTRE page, sans
    // équivalence démontrée (le fait réparé ne cite que la page 2) : ce n'est plus une couverture, c'est un résidu
    // réel. La reprise rejouée ne vise donc QUE ce résidu (jamais la page 2 déjà prouvée), dans ses bornes.
    const faitsAvant = await faitsActifs(f);
    const unitesAvant = await unites(f);
    const page1 = unitesAvant.find((u) => u.page === 1 && u.kind === 'LABEL_VALUE' && u.status !== 'COVERED')!;
    expect(page1).toBeDefined();
    const r2 = await reprendre(c, f, []);
    expect(r2.calls).toBeLessThanOrEqual(1);
    expect([...r2.attempted]).not.toContain(page2.id);
    if (r2.calls > 0) expect([...r2.attempted]).toEqual([page1.id]);
    expect(await faitsActifs(f)).toEqual(faitsAvant);
    expect((await unites(f)).map((u) => u.id)).toEqual(unitesAvant.map((u) => u.id));
  });
});
