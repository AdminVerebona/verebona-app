/**
 * Cas de qualification d'une opération — lot 86A (CDC Pilotage IA V2 P5 :
 * QUAL-03, QUAL-04, QUAL-09, OP-07, R32, R36-R38, R41, R48, R49 ; décision
 * PO n° 13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CORPUS (INV-11) : LE CORPUS DES PROMPTS MAÎTRES, ENRICHI
 *
 *   1. CORPUS_FIXTURE — cas du corpus des prompts maîtres
 *      (`governance/master-corpus`, toutes les opérations T1–T6) dont les
 *      variables RÉELLES se construisent avec les fonctions de production
 *      (`liveVariablesFor`). Attendu présent : source `REFERENCE` (attendu
 *      vérifié du corpus, jugé par le contrôle serveur déterministe de la
 *      branche) ; sans attendu : `INVARIANTS` (contrôles serveur seuls —
 *      l'exactitude n'est pas démontrée : non concluant). Obligatoires.
 *   2. T1_REFERENCE — cas de référence T1 du harnais historique absorbé
 *      (`t1-reference.ts`), CONSULTATIFS tant que leurs attendus ne sont pas
 *      validés par l'équipe IA.
 *   3. PREPROD_REPLAY — rejeu des traitements applicables sur les données
 *      EXISTANTES de préproduction (décision 13 : tous les comptes existants,
 *      aucun compte dédié, aucune remise à zéro) : l'entrée modèle CAPTURÉE à
 *      la source (82C, construite par les constructeurs de production) est
 *      renvoyée au couple testé ; la sortie est comparée au résultat
 *      HISTORIQUE (divergence relevée, jamais prise pour une vérité) et aux
 *      contrôles serveur (une violation absente de la sortie historique =
 *      régression démontrée). Sans résultat attendu vérifiable, un rejeu ne
 *      prouve pas l'exactitude : il n'est jamais obligatoire et n'autorise
 *      aucune mise à jour automatique des données.
 * Aucun cas n'est auto-certifié par le modèle testé (QUAL-09, R49).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ZodType } from 'zod';
import { createHash } from 'node:crypto';
import { AI_OPERATIONS, type AiOperationDefinition } from '../registry/operations';
import { treatmentOfUseCase, type Treatment } from '../config/treatments';
import type { MasterCorpusCase, MasterFileReader } from '../governance/master-corpus/cases';
import { defectsFromComparison, defectsFromEvaluator, schemaDefect, type Defect } from './defects';
import { canonicalJson, sha256 } from './signature';
import { structuredSpecFor } from '../master-prompts/structured-context';
import type { CaseSource, ExpectedSource } from './verdict';

export interface CaseEvaluation { defects: Defect[]; inconclusive: string | null }

export interface QualificationCase {
  caseId: string;
  operationCode: string;
  treatment: Treatment;
  source: CaseSource;
  expectedSource: ExpectedSource;
  mandatory: boolean;
  /** Consultatif : relevé et affiché, jamais compté dans le verdict. */
  advisory: boolean;
  /** Compte des données (rejeu) ; null : compte technique de mesure. */
  accountId: number | null;
  captureId: number | null;
  variables: Record<string, unknown>;
  outputSchema: ZodType;
  acceptedOutputSchemas: ZodType[];
  historicalOutput: unknown | null;
  /** Jeton propre au cas présent dans le prompt (simulation, diagnostic). */
  marker: string | null;
  evaluate(output: unknown, ctx: { masterText: MasterFileReader }): Promise<CaseEvaluation>;
}

export interface CaseSet {
  operationCode: string;
  cases: QualificationCase[];
  /** Cas écartés et motif (pièce jointe, variables non reconstituables, contenu masqué…). */
  skipped: Array<{ caseId: string; source: CaseSource; reason: string }>;
  /** Empreinte du corpus de l'opération (cas du corpus seulement, pas les rejeux). */
  corpusFingerprint: string;
}

/** Plus longue valeur texte des variables : jeton distinctif présent dans le prompt rendu. */
export function markerOf(vars: Record<string, unknown> | null): string | null {
  let best: string | null = null;
  const visit = (v: unknown) => {
    if (typeof v === 'string') { if (v.length >= 12 && (!best || v.length > best.length)) best = v; return; }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(visit);
  };
  visit(vars);
  return best ? (best as string).slice(0, 200) : null;
}

