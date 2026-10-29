/**
 * Lot 99B — mise en conformité automatique des prompts IA (parties PURES et
 * registre, sans base) :
 *
 *  L99B-U01  registre unique T1/T2/T3/T4/T6 alimenté par le code : marqueurs = constantes du code, opérations du
 *            registre IA, blocs officiels présents dans le guide, ordre conseillé du guide
 *  L99B-U02  cas 88B : T3 actif (étapes 1 et 7 faites) sans t3-knowledge-query-v2 → contrat ABSENT ; correction
 *            minimale (bloc officiel à son ancre, rien d'autre ne change), diff explicite, compatibilité effective
 *  L99B-U03  refus explicites : ancre introuvable / ambiguë, bloc déjà présent en partie, zone remplacée qui contiendrait
 *            une branche, T4 au texte trop divergent
 *  L99B-U04  vérification effective (pas seulement le marqueur) : exemple JSON refusé par le schéma réel, contrat perdu
 *  L99B-U05  chaque contrat corrigeable s'applique au texte livré (prérequis dans l'ordre du guide) et passe la vérification
 *  L99B-U06  non-régression : qualifiée / régression / non concluant / couverture / coût ; jamais le candidat comme vérité
 *  L99B-U07  garde d'environnement : jamais d'activation hors préproduction ; coupure
 *  L99B-U08  corpus de la nouvelle branche (v2) : cas de référence jugés par la décision serveur réelle
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { promptContracts } = await import('../contracts');
const { applyCorrection, applyBlock, verifyCandidate, lineDiff, jsonExamplesOf } = await import('../correct');
const { loadGuideBlocks, guideBlock } = await import('../guide-blocks');
const { conformityMode, contractAllowlist } = await import('../service');
const { assessNonRegression } = await import('@/services/ai/qualification/non-regression');
const { executionConfigFor, LEGACY_EXECUTION } = await import('@/services/ai/master-prompts/structured-context');
const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
const { knowledgeContractsIn } = await import('@/services/ai/reconciliation/knowledge-query/model');
const mp = await import('@/services/ai/reconciliation/missing-properties/contract');
const kq = await import('@/services/ai/reconciliation/knowledge-query/contract');
const t6s = await import('@/services/home/mascot/t6-suggestions');
const vd = await import('@/services/ai/source-analysis/value-decisions/contract');
const bp = await import('@/services/ai/source-analysis/billing-period/contract');
const idc = await import('@/services/business-operations/semantic/identity-contract');
const repc = await import('@/services/business-operations/semantic/contract');

const FICHIERS: Record<string, string> = {
  T1: 'source-analysis/t1_master_v1.txt', T2: 'assistant/t2_master_v1.txt', T3: 'reconciliation/t3_master_v1.txt', T4: 'agenda/t4_master_v1.txt', T6: 'mascot/t6_master_v1.txt',
};
const LIVRE = Object.fromEntries(Object.entries(FICHIERS).map(([t, f]) => [t, readFileSync(join(process.cwd(), 'src/services/ai/prompts', f), 'utf8')])) as Record<string, string>;
const contrats = await promptContracts();
const contrat = (id: string) => contrats.find((c) => c.id === id)!;
const execFichier = (t: string) => executionConfigFor({ masterPromptCode: contrat(`${t.toLowerCase()}-socle`).masterPromptCode, source: 'file' });
const autres = (id: string) => contrats.filter((c) => c.id !== id && c.treatment === contrat(id).treatment).flatMap((c) => c.markers);

/** Applique un contrat comme le système (plan → correction), lève si refusé. */
async function corriger(id: string, text: string, execution = execFichier(contrat(id).treatment)) {
  const c = contrat(id);
  const plan = await c.plan({ text, execution, referenceText: LIVRE[c.treatment] });
  if (!plan.ok) throw new Error(`${id} : ${plan.message}`);
  const r = applyCorrection({ text, execution, steps: plan.steps, protectedMarkers: autres(id) });
  if (!r.ok) throw new Error(`${id} : ${r.message}`);
  return { ...r, blocks: plan.steps.flatMap((s) => (s.kind === 'block' ? [s.block] : [])) };
}

