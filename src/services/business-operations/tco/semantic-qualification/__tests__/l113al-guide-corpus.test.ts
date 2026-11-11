/**
 * Lot 113AL (Trello #737) — registre IA, branche facultative, bloc 31 du guide du PO, conformité des prompts et
 * corpus maître de l'arbitrage sémantique T3 des montants non qualifiés (contrat `t3-economic-qualification-v1`).
 *
 *   L113AL-U-REGISTRE  opération master T3 (six emplacements), non facturée ; schéma et contrat runtime ; diagnostic ;
 *                      branche FACULTATIVE dont le texte est attendu du PO ; aucun texte de prompt dans le code ;
 *   L113AL-U-GUIDE     bloc 31 balisé, applicable au T3 livré, rendu réel ; exemples validés ; capacité ; conformité
 *                      BO « absent » puis « satisfait » ;
 *   L113AL-U-CORPUS    six cas rejoués sur le texte T3 + bloc 31 par le contrôle serveur réel ; manifeste à jour.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const eqc = await import('../contract');
const dec = await import('../decider');
const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
const { evaluateCorpusOutput } = await import('@/services/ai/governance/master-corpus/runner');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const GUIDE = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
const LIVRE_T3 = lire('src/services/ai/prompts/reconciliation/t3_master_v1.txt');
const REPERE = 'Réponds uniquement par le JSON correspondant au TASK demandé.';
const FX = (n: string) => JSON.parse(lire(`src/services/ai/reconciliation/master/__fixtures__/${n}`)) as {
  context: { economicQualification: import('../contract').RawQualificationContext }; recording: { output: Record<string, unknown> };
};
const AVIS = FX('p-t3-eq-01-avis-charge-sans-indice.json');
const REGLEMENT = FX('p-t3-eq-02-reglement-d-une-charge.json');

describe('L113AL-U-REGISTRE — opération, schéma, branche facultative, diagnostic', () => {
  it('opération master active du prompt T3 existant (six emplacements), non facturée ; schéma et contrat runtime', async () => {
    const { AI_OPERATIONS, listMasterTasks, T3_MASTER_VARIABLES } = await import('@/services/ai/registry/operations');
    const { masterOutputSchemaFor } = await import('@/services/ai/gateway/master-output-schemas');
    const { contractVersionsOf } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    const { DIAG_AI_OPERATION_COVERAGE, DIAG_TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    const { RECETTE_TABLES } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { ASSET_SCOPED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
    expect(AI_OPERATIONS.t3_economic_qualification).toMatchObject({
      masterPromptCode: 't3_master_v1', task: 'ECONOMIC_QUALIFICATION', outputSchema: 'T3EconomicQualificationOutput', active: true, billable: false,
      useCaseCode: 'DATA_RECONCILIATION', promptVariables: T3_MASTER_VARIABLES,
    });
    expect(listMasterTasks('t3_master_v1')).toContain('ECONOMIC_QUALIFICATION');
    expect(masterOutputSchemaFor('T3EconomicQualificationOutput')).toBe(eqc.T3EconomicQualificationOutput);
    expect(contractVersionsOf('T3EconomicQualificationOutput')).toContain(1);
    expect(DIAG_AI_OPERATION_COVERAGE.t3_economic_qualification.tables).toContain('economic_qualification_reviews');
    expect(DIAG_TABLE_COVERAGE.economic_qualification_reviews).toBeTruthy();
    expect(RECETTE_TABLES.economic_qualification_reviews.domain).toBe('tco');
    expect(ASSET_SCOPED_TABLES).toContain('economic_qualification_reviews');
    expect(Object.keys(eqc.qualificationVariables(eqc.buildQualificationInput(AVIS.context.economicQualification).input)).sort()).toEqual([...T3_MASTER_VARIABLES].sort());
  });
  it('branche FACULTATIVE (version BO antérieure valide), texte attendu du PO ; aucun prompt du dépôt ne la porte', async () => {
    const loader = await import('@/services/ai/prompts/prompt-loader');
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    expect(loader.isOptionalMasterTask('t3_master_v1', 'ECONOMIC_QUALIFICATION')).toBe(true);
    expect(loader.isMasterTaskTextPending('t3_master_v1', 'ECONOMIC_QUALIFICATION')).toBe(true);
    expect(LIVRE_T3).not.toContain(eqc.ECONOMIC_QUALIFICATION_CONTRACT_VERSION);
    expect(checkMasterPromptContent('T3', LIVRE_T3).blocking).toEqual([]);
  });
  it('aucun texte de prompt dans le code : les modules ne contiennent que le contrat (marqueur, schéma, validation)', () => {
    for (const f of ['contract.ts', 'decider.ts', 'review.ts', 'context.ts', 'targets.ts', 'corpus.ts']) {
      const t = lire(`src/services/business-operations/tco/semantic-qualification/${f}`);
      expect(t, f).not.toMatch(/BRANCHE TASK = ECONOMIC_QUALIFICATION\n/);
      expect(t, f).not.toMatch(/E1 — MONDE FERMÉ/);
    }
  });
});

describe('L113AL-U-GUIDE — bloc 31, capacité, conformité BO', () => {
  const bloc = async () => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    return parseGuideBlocks(GUIDE).find((x) => x.id === eqc.ECONOMIC_QUALIFICATION_CONTRACT_VERSION)!;
  };
  const applique = async () => LIVRE_T3.replace(REPERE, `${(await bloc()).text}\n\n${REPERE}`);

  it('bloc officiel balisé (T3, insertion avant la ligne repère unique), branche + marqueur, aucun emplacement', async () => {
    const b = await bloc();
    expect(b).toMatchObject({ prompt: 't3', action: 'insert-before', anchor: REPERE });
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(b.text).branches).toContain('ECONOMIC_QUALIFICATION');
    expect(b.text).toContain(eqc.ECONOMIC_QUALIFICATION_CONTRACT_VERSION);
    for (const o of eqc.QUALIFICATION_OUTCOMES) expect(b.text).toContain(`"${o}"`);
    for (const x of eqc.QUALIFICATION_EXCLUSIONS) expect(b.text).toContain(`"${x}"`);
    expect(b.text).not.toMatch(/opération/i);
    expect(GUIDE).toContain('| 31 | 113AL (#737)');
  });
  it('T3 après collage : aucun bloquant, l’avertissement disparaît, rendu réel avec les variables de production', async () => {
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    const { renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
    const { listMasterTasks } = await import('@/services/ai/registry/operations');
    const t = await applique();
    expect(checkMasterPromptContent('T3', t).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', t).warnings.map((w) => w.message).join('\n')).not.toMatch(/ECONOMIC_QUALIFICATION/);
    const variables = eqc.qualificationVariables(eqc.buildQualificationInput(AVIS.context.economicQualification).input);
    const rendu = renderMasterPrompt(t, { masterPromptCode: 't3_master_v1', task: 'ECONOMIC_QUALIFICATION', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('BRANCHE TASK = ECONOMIC_QUALIFICATION');
    expect(rendu).toContain('Montant à payer : 1 340,00 €');
  });
  it('les deux exemples du bloc sont acceptés par le validateur réel (cas P-T3-EQ-01 et P-T3-EQ-02)', async () => {
    const lignes = (await bloc()).text.split('\n').filter((l) => l.startsWith('{"task": "ECONOMIC_QUALIFICATION"'));
    expect(lignes).toHaveLength(2);
    const [ex1, ex2] = lignes.map((l) => JSON.parse(l));
    const v1 = eqc.validateQualification(ex1, eqc.buildQualificationInput(AVIS.context.economicQualification).scope);
    const v2 = eqc.validateQualification(ex2, eqc.buildQualificationInput(REGLEMENT.context.economicQualification).scope);
    expect(v1).toMatchObject({ ok: true, effects: [{ outcome: 'INCLUDE', applied: true }] });
    expect(v2).toMatchObject({ ok: true, effects: [{ outcome: 'REPRESENTED', role: 'PAYMENT', applied: true }] });
    expect(eqc.T3EconomicQualificationOutput.parse(ex1)).toEqual(eqc.T3EconomicQualificationOutput.parse(AVIS.recording.output));
  });
  it('capacité sur le texte réel : absente sur le T3 livré, présente après collage', async () => {
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    const t = await applique();
    expect(dec.qualificationCapabilityOf({ text: LIVRE_T3, version: 'v', branches: inspectMasterTemplate(LIVRE_T3).branches })).toMatchObject({ available: false, contractState: 'BRANCH_MISSING' });
    expect(dec.qualificationCapabilityOf({ text: t, version: 'v31', branches: inspectMasterTemplate(t).branches })).toEqual({ available: true, version: 'v31', reason: 'AVAILABLE' });
    const faux = { capability: async () => ({ available: true, version: 'x', reason: 'AVAILABLE' as const }), decide: async () => ({ output: null, traceId: null }) };
    dec.__setQualificationDeciderForTests(faux);
    expect(dec.qualificationDecider()).toBe(faux);
    dec.__setQualificationDeciderForTests(null);
    expect(dec.qualificationDecider()).toBe(dec.productionQualificationDecider);
  });
  it('conformité BO : contrat déclaré — « absent » sur le T3 livré (configuration incomplète), satisfait après collage', async () => {
    const { promptContracts } = await import('@/services/ai/prompt-conformity/contracts');
    const c = (await promptContracts()).find((x) => x.id === eqc.ECONOMIC_QUALIFICATION_CONTRACT_VERSION)!;
    expect(c).toMatchObject({ treatment: 'T3', guideStep: 31, lot: '113AL', task: 'ECONOMIC_QUALIFICATION', operations: ['t3_economic_qualification'], killSwitch: 'T3_ECONOMIC_QUALIFICATION_ENABLED' });
    const execution = { mode: 'LEGACY_SLOTS' } as never;
    expect((await c.check({ text: LIVRE_T3, execution, referenceText: LIVRE_T3 })).state).toBe('ABSENT');
    expect((await c.check({ text: await applique(), execution, referenceText: LIVRE_T3 })).state).toBe('SATISFIED');
    expect((await c.plan({ text: LIVRE_T3, execution, referenceText: LIVRE_T3 })).ok).toBe(true);
    expect(c.impact).toMatch(/Configuration incomplète/);
  });
});

describe('L113AL-U-CORPUS — cas du corpus rejoués par le contrôle serveur réel', () => {
  const cas = loadMasterCorpusCases(readMasterFileFromRepo).filter((c) => c.operationCode === 't3_economic_qualification');
  it('six cas (quatre réponses de référence, deux gardes), tous au manifeste', () => {
    expect(cas.map((c) => c.id)).toEqual(['P-T3-EQ-01', 'P-T3-EQ-02', 'P-T3-EQ-03', 'P-T3-EQ-04', 'P-T3-EQ-05', 'P-T3-EQ-06']);
    expect(cas.filter((c) => c.qualificationRole === 'answer')).toHaveLength(4);
    const manifeste = lire('src/services/ai/governance/master-corpus/certification/corpus-manifest.json');
    for (const c of cas) expect(manifeste).toContain(c.file.replace(/\\/g, '/'));
  });
  it.each(cas.map((c) => [c.id, c] as const))('%s : attendu respecté sur le texte T3 + bloc 31', async (_id, c) => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    const b = parseGuideBlocks(GUIDE).find((x) => x.id === eqc.ECONOMIC_QUALIFICATION_CONTRACT_VERSION)!;
    const r = await evaluateCorpusOutput(c, c.output, LIVRE_T3.replace(REPERE, `${b.text}\n\n${REPERE}`), readMasterFileFromRepo, c.outputSchema);
    expect(r.errors).toEqual([]);
  });
});
