/**
 * Lot 97A (demande `86A-contrats-qualite-operations`) — RÔLES de qualification
 * déclarés dans les fichiers de cas du corpus des prompts maîtres
 * (`"qualification": { "role": "answer" | "guard" }`).
 *
 *  L97A-Q01  chaque cas du corpus déclare son rôle (aucun cas « non déclaré ») ;
 *  L97A-Q02  une RÉPONSE de référence porte une sortie enregistrée CORRECTE : elle
 *            passe son attendu par le contrôle serveur réel (schéma de son contrat) ;
 *  L97A-Q03  une GARDE est écartée de la qualification réelle (sans objet) ;
 *  L97A-Q04  campagne simulée (passerelle remplacée, mêmes cas, mêmes contrôles) :
 *            un couple qui rend les bonnes réponses est ADMISSIBLE pour chaque
 *            opération qualifiable ; un couple qui rend la réponse d'un autre cas
 *            est REFUSÉ ; les opérations sans cas de référence vérifiable restent
 *            NON CONCLUANTES (jamais admissibles par défaut).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
const { evaluateCorpusOutput } = await import('@/services/ai/governance/master-corpus/runner');
const { structuredSpecFor } = await import('@/services/ai/master-prompts/structured-context');
const { buildCaseSet } = await import('../cases');
const { runCoupleCases } = await import('../runner');
const { decideCoupleVerdict } = await import('../verdict');
const { canonicalJson } = await import('../signature');
type CoupleDescriptor = import('../couples').CoupleDescriptor;
type MasterCorpusCase = import('@/services/ai/governance/master-corpus/cases').MasterCorpusCase;

const CORPUS = loadMasterCorpusCases(readMasterFileFromRepo);

/** Schéma du contrat de la sortie enregistrée (T4 v2 / v3), sinon schéma de l'opération. */
function schemaDuCas(c: MasterCorpusCase): string {
  const spec = structuredSpecFor(c.masterPromptCode);
  return (c.outputContract && spec?.outputContracts[c.outputContract]?.byTask[c.task]?.schemaName) || c.outputSchema;
}

/** Opérations dont un couple PEUT être qualifié avec les cas du dépôt (au moins un cas de référence réel, aucun cas non vérifiable). */
const QUALIFIABLES = [
  't2_understand', 't2_answer', 't2_revalidate',
  't3_link_ambiguity', 't3_operation_match', 't3_document_naming', 't3_knowledge_query',
  't3_operation_identity',
  't4_classify_event', 't4_verify_completion', 't4_temporal_ambiguity', 't4_agenda_representation',
  't6_formulate', 't6_evaluate',
];
/** Restent non concluantes, motif à lever par un attendu (contenu métier du corpus, hors de ce lot). */
const NON_CONCLUANTES: Record<string, RegExp> = {
  // Seul cas réel (P-T1-01) sans attendu : contrôles serveur seuls.
  t1_group_upload: /attendu vérifiable/,
  // Seul cas réel non garde (P-T1-02) sans attendu ; les autres cas exigent une pièce jointe.
  t1_analyze_document: /attendu vérifiable/,
  // Seul cas (P-T3-01) : une garde (sortie fautive enregistrée) — aucun cas de référence.
  t3_value_conflict: /attendu vérifiable/,
};

describe('L97A-Q01 — chaque cas du corpus déclare son rôle', () => {
  it('aucun cas sans rôle ; réponses et gardes présentes', () => {
    expect(CORPUS.length).toBeGreaterThan(80);
    expect(CORPUS.filter((c) => c.qualificationRole !== 'answer' && c.qualificationRole !== 'guard').map((c) => c.file)).toEqual([]);
    const n = (r: string) => CORPUS.filter((c) => c.qualificationRole === r).length;
    expect(n('answer')).toBeGreaterThan(40);
    expect(n('guard')).toBeGreaterThan(20);
  });
  it('les gardes connues sont bien déclarées comme telles (sortie enregistrée délibérément fautive)', () => {
    const role = (id: string) => CORPUS.find((c) => c.id === id)?.qualificationRole;
    for (const id of ['P-T6-01b', 'P-T6-01c', 'P-T6-01e', 'P-T6-EV-02', 'P-T3-KQ-05', 'P-T3-09', 'P-T3-10', 'P-T3-11', 'P-T3-14', 'P-T4-03', 'T1-33D-02']) expect(role(id), id).toBe('guard');
    for (const id of ['P-T6-01', 'P-T6-EV-01', 'P-T3-08', 'P-T3-KQ-01', 'P-T4-04', 'P-T2-03']) expect(role(id), id).toBe('answer');
  });
});

describe('L97A-Q02 — une réponse de référence passe son attendu (contrôle serveur réel)', () => {
  const reponses = CORPUS.filter((c) => c.qualificationRole === 'answer' && c.expected && Object.keys(c.expected).length);
  it.each(reponses.map((c) => [`${c.id} (${c.file.split('/').pop()})`, c] as const))('%s', async (_n, c) => {
    const r = await evaluateCorpusOutput(c, c.output, readMasterFileFromRepo(c.masterPromptCode), readMasterFileFromRepo, schemaDuCas(c));
    expect(r.errors).toEqual([]);
  });
});

