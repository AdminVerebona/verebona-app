/**
 * Lot 97A — réévaluations sémantiques T3 (identité multi-sources, demande
 * `87B-t3-identite-multi-operations`) et T4 (représentation Agenda
 * multi-événements, demande `87B-t4-representation-agenda-multi-evenements`) :
 * contrats, validateurs, activation par marqueur, opérations du registre et
 * blocs du guide du PO rejoués contre le code réel. Aucun prompt modifié.
 *
 *  L97A-S01  registre IA, schémas de sortie, contrats runtime, diagnostic ; branches FACULTATIVES ;
 *  L97A-S02  T4 : contrats d'exécution v3 / v4, TASK jamais autorisée par défaut, versions antérieures intactes ;
 *  L97A-S03  T4 : guide (bloc 6) → marqueur + configuration, contrôles BO, contexte construit, exemple validé et planifié ;
 *  L97A-S04  T3 : contrat, validation (monde fermé, complétude, protections), plan (décisions certaines seulement) ;
 *  L97A-S05  T3 : guide (bloc 5) → branche + marqueur, contrôles BO, rendu réel, exemples validés et planifiés ;
 *  L97A-S06  prompts:check du dépôt : aucune erreur (branches facultatives signalées en avertissement) ;
 *  L97A-S07  le guide cite les marqueurs, les coupures d'urgence, et ne liste plus ces demandes parmi les non réglables.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { AI_OPERATIONS, listMasterTasks } = await import('@/services/ai/registry/operations');
const { masterOutputSchemaFor } = await import('@/services/ai/gateway/master-output-schemas');
const { contractVersionsOf } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
const { DIAG_AI_OPERATION_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
const loader = await import('@/services/ai/prompts/prompt-loader');
const sc = await import('@/services/ai/master-prompts/structured-context');
const { T4_EXECUTION_SPEC } = await import('@/services/ai/agenda/master/t4-execution-contract');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { checkPromptFiles } = await import('@/services/ai/prompts/prompt-files-check');
const contract = await import('../contract');
const { buildRepresentationInput } = await import('../context');
const { validateRepresentation } = await import('../validate');
const { planRepresentation } = await import('../plan');
const decider = await import('../decider');
const idc = await import('../identity-contract');
const { buildIdentityInput } = await import('../identity-context');
const { validateIdentity, planIdentity } = await import('../identity-validate');
const idd = await import('../identity-decider');

const RACINE = process.cwd();
const lire = (p: string) => readFileSync(join(RACINE, p), 'utf-8');
const GUIDE = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
const LIVRE = { t3: lire('src/services/ai/prompts/reconciliation/t3_master_v1.txt'), t4: lire('src/services/ai/prompts/agenda/t4_master_v1.txt') };
const FX_T4 = JSON.parse(lire('src/services/ai/agenda/master/__fixtures__/p-t4-15-v4-representation-doublon.json')) as { context: { representation: never } };
const FX_T3 = JSON.parse(lire('src/services/ai/reconciliation/master/__fixtures__/p-t3-id-01-devis-mal-regroupe.json')) as { context: { identity: Record<string, unknown> } };

function bloc(id: string) {
  const re = new RegExp(`<!-- l89c:bloc ([^>]*?id="${id}"[^>]*?) -->\\s*\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``);
  const m = re.exec(GUIDE);
  if (!m) throw new Error(`bloc ${id} absent du guide`);
  return { attrs: Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])), text: m[2] };
}
const appliquer = (texte: string, b: ReturnType<typeof bloc>) => {
  expect(b.attrs.action).toBe('insert-before');
  expect(texte.split(b.attrs.anchor).length - 1, `${b.attrs.id} : ligne repère`).toBe(1);
  return texte.replace(b.attrs.anchor, `${b.text}\n\n${b.attrs.anchor}`);
};
function jsonsDe(texte: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const lignes = texte.split('\n');
  for (let k = 0; k < lignes.length; k++) {
    if (!lignes[k].startsWith('{')) continue;
    const reste = lignes.slice(k).join('\n');
    let prof = 0; let chaine = false; let echap = false; let fin = -1;
    for (let c = 0; c < reste.length; c++) {
      const ch = reste[c];
      if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
      if (ch === '"') chaine = true; else if (ch === '{') prof += 1; else if (ch === '}') { prof -= 1; if (prof === 0) { fin = c; break; } }
    }
    const brut = reste.slice(0, fin + 1);
    out.push(JSON.parse(brut));
    k += brut.split('\n').length - 1;
  }
  return out;
}

const V3V4: import('@/services/ai/master-prompts/structured-context').MasterExecutionConfig = {
  mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v3', outputContractVersion: 't4_output_v4',
  allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY', 'AGENDA_REPRESENTATION'],
};
const FICHIER = sc.executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'file' });

describe('L97A-S01 — registre IA, schémas, contrats runtime, diagnostic', () => {
  it('deux opérations master actives, branchées sur les prompts T3 / T4 existants', () => {
    expect(AI_OPERATIONS.t3_operation_identity).toMatchObject({ masterPromptCode: 't3_master_v1', task: 'OPERATION_IDENTITY', outputSchema: 'T3OperationIdentityOutput', active: true, billable: false });
    expect(AI_OPERATIONS.t4_agenda_representation).toMatchObject({ masterPromptCode: 't4_master_v1', task: 'AGENDA_REPRESENTATION', outputSchema: 'T4AgendaRepresentationOutput', active: true, billable: false });
    expect(listMasterTasks('t3_master_v1')).toContain('OPERATION_IDENTITY');
    expect(listMasterTasks('t4_master_v1')).toContain('AGENDA_REPRESENTATION');
  });
  it('schémas au catalogue master et contrats runtime v1 ; traitement déclaré au diagnostic global', () => {
    expect(masterOutputSchemaFor('T3OperationIdentityOutput')).toBe(idc.T3OperationIdentityOutput);
    expect(masterOutputSchemaFor('T4AgendaRepresentationOutput')).toBe(contract.T4AgendaRepresentationOutput);
    expect(contractVersionsOf('T3OperationIdentityOutput')).toContain(1);
    expect(contractVersionsOf('T4AgendaRepresentationOutput')).toContain(1);
    expect(DIAG_AI_OPERATION_COVERAGE.t3_operation_identity.tables).toContain('operation_semantic_reevaluations');
    expect(DIAG_AI_OPERATION_COVERAGE.t4_agenda_representation.tables).toContain('operation_semantic_reevaluations');
  });
  it('branches FACULTATIVES (une version BO antérieure reste valide, sans erreur) ; texte attendu du PO', () => {
    expect(loader.isOptionalMasterTask('t3_master_v1', 'OPERATION_IDENTITY')).toBe(true);
    expect(loader.isOptionalMasterTask('t4_master_v1', 'AGENDA_REPRESENTATION')).toBe(true);
    expect(loader.isMasterTaskTextPending('t3_master_v1', 'OPERATION_IDENTITY')).toBe(true);
    expect(checkMasterPromptContent('T3', LIVRE.t3).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', LIVRE.t3).warnings.map((w) => w.message).join('\n')).toMatch(/BRANCHE TASK = OPERATION_IDENTITY/);
  });
});

describe('L97A-S02 — T4 : contrats d’exécution, TASK jamais autorisée par défaut', () => {
  it('fichier du dépôt : défauts inchangés (v2 / v3, trois TASK) ; la TASK facultative n’est pas autorisée', () => {
    expect(FICHIER).toMatchObject({ inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3' });
    expect(sc.allowedTasksOf(T4_EXECUTION_SPEC, FICHIER)).toEqual(['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY']);
    expect(sc.checkExecutionConfig(T4_EXECUTION_SPEC, FICHIER, (n, v) => contractVersionsOf(n).includes(v))).toEqual([]);
  });
  it('version BO antérieure sans liste explicite de TASK (v2 / v3) : toujours valide, AGENDA_REPRESENTATION exclue', () => {
    const ancienne = { ...FICHIER, allowedTasks: null };
    expect(sc.checkExecutionConfig(T4_EXECUTION_SPEC, ancienne, (n, v) => contractVersionsOf(n).includes(v))).toEqual([]);
    expect(sc.allowedTasksOf(T4_EXECUTION_SPEC, ancienne)).not.toContain('AGENDA_REPRESENTATION');
    expect(sc.structuredTaskSupport(T4_EXECUTION_SPEC, ancienne, 'AGENDA_REPRESENTATION')).toEqual({ supported: false, reason: 'TASK_NOT_ALLOWED' });
    // Liste vide avec v3 / v4 : la TASK y est décrite, donc autorisée.
    expect(sc.allowedTasksOf(T4_EXECUTION_SPEC, { ...V3V4, allowedTasks: null })).toContain('AGENDA_REPRESENTATION');
  });
  it('TASK cochée avec les anciens contrats : refus explicite (bloquant au BO) ; v3 / v4 : configuration valide', () => {
    const issues = sc.checkExecutionConfig(T4_EXECUTION_SPEC, { ...FICHIER, allowedTasks: V3V4.allowedTasks }, (n, v) => contractVersionsOf(n).includes(v));
    expect(issues.map((i) => i.message).join(' ')).toMatch(/ne décrit pas la TASK AGENDA_REPRESENTATION/);
    expect(sc.checkExecutionConfig(T4_EXECUTION_SPEC, V3V4, (n, v) => contractVersionsOf(n).includes(v))).toEqual([]);
    expect(sc.structuredTaskSupport(T4_EXECUTION_SPEC, V3V4, 'AGENDA_REPRESENTATION').supported).toBe(true);
  });
  it('contexte d’exécution construit et VALIDÉ avant appel (contrat d’entrée t4_input_v3) ; donnée hors contrat refusée', () => {
    const b = buildRepresentationInput(FX_T4.context.representation);
    const built = sc.buildExecutionContext(T4_EXECUTION_SPEC, V3V4, 'AGENDA_REPRESENTATION', { AGENDA_REPRESENTATION: b.input });
    expect(built.fields).toEqual(['agenda_representation']);
    expect(built.output).toEqual({ schemaName: 'T4AgendaRepresentationOutput', contractVersion: 1 });
    expect(() => sc.buildExecutionContext(T4_EXECUTION_SPEC, V3V4, 'AGENDA_REPRESENTATION', { AGENDA_REPRESENTATION: { ...b.input, contractVersion: 'autre' } })).toThrow(/non conforme/);
    expect(() => sc.buildExecutionContext(T4_EXECUTION_SPEC, FICHIER, 'AGENDA_REPRESENTATION', { AGENDA_REPRESENTATION: b.input })).toThrow(/non autorisée/);
  });
});

describe('L97A-S03 — T4 : bloc 6 du guide contre le code réel', () => {
  const b6 = bloc('t4-agenda-representation-v1');
  const T4_ETAPE6 = appliquer(LIVRE.t4, b6);
  it('capacité : texte livré → marqueur absent ; bloc seul → TASK non cochée ; bloc + v3 / v4 → disponible ; ancien mode → indisponible', () => {
    expect(decider.representationCapabilityOf({ text: LIVRE.t4, version: 'file', execution: V3V4 })).toMatchObject({ available: false, contractState: 'MARKER_MISSING' });
    expect(decider.representationCapabilityOf({ text: T4_ETAPE6, version: 'v9', execution: FICHIER })).toMatchObject({ available: false, contractState: 'TASK_NOT_ALLOWED' });
    expect(decider.representationCapabilityOf({ text: T4_ETAPE6, version: 'v9', execution: V3V4 })).toEqual({ available: true, version: 'v9', reason: 'AVAILABLE' });
    expect(decider.representationCapabilityOf({ text: T4_ETAPE6, version: 'v9', execution: sc.LEGACY_EXECUTION })).toMatchObject({ available: false, contractState: 'LEGACY_TEMPLATE' });
  });
  it('contrôles d’activation du BO : aucun bloquant avec v3 / v4 ; bloquant si la TASK est cochée avec v2 / v3 ; aucun emplacement ajouté', () => {
    expect(loader.inspectMasterTemplate(b6.text).placeholders).toEqual([]);
    expect(checkMasterPromptContent('T4', T4_ETAPE6, V3V4).blocking).toEqual([]);
    expect(checkMasterPromptContent('T4', T4_ETAPE6, { ...FICHIER, allowedTasks: V3V4.allowedTasks }).blocking.length).toBeGreaterThan(0);
    expect(checkMasterPromptContent('T4', T4_ETAPE6, FICHIER).blocking).toEqual([]);
  });
  it('exemple JSON : schéma de sortie, validation serveur et plan réels → projection intacte retirée, principal conservé', () => {
    const [ex] = jsonsDe(b6.text);
    const sortie = contract.T4AgendaRepresentationOutput.parse(ex);
    const built = buildRepresentationInput(FX_T4.context.representation);
    const v = validateRepresentation(sortie, built.scope);
    expect(v.ok).toBe(true);
    const plan = planRepresentation((v as { decision: typeof sortie }).decision, built.scope);
    expect(plan.mutations.map((m) => m.kind)).toEqual(['REMOVE_PROJECTION']);
    expect(plan.refused).toEqual([]);
  });
});

describe('L97A-S04 — T3 identité : contrat, validation, plan', () => {
  const built = buildIdentityInput(FX_T3.context.identity as never);
  const ok = (sources: unknown[], outcome = 'REVISED') => ({ task: 'OPERATION_IDENTITY', outcome, sources, reason: 'motif' });
  const s = (source: string, decision: string, o: Record<string, unknown> = {}) => ({ source, decision, targetOperation: decision === 'MOVE' ? 'O2' : null, confidence: 'certain', evidence: [], reason: 'r', ...o });
  it('entrée : références opaques, sources à décider = documents, protections, empreinte stable hors date et motif', () => {
    expect(built.input.sources.map((x) => [x.ref, x.document, x.inScope, x.protected, x.attachedBy])).toEqual([['S1', 'D1', true, false, 'FOUNDING'], ['S2', 'D2', true, false, 'AI']]);
    expect(built.input.neighbours.map((n) => n.ref)).toEqual(['O2']);
    expect(JSON.stringify(built.input)).not.toMatch(/"(601|602|8001|8002)"|:\s*601\b|:\s*8001\b/);
    const autre = buildIdentityInput({ ...FX_T3.context.identity, today: '2027-01-01', request: 'autre motif' } as never);
    expect(autre.fingerprint).toBe(built.fingerprint);
    const vars = idc.identityVariables(built.input);
    expect(Object.keys(vars).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    expect(vars.RELATION_TYPE).toBe('OPERATION_IDENTITY');
  });
  it('schéma : cohérence interne (ABSTAIN vide, CONFIRMED = KEEP, REVISED garde une source, MOVE ⇔ cible)', () => {
    expect(idc.T3OperationIdentityOutput.safeParse(ok([s('S1', 'KEEP')], 'ABSTAIN')).success).toBe(false);
    expect(idc.T3OperationIdentityOutput.safeParse(ok([s('S1', 'KEEP'), s('S2', 'SEPARATE')], 'CONFIRMED')).success).toBe(false);
    expect(idc.T3OperationIdentityOutput.safeParse(ok([s('S1', 'SEPARATE'), s('S2', 'SEPARATE')])).success).toBe(false);
    expect(idc.T3OperationIdentityOutput.safeParse(ok([s('S1', 'KEEP'), s('S2', 'MOVE', { targetOperation: null })])).success).toBe(false);
    expect(idc.T3OperationIdentityOutput.safeParse(ok([s('S1', 'KEEP'), s('S2', 'MOVE')])).success).toBe(true);
  });
  it('refus EN BLOC : référence inconnue, source oubliée ou décidée deux fois, déplacement vers O1, source protégée', () => {
    const issues = (o: unknown, b = built) => { const v = validateIdentity(o, b.scope); return v.ok ? [] : [...new Set(v.problems.map((p) => p.issue))].sort(); };
    expect(issues(ok([s('S1', 'KEEP'), s('S9', 'SEPARATE')]))).toEqual(['SOURCE_NOT_DECIDED', 'UNKNOWN_REFERENCE']);
    expect(issues(ok([s('S1', 'KEEP'), s('S2', 'MOVE', { targetOperation: 'O7' })]))).toEqual(['UNKNOWN_REFERENCE']);
    expect(issues(ok([s('S1', 'KEEP'), s('S2', 'MOVE', { targetOperation: 'O1' })]))).toEqual(['TARGET_IS_EXAMINED_OPERATION']);
    expect(issues(ok([s('S1', 'KEEP'), s('S1', 'KEEP'), s('S2', 'SEPARATE')]))).toEqual(['SOURCE_DECIDED_TWICE']);
    expect(issues(ok([s('S1', 'KEEP'), s('S2', 'SEPARATE', { evidence: [{ document: 'D9', excerpt: 'x' }] })]))).toEqual(['UNKNOWN_REFERENCE']);
    const protege = buildIdentityInput({ ...FX_T3.context.identity, sources: (FX_T3.context.identity.sources as Array<Record<string, unknown>>).map((x, i) => (i === 1 ? { ...x, userConfirmed: true } : x)) } as never);
    expect(issues(ok([s('S1', 'KEEP'), s('S2', 'SEPARATE', { confidence: 'probable' })]), protege)).toEqual(['PROTECTED_OBJECT']);
  });
  it('plan : seules les décisions CERTAINES deviennent des décisions de rattachement (refus O1, confirmation de la voisine)', () => {
    const v = validateIdentity(ok([s('S1', 'KEEP'), s('S2', 'MOVE')]), built.scope);
    expect(v.ok).toBe(true);
    const plan = planIdentity((v as unknown as { decision: never }).decision, built.scope);
    expect(plan.mutations).toEqual([
      expect.objectContaining({ kind: 'REJECT', fileId: 8002, candidateKey: 'op1', operationId: 601 }),
      expect.objectContaining({ kind: 'CONFIRM', fileId: 8002, candidateKey: 'op1', operationId: 602 }),
    ]);
    const prudent = planIdentity((validateIdentity(ok([s('S1', 'KEEP'), s('S2', 'SEPARATE', { confidence: 'probable' })]), built.scope) as unknown as { decision: never }).decision, built.scope);
    expect(prudent.mutations).toEqual([]);
    expect(prudent.refused).toEqual([{ source: 'S2', decision: 'SEPARATE', reason: 'NOT_CERTAIN' }]);
  });
});

describe('L97A-S05 — T3 identité : bloc 5 du guide contre le code réel', () => {
  const b5 = bloc('t3-operation-identity-v1');
  const T3_ETAPE5 = appliquer(LIVRE.t3, b5);
  const branches = (t: string) => loader.inspectMasterTemplate(t).branches;
  it('capacité : texte livré → branche absente ; bloc → disponible ; marqueur seul sans branche → indisponible', () => {
    expect(idd.identityCapabilityOf({ text: LIVRE.t3, version: 'file', branches: branches(LIVRE.t3) })).toMatchObject({ available: false, contractState: 'BRANCH_MISSING' });
    expect(idd.identityCapabilityOf({ text: T3_ETAPE5, version: 'v5', branches: branches(T3_ETAPE5) })).toEqual({ available: true, version: 'v5', reason: 'AVAILABLE' });
    const sansMarqueur = T3_ETAPE5.replaceAll(idc.IDENTITY_CONTRACT_VERSION, 't3-operation-identity');
    expect(idd.identityCapabilityOf({ text: sansMarqueur, version: 'v5', branches: branches(sansMarqueur) })).toMatchObject({ available: false, contractState: 'MARKER_MISSING' });
    expect(idd.identityEnabled({ T3_OPERATION_IDENTITY_ENABLED: '0' })).toBe(false);
  });
  it('contrôles d’activation du BO : aucun bloquant, plus d’avertissement de branche absente ; aucun emplacement ajouté', () => {
    expect(loader.inspectMasterTemplate(b5.text).placeholders).toEqual([]);
    expect(checkMasterPromptContent('T3', T3_ETAPE5).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', T3_ETAPE5).warnings.map((w) => w.message).join('\n')).not.toMatch(/OPERATION_IDENTITY/);
  });
  it('rendu réel de la branche avec les variables de production ; les autres branches restent rendables', () => {
    const variables = idc.identityVariables(buildIdentityInput(FX_T3.context.identity as never).input);
    const rendu = loader.renderMasterPrompt(T3_ETAPE5, { masterPromptCode: 't3_master_v1', task: 'OPERATION_IDENTITY', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('BRANCHE TASK = OPERATION_IDENTITY');
    expect(rendu).toContain('"contractVersion":"t3-operation-identity-v1"');
    for (const task of ['VALUE_CONFLICT', 'LINK_AMBIGUITY', 'OPERATION_MATCH', 'DOCUMENT_NAMING']) {
      expect(() => loader.renderMasterPrompt(T3_ETAPE5, { masterPromptCode: 't3_master_v1', task, variables, allowedTasks: listMasterTasks('t3_master_v1') })).not.toThrow();
    }
  });
  it('exemples JSON : schéma, validation et plan réels (déplacement certain → deux décisions ; confirmation → aucune)', () => {
    const exemples = jsonsDe(b5.text);
    expect(exemples).toHaveLength(2);
    const built = buildIdentityInput(FX_T3.context.identity as never);
    const kinds = exemples.map((e) => {
      const v = validateIdentity(idc.T3OperationIdentityOutput.parse(e), built.scope);
      expect(v.ok).toBe(true);
      return planIdentity((v as unknown as { decision: never }).decision, built.scope).mutations.map((m) => m.kind);
    });
    expect(kinds).toEqual([['REJECT', 'CONFIRM'], []]);
  });
});

describe('L97A-S05b — corpus des prompts maîtres sur les versions du PO (« Tester avec le corpus » du BO)', () => {
  it('T3 avec le bloc 5 et T4 avec le bloc 6 + v3 / v4 : corpus VERT, nouvelles branches exigées et couvertes', async () => {
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const r = await runMasterCorpus({
      readMasterFile: readMasterFileFromRepo, treatments: ['T3', 'T4'],
      texts: {
        t3_master_v1: { text: appliquer(LIVRE.t3, bloc('t3-operation-identity-v1')), source: 'config' },
        t4_master_v1: { text: appliquer(LIVRE.t4, bloc('t4-agenda-representation-v1')), source: 'config', execution: V3V4 },
      },
    });
    for (const m of r) expect(m.failures, m.masterPromptCode).toEqual([]);
    const t3 = r.find((m) => m.masterPromptCode === 't3_master_v1')!;
    const t4 = r.find((m) => m.masterPromptCode === 't4_master_v1')!;
    expect(t3.branchesPassed).toContain('OPERATION_IDENTITY');
    expect(t3.cases.filter((c) => c.task === 'OPERATION_IDENTITY').map((c) => [c.id, c.level, c.passed])).toEqual([['P-T3-ID-01', 'full', true], ['P-T3-ID-02', 'full', true]]);
    expect(t4.branchesPassed).toContain('AGENDA_REPRESENTATION');
    expect(t4.cases.filter((c) => c.task === 'AGENDA_REPRESENTATION').map((c) => [c.id, c.level, c.passed])).toEqual([['P-T4-V4-15', 'full', true], ['P-T4-V4-16', 'full', true]]);
  });
});

describe('L97A-S06 — prompts:check du dépôt', () => {
  it('aucune erreur ; branches facultatives signalées en avertissement (texte attendu du PO)', () => {
    const r = checkPromptFiles({ operations: Object.values(AI_OPERATIONS), root: join(RACINE, 'src', 'services', 'ai', 'prompts') });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/OPERATION_IDENTITY/);
    expect(r.warnings.join('\n')).toMatch(/AGENDA_REPRESENTATION/);
  });
});

describe('L97A-S07 — le guide cite les marqueurs et les coupures ; demandes retirées de la liste non réglable', () => {
  it('marqueurs, demandes, coupures d’urgence, contrats d’exécution présents', () => {
    for (const m of [
      idc.IDENTITY_CONTRACT_VERSION, contract.REPRESENTATION_CONTRACT_VERSION, contract.T3_IDENTITY_AI_CONTRACT, contract.REPRESENTATION_AI_CONTRACT,
      'BRANCHE TASK = OPERATION_IDENTITY', 'T3_OPERATION_IDENTITY_ENABLED', 'T4_AGENDA_REPRESENTATION_ENABLED', 't4_input_v3', 't4_output_v4',
      'AGENDA_REPRESENTATION', '86A-contrats-qualite-operations', 'qualif-couple-v2',
    ]) expect(GUIDE, m).toContain(m);
  });
  it('la liste « ne se règlent pas dans le BO » ne porte plus 86A, 87B T3, 87B T4 ni 87D', () => {
    for (const d of ['86A-contrats-qualite-operations', '87B-t4-representation-agenda-multi-evenements', '87B-t3-identite-multi-operations', '87D-mois-principal-factures']) {
      expect(GUIDE, d).not.toMatch(new RegExp(`^\\| \`${d}`, 'm'));
    }
  });
});
