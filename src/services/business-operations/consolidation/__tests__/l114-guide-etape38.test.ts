/**
 * Lot 114 (Trello #750, issue B) — registre IA, branche facultative, bloc 38 du guide du PO, conformité des prompts et
 * corpus maître de l'arbitrage T3 d'une contradiction réelle d'attribut (contrat `t3-attribute-arbitration-v1`).
 *
 *   L114-U-REGISTRE  opération master T3 (six emplacements), non facturée ; schéma et contrat runtime ; diagnostic ;
 *                    branche FACULTATIVE dont le texte est attendu du PO ; aucun texte de prompt dans le code ;
 *   L114-U-GUIDE     bloc 38 balisé, applicable au T3 livré, rendu réel ; exemples validés ; capacité ; conformité
 *                    BO « absent » puis « satisfait » ;
 *   L114-U-CORPUS    six cas rejoués sur le texte T3 + bloc 38 par le contrôle serveur réel ; manifeste à jour.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const aac = await import('../attribute-arbitration/contract');
const dec = await import('../attribute-arbitration/decider');
const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
const { evaluateCorpusOutput } = await import('@/services/ai/governance/master-corpus/runner');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const GUIDE = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
const LIVRE_T3 = lire('src/services/ai/prompts/reconciliation/t3_master_v1.txt');
const REPERE = 'Réponds uniquement par le JSON correspondant au TASK demandé.';
const FX = (n: string) => JSON.parse(lire(`src/services/ai/reconciliation/master/__fixtures__/${n}`)) as {
  context: { attributeArbitration: import('../attribute-arbitration/contract').RawArbitrationContext }; recording: { output: Record<string, unknown> };
};
const RECTIFICATIVE = FX('p-t3-aa-01-facture-rectificative.json');
const INDECIDABLE = FX('p-t3-aa-02-meme-autorite-indecidable.json');

describe('L114-U-REGISTRE — opération, schéma, branche facultative, diagnostic', () => {
  it('opération master active du prompt T3 existant (six emplacements), non facturée ; schéma et contrat runtime ; table déclarée', async () => {
    const { AI_OPERATIONS, listMasterTasks, T3_MASTER_VARIABLES } = await import('@/services/ai/registry/operations');
    const { masterOutputSchemaFor } = await import('@/services/ai/gateway/master-output-schemas');
    const { contractVersionsOf } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    const { DIAG_AI_OPERATION_COVERAGE, DIAG_TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    const { RECETTE_TABLES } = await import('@/services/admin/diagnostics-export/recette-catalog');
    expect(AI_OPERATIONS.t3_attribute_arbitration).toMatchObject({
      masterPromptCode: 't3_master_v1', task: 'ATTRIBUTE_ARBITRATION', outputSchema: 'T3AttributeArbitrationOutput', active: true, billable: false,
      useCaseCode: 'DATA_RECONCILIATION', promptVariables: T3_MASTER_VARIABLES,
    });
    expect(listMasterTasks('t3_master_v1')).toContain('ATTRIBUTE_ARBITRATION');
    expect(masterOutputSchemaFor('T3AttributeArbitrationOutput')).toBe(aac.T3AttributeArbitrationOutput);
    expect(contractVersionsOf('T3AttributeArbitrationOutput')).toContain(1);
    expect(DIAG_AI_OPERATION_COVERAGE.t3_attribute_arbitration.tables).toContain('business_operation_attribute_arbitrations');
    expect(DIAG_TABLE_COVERAGE.business_operation_attribute_arbitrations).toBeTruthy();
    expect(RECETTE_TABLES.business_operation_attribute_arbitrations.domain).toBe('operations');
    expect(Object.keys(aac.arbitrationVariables(aac.buildArbitrationInput(RECTIFICATIVE.context.attributeArbitration).input)).sort()).toEqual([...T3_MASTER_VARIABLES].sort());
  });
  it('branche FACULTATIVE (version BO antérieure valide), texte attendu du PO ; aucun prompt du dépôt ne la porte', async () => {
    const loader = await import('@/services/ai/prompts/prompt-loader');
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    expect(loader.isOptionalMasterTask('t3_master_v1', 'ATTRIBUTE_ARBITRATION')).toBe(true);
    expect(loader.isMasterTaskTextPending('t3_master_v1', 'ATTRIBUTE_ARBITRATION')).toBe(true);
    expect(LIVRE_T3).not.toContain(aac.ATTRIBUTE_ARBITRATION_CONTRACT_VERSION);
    expect(checkMasterPromptContent('T3', LIVRE_T3).blocking).toEqual([]);
  });
  it('aucun texte de prompt dans le code : les modules ne contiennent que le contrat (marqueur, schéma, validation)', () => {
    for (const f of ['contract.ts', 'decider.ts', 'review.ts']) {
      const t = lire(`src/services/business-operations/consolidation/attribute-arbitration/${f}`);
      expect(t, f).not.toMatch(/BRANCHE TASK = ATTRIBUTE_ARBITRATION\n/);
      expect(t, f).not.toMatch(/R1 — MONDE FERMÉ/);
    }
  });
});

describe('L114-U-GUIDE — bloc 38, capacité, conformité BO', () => {
  const bloc = async () => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    return parseGuideBlocks(GUIDE).find((x) => x.id === aac.ATTRIBUTE_ARBITRATION_CONTRACT_VERSION)!;
  };
  const applique = async () => LIVRE_T3.replace(REPERE, `${(await bloc()).text}\n\n${REPERE}`);

  it('bloc officiel balisé (T3, insertion avant la ligne repère unique), branche + marqueur, aucun emplacement, jamais « Opération »', async () => {
    const b = await bloc();
    expect(b).toMatchObject({ prompt: 't3', action: 'insert-before', anchor: REPERE });
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(b.text).branches).toContain('ATTRIBUTE_ARBITRATION');
    expect(b.text).toContain(aac.ATTRIBUTE_ARBITRATION_CONTRACT_VERSION);
    for (const o of aac.ARBITRATION_OUTCOMES) expect(b.text).toContain(`"${o}"`);
    expect(b.text).not.toMatch(/opération/i);
    expect(GUIDE).toContain('| 38 | 114 (#750)');
  });
  it('T3 après collage : aucun bloquant, l’avertissement disparaît, rendu réel avec les variables de production', async () => {
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    const { renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
    const { listMasterTasks } = await import('@/services/ai/registry/operations');
    const t = await applique();
    expect(checkMasterPromptContent('T3', t).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', t).warnings.map((w) => w.message).join('\n')).not.toMatch(/ATTRIBUTE_ARBITRATION/);
    const variables = aac.arbitrationVariables(aac.buildArbitrationInput(RECTIFICATIVE.context.attributeArbitration).input);
    const rendu = renderMasterPrompt(t, { masterPromptCode: 't3_master_v1', task: 'ATTRIBUTE_ARBITRATION', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('BRANCHE TASK = ATTRIBUTE_ARBITRATION');
    expect(rendu).toContain('annule et remplace la facture F-2026-118');
  });
  it('les deux exemples du bloc sont acceptés par le validateur réel (cas P-T3-AA-01 et P-T3-AA-02)', async () => {
    const lignes = (await bloc()).text.split('\n').filter((l) => l.startsWith('{"task": "ATTRIBUTE_ARBITRATION"'));
    expect(lignes).toHaveLength(2);
    const [ex1, ex2] = lignes.map((l) => JSON.parse(l));
    const v1 = aac.validateArbitration(ex1, aac.buildArbitrationInput(RECTIFICATIVE.context.attributeArbitration).scope);
    const v2 = aac.validateArbitration(ex2, aac.buildArbitrationInput(INDECIDABLE.context.attributeArbitration).scope);
    expect(v1).toMatchObject({ ok: true, effect: { outcome: 'RESOLVED', value: '2026-03-19' } });
    expect(v2).toMatchObject({ ok: true, effect: { outcome: 'UNDECIDABLE' } });
    expect(aac.T3AttributeArbitrationOutput.parse(ex1)).toEqual(aac.T3AttributeArbitrationOutput.parse(RECTIFICATIVE.recording.output));
    expect(aac.T3AttributeArbitrationOutput.parse(ex2)).toEqual(aac.T3AttributeArbitrationOutput.parse(INDECIDABLE.recording.output));
  });
  it('capacité sur le texte réel : absente sur le T3 livré, présente après collage ; port de test', async () => {
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    const t = await applique();
    expect(dec.arbitrationCapabilityOf({ text: LIVRE_T3, version: 'v', branches: inspectMasterTemplate(LIVRE_T3).branches })).toMatchObject({ available: false, contractState: 'BRANCH_MISSING' });
    expect(dec.arbitrationCapabilityOf({ text: t, version: 'v38', branches: inspectMasterTemplate(t).branches })).toEqual({ available: true, version: 'v38', reason: 'AVAILABLE' });
    const faux = { capability: async () => ({ available: true, version: 'x', reason: 'AVAILABLE' as const }), decide: async () => ({ output: null, traceId: null }) };
    dec.__setArbitrationDeciderForTests(faux);
    expect(dec.arbitrationDecider()).toBe(faux);
    dec.__setArbitrationDeciderForTests(null);
    expect(dec.arbitrationDecider()).toBe(dec.productionArbitrationDecider);
    expect(dec.attributeArbitrationEnabled({ T3_ATTRIBUTE_ARBITRATION_ENABLED: '0' })).toBe(false);
    expect(dec.attributeArbitrationEnabled({})).toBe(true);
  });
  it('conformité BO : contrat déclaré — « absent » sur le T3 livré (configuration incomplète), satisfait après collage', async () => {
    const { promptContracts } = await import('@/services/ai/prompt-conformity/contracts');
    const c = (await promptContracts()).find((x) => x.id === aac.ATTRIBUTE_ARBITRATION_CONTRACT_VERSION)!;
    expect(c).toMatchObject({ treatment: 'T3', guideStep: 38, lot: '114', task: 'ATTRIBUTE_ARBITRATION', operations: ['t3_attribute_arbitration'], killSwitch: 'T3_ATTRIBUTE_ARBITRATION_ENABLED' });
    const execution = { mode: 'LEGACY_SLOTS' } as never;
    expect((await c.check({ text: LIVRE_T3, execution, referenceText: LIVRE_T3 })).state).toBe('ABSENT');
    expect((await c.check({ text: await applique(), execution, referenceText: LIVRE_T3 })).state).toBe('SATISFIED');
    expect((await c.plan({ text: LIVRE_T3, execution, referenceText: LIVRE_T3 })).ok).toBe(true);
    expect(c.impact).toMatch(/Configuration incomplète/);
  });
});

describe('L114-U-CORPUS — cas du corpus rejoués par le contrôle serveur réel', () => {
  const cas = loadMasterCorpusCases(readMasterFileFromRepo).filter((c) => c.operationCode === 't3_attribute_arbitration');
  it('six cas (trois réponses de référence, trois gardes), tous au manifeste', () => {
    expect(cas.map((c) => c.id)).toEqual(['P-T3-AA-01', 'P-T3-AA-02', 'P-T3-AA-03', 'P-T3-AA-04', 'P-T3-AA-05', 'P-T3-AA-06']);
    expect(cas.filter((c) => c.qualificationRole === 'answer')).toHaveLength(3);
    const manifeste = lire('src/services/ai/governance/master-corpus/certification/corpus-manifest.json');
    for (const c of cas) expect(manifeste).toContain(c.file.replace(/\\/g, '/'));
  });
  it.each(cas.map((c) => [c.id, c] as const))('%s : attendu respecté sur le texte T3 + bloc 38', async (_id, c) => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    const b = parseGuideBlocks(GUIDE).find((x) => x.id === aac.ATTRIBUTE_ARBITRATION_CONTRACT_VERSION)!;
    const r = await evaluateCorpusOutput(c, c.output, LIVRE_T3.replace(REPERE, `${b.text}\n\n${REPERE}`), readMasterFileFromRepo, c.outputSchema);
    expect(r.errors).toEqual([]);
  });
});