describe('L97A-Q03 — une garde est écartée de la qualification réelle', () => {
  it('P-T6-01b (fait ajouté, rejet attendu) n’est jamais un cas obligatoire', async () => {
    const set = await buildCaseSet('t6_formulate', { readMasterFile: readMasterFileFromRepo });
    expect(set.cases.map((c) => c.caseId)).toEqual(['corpus:P-T6-01']);
    expect(set.skipped.filter((s) => /garde/.test(s.reason)).map((s) => s.caseId).sort()).toEqual(['corpus:P-T6-01b', 'corpus:P-T6-01c', 'corpus:P-T6-01d', 'corpus:P-T6-01e']);
  });
});

describe('L97A-Q04 — campagne simulée : un couple qui répond juste est ADMISSIBLE', () => {
  const couple = (op: string, treatment: string): CoupleDescriptor => ({
    treatment, operationCode: op, rank: 0, slot: 'primaryModel', model: 'modele-teste', versionId: 1, revisionId: 1,
    profile: { reasoning: null, reasoningOrigin: null, maxOutputTokens: null, timeoutMs: 60_000, timeoutOrigin: null, params: {} },
    technicalRefusal: null, signature: 'sig',
    parts: { operationCode: op, rank: 0, model: 'modele-teste', profile: {}, promptFingerprint: null, contractFingerprint: null, corpusFingerprint: null, evaluatorFingerprint: null, capabilitiesSha256: null, thresholdsVersion: 'qualif-seuils-v1' },
  }) as unknown as CoupleDescriptor;

  async function campagne(op: string, mode: 'GOOD' | 'BAD') {
    const set = await buildCaseSet(op, { readMasterFile: readMasterFileFromRepo, includeT1Reference: false });
    const parCas = new Map(CORPUS.filter((c) => c.operationCode === op).map((c) => [`corpus:${c.id}`, c.output]));
    const reponses = set.cases.map((c) => ({ key: canonicalJson(c.variables), output: parCas.get(c.caseId) }));
    let n = 0;
    const call = (async (req: { promptVariables: Record<string, unknown> }) => {
      const k = canonicalJson(req.promptVariables);
      const i = reponses.findIndex((r) => r.key === k);
      // Couple « mauvais » : la sortie d'un AUTRE cas de la même opération (format valide, contenu faux).
      const j = mode === 'GOOD' || reponses.length < 2 ? i : (i + 1) % reponses.length;
      n += 1;
      return { data: reponses[j]?.output, provider: 'fake', model: 'modele-teste', promptVersion: 'p', usedFallback: false, inputTokens: 1, outputTokens: 1, costMicros: 10, durationMs: 100 + (n % 7), traceId: `t-${op}-${n}`, fromCache: false };
    }) as never;
    const run = await runCoupleCases({ couple: couple(op, set.cases[0]?.treatment ?? 'T3'), cases: set.cases, observations: 2, campaignId: 1, technicalAccountId: 7, masterText: readMasterFileFromRepo, call });
    return { set, run, verdict: decideCoupleVerdict({ observations: run.observations.filter((o) => !o.advisory), reference: { p95Ms: null, isSelf: true }, concurrency: run.concurrency }) };
  }

  it.each(QUALIFIABLES)('%s : cas obligatoires tous vérifiables, bonnes réponses → ADMISSIBLE', async (op) => {
    const { set, verdict } = await campagne(op, 'GOOD');
    expect(set.cases.length, `${op} : aucun cas réel`).toBeGreaterThan(0);
    expect(set.cases.filter((c) => c.expectedSource !== 'REFERENCE').map((c) => c.caseId)).toEqual([]);
    expect(verdict.reasons.filter((r) => r.outcome !== 'OK'), op).toEqual([]);
    expect(verdict.verdict).toBe('ADMISSIBLE');
  });

  it.each(QUALIFIABLES.filter((op) => !['t2_understand', 't2_revalidate', 't4_verify_completion', 't4_agenda_representation', 't3_operation_identity', 't6_formulate', 't6_evaluate'].includes(op)))(
    '%s : la réponse d’un autre cas → REFUSÉ (erreur métier confirmée)', async (op) => {
      const { set, verdict } = await campagne(op, 'BAD');
      expect(set.cases.length).toBeGreaterThan(1);
      expect(verdict.verdict).toBe('REFUSED');
      expect(verdict.reasons.find((r) => r.outcome === 'BLOCKING')?.step).toBe('QUALITY');
    },
  );

  it.each(Object.entries(NON_CONCLUANTES))('%s : reste NON CONCLUANT (jamais admissible sans attendu)', async (op, motif) => {
    const { verdict } = await campagne(op, 'GOOD');
    expect(verdict.verdict).toBe('INCONCLUSIVE');
    expect(verdict.reasons.filter((r) => r.outcome === 'INCONCLUSIVE').map((r) => r.message).join(' | ')).toMatch(motif);
  });
});
