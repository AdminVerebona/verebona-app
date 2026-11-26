/**
 * Carte #854 (P1-02 de #835) sur PostgreSQL réel — DÉCISIONS DE VALEUR DES
 * RÉPARATIONS DIFFÉRÉES : contrat figé par appel, faits existants, persistance
 * des décisions ET des rejets, relecture exacte, reprise sûre. Points d'entrée
 * de production (`repairDocumentSourceUnits` — contrôle de cohérence, texte
 * seul ; `runCompletenessRetry` — reprise planifiée), sorties Gemini REJOUÉES
 * derrière la passerelle réelle (aucun réseau). Fixtures génériques, pas des
 * incidents constatés.
 *
 *   C854-E01  AC01 / AC13 / AC14 : décision seule sur un fait ANCIEN (fait cité hors zone) → valide, persistée,
 *             relue CONFORME, aucun doublon de fait, aucun appel de plus ; rejeu : rien de plus ;
 *   C854-E02  AC02 : COMPONENT_OR_CONTEXT vers un candidat ACTIF préexistant prouvé → valide ; même clé sans
 *             preuve / candidat remplacé → refus motivé ;
 *   C854-E03  AC03 : deux faits persistés candidats → AMBIGU ; fait d'un AUTRE compte → inconnu, sans fuite ;
 *   C854-E04  AC04 : contexte illisible → non évaluée (jamais un vide), reprise SANS IA → confirmée ; référence
 *             invalidée avant le commit → non évaluée, revalidée ensuite ;
 *   C854-E05  AC05 : analyse sous A, appel sous B, BO passe à C pendant l'appel → validée sous B (trace B) ;
 *             inverse (B sans contrat, C avec) → rejet CONTRACT_MARKER_MISSING ;
 *   C854-E06  AC06 : deux appels d'une passe, deux contrats ; même décision canonique sur deux appels → UNE ligne,
 *             deux réceptions corrélées ;
 *   C854-E07  AC07 : preuve absente, version non supportée, coupure d'urgence, contrat v1 supporté ;
 *   C854-E08  AC08 : zéro décision réelle ≠ rejet ≠ incident ; brut compté avant filtrage ;
 *   C854-E09  AC09 : quatre types valides / invalides, couverture (UNDETERMINED et rejet ne couvrent jamais) ;
 *   C854-E10  AC10 : anciennes VALID nombreuses, nouvelle décision divergente / absente → détectée ;
 *   C854-E11  AC11 : panne pendant l'écriture (annulation) / relecture impossible → aucun faux COVERED, reprise ;
 *   C854-E12  AC12 : arrêts avant / après le commit, deux rejeux, deux workers → aucun doublon, issues préservées ;
 *   C854-E13  AC13 / AC14 : reprise planifiée, plafond de reprises → état final, aucune boucle, aucun appel ;
 *   C854-E14  AC15 / AC16 : bilan BO réconcilié, isolation intercomptes, décisions historiques non certifiées ;
 *   C854-E15  migration 2012 rejouable, registres transverses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import { setDefaultResponder, type RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
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
const BLOC = (() => {
  const m = /<!-- l89c:bloc id="t1-value-decisions-v1"[^>]*-->\s*\n```text\n([\s\S]*?)\n```/.exec(GUIDE);
  if (!m) throw new Error('bloc T1 absent du guide');
  return m[1];
})();
/** Trois versions BO du prompt T1 : A et B portent le contrat (textes différents), C ne le porte pas. */
const PROMPTS = {
  A: { id: 98541, versionNumber: 8541, content: T1_LIVRE.replace(ANCRE, `${BLOC}\n\n${ANCRE}`) },
  B: { id: 98542, versionNumber: 8542, content: T1_LIVRE.replace(ANCRE, `${BLOC}\n\nVersion B du PO.\n\n${ANCRE}`) },
  C: { id: 98543, versionNumber: 8543, content: T1_LIVRE },
} as const;