const hashOf = (v: unknown): string | null => (v == null ? null : sha256(canonicalJson(v)));

/** Empreinte d'une sortie (jamais le contenu dans les preuves). */
export function outputSha256(v: unknown): string | null { return hashOf(v); }

// ── 1. Corpus des prompts maîtres ───────────────────────────────────────────

/**
 * Lot 97A — schémas de sortie possibles de la branche d'un cas, dans l'ordre
 * d'essai : contrat de la sortie enregistrée, schéma de l'opération, puis
 * schémas des contrats de sortie déclarés (contexte structuré). Pur.
 */
export function branchSchemaNames(c: Pick<MasterCorpusCase, 'masterPromptCode' | 'task' | 'outputSchema' | 'outputContract'>): string[] {
  const spec = structuredSpecFor(c.masterPromptCode);
  const propre = c.outputContract ? spec?.outputContracts[c.outputContract]?.byTask[c.task]?.schemaName : undefined;
  const declares = spec ? Object.values(spec.outputContracts).map((o) => o.byTask[c.task]?.schemaName) : [];
  return [...new Set([propre, c.outputSchema, ...declares].filter((n): n is string => Boolean(n)))];
}

let corpusOverride: MasterCorpusCase[] | null = null;
/** Tests seulement : corpus substitué (campagne ET lecture BO voient le même corpus). */
export function __setQualificationCorpusForTests(cases: MasterCorpusCase[] | null): void { corpusOverride = cases; }

/**
 * Source de la vérité attendue d'un cas du corpus pour un appel RÉEL
 * (QUAL-09, pur). Les attendus du corpus ont été écrits pour REJOUER des
 * sorties enregistrées (D-08) : certains décrivent la bonne réponse, d'autres
 * la réaction du serveur à une sortie délibérément fautive (garde). Seule
 * une déclaration de l'équipe IA (`qualification.role`) en fait une vérité de
 * référence — aucun classement deviné par le code :
 *   · `answer` + attendu : REFERENCE (obligatoire, jugé contre l'attendu) ;
 *   · `guard` : écarté (sans objet pour une réponse réelle) ;
 *   · non déclaré : INVARIANTS — contrôles serveur seuls (attendu retiré),
 *     exactitude non démontrée : NON CONCLUANT.
 */
export function fixtureExpectation(c: Pick<MasterCorpusCase, 'expected' | 'qualificationRole'>, hasEvaluator: boolean): { use: 'REFERENCE' | 'INVARIANTS' | 'NONE' | 'SKIP'; reason: string | null } {
  const hasExpected = Boolean(c.expected && Object.keys(c.expected).length);
  if (c.qualificationRole === 'guard') return { use: 'SKIP', reason: 'cas de garde (réaction du serveur à une sortie enregistrée fautive) : sans objet pour une réponse réelle' };
  if (c.qualificationRole === 'answer' && hasExpected) return { use: 'REFERENCE', reason: null };
  return { use: hasEvaluator ? 'INVARIANTS' : 'NONE', reason: c.qualificationRole === 'answer' ? 'réponse de référence sans attendu' : 'rôle du cas non déclaré par l’équipe IA (réponse de référence ou garde)' };
}

/**
 * Lot 99B — corpus de qualification en vigueur (substitué par un test, sinon
 * fichiers du dépôt) : entre dans l'empreinte du contexte d'un essai de mise
 * en conformité (un corpus enrichi autorise un nouvel essai).
 */
export async function qualificationCorpus(readMasterFile: MasterFileReader): Promise<MasterCorpusCase[]> {
  if (corpusOverride) return corpusOverride;
  return (await import('../governance/master-corpus/cases')).loadMasterCorpusCases(readMasterFile);
}