/** T3 « préproduction » : étapes 1 (85F) et 7 (98A) faites, étape 2 (88B) absente. */
const T3_SANS_V2 = (await corriger(kq.KNOWLEDGE_QUERY_CONTRACT_VERSION, LIVRE.T3)).text;
const T3_ACTIF = (await corriger('kq-constituants-complets-v1', T3_SANS_V2)).text;

describe('L99B-U01 — registre unique alimenté par le code', () => {
  it('T1, T2, T3, T4, T6 couverts ; un socle par prompt', () => {
    expect([...new Set(contrats.map((c) => c.treatment))].sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    for (const t of ['t1', 't2', 't3', 't4', 't6']) expect(contrat(`${t}-socle`)?.rank).toBe(0);
  });
  it('marqueurs et identifiants = constantes du code (aucune copie divergente)', () => {
    expect(contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION).markers).toEqual([mp.MISSING_PROPERTIES_CONTRACT_VERSION]);
    expect(contrat(kq.KNOWLEDGE_QUERY_CONTRACT_VERSION).markers).toContain(kq.KNOWLEDGE_QUERY_CONTRACT_VERSION);
    expect(contrat(t6s.T6_SUGGESTION_CONTRACT).markers).toEqual(['{{SUGGESTION_CONTEXT}}', t6s.T6_SUGGESTION_CONTRACT, '"groundRefs"']);
    expect(contrat(vd.T1_VALUE_DECISIONS_CONTRACT)).toBeTruthy();
    expect(contrat(bp.T1_BILLING_PERIOD_CONTRACT).requires).toEqual([vd.T1_VALUE_DECISIONS_CONTRACT]);
    expect(contrat(idc.IDENTITY_CONTRACT_VERSION).task).toBe(idc.IDENTITY_TASK);
    expect(contrat(repc.REPRESENTATION_CONTRACT_VERSION).expectedExecution).toMatch(/t4_input_v3 \/ t4_output_v4/);
    expect(contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION).anomaly).toEqual({ checkIds: [mp.MISSING_PROPERTIES_CHECK_ID, mp.MISSING_PROPERTIES_EQUIPMENT_CHECK_ID], anomaly: 'MISSING_PROPERTY_ARBITRATION_PENDING' });
  });
  it('opérations, tâche et schémas de sortie pris dans le registre IA', () => {
    for (const c of contrats) {
      for (const op of c.operations) {
        expect(AI_OPERATIONS[op]?.active, `${c.id} : ${op}`).toBe(true);
        expect(AI_OPERATIONS[op].masterPromptCode).toBe(c.masterPromptCode);
        if (c.task && c.rank > 0) expect(AI_OPERATIONS[op].task).toBe(c.task);
      }
    }
    expect(contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION).operations).toEqual([kq.KNOWLEDGE_QUERY_OPERATION]);
    expect(contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION).outputs).toEqual([AI_OPERATIONS[kq.KNOWLEDGE_QUERY_OPERATION].outputSchema]);
  });
  it('chaque bloc cité existe dans le guide du PO (blocs testés par l89c / l91d / l97a / l98a)', () => {
    expect(loadGuideBlocks().path).not.toBeNull();
    for (const c of contrats) for (const b of c.blockIds) expect(guideBlock(b), `${c.id} → ${b}`).not.toBeNull();
  });
  it('ordre conseillé du guide : 1, 7, 8, 2, 3, 4, 5, 6 ; prérequis avant leurs dépendants', () => {
    const corrigeables = contrats.filter((c) => c.rank > 0);
    // Contrats livrés jusqu'au lot 99B ; les contrats déclarés en une ligne (MARKER_CONTRACT_DECLARATIONS) viennent après.
    expect(corrigeables.map((c) => c.guideStep).slice(0, 9)).toEqual([1, 7, 8, 2, 3, 4, 4, 5, 6]);
    for (const c of corrigeables) for (const r of c.requires) expect(contrat(r).rank, `${c.id} exige ${r}`).toBeLessThan(c.rank);
  });
});