const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const sortie = (p: { transcription?: string; facts?: Fait[]; valueDecisions?: Fait[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Contrat habitation', confidence: 'certain', evidence: { excerpt: 'Contrat assurance habitation', page: 1 } },
    classification: { canonicalType: 'CONTRAT', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'CONTRAT', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: [], facts: p.facts ?? [], hasExploitableContent: true,
  ...(p.valueDecisions ? { valueDecisions: p.valueDecisions } : {}),
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
const REPARATION = (output: unknown, over: Partial<RecordedOutput> = {}) => T1(output, { promptIncludes: 'extrait ciblé', ...over });

/** Contrat d'assurance générique : cotisation en page 1, RAPPEL de la même cotisation et frais en page 2. */
const CONTRAT = [
  '--- page 1 ---', 'Contrat assurance habitation', 'Contrat n° : HAB-445566', 'Cotisation annuelle : 412,00 €',
  '--- page 2 ---', 'Rappel : cotisation annuelle de 412,00 € prélevée en une fois', 'Frais de dossier : 34,00 €',
].join('\n');
const COTISATION = () => fait('Cotisation annuelle : 412,00 €', '412.00', { rawKey: 'cotisation.annuelle' });
const faitsContrat = () => [fait('Contrat n° : HAB-445566', 'HAB-445566', { rawKey: 'contrat.numero' }), COTISATION()];
const dec = (value: string, kind: string, decision: string, reason: string, unit: string | null, over: Fait = {}): Fait => ({
  value, kind, normalizedValue: null, decision, reason, sourceUnitId: unit ? `[${unit}]` : null, evidence: {},
  relatedFactIndexes: [], relatedCandidateKeys: [], confidence: 'certain', ...over,
});
const RAPPEL_STRUCTURE = (unit: string) => dec('412,00 €', 'AMOUNT', 'STRUCTURED', 'Rappel de la cotisation annuelle du contrat, déjà reprise dans le fait de cotisation.', unit, { relatedFactIndexes: [0] });
const FRAIS_NON_RETENUS = (unit: string) => dec('34,00 €', 'AMOUNT', 'NOT_RETAINED', 'Frais de dossier facturés une seule fois à la souscription, sans échéance pour le contrat.', unit);

scenario('C854', 'T1 — décisions des réparations différées : contrat par appel, faits existants, persistance (#854)', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let deuxPages: Uint8Array;
  beforeAll(async () => {
    const { PDFDocument } = await import('pdf-lib');
    const d2 = await PDFDocument.create();
    d2.addPage(); d2.addPage();
    deuxPages = await d2.save();
  });
  beforeEach(async () => {
    pdf.bytes = deuxPages;
    await prompt('A');
    process.env.T1_MAX_REPAIR_PASSES = '0';
  });
  afterEach(async () => {
    delete process.env.T1_MAX_REPAIR_PASSES;
    delete process.env.T1_VALUE_DECISIONS_ENABLED;
    const m = await import('@/services/ai/source-analysis/source-units/repair-decisions');
    m.__setDecisionFailpointsForTests(null);
    m.__setDecisionHooksForTests(null);
    setDefaultResponder('t1_analyze_document', 'ANALYZE_DOCUMENT', null);
  });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  async function prompt(v: keyof typeof PROMPTS) {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ ...PROMPTS[v], treatment: 'T1' }]);
    (await import('@/services/ai/source-analysis/value-decisions/contract')).__resetValueDecisionsCapabilityCacheForTests();
  }
  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, billable: false, origin: 'e2e/c854' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  /** Contrôle de cohérence (texte seul) — même `retryDocument` que la reprise planifiée. */
  const reprendre = async (compte: AccountRow, fileId: number, records: RecordedOutput[]) => {
    delete process.env.T1_MAX_REPAIR_PASSES;
    await rejouer(records);
    const { repairDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units/jobs');
    await sql`UPDATE document_extraction_coverage SET next_retry_at = NULL WHERE file_id = ${fileId}`;
    return repairDocumentSourceUnits({ accountId: compte.id, fileId });
  };
  const appelsT1 = () => replay.calls.filter((c) => c.operationCode === 't1_analyze_document').length;
  const uniteDe = async (fileId: number, debut: string) => (await sql<Json[]>`
    SELECT source_unit_id AS id, coverage_status AS status, coverage_reason AS reason FROM document_source_units
     WHERE file_id = ${fileId} AND content_text LIKE ${`${debut}%`} ORDER BY ordinal LIMIT 1`)[0];
  const faitsActifs = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, coalesce(raw_key, fact_key) AS cle, value_text FROM document_facts WHERE file_id = ${fileId} AND status = 'active' ORDER BY id`;
  const decisions = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, source_unit_id AS unit, decision, validity, invalid_reason AS invalid, related_fact_ids::int[] AS ids, prompt_version AS pv, ai_trace_id AS trace
      FROM document_value_decisions WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id`;
  const recus = (fileId: number) => sql<Json[]>`
    SELECT pass_id, pass_origin, call_index, call_ref, ordinal, contract_state, contract_version, prompt_version, prompt_fingerprint,
           decision_type, outcome, reason, retryable, decision_id::int AS decision_id, write_state, recovery_attempts
      FROM document_value_decision_receipts WHERE file_id = ${fileId} ORDER BY id`;
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT next_retry_at, last_retry_result, verification FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const diag = async (fileId: number) => (await couverture(fileId)).verification.deferredRepair;

  /** Document analysé (sans réparation), unités du rappel et des frais. */
  const contratAnalyse = async (compte?: AccountRow, faits = faitsContrat()) => {
    const c = compte ?? await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: CONTRAT, facts: faits }))]);
    const rappel = await uniteDe(f, 'Rappel');
    const frais = await uniteDe(f, 'Frais de dossier');
    return { c, f, rappel, frais };
  };

  // ── Appels directs de la passe (intégration PostgreSQL : contrats, pannes, concurrence) ─────────────────
  const contrat = async () => import('@/services/ai/source-analysis/value-decisions/contract');
  const preuve = (over: Fait = {}) => ({
    promptVersion: 't1_master_v1@pv98542:bbbbbbbbbbbb', textFingerprint: 'bbbbbbbbbbbbbbbb', configVersionId: 1, promptVersionId: 98542,
    markers: ['t1-value-decisions-v1'], source: 'version', ...over,
  });
  const enveloppe = async (callIndex: number, ev: unknown = preuve()) => ({
    callIndex, callRef: `trace-e2e-${callIndex}`, provider: 'replay', model: 'm', usedFallback: false, fromCache: false, providerRequests: 1,
    contract: (await contrat()).decisionContractOfCall(ev as never), rawDecisions: null, decisionsField: 'PRESENT', failed: false,
  });
  const recu = (callIndex: number, ordinal: number, d: Fait, refFacts: Fait[] = [], preRejected: string | null = null) => ({
    callIndex, ordinal, preRejected, refFacts,
    decision: {
      origin: 'CHUNK', evidence: {}, relatedFactRefs: [], relatedCandidateKeys: [], confidence: 'certain', normalizedValue: null,
      ...d, callIndex, ordinal,
    },
  });
  let n = 0;
  const passe = async (c: AccountRow, f: number, received: unknown[], envelopes?: unknown[], factIdsByRef = new Map<string, number[]>()) => {
    const [{ persistRepairDecisions, toCovered }, { loadAllDocumentSourceUnits }] = await Promise.all([
      import('@/services/ai/source-analysis/source-units/jobs'), import('@/services/ai/source-analysis/source-units/repository'),
    ]);
    const units = (await loadAllDocumentSourceUnits(f, { accountId: c.id })).map(toCovered);
    const [e] = await sql<Json[]>`SELECT id::int AS id FROM document_extractions WHERE file_id = ${f}`;
    return persistRepairDecisions({
      accountId: c.id, fileId: f, extractionId: e?.id ?? null, assetId: null, passId: `e2e:${f}:${++n}`, passOrigin: 'e2e',
      received: received as never, envelopes: (envelopes ?? [await enveloppe(1)]) as never, units, factIdsByRef,
    });
  };
  const ref = (excerpt: string, value: string, t1FactRef: string, over: Fait = {}) => ({ ...fait(excerpt, value, over), t1FactRef });

  it('C854-E01 — AC01 / AC13 / AC14 : décision seule sur un fait ANCIEN cité hors zone → valide, relue conforme, sans doublon ni appel de plus', async () => {
    const { c, f, rappel, frais } = await contratAnalyse();
    expect(rappel.status).not.toBe('COVERED');
    const avant = await faitsActifs(f);
    const cotisation = avant.find((x) => x.cle === 'cotisation.annuelle')!;
    // Réponse : AUCUN fait nouveau — le fait cité est le rappel du fait de la page 1 (hors de la zone ciblée).
    const r = await reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id)] }))]);
    expect(r).toMatchObject({ calls: 1, newFacts: 0 });
    expect(appelsT1()).toBe(1);
    // Défaut A reproduit par le code d'avant : `gardes` = faits de la passe (vides) → STRUCTURED `LINK_UNKNOWN`.
    expect(await decisions(f)).toEqual([
      expect.objectContaining({ unit: rappel.id, decision: 'STRUCTURED', validity: 'VALID', ids: [cotisation.id] }),
      expect.objectContaining({ unit: frais.id, decision: 'NOT_RETAINED', validity: 'VALID', ids: [] }),
    ]);
    expect((await faitsActifs(f)).map((x) => x.id)).toEqual(avant.map((x) => x.id));
    expect((await uniteDe(f, 'Rappel')).status).toBe('COVERED');
    const j = await recus(f);
    expect(j).toHaveLength(2);
    expect(j.every((x) => x.outcome === 'VALID' && x.write_state === 'CONFIRMED' && x.pass_origin === 'coherence-control' && x.contract_state === 'CARRIED')).toBe(true);
    expect(j[0].call_ref).toMatch(/.+/);
    expect(j[0].prompt_version).toContain('pv98541');
    const d = (await diag(f)).decisions;
    expect(d).toMatchObject({ received: 2, valid: 2, invalid: 0, rejected: 0, notEvaluated: 0, newlyWritten: 2, alreadyPresent: 0, confirmed: 2, state: 'CONFIRMED', balanced: true, persisted: 2 });
    expect(d.calls).toEqual([expect.objectContaining({ callIndex: 1, contractState: 'CARRIED', received: 2, failed: false })]);
    expect((await couverture(f)).last_retry_result).not.toContain('DECISIONS_INCOMPLETE');
    // Rejeu : aucune décision ni réception de plus, aucun appel.
    const r2 = await reprendre(c, f, []);
    expect(r2.calls).toBe(0);
    expect(await decisions(f)).toHaveLength(2);
    expect(await recus(f)).toHaveLength(2);
  });

  it('C854-E02 — AC02 : candidat ACTIF préexistant prouvé → valide ; même clé sans preuve, candidat remplacé → refus', async () => {
    const { c, f, frais } = await contratAnalyse();
    const cotis = await uniteDe(f, 'Cotisation annuelle');
    const [e] = await sql<Json[]>`SELECT id::int AS id FROM document_extractions WHERE file_id = ${f}`;
    const candidat = async (key: string, payload: Json, status = 'ACTIVE') => sql`
      INSERT INTO document_operation_candidates (account_id, file_id, extraction_id, candidate_key, established, confidence, summary, payload, status, superseded_at)
      VALUES (${c.id}, ${f}, ${e.id}, ${key}, true, 'certain', 'Souscription', ${JSON.stringify(payload)}::jsonb, ${status}, CASE WHEN ${status} = 'ACTIVE' THEN NULL ELSE now() END)`;
    await candidat('op-1', { financialHints: [{ amountMinor: 44600, evidence: { sourceUnitIds: [cotis.id] } }] });
    await candidat('op-2', {});
    await candidat('op-3', { financialHints: [{ amountMinor: 44600, evidence: { sourceUnitIds: [cotis.id] } }] }, 'SUPERSEDED');
    const composante = (key: string, i: number) => recu(1, i, {
      value: '34,00 €', kind: 'AMOUNT', decision: 'COMPONENT_OR_CONTEXT', sourceUnitId: frais.id,
      reason: 'Frais de dossier inclus dans le montant total de 446,00 € de la souscription.', relatedCandidateKeys: [key],
    });
    const d1 = await passe(c, f, [composante('op-1', 0)]);
    expect(d1).toMatchObject({ valid: 1, state: 'CONFIRMED' });
    expect(d1.context).toMatchObject({ candidates: 2, complete: true });
    const d2 = await passe(c, f, [composante('op-2', 1)]);
    expect(d2).toMatchObject({ invalid: 1, skipped: { 'INVALID:LINK_INCOHERENT': 1 } });
    const d3 = await passe(c, f, [composante('op-3', 2)]);
    expect(d3).toMatchObject({ invalid: 1, skipped: { 'INVALID:LINK_UNKNOWN': 1 } });
    expect((await recus(f)).map((x) => [x.outcome, x.reason])).toEqual([['VALID', null], ['INVALID', 'LINK_INCOHERENT'], ['INVALID', 'LINK_UNKNOWN']]);
  });

  it('C854-E03 — AC03 : deux faits persistés candidats → AMBIGU ; fait d’un autre compte → inconnu, sans fuite', async () => {
    const deux = [...faitsContrat(), fait('Échéancier : cotisation annuelle 412,00 €', '412.00', { rawKey: 'cotisation.annuelle' })];
    const { c, f, rappel } = await contratAnalyse(undefined, deux);
    expect((await faitsActifs(f)).filter((x) => x.cle === 'cotisation.annuelle')).toHaveLength(2);
    const structure = (i: number, refFacts: Fait[], refIds: string[] = []) => recu(1, i, {
      value: '412,00 €', kind: 'AMOUNT', decision: 'STRUCTURED', sourceUnitId: rappel.id,
      reason: 'Rappel de la cotisation annuelle du contrat, déjà reprise dans le fait de cotisation.', relatedFactRefs: refIds,
    }, refFacts);
    // Le fait cité est un rappel (autre passage) : deux faits persistés de même clé, valeur et cible → AMBIGU, jamais le premier.
    const cite = ref('Rappel : cotisation annuelle de 412,00 €', '412.00', 'r-rappel', { rawKey: 'cotisation.annuelle' });
    const a = await passe(c, f, [structure(0, [cite], ['r-rappel'])]);
    expect(a).toMatchObject({ invalid: 1, skipped: { 'INVALID:LINK_AMBIGUOUS': 1 } });
    // Identité EXACTE d'un des deux faits : seule cette référence est acceptée.
    const exact = ref('Cotisation annuelle : 412,00 €', '412.00', 'r-exact', { rawKey: 'cotisation.annuelle' });
    const b = await passe(c, f, [structure(1, [exact], ['r-exact'])]);
    const vise = (await faitsActifs(f)).find((x) => x.cle === 'cotisation.annuelle')!;
    expect(b).toMatchObject({ valid: 1 });
    expect((await decisions(f)).find((x) => x.validity === 'VALID')!.ids).toEqual([vise.id]);
    // Autre compte, même document type : le fait de l'autre compte n'est jamais résolu, même par identifiant forgé.
    const autre = await contratAnalyse();
    const autreFait = (await faitsActifs(autre.f)).find((x) => x.cle === 'cotisation.annuelle')!;
    const x = await passe(autre.c, autre.f, [structure(0, [exact], ['r-exact'])].map((r) => ({ ...r, decision: { ...r.decision, sourceUnitId: autre.rappel.id } })));
    expect(x.valid).toBe(1);
    expect((await decisions(autre.f))[0].ids).toEqual([autreFait.id]);
    const forge = await passe(c, f, [structure(2, [], ['r-forge'])], undefined, new Map([['r-forge', [autreFait.id]]]));
    expect(forge).toMatchObject({ invalid: 1, skipped: { 'INVALID:LINK_UNKNOWN': 1 } });
    expect((await decisions(f)).flatMap((d) => d.ids)).not.toContain(autreFait.id);
  });

  it('C854-E04 — AC04 : contexte illisible → non évaluée puis reprise SANS IA ; référence invalidée avant le commit → revalidée', async () => {
    const m = await import('@/services/ai/source-analysis/source-units/repair-decisions');
    const { c, f, rappel, frais } = await contratAnalyse();
    m.__setDecisionFailpointsForTests(['context']);
    await reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id)] }))]);
    expect(await decisions(f)).toEqual([]);
    expect((await recus(f)).map((x) => [x.outcome, x.reason, x.retryable])).toEqual([['NOT_EVALUATED', 'CONTEXT_UNAVAILABLE', true], ['NOT_EVALUATED', 'CONTEXT_UNAVAILABLE', true]]);
    const cov = await couverture(f);
    expect(cov.last_retry_result).toContain('DECISIONS_INCOMPLETE');
    expect(cov.next_retry_at).not.toBeNull();
    expect(cov.verification.deferredRepair.decisions).toMatchObject({ received: 2, notEvaluated: 2, state: 'INCOMPLETE', retryable: true, balanced: true });
    expect((await uniteDe(f, 'Rappel')).status).not.toBe('COVERED');
    // Reprise : aucun appel IA, décisions évaluées sur le contrat FIGÉ de l'appel (même si le BO a changé depuis).
    m.__setDecisionFailpointsForTests(null);
    await prompt('C');
    const r = await reprendre(c, f, []);
    expect(r.calls).toBe(0);
    expect(appelsT1()).toBe(0);
    expect((await decisions(f)).map((x) => x.validity)).toEqual(['VALID', 'VALID']);
    expect((await recus(f)).map((x) => [x.outcome, x.write_state, x.recovery_attempts])).toEqual([['VALID', 'CONFIRMED', 1], ['VALID', 'CONFIRMED', 1]]);
    expect((await diag(f)).decisionsRecovery).toMatchObject({ recovery: true, valid: 2, confirmed: 2, state: 'CONFIRMED' });
    expect((await uniteDe(f, 'Rappel')).status).toBe('COVERED');

    // Référence invalidée entre la validation et le commit : non évaluée (réessayable), revalidée ensuite → refus motivé.
    const g = await contratAnalyse();
    const cot = (await faitsActifs(g.f)).find((x) => x.cle === 'cotisation.annuelle')!;
    m.__setDecisionHooksForTests({ beforeWrite: async () => { await sql`UPDATE document_facts SET status = 'superseded' WHERE id = ${cot.id}`; } });
    const exact = ref('Cotisation annuelle : 412,00 €', '412.00', 'r1', { rawKey: 'cotisation.annuelle' });
    const d = await passe(g.c, g.f, [recu(1, 0, { value: '412,00 €', kind: 'AMOUNT', decision: 'STRUCTURED', sourceUnitId: g.rappel.id,
      reason: 'Rappel de la cotisation annuelle du contrat, déjà reprise dans le fait de cotisation.', relatedFactRefs: ['r1'] }, [exact])]);
    expect(d).toMatchObject({ notEvaluated: 1, skipped: { REFERENCE_INVALIDATED: 1 }, state: 'INCOMPLETE', retryable: true });
    expect(await decisions(g.f)).toEqual([]);
    m.__setDecisionHooksForTests(null);
    const rep = await m.recoverDecisionReceipts({ accountId: g.c.id, fileId: g.f, extractionId: null, assetId: null });
    expect(rep).toMatchObject({ invalid: 1, skipped: { 'INVALID:LINK_UNKNOWN': 1 } });
  });

  it('C854-E05 — AC05 : analyse A, appel B, BO passe à C pendant l’appel → validée sous B ; inverse → rejet motivé', async () => {
    const runtime = await import('@/services/ai/master-prompts/master-prompt-runtime');
    const { c, f, rappel, frais } = await contratAnalyse();
    const reponse = sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id)] });
    await prompt('B');
    // Le BO publie C (sans contrat) PENDANT l'appel B : la persistance qui suit relit C — sans effet rétroactif.
    setDefaultResponder('t1_analyze_document', 'ANALYZE_DOCUMENT', () => {
      runtime.__setActiveMasterPromptsForTests([{ ...PROMPTS.C, treatment: 'T1' }]);
      return reponse;
    });
    await reprendre(c, f, []);
    expect((await decisions(f)).map((x) => x.validity)).toEqual(['VALID', 'VALID']);
    expect((await decisions(f)).every((x) => String(x.pv).includes('pv98542'))).toBe(true);
    const j = await recus(f);
    expect(j.every((x) => String(x.prompt_version).includes('pv98542') && x.contract_state === 'CARRIED' && x.prompt_fingerprint)).toBe(true);
    expect((await diag(f)).decisions.calls[0]).toMatchObject({ contractState: 'CARRIED', contractVersion: 't1-value-decisions-v1' });

    // Inverse : appel sous C (sans contrat), BO repasse à A (avec) avant l'écriture → rejet CONTRACT_MARKER_MISSING, rien d'accepté.
    const g = await contratAnalyse();
    await prompt('C');
    setDefaultResponder('t1_analyze_document', 'ANALYZE_DOCUMENT', () => {
      runtime.__setActiveMasterPromptsForTests([{ ...PROMPTS.A, treatment: 'T1' }]);
      return sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(g.rappel.id)] });
    });
    await reprendre(g.c, g.f, []);
    expect(await decisions(g.f)).toEqual([]);
    expect((await recus(g.f)).map((x) => [x.outcome, x.reason, x.contract_state])).toEqual([['REJECTED', 'CONTRACT_MARKER_MISSING', 'MARKER_MISSING']]);
    expect((await diag(g.f)).decisions).toMatchObject({ received: 1, rejected: 1, state: 'CONFIRMED', balanced: true });
  });

  it('C854-E06 — AC06 : deux appels, deux contrats, aucun mélange ; même décision canonique sur deux appels → une ligne, deux réceptions', async () => {
    const { c, f, rappel, frais } = await contratAnalyse();
    const exact = ref('Cotisation annuelle : 412,00 €', '412.00', 'r1', { rawKey: 'cotisation.annuelle' });
    const rappelD = { value: '412,00 €', kind: 'AMOUNT', decision: 'STRUCTURED', sourceUnitId: rappel.id,
      reason: 'Rappel de la cotisation annuelle du contrat, déjà reprise dans le fait de cotisation.', relatedFactRefs: ['r1'] };
    const fraisD = { value: '34,00 €', kind: 'AMOUNT', decision: 'NOT_RETAINED', sourceUnitId: frais.id,
      reason: 'Frais de dossier facturés une seule fois à la souscription, sans échéance pour le contrat.' };
    const env1 = { ...(await enveloppe(1)), usedFallback: true, providerRequests: 3, model: 'repli' };
    const env2 = await enveloppe(2, preuve({ promptVersion: 't1_master_v1@pv98543:cccccccccccc', textFingerprint: 'cccccccccccccccc', markers: [] }));
    const env3 = await enveloppe(3);
    const d = await passe(c, f, [recu(1, 0, rappelD, [exact]), recu(2, 0, fraisD), recu(3, 0, rappelD, [exact])], [env1, env2, env3]);
    expect(d).toMatchObject({ received: 3, valid: 2, rejected: 1, newlyWritten: 1, alreadyPresent: 1, confirmed: 2, state: 'CONFIRMED', contractVersionChanged: true });
    expect(d.calls!.map((x) => [x.callIndex, x.contractState, x.promptVersion])).toEqual([
      [1, 'CARRIED', 't1_master_v1@pv98542:bbbbbbbbbbbb'], [2, 'MARKER_MISSING', 't1_master_v1@pv98543:cccccccccccc'], [3, 'CARRIED', 't1_master_v1@pv98542:bbbbbbbbbbbb'],
    ]);
    const lignes = await decisions(f);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ trace: 'trace-e2e-1', pv: 't1_master_v1@pv98542:bbbbbbbbbbbb' });
    const j = await recus(f);
    expect(j.map((x) => [x.call_index, x.call_ref, x.outcome, x.decision_id, x.write_state])).toEqual([
      [1, 'trace-e2e-1', 'VALID', lignes[0].id, 'CONFIRMED'], [2, 'trace-e2e-2', 'REJECTED', null, 'NOT_APPLICABLE'], [3, 'trace-e2e-3', 'VALID', lignes[0].id, 'CONFIRMED'],
    ]);
  });

  it('C854-E07 — AC07 : preuve absente, version non supportée, coupure d’urgence ; v1 supportée selon SON contrat', async () => {
    const { c, f, frais } = await contratAnalyse();
    const fraisD = (i: number) => recu(1, i, { value: '34,00 €', kind: 'AMOUNT', decision: 'NOT_RETAINED', sourceUnitId: frais.id,
      reason: 'Frais de dossier facturés une seule fois à la souscription, sans échéance pour le contrat.' });
    expect(await passe(c, f, [fraisD(0)], [await enveloppe(1, null)])).toMatchObject({ rejected: 1, skipped: { CONTRACT_EVIDENCE_MISSING: 1 } });
    expect(await passe(c, f, [fraisD(0)], [await enveloppe(1, preuve({ markers: ['t1-value-decisions-v2'] }))])).toMatchObject({ rejected: 1, skipped: { CONTRACT_UNSUPPORTED_VERSION: 1 } });
    process.env.T1_VALUE_DECISIONS_ENABLED = '0';
    const s = await passe(c, f, [fraisD(0)], [await enveloppe(1)]);
    expect(s).toMatchObject({ notEvaluated: 1, skipped: { PERSISTENCE_SUSPENDED: 1 } });
    expect(s.calls![0]).toMatchObject({ contractState: 'CARRIED', persistenceSuspended: true });
    delete process.env.T1_VALUE_DECISIONS_ENABLED;
    expect(await decisions(f)).toEqual([]);
    expect(await passe(c, f, [fraisD(0)], [await enveloppe(1)])).toMatchObject({ valid: 1, state: 'CONFIRMED' });
    expect((await recus(f)).map((x) => [x.contract_state, x.outcome])).toEqual([
      ['EVIDENCE_MISSING', 'REJECTED'], ['UNSUPPORTED_VERSION', 'REJECTED'], ['CARRIED', 'NOT_EVALUATED'], ['CARRIED', 'VALID'],
    ]);
  });

  it('C854-E08 — AC08 : zéro décision réelle ≠ rejet motivé ≠ incident ; brut compté avant filtrage', async () => {
    const { c, f, rappel } = await contratAnalyse();
    await reprendre(c, f, [REPARATION(sortie({ facts: [], valueDecisions: [] }))]);
    const zero = (await diag(f)).decisions;
    expect(zero).toMatchObject({ received: 0, state: 'NONE' });
    expect(zero.calls).toEqual([expect.objectContaining({ received: 0, failed: false })]);
    expect(await recus(f)).toEqual([]);
    const g = await contratAnalyse();
    await reprendre(g.c, g.f, [REPARATION(sortie({ facts: [], valueDecisions: [
      dec('412,00 €', 'EMAIL', 'NOT_RETAINED', 'x', g.rappel.id),
      dec('99,00 €', 'AMOUNT', 'NOT_RETAINED', 'Montant d’une autre unité, hors de la zone transmise.', 'page:9:field:9', { evidence: { excerpt: 'Inexistant : 99,00 €' } }),
    ] }))]);
    const d = (await diag(g.f)).decisions;
    expect(d).toMatchObject({ received: 2, rejected: 2, valid: 0, balanced: true });
    expect((await recus(g.f)).map((x) => [x.outcome, x.reason]).sort()).toEqual([['REJECTED', 'SCHEMA_INVALID'], ['REJECTED', 'UNIT_NOT_IN_TARGET_ZONE']]);
    void rappel;
    // Incident : appel en échec → décisions INCONNUES (jamais « zéro »).
    const h = await contratAnalyse();
    await reprendre(h.c, h.f, [REPARATION(null, { error: { message: 'requête invalide', status: 400, recoverable: false } }), REPARATION(null, { error: { message: 'requête invalide', status: 400, recoverable: false }, repeat: true })]);
    const e = (await diag(h.f)).decisions;
    expect(e).toMatchObject({ received: 0, state: 'NONE' });
    expect(e.calls).toEqual([expect.objectContaining({ received: null, failed: true })]);
  });

  it('C854-E09 — AC09 : quatre types valides / invalides, couverture : UNDETERMINED et rejet ne couvrent jamais, NOT_RETAINED non structuré', async () => {
    const TEXTE = [
      '--- page 1 ---', 'Contrat assurance habitation', 'Cotisation annuelle : 412,00 €',
      '--- page 2 ---', 'Rappel : cotisation annuelle de 412,00 € prélevée en une fois', 'Frais de dossier : 34,00 €',
      'Taxe attentat : 5,90 €', 'Remise fidélité éventuelle : 20,00 €', 'Référence agence : AG-4455-Z',
    ].join('\n');
    const c = await make.account();
    const f = await fichier(c);
    await analyser(c, f, [T1(sortie({ transcription: TEXTE, facts: [COTISATION()] }))]);
    const u = async (d: string) => (await uniteDe(f, d)).id as string;
    const [rappel, frais, taxe, remise, agence] = [await u('Rappel'), await u('Frais'), await u('Taxe'), await u('Remise'), await u('Référence agence')];
    const avant = await faitsActifs(f);
    await reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [
      RAPPEL_STRUCTURE(rappel), FRAIS_NON_RETENUS(frais),
      dec('5,90 €', 'AMOUNT', 'COMPONENT_OR_CONTEXT', 'Taxe attentat comprise dans la cotisation annuelle de 412,00 €.', taxe, { relatedFactIndexes: [0] }),
      dec('20,00 €', 'AMOUNT', 'UNDETERMINED', 'Remise fidélité conditionnelle, application non établie par le document.', remise),
      dec('AG-4455-Z', 'IDENTIFIER', 'STRUCTURED', 'Référence de l’agence gestionnaire du contrat.', agence),
    ] }))]);
    const lignes = await decisions(f);
    expect(lignes.map((x) => [x.decision, x.validity, x.invalid])).toEqual([
      ['STRUCTURED', 'VALID', null], ['NOT_RETAINED', 'VALID', null], ['COMPONENT_OR_CONTEXT', 'VALID', null], ['UNDETERMINED', 'VALID', null], ['STRUCTURED', 'INVALID', 'LINK_MISSING'],
    ]);
    const d = (await diag(f)).decisions;
    expect(d).toMatchObject({ received: 5, valid: 4, invalid: 1, confirmed: 5, state: 'CONFIRMED', balanced: true });
    expect(d.byType).toMatchObject({ STRUCTURED: { received: 2, valid: 1, invalid: 1 }, NOT_RETAINED: { valid: 1 }, COMPONENT_OR_CONTEXT: { valid: 1 }, UNDETERMINED: { valid: 1 } });
    expect((await recus(f)).find((x) => x.decision_type === 'STRUCTURED' && x.outcome === 'INVALID')).toMatchObject({ reason: 'LINK_MISSING', write_state: 'CONFIRMED' });
    expect((await uniteDe(f, 'Rappel')).status).toBe('COVERED');
    expect((await uniteDe(f, 'Frais')).status).toBe('COVERED');
    expect((await uniteDe(f, 'Taxe')).status).toBe('COVERED');
    expect((await uniteDe(f, 'Remise')).status).not.toBe('COVERED');
    expect((await uniteDe(f, 'Référence agence')).status).not.toBe('COVERED');
    // NOT_RETAINED n'est pas une valeur structurée : aucun fait créé.
    expect((await faitsActifs(f)).length).toBe(avant.length);
  });

  it('C854-E10 — AC10 : anciennes VALID nombreuses, nouvelle décision divergente / absente → détectée, jamais le compte global', async () => {
    const m = await import('@/services/ai/source-analysis/source-units/repair-decisions');
    const { c, f, rappel, frais } = await contratAnalyse();
    await reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id)] }))]);
    expect((await decisions(f)).filter((x) => x.validity === 'VALID')).toHaveLength(2);
    const contratUnite = await uniteDe(f, 'Contrat n°');
    const d0 = recu(1, 0, { value: 'HAB-445566', kind: 'IDENTIFIER', decision: 'NOT_RETAINED', sourceUnitId: contratUnite.id,
      reason: 'Numéro du contrat rappelé en page 2 pour le prélèvement de la cotisation.' });
    // Altération concurrente APRÈS le commit (ligne remplacée) : relue DIVERGENTE alors que le compte global VALID ne baisse pas.
    m.__setDecisionHooksForTests({ afterCommit: async () => {
      await sql`UPDATE document_value_decisions SET status = 'SUPERSEDED', superseded_at = now(), superseded_reason = 'E2E' WHERE file_id = ${f} AND source_unit_id = ${contratUnite.id} AND status = 'ACTIVE'`;
    } });
    const d = await passe(c, f, [d0]);
    expect(d).toMatchObject({ divergent: 1, confirmed: 0, state: 'INCOMPLETE', retryable: true });
    expect(d.rereadActive).toBeGreaterThanOrEqual(2);
    expect((await recus(f)).at(-1)).toMatchObject({ write_state: 'DIVERGENT' });
    // Ligne absente après le commit (perte simulée) : MANQUANTE.
    m.__setDecisionHooksForTests({ afterCommit: async () => {
      await sql`DELETE FROM document_value_decisions WHERE file_id = ${f} AND source_unit_id = ${contratUnite.id} AND status = 'ACTIVE'`;
    } });
    const e = await passe(c, f, [{ ...d0, decision: { ...d0.decision, reason: 'Numéro du contrat rappelé pour identifier le prélèvement de la cotisation.' } }]);
    expect(e).toMatchObject({ missing: 1, state: 'INCOMPLETE' });
    expect((await recus(f)).at(-1)).toMatchObject({ write_state: 'MISSING' });
  });

  it('C854-E11 — AC11 : panne pendant l’écriture → annulée, aucun faux COVERED ; relecture impossible → non confirmée, exclue, reprise', async () => {
    const m = await import('@/services/ai/source-analysis/source-units/repair-decisions');
    const { c, f, rappel, frais } = await contratAnalyse();
    const faitsAvant = await faitsActifs(f);
    m.__setDecisionFailpointsForTests(['during_write']);
    await reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id)] }))]);
    expect(await decisions(f)).toEqual([]);
    expect((await recus(f)).map((x) => [x.outcome, x.reason])).toEqual([['NOT_EVALUATED', 'WRITE_FAILED'], ['NOT_EVALUATED', 'WRITE_FAILED']]);
    expect(await faitsActifs(f)).toEqual(faitsAvant);
    expect((await uniteDe(f, 'Rappel')).status).not.toBe('COVERED');
    expect((await couverture(f)).last_retry_result).toContain('DECISIONS_INCOMPLETE');

    // Relecture impossible après le commit : écrites mais NON confirmées → exclues de la couverture, puis confirmées sans IA.
    const g = await contratAnalyse();
    m.__setDecisionFailpointsForTests(['reread']);
    await reprendre(g.c, g.f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(g.rappel.id), FRAIS_NON_RETENUS(g.frais.id)] }))]);
    expect((await decisions(g.f)).map((x) => x.validity)).toEqual(['VALID', 'VALID']);
    expect((await recus(g.f)).map((x) => x.write_state)).toEqual(['UNCONFIRMED', 'UNCONFIRMED']);
    expect((await diag(g.f)).decisions).toMatchObject({ unconfirmed: 2, confirmed: 0, state: 'INCOMPLETE' });
    expect((await uniteDe(g.f, 'Rappel')).status).not.toBe('COVERED');
    m.__setDecisionFailpointsForTests(null);
    const r = await reprendre(g.c, g.f, []);
    expect(r.calls).toBe(0);
    expect((await recus(g.f)).map((x) => x.write_state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await decisions(g.f)).toHaveLength(2);
    expect((await uniteDe(g.f, 'Rappel')).status).toBe('COVERED');
  });

  it('C854-E12 — AC12 : arrêts avant / après le commit, deux rejeux, deux workers → aucun doublon, identités et issues préservées', async () => {
    const m = await import('@/services/ai/source-analysis/source-units/repair-decisions');
    // Arrêt APRÈS le commit des décisions, avant relecture et couverture : la passe échoue (tentative consommée), rien n'est faussement terminé.
    const { c, f, rappel, frais } = await contratAnalyse();
    m.__setDecisionFailpointsForTests(['crash_after_commit']);
    await expect(reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id)] }))])).rejects.toThrow(/arrêt simulé/);
    expect((await recus(f)).map((x) => x.write_state)).toEqual(['NEW', 'NEW']);
    expect((await uniteDe(f, 'Rappel')).status).not.toBe('COVERED');
    m.__setDecisionFailpointsForTests(null);
    const r = await reprendre(c, f, []);
    expect(r.calls).toBe(0);
    expect(await decisions(f)).toHaveLength(2);
    expect((await recus(f)).map((x) => x.write_state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect((await uniteDe(f, 'Rappel')).status).toBe('COVERED');
    // Second rejeu : rien à reprendre, rien en double.
    expect(await m.recoverDecisionReceipts({ accountId: c.id, fileId: f, extractionId: null, assetId: null })).toBeNull();
    expect(await decisions(f)).toHaveLength(2);

    // Arrêt APRÈS les faits, AVANT l'écriture des décisions : manifeste en attente, repris par DEUX workers concurrents.
    const g = await contratAnalyse();
    m.__setDecisionFailpointsForTests(['crash_before_write']);
    await expect(reprendre(g.c, g.f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(g.rappel.id), FRAIS_NON_RETENUS(g.frais.id)] }))])).rejects.toThrow(/arrêt simulé/);
    expect((await recus(g.f)).map((x) => x.outcome)).toEqual(['PENDING', 'PENDING']);
    expect(await decisions(g.f)).toEqual([]);
    m.__setDecisionFailpointsForTests(null);
    const [a, b] = await Promise.all([
      m.recoverDecisionReceipts({ accountId: g.c.id, fileId: g.f, extractionId: null, assetId: null }),
      m.recoverDecisionReceipts({ accountId: g.c.id, fileId: g.f, extractionId: null, assetId: null }),
    ]);
    expect([a, b].some((x) => x && x.valid === 2)).toBe(true);
    const lignes = await decisions(g.f);
    expect(lignes).toHaveLength(2);
    expect(lignes.every((x) => x.validity === 'VALID')).toBe(true);
    const j = await recus(g.f);
    expect(j).toHaveLength(2);
    expect(j.every((x) => x.outcome === 'VALID' && x.write_state === 'CONFIRMED')).toBe(true);
    expect(new Set(j.map((x) => x.decision_id)).size).toBe(2);
    expect(appelsT1()).toBe(1);
  });

  it('C854-E13 — AC13 / AC14 : reprise PLANIFIÉE sans IA ; plafond de reprises → état final explicite, aucune boucle', async () => {
    const m = await import('@/services/ai/source-analysis/source-units/repair-decisions');
    const receipts = await import('@/services/ai/source-analysis/value-decisions/receipts');
    const { c, f, rappel, frais } = await contratAnalyse();
    m.__setDecisionFailpointsForTests(['context']);
    await reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id)] }))]);
    m.__setDecisionFailpointsForTests(null);
    // Reprise planifiée (`t1-completeness-retry`) : la persistance seule est reprise, aucun appel.
    await rejouer([]);
    await sql`UPDATE document_extraction_coverage SET next_retry_at = now() - interval '1 minute' WHERE file_id = ${f}`;
    const { runCompletenessRetry } = await import('@/services/ai/source-analysis/source-units/jobs');
    const run = await runCompletenessRetry();
    expect(run.examined).toBeGreaterThanOrEqual(1);
    expect(appelsT1()).toBe(0);
    expect((await recus(f)).map((x) => [x.outcome, x.write_state])).toEqual([['VALID', 'CONFIRMED'], ['VALID', 'CONFIRMED']]);

    // Plafond : une réception déjà reprise RECEIPT_RECOVERY_MAX fois n'est plus reprise — état final, motif dit.
    const g = await contratAnalyse();
    m.__setDecisionFailpointsForTests(['context']);
    await reprendre(g.c, g.f, [REPARATION(sortie({ facts: [], valueDecisions: [FRAIS_NON_RETENUS(g.frais.id)] }))]);
    m.__setDecisionFailpointsForTests(['context']);
    for (let i = 0; i < receipts.RECEIPT_RECOVERY_MAX; i++) await m.recoverDecisionReceipts({ accountId: g.c.id, fileId: g.f, extractionId: null, assetId: null });
    m.__setDecisionFailpointsForTests(null);
    const fin = await m.recoverDecisionReceipts({ accountId: g.c.id, fileId: g.f, extractionId: null, assetId: null });
    expect(fin).toMatchObject({ notEvaluated: 1, skipped: { RECOVERY_EXHAUSTED: 1 } });
    expect((await recus(g.f))[0]).toMatchObject({ outcome: 'NOT_EVALUATED', reason: 'RECOVERY_EXHAUSTED', retryable: false, recovery_attempts: receipts.RECEIPT_RECOVERY_MAX });
    expect(await m.recoverDecisionReceipts({ accountId: g.c.id, fileId: g.f, extractionId: null, assetId: null })).toBeNull();
  });

  it('C854-E14 — AC15 / AC16 : bilan BO réconcilié, isolation intercomptes, décisions historiques jamais certifiées', async () => {
    const { c, f, rappel, frais } = await contratAnalyse();
    await reprendre(c, f, [REPARATION(sortie({ facts: [COTISATION()], valueDecisions: [RAPPEL_STRUCTURE(rappel.id), FRAIS_NON_RETENUS(frais.id), dec('34,00 €', 'EMAIL', 'NOT_RETAINED', 'x', frais.id)] }))]);
    const cov = await couverture(f);
    const { deferredRepairText } = await import('@/app/admin/ai-executions/_components/T1CompletenessUnits');
    const t = deferredRepairText({ coverageRepair: null, deferredRepair: cov.verification.deferredRepair, sourceReread: null, retryAttempts: 1, lastRetryResult: cov.last_retry_result });
    expect(t).toContain('3 reçue(s) = 2 acceptée(s) + 0 rejetée(s) à la validation + 1 rejetée(s) avant validation + 0 non évaluée(s)');
    expect(t).toContain('relecture exacte : 2 conforme(s)');
    expect(t).toMatch(/appel 1 : contrat porté t1-value-decisions-v1, prompt t1_master_v1@pv98541/);
    // Aucun extrait du document dans le bilan BO (identifiants et codes seulement).
    expect(t).not.toContain('Frais de dossier facturés');
    // Isolation : les réceptions d'un compte ne sont jamais lues pour un autre.
    const autre = await make.account();
    const receipts = await import('@/services/ai/source-analysis/value-decisions/receipts');
    const { pgClient } = await import('@/db');
    const passId = (await recus(f))[0].pass_id as string;
    expect(await receipts.loadPassReceipts(pgClient as never, autre.id, f, passId)).toEqual([]);
    expect((await receipts.loadPassReceipts(pgClient as never, c.id, f, passId))).toHaveLength(3);
    // Décision historique (sans réception) : jamais exclue en masse, jamais certifiée sur l'appel.
    const [h] = await sql<Json[]>`
      INSERT INTO document_value_decisions (account_id, file_id, origin, contract_version, source_unit_id, value_kind, raw_value, normalized_value, decision, reason, validity, decision_fp)
      VALUES (${c.id}, ${f}, 'ANALYSIS', 't1-value-decisions-v1', ${frais.id}, 'AMOUNT', '34,00 €', '3400', 'NOT_RETAINED', 'Historique', 'VALID', 'historique-e2e')
      RETURNING id::int AS id`;
    const nonConfirmees = await receipts.unconfirmedDecisionIds(pgClient as never, c.id, f);
    expect(nonConfirmees.has(h.id)).toBe(false);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM document_value_decision_receipts WHERE decision_id = ${h.id}`)[0].n).toBe(0);
  });

  it('C854-E15 — migration 2012 rejouable ; table déclarée dans les registres transverses', async () => {
    const texte = readFileSync(join(RACINE, 'src/db/migrations/2012_c854_recus_decisions_valeur.sql'), 'utf8');
    for (let i = 0; i < 2; i++) await sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL client_min_messages = warning`); await tx.unsafe(texte); });
    const [t] = await sql<Json[]>`SELECT to_regclass('document_value_decision_receipts') IS NOT NULL AS ok`;
    expect(t.ok).toBe(true);
    const cov = await import('@/services/admin/diagnostics-export/coverage');
    const cat = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { FILE_SCOPED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
    expect(JSON.stringify(cov)).toContain('document_value_decision_receipts');
    expect(JSON.stringify(cat)).toContain('document_value_decision_receipts');
    expect(FILE_SCOPED_TABLES).toContainEqual(['document_value_decision_receipts', 'file_id']);
  });
});