async function fixtureCases(op: AiOperationDefinition, treatment: Treatment, readMasterFile: MasterFileReader, given?: MasterCorpusCase[]) {
  const [{ loadMasterCorpusCases }, { liveVariablesFor, branchSchemas }, { evaluateCorpusOutput }, { masterOutputSchemaFor }, { MASTER_CORPUS_EVALUATORS }] = await Promise.all([
    import('../governance/master-corpus/cases'), import('../governance/master-corpus/live'), import('../governance/master-corpus/runner'),
    import('../gateway/master-output-schemas'), import('../governance/master-corpus/evaluators'),
  ]);
  const all = (given ?? corpusOverride ?? loadMasterCorpusCases(readMasterFile)).filter((c) => c.operationCode === op.operationCode);
  const cases: QualificationCase[] = [];
  const skipped: CaseSet['skipped'] = [];
  const schema = masterOutputSchemaFor(op.outputSchema);
  for (const c of all) {
    if (!schema) { skipped.push({ caseId: c.id, source: 'CORPUS_FIXTURE', reason: `schéma ${op.outputSchema} inconnu` }); continue; }
    let variables: Record<string, unknown> | null = null;
    try { variables = await liveVariablesFor(c); } catch (e) { skipped.push({ caseId: c.id, source: 'CORPUS_FIXTURE', reason: `variables : ${(e as Error).message}` }); continue; }
    if (!variables) { skipped.push({ caseId: c.id, source: 'CORPUS_FIXTURE', reason: 'hors sous-ensemble réel (pièce jointe ou contexte non reconstituable)' }); continue; }
    const attendu = fixtureExpectation(c, op.operationCode in MASTER_CORPUS_EVALUATORS);
    if (attendu.use === 'SKIP') { skipped.push({ caseId: `corpus:${c.id}`, source: 'CORPUS_FIXTURE', reason: attendu.reason! }); continue; }
    // Sans déclaration « réponse de référence », l'attendu (écrit pour une sortie enregistrée) n'est pas appliqué.
    const juge: MasterCorpusCase = attendu.use === 'REFERENCE' ? c : { ...c, expected: null };
    const schemaNames = branchSchemaNames(c);
    cases.push({
      caseId: `corpus:${c.id}`, operationCode: op.operationCode, treatment, source: 'CORPUS_FIXTURE',
      expectedSource: attendu.use,
      mandatory: true, advisory: false, accountId: null, captureId: null, variables,
      outputSchema: schema, acceptedOutputSchemas: branchSchemas(c),
      historicalOutput: c.output ?? null, marker: markerOf(variables),
      async evaluate(output, ctx) {
        // Lot 97A : la sortie RÉELLE suit le contrat de sortie du prompt actif (T4 v1 / v2 / v3…), pas
        // forcément celui de la sortie enregistrée : elle est jugée avec le premier schéma de la branche
        // qui la valide (schéma du cas, de l'opération, puis des contrats déclarés), jamais avec un schéma
        // d'un autre contrat qui la rejetterait à tort (ex. v1 : `unknown` exige `ambiguous`).
        let r = await evaluateCorpusOutput(juge, output, ctx.masterText(c.masterPromptCode), ctx.masterText, schemaNames[0]);
        for (const nom of schemaNames.slice(1)) {
          if (!r.errors.some((e) => /^(sortie|schéma) /.test(e))) break;
          const autre = await evaluateCorpusOutput(juge, output, ctx.masterText(c.masterPromptCode), ctx.masterText, nom);
          if (!autre.errors.some((e) => /^(sortie|schéma) /.test(e))) r = autre;
        }
        const defects: Defect[] = [];
        let inconclusive: string | null = null;
        for (const e of r.errors) {
          if (/^(sortie|schéma) /.test(e)) defects.push(schemaDefect(e));
          else if (/^contrôle : /.test(e)) inconclusive = `contrôle serveur en erreur (${e.slice(10, 160)})`;
          else defects.push(...defectsFromEvaluator([e]));
        }
        return { defects, inconclusive: defects.length ? null : inconclusive };
      },
    });
  }
  const corpusFingerprint = sha256(canonicalJson(all.map((c) => ({ id: c.id, file: c.file, context: c.context, expected: c.expected, contract: c.outputContract ?? null, role: c.qualificationRole ?? null }))
    .sort((a, b) => `${a.file}#${a.id}`.localeCompare(`${b.file}#${b.id}`))));
  return { cases, skipped, corpusFingerprint };
}

// ── 2. Cas de référence T1 (harnais historique absorbé) ─────────────────────