describe('L99B-U02 — cas 88B : T3 actif sans t3-knowledge-query-v2', () => {
  it('détection : contrat ABSENT, branche KNOWLEDGE_QUERY présente (prérequis satisfait)', async () => {
    expect(knowledgeContractsIn(T3_ACTIF)).toEqual([kq.KNOWLEDGE_QUERY_CONTRACT_VERSION]);
    const chk = await contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION).check({ text: T3_ACTIF, execution: LEGACY_EXECUTION, referenceText: LIVRE.T3 });
    expect(chk.state).toBe('ABSENT');
    expect(chk.cause).toMatch(/88B-t3-proprietes-manquantes/);
    expect((await contrat(kq.KNOWLEDGE_QUERY_CONTRACT_VERSION).check({ text: T3_ACTIF, execution: LEGACY_EXECUTION, referenceText: LIVRE.T3 })).state).toBe('SATISFIED');
  });
  it('correction minimale : bloc officiel inséré avant son ancre, le reste du texte inchangé octet pour octet', async () => {
    const r = await corriger(mp.MISSING_PROPERTIES_CONTRACT_VERSION, T3_ACTIF, LEGACY_EXECUTION);
    const bloc = guideBlock('t3-knowledge-query-v2')!;
    expect(r.diff.removed).toBe(0);
    expect(r.diff.added).toBe(bloc.text.split('\n').length + 1);
    expect(r.text.replace(`${bloc.text}\n\n`, '')).toBe(T3_ACTIF);
    expect(r.text.indexOf(bloc.text)).toBeLessThan(r.text.indexOf('Réponds uniquement par le JSON correspondant au TASK demandé.'));
    expect(r.diff.unified).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(r.diff.unified).toContain('+PROPRIÉTÉS MANQUANTES D’UN OBJET (contrat d’entrée t3-knowledge-query-v2)');
    expect(knowledgeContractsIn(r.text)).toEqual([kq.KNOWLEDGE_QUERY_CONTRACT_VERSION, mp.MISSING_PROPERTIES_CONTRACT_VERSION]);
    expect(r.execution).toEqual(LEGACY_EXECUTION);
  });
  it('compatibilité effective : contrôles du BO, emplacements, branches, autres contrats, exemple JSON validé', async () => {
    const r = await corriger(mp.MISSING_PROPERTIES_CONTRACT_VERSION, T3_ACTIF, LEGACY_EXECUTION);
    const c = contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION);
    expect(await verifyCandidate({ treatment: 'T3', contract: c, contracts: contrats, before: { text: T3_ACTIF, execution: LEGACY_EXECUTION }, after: { text: r.text, execution: r.execution }, referenceText: LIVRE.T3, insertedBlocks: r.blocks })).toEqual([]);
    expect(jsonExamplesOf(r.blocks[0].text)).toHaveLength(1);
  });
});

describe('L99B-U03 — refus explicites (aucune correction automatique)', () => {
  const v2 = guideBlock('t3-knowledge-query-v2')!;
  it('ancre introuvable ou ambiguë', () => {
    const sansAncre = T3_ACTIF.replace('Réponds uniquement par le JSON correspondant au TASK demandé.', 'Réponds par le JSON.');
    expect(applyBlock(sansAncre, v2, [])).toMatchObject({ ok: false, code: 'ANCHOR_NOT_FOUND' });
    const double = `${T3_ACTIF}\nRéponds uniquement par le JSON correspondant au TASK demandé.\n`;
    expect(applyBlock(double, v2, [])).toMatchObject({ ok: false, code: 'ANCHOR_AMBIGUOUS' });
  });
  it('bloc déjà présent en partie (texte propre au PO) : jamais dupliqué', () => {
    const partiel = T3_ACTIF.replace('Réponds uniquement par le JSON correspondant au TASK demandé.', 'PROPRIÉTÉS MANQUANTES D’UN OBJET (contrat d’entrée t3-knowledge-query-v2)\n\nRéponds uniquement par le JSON correspondant au TASK demandé.');
    expect(applyBlock(partiel, v2, [])).toMatchObject({ ok: false, code: 'ALREADY_PARTIALLY_PRESENT' });
  });
  it('remplacement T6 refusé si la zone contient une autre branche (texte trop divergent)', () => {
    const t6 = guideBlock('t6-suggestions-v3')!;
    const i = LIVRE.T6.indexOf('R12 — Questions suggérées.');
    const divergent = `${LIVRE.T6.slice(0, i)}${LIVRE.T6.slice(i).replace('SORTIE FORMULATE', 'BRANCHE MODE = EVALUATE\n\nSORTIE FORMULATE')}`;
    expect(applyBlock(divergent, t6, [])).toMatchObject({ ok: false, code: 'TEXT_TOO_DIVERGENT' });
  });
  it('T4 en mode historique dont le texte ne décrit pas l’intervention : reprise du texte livré exigée', async () => {
    const plan = await contrat('t4_output_v3').plan({ text: 'Texte T4 propre au PO.\n{{TASK}}', execution: LEGACY_EXECUTION, referenceText: LIVRE.T4 });
    expect(plan).toMatchObject({ ok: false, code: 'TEXT_TOO_DIVERGENT' });
  });
  it('T4 en mode historique dont le texte porte l’intervention : même texte, configuration conforme seulement', async () => {
    const r = await corriger('t4_output_v3', LIVRE.T4, LEGACY_EXECUTION);
    expect(r.text).toBe(LIVRE.T4.replace(/\r\n?/g, '\n'));
    expect(r.diff.added + r.diff.removed).toBe(0);
    expect(r.execution).toMatchObject({ mode: 'STRUCTURED_CONTEXT', outputContractVersion: 't4_output_v3' });
  });
});

describe('L99B-U04 — vérification effective, pas seulement le marqueur', () => {
  it('exemple JSON du bloc refusé par le schéma de sortie réel → EXAMPLE_REJECTED', async () => {
    const c = contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION);
    const faux = { ...guideBlock('t3-knowledge-query-v2')!, text: `${guideBlock('t3-knowledge-query-v2')!.text}\n\n{"task": "KNOWLEDGE_QUERY", "outcome": "FOUND", "findings": [], "reason": "x"}` };
    const after = T3_ACTIF.replace('Réponds uniquement par le JSON correspondant au TASK demandé.', `${faux.text}\n\nRéponds uniquement par le JSON correspondant au TASK demandé.`);
    const issues = await verifyCandidate({ treatment: 'T3', contract: c, contracts: contrats, before: { text: T3_ACTIF, execution: LEGACY_EXECUTION }, after: { text: after, execution: LEGACY_EXECUTION }, referenceText: LIVRE.T3, insertedBlocks: [faux] });
    expect(issues.map((i) => i.code)).toContain('EXAMPLE_REJECTED');
  });
  it('un texte qui ferait perdre un autre contrat ou un emplacement est refusé', async () => {
    const c = contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION);
    const r = await corriger(mp.MISSING_PROPERTIES_CONTRACT_VERSION, T3_ACTIF, LEGACY_EXECUTION);
    const abime = r.text.replace('kq-constituants-complets-v1', 'kq-constituants').replace('{{EVIDENCES}}', '');
    const codes = (await verifyCandidate({ treatment: 'T3', contract: c, contracts: contrats, before: { text: T3_ACTIF, execution: LEGACY_EXECUTION }, after: { text: abime, execution: LEGACY_EXECUTION }, referenceText: LIVRE.T3, insertedBlocks: r.blocks })).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['OTHER_CONTRACT_LOST', 'PLACEHOLDERS_CHANGED']));
  });
});