async function t1ReferenceCases(op: AiOperationDefinition, treatment: Treatment): Promise<{ cases: QualificationCase[]; skipped: CaseSet['skipped']; fingerprint: string }> {
  const [{ listCorpusCases }, { readFixture }, t1, { compareCase }, tol] = await Promise.all([
    import('../governance/corpus/corpus-cases').then(() => import('../governance/corpus/corpus-registry')),
    import('./t1-reference').then((m) => ({ readFixture: m.readT1ReferenceFixture })), import('./t1-reference'), import('../governance/corpus/corpus-comparator'),
    import('../source-analysis/master/tolerant-output'),
  ]);
  const cases: QualificationCase[] = [];
  const skipped: CaseSet['skipped'] = [];
  const liste = listCorpusCases();
  for (const c of liste) {
    let html: string;
    try { html = readFixture(c.fixturePath); } catch (e) { skipped.push({ caseId: `t1ref:${c.caseId}`, source: 'T1_REFERENCE', reason: `document introuvable (${(e as Error).message})` }); continue; }
    const variables = t1.t1ReferenceVariables(c, html, 0);
    cases.push({
      caseId: `t1ref:${c.caseId}`, operationCode: op.operationCode, treatment, source: 'T1_REFERENCE', expectedSource: 'REFERENCE',
      mandatory: false, advisory: true, accountId: null, captureId: null, variables,
      outputSchema: tol.T1AnalyzeDocumentTolerantOutput, acceptedOutputSchemas: [], historicalOutput: null, marker: c.caseId,
      async evaluate(output) {
        const { output: out } = tol.splitNormalisation(output as never);
        return { defects: defectsFromComparison(compareCase(c, t1.observedFromT1Output(c, out))), inconclusive: null };
      },
    });
  }
  return { cases, skipped, fingerprint: sha256(canonicalJson(liste.map((c) => ({ id: c.caseId, expected: c.expected })))) };
}

// ── 3. Rejeu des données existantes de préproduction ────────────────────────

export interface CaptureRow {
  id: number;
  accountId: number;
  operationCode: string;
  promptText: string | null;
  promptStatus: string;
  responseStatus: string;
  variables: Record<string, unknown> | null;
  attachments: unknown[] | null;
  masking: unknown;
  parsedOutput: unknown;
}

/**
 * Variables d'origine d'une capture (pur) : les valeurs longues remplacées
 * par `{ $ref: 'prompt', offset, length, sha256 }` sont relues dans le prompt
 * capturé, empreinte vérifiée. Rend null si une référence est illisible.
 */
export function resolveCapturedVariables(vars: Record<string, unknown> | null, prompt: string | null): Record<string, unknown> | null {
  if (!vars) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v && typeof v === 'object' && (v as { $ref?: unknown }).$ref === 'prompt') {
      const r = v as { offset: number; length: number; sha256: string };
      if (!prompt) return null;
      const s = prompt.slice(r.offset, r.offset + r.length);
      if (s.length !== r.length || createHash('sha256').update(s, 'utf8').digest('hex') !== r.sha256) return null;
      out[k] = s;
    } else out[k] = v;
  }
  return out;
}

/** Motif d'exclusion d'une capture du rejeu, null si rejouable (pur). */
export function replayExclusion(c: CaptureRow): string | null {
  if (c.promptStatus !== 'CAPTURED') return c.promptStatus === 'MASKED' ? 'contenu masqué à la capture (non rejoué tel quel)' : 'prompt non capturé';
  if (c.responseStatus !== 'CAPTURED' || c.parsedOutput == null) return 'résultat historique non capturé';
  if (Array.isArray(c.attachments) && c.attachments.length > 0) return 'pièce jointe : non rejouable en P5 (référence de stockage seulement)';
  if (c.masking && typeof c.masking === 'object' && Object.keys(c.masking as object).length > 0) return 'variables masquées à la capture';
  return null;
}