describe('L99B-U05 — chaque contrat corrigeable passe par la voie automatique', () => {
  it('textes livrés, prérequis dans l’ordre du guide : correction + vérification sans défaut', async () => {
    const etat: Record<string, { text: string; execution: ReturnType<typeof execFichier> }> = Object.fromEntries(Object.keys(LIVRE).map((t) => [t, { text: LIVRE[t], execution: t === 'T4' ? LEGACY_EXECUTION : execFichier(t) }]));
    const faits: string[] = [];
    for (const c of contrats.filter((x) => x.rank > 0)) {
      const e = etat[c.treatment];
      const avant = await c.check({ ...e, referenceText: LIVRE[c.treatment] });
      if (avant.state === 'SATISFIED') { faits.push(`${c.id}:déjà`); continue; }
      const r = await corriger(c.id, e.text, e.execution);
      const issues = await verifyCandidate({ treatment: c.treatment, contract: c, contracts: contrats, before: e, after: { text: r.text, execution: r.execution }, referenceText: LIVRE[c.treatment], insertedBlocks: r.blocks });
      expect(issues, c.id).toEqual([]);
      etat[c.treatment] = { text: r.text, execution: r.execution };
      faits.push(c.id);
    }
    // Le bloc T1 unique porte les deux contrats : la période facturée est déjà satisfaite après lui.
    expect(faits.slice(0, 9)).toEqual([kq.KNOWLEDGE_QUERY_CONTRACT_VERSION, 'kq-constituants-complets-v1', 't4_output_v3', mp.MISSING_PROPERTIES_CONTRACT_VERSION,
      t6s.T6_SUGGESTION_CONTRACT, vd.T1_VALUE_DECISIONS_CONTRACT, `${bp.T1_BILLING_PERIOD_CONTRACT}:déjà`, idc.IDENTITY_CONTRACT_VERSION, repc.REPRESENTATION_CONTRACT_VERSION]);
    for (const c of contrats) expect((await c.check({ ...etat[c.treatment], referenceText: LIVRE[c.treatment] })).state, c.id).toBe('SATISFIED');
  });
  it('T1 au bloc 91D seul (version précédente du guide) : seule la partie « période facturée » est ajoutée', async () => {
    const b = guideBlock(vd.T1_VALUE_DECISIONS_CONTRACT)!;
    const ancien = b.text.slice(0, b.text.indexOf('PÉRIODE FACTURÉE ET MOIS PRINCIPAL')).trimEnd();
    const t1 = LIVRE.T1.replace('Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.', `${ancien}\n\nRéponds uniquement par le JSON de la branche TASK demandée, sans texte autour.`);
    expect((await contrat(bp.T1_BILLING_PERIOD_CONTRACT).check({ text: t1, execution: LEGACY_EXECUTION, referenceText: LIVRE.T1 })).state).toBe('OBSOLETE');
    const r = await corriger(bp.T1_BILLING_PERIOD_CONTRACT, t1, LEGACY_EXECUTION);
    expect(r.diff.removed).toBe(0);
    expect(bp.promptCarriesBillingPeriod(r.text) && vd.promptCarriesValueDecisions(r.text)).toBe(true);
  });
});

describe('L99B-U06 — non-régression (jamais la sortie du candidat comme vérité)', () => {
  const obs = (caseId: string, outcome: 'PASSED' | 'FAILED' | 'INCONCLUSIVE', o: Partial<Record<string, unknown>> = {}) => ({
    caseId, source: 'CORPUS_FIXTURE', expectedSource: 'REFERENCE', mandatory: true, advisory: false, observation: 1, outcome,
    defects: outcome === 'FAILED' ? [{ category: 'INCORRECT_VALUE', message: 'valeur ≠ attendu' }] : [], inconclusiveReason: outcome === 'INCONCLUSIVE' ? 'résultat non vérifiable' : null,
    durationMs: 100, timeoutMs: 60_000, costMicros: 10, servedModel: 'm', traceId: `${caseId}-${Math.random()}`, ...o,
  }) as never;
  const run = (op: string, ref: never[], cand: never[], cv: 'ADMISSIBLE' | 'REFUSED' | 'INCONCLUSIVE' = 'ADMISSIBLE') => ({
    operationCode: op, reference: { verdict: 'ADMISSIBLE' as const, reasons: [], observations: ref, evidenceId: 1 }, candidate: { verdict: cv, reasons: [], observations: cand, evidenceId: 2 },
  });
  it('toutes les branches réussies, couverture de la nouvelle branche → QUALIFIED', () => {
    const a = assessNonRegression({ runs: [run('t3_a', [obs('c1', 'PASSED')], [obs('c1', 'PASSED')]), run('t3_kq', [obs('kq8', 'FAILED')], [obs('kq8', 'PASSED')])], coverage: { label: 'cas v2', caseIds: ['kq8'] } });
    expect(a.decision).toBe('QUALIFIED');
    expect(a.operations[1].improvements.map((x) => x.caseId)).toEqual(['kq8']);
  });
  it('régression injectée (réussi avant, en échec avec le candidat) → REFUSED, motif précis', () => {
    const a = assessNonRegression({ runs: [run('t3_link_ambiguity', [obs('c1', 'PASSED')], [obs('c1', 'FAILED')], 'REFUSED')], coverage: null });
    expect(a.decision).toBe('REFUSED');
    expect(a.operations[0].regressions.map((x) => x.caseId)).toEqual(['c1']);
    expect(a.refusalReasons.join(' ')).toMatch(/c1/);
  });
  it('cas non concluant (aucun attendu vérifiable, ex. T3 VALUE_CONFLICT) → INCONCLUSIVE, jamais transformé en réussite', () => {
    const a = assessNonRegression({ runs: [run('t3_a', [obs('c1', 'PASSED')], [obs('c1', 'PASSED')]), run('t3_value_conflict', [], [], 'INCONCLUSIVE')], coverage: null });
    expect(a.decision).toBe('INCONCLUSIVE');
    expect(a.blockingReasons.join(' ')).toMatch(/t3_value_conflict/);
  });
  it('couverture insuffisante de la nouvelle branche → INCONCLUSIVE', () => {
    const a = assessNonRegression({ runs: [run('t3_a', [obs('c1', 'PASSED')], [obs('c1', 'PASSED')])], coverage: { label: 'cas de référence au contrat v2', caseIds: [] } });
    expect(a.decision).toBe('INCONCLUSIVE');
    expect(a.blockingReasons.join(' ')).toMatch(/couverture de la nouvelle branche insuffisante/);
  });
  it('coût par résultat valide au-delà du seuil → REFUSED', () => {
    const a = assessNonRegression({ runs: [run('t3_a', [obs('c1', 'PASSED')], [obs('c1', 'PASSED', { costMicros: 20 })])], coverage: null });
    expect(a.decision).toBe('REFUSED');
  });
  it('non concluant chez le candidat sur un cas réussi avant → bloquant', () => {
    const a = assessNonRegression({ runs: [run('t3_a', [obs('c1', 'PASSED')], [obs('c1', 'INCONCLUSIVE')], 'INCONCLUSIVE')], coverage: null });
    expect(a.decision).toBe('INCONCLUSIVE');
  });
});

describe('L99B-U07 — garde d’environnement et coupure', () => {
  it('préproduction : automatique par défaut ; production : jamais d’activation, même avec auto', () => {
    expect(conformityMode('preprod', {})).toMatchObject({ mode: 'auto', activationAllowed: true });
    expect(conformityMode('production', {})).toMatchObject({ mode: 'candidate', activationAllowed: false });
    expect(conformityMode('production', { AI_PROMPT_CONFORMITY: 'auto' })).toMatchObject({ mode: 'candidate', activationAllowed: false });
    expect(conformityMode('local', {})).toMatchObject({ mode: 'detect', activationAllowed: false });
    expect(conformityMode('local', { AI_PROMPT_CONFORMITY: 'auto' })).toMatchObject({ activationAllowed: false });
  });
  it('coupure : off, detect, candidate ; liste blanche de contrats', () => {
    expect(conformityMode('preprod', { AI_PROMPT_CONFORMITY: 'off' }).mode).toBe('off');
    expect(conformityMode('preprod', { AI_PROMPT_CONFORMITY: 'detect' })).toMatchObject({ mode: 'detect', activationAllowed: false });
    expect(conformityMode('preprod', { AI_PROMPT_CONFORMITY: 'candidate' })).toMatchObject({ mode: 'candidate', activationAllowed: false });
    expect(contractAllowlist({ AI_PROMPT_CONFORMITY_CONTRACTS: 't3-knowledge-query-v2, t6-suggestions-v3' })).toEqual(new Set(['t3-knowledge-query-v2', 't6-suggestions-v3']));
    expect(contractAllowlist({})).toBeNull();
  });
});