async function replayCases(op: AiOperationDefinition, treatment: Treatment, rows: CaptureRow[], readMasterFile: MasterFileReader) {
  const [{ masterOutputSchemaFor }, { branchSchemas }, { MASTER_CORPUS_EVALUATORS }, { validateOutput }] = await Promise.all([
    import('../gateway/master-output-schemas'), import('../governance/master-corpus/live'), import('../governance/master-corpus/evaluators'),
    import('../gateway/output-validator'),
  ]);
  const cases: QualificationCase[] = [];
  const skipped: CaseSet['skipped'] = [];
  const schema = masterOutputSchemaFor(op.outputSchema);
  const evaluator = MASTER_CORPUS_EVALUATORS[op.operationCode] as ((c: MasterCorpusCase, o: unknown, x: { masterText: MasterFileReader }) => Promise<string[]>) | undefined;
  const pseudo = (): MasterCorpusCase => ({
    id: 'replay', description: '', file: 'replay', operationCode: op.operationCode, masterPromptCode: op.masterPromptCode ?? '',
    task: op.task ?? '', taskField: op.taskField ?? 'task', outputSchema: op.outputSchema, context: {}, output: null, expected: null,
  });
  for (const r of rows) {
    const caseId = `replay:${r.id}`;
    const motif = replayExclusion(r);
    if (motif) { skipped.push({ caseId, source: 'PREPROD_REPLAY', reason: motif }); continue; }
    if (!schema) { skipped.push({ caseId, source: 'PREPROD_REPLAY', reason: `schéma ${op.outputSchema} inconnu` }); continue; }
    const variables = resolveCapturedVariables(r.variables, r.promptText);
    if (!variables) { skipped.push({ caseId, source: 'PREPROD_REPLAY', reason: 'variables non reconstituables depuis la capture' }); continue; }
    const historique = r.parsedOutput;
    cases.push({
      caseId, operationCode: op.operationCode, treatment, source: 'PREPROD_REPLAY',
      expectedSource: evaluator ? 'INVARIANTS' : 'NONE', mandatory: false, advisory: false,
      accountId: r.accountId, captureId: r.id, variables, outputSchema: schema,
      acceptedOutputSchemas: op.masterPromptCode ? branchSchemas({ masterPromptCode: op.masterPromptCode, task: op.task ?? '', outputSchema: op.outputSchema }) : [],
      historicalOutput: historique, marker: markerOf(variables),
      async evaluate(output, ctx) {
        try {
          validateOutput(JSON.stringify(output), schema, op.operationCode, 'json', { expectedTask: op.task ?? undefined, taskField: op.taskField ?? 'task', schemaName: op.outputSchema });
        } catch (e) {
          return { defects: [schemaDefect(`sortie : ${(e as Error).message}`)], inconclusive: null };
        }
        if (!evaluator) return { defects: [], inconclusive: null };
        try {
          const avant = new Set(await evaluator(pseudo(), historique, { masterText: ctx.masterText }).catch(() => [] as string[]));
          const apres = await evaluator(pseudo(), output, { masterText: ctx.masterText });
          // Régression DÉMONTRÉE : violation d'un contrôle serveur absente du résultat historique.
          return { defects: defectsFromEvaluator(apres.filter((m) => !avant.has(m)).map((m) => `régression par rapport au résultat historique : ${m}`)), inconclusive: null };
        } catch (e) {
          return { defects: [], inconclusive: `contrôle serveur non applicable au rejeu (${(e as Error).message.slice(0, 120)})` };
        }
      },
    });
  }
  void readMasterFile;
  return { cases, skipped };
}

/**
 * Cas de qualification d'une opération : corpus (obligatoire), cas de
 * référence T1 (consultatifs, `t1_analyze_document`) et rejeux de données
 * existantes (`captures`, déjà bornées par compte et par opération).
 */
export async function buildCaseSet(operationCode: string, opts: {
  readMasterFile: MasterFileReader;
  captures?: CaptureRow[];
  /** Tests : cas du corpus injectés. */
  corpusCases?: MasterCorpusCase[];
  /** Inclure les cas de référence T1 (défaut : oui pour `t1_analyze_document`). */
  includeT1Reference?: boolean;
}): Promise<CaseSet> {
  const op = AI_OPERATIONS[operationCode];
  if (!op || op.provider === 'none' || !op.active) throw new Error(`Opération modèle inconnue ou inactive : ${operationCode}`);
  const treatment = treatmentOfUseCase(op.useCaseCode);
  if (!treatment) throw new Error(`Opération ${operationCode} : usage technique, hors qualification par couple.`);
  const f = await fixtureCases(op, treatment, opts.readMasterFile, opts.corpusCases);
  const cases = [...f.cases];
  const skipped = [...f.skipped];
  let fp = f.corpusFingerprint;
  if (operationCode === 't1_analyze_document' && (opts.includeT1Reference ?? true)) {
    const t = await t1ReferenceCases(op, treatment);
    cases.push(...t.cases);
    skipped.push(...t.skipped);
    fp = sha256(`${fp}:${t.fingerprint}`);
  }
  if (opts.captures?.length) {
    const r = await replayCases(op, treatment, opts.captures.filter((c) => c.operationCode === operationCode), opts.readMasterFile);
    cases.push(...r.cases);
    skipped.push(...r.skipped);
  }
  return { operationCode, cases, skipped, corpusFingerprint: fp };
}