describe('L99B-U08 — corpus : cas de référence de la nouvelle branche (contrat v2)', () => {
  it('P-T3-KQ-08 (valeur établie) et P-T3-KQ-09 (abstention) passent la décision serveur ; une valeur inventée échoue', async () => {
    const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { evaluateCorpusOutput } = await import('@/services/ai/governance/master-corpus/runner');
    const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
    const cas = loadMasterCorpusCases(readMasterFileFromRepo).filter((c) => c.id === 'P-T3-KQ-08' || c.id === 'P-T3-KQ-09');
    expect(cas.map((c) => [c.id, c.qualificationRole])).toEqual([['P-T3-KQ-08', 'answer'], ['P-T3-KQ-09', 'answer']]);
    for (const c of cas) {
      const r = await evaluateCorpusOutput(c, c.output, LIVRE.T3, readMasterFileFromRepo);
      expect(r.errors, c.id).toEqual([]);
      // Le constructeur de production produit bien le contrat d'entrée v2 (prédicat de couverture du registre).
      const v = (await liveVariablesFor(c))!;
      expect(contrat(mp.MISSING_PROPERTIES_CONTRACT_VERSION).coverage!.matches({ variables: v, operationCode: c.operationCode })).toBe(true);
    }
    const kq09 = cas.find((c) => c.id === 'P-T3-KQ-09')!;
    const invente = { task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'x', findings: [{ target: 'acquisitionPrice', rawValue: '312,00 €', value: 312, evidenceRefs: ['U-1'], excerpt: 'Cotisation annuelle : 312,00 €', confidence: 'certain', meaning: 'prix' }] };
    const r = await evaluateCorpusOutput(kq09, invente, LIVRE.T3, readMasterFileFromRepo);
    expect(r.errors.join(' ')).toMatch(/acquisitionPrice/);
  });
});

describe('L99B-U10 — extension : un contrat à marqueur se déclare en une entrée', () => {
  it('déclaration générique → contrat détecté, corrigé par son bloc officiel, vérifié', async () => {
    const { MARKER_CONTRACT_DECLARATIONS, __resetPromptContractsForTests, promptContracts: lire } = await import('../contracts');
    const decl = MARKER_CONTRACT_DECLARATIONS as unknown as Array<import('../contracts').MarkerContractDeclaration>;
    // Simulation d'une étape future : on réutilise un bloc officiel existant (T3 identité) sous un autre identifiant.
    decl.push({ id: 'e2e-marqueur-v1', treatment: 'T3', rank: 50, guideStep: 99, lot: 'test', task: 'OPERATION_IDENTITY', blockId: idc.IDENTITY_CONTRACT_VERSION,
      killSwitch: null, label: 'test', impact: 'test', detect: (t) => t.includes(idc.IDENTITY_CONTRACT_VERSION) });
    try {
      __resetPromptContractsForTests();
      const tous = await lire();
      const c = tous.find((x) => x.id === 'e2e-marqueur-v1')!;
      expect(c).toMatchObject({ treatment: 'T3', operations: [idc.IDENTITY_OPERATION], requires: ['t3-socle'], blockIds: [idc.IDENTITY_CONTRACT_VERSION] });
      expect((await c.check({ text: LIVRE.T3, execution: LEGACY_EXECUTION, referenceText: LIVRE.T3 })).state).toBe('ABSENT');
      const plan = await c.plan({ text: LIVRE.T3, execution: LEGACY_EXECUTION, referenceText: LIVRE.T3 });
      expect(plan.ok).toBe(true);
    } finally {
      decl.pop();
      __resetPromptContractsForTests();
    }
  });
});

describe('L99B-U09 — diff ligne à ligne', () => {
  it('insertion, remplacement, contexte', () => {
    const d = lineDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nX\nY\nd\ne\nf\ng\nZ');
    expect(d.added).toBe(3);
    expect(d.removed).toBe(1);
    expect(d.unified).toContain('+X');
    expect(d.unified).toContain('-h');
  });
});
