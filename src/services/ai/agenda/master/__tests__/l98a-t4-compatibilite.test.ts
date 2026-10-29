/**
 * Lot 98A (P0-B) — la version T4 ACTIVE doit déclarer `t4_output_v3` (ou
 * suivant) pour que le moteur « À traiter » reçoive l'évaluation structurée
 * d'une intervention. Diagnostic constaté : version active en mode historique
 * (LEGACY_TEMPLATE, migration 0290) → T4_INCOMPATIBLE, carte conservée.
 *
 *  L98A-T01  diagnostic pur : ce qui manque, en clair, et le chemin (même texte / texte de référence)
 *  L98A-T02  « configuration T4 active normale » = défauts du texte livré (v2 / v3) ; v3 / v4 conservés
 *  L98A-T03  même règle que le moteur (`t4AssessmentConfig.interventionCapable`) : après la
 *            procédure, la configuration n'est plus incompatible ; la version préparée est activable
 *  L98A-T04  rattrapage « Préparer une version conforme » : brouillon au MÊME texte, idempotent,
 *            jamais activé, refus explicites (déjà compatible, texte sans évaluation, autre brouillon)
 *  L98A-T05  BO › Configuration IA : diagnostic exposé par le détail du prompt T4 (actif et brouillon)
 *  L98A-T06  écran, route et guide du PO (étape 8) branchés
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

type Row = import('../../../master-prompts/master-prompt.repository').MasterPromptVersionRow;
type Exec = import('../../../master-prompts/structured-context').MasterExecutionConfig;
const base = vi.hoisted(() => ({ rows: [] as Row[], inserts: [] as unknown[], switches: 0 }));

vi.mock('@/services/ai/master-prompts/master-prompt.repository', async (orig) => {
  const vrai = await orig<typeof import('../../../master-prompts/master-prompt.repository')>();
  const env = (r: Row, e: string, t: string) => r.environment === e && r.treatment === t;
  return {
    ...vrai,
    masterPromptTablesReady: async () => true,
    getActive: async (e: string, t: string) => base.rows.find((r) => env(r, e, t) && r.status === 'ACTIVE') ?? null,
    getDraft: async (e: string, t: string) => base.rows.find((r) => env(r, e, t) && r.status === 'DRAFT') ?? null,
    getPromptVersion: async (id: number) => base.rows.find((r) => r.id === id) ?? null,
    listPromptVersions: async (e: string, t: string) => base.rows.filter((r) => env(r, e, t)),
    listTestRuns: async () => [],
    userEmails: async () => new Map(),
    listActivations: async () => [],
    switchActivePrompt: async () => { base.switches += 1; throw new Error('aucune activation attendue'); },
    insertDraft: async (p: { environment: string; treatment: string; masterPromptCode: string; content: string; basedOnId: number | null; userId: number; execution?: Exec | null }) => {
      base.inserts.push(p);
      const r = ligne({ id: 100 + base.rows.length, status: 'DRAFT', content: p.content, execution: p.execution ?? null, basedOnId: p.basedOnId, versionNumber: 99, environment: p.environment });
      base.rows.push(r);
      return r;
    },
  };
});

const { getAiEnvironment } = await import('../../../config/environment');
const ENV = getAiEnvironment();
function ligne(p: Partial<Row>): Row {
  const d = new Date('2026-10-27T08:00:00Z');
  return {
    id: 1, environment: ENV, treatment: 'T4', masterPromptCode: 't4_master_v1', versionNumber: 7, status: 'ACTIVE', content: '', contentSha256: 'x',
    origin: 'admin', basedOnId: null, createdBy: 1, createdAt: d, updatedBy: 1, updatedAt: d, activatedBy: 1, activatedAt: d, firstActivatedAt: d, execution: null, ...p,
  };
}

const compat = await import('../t4-compatibility');
const { T4_EXECUTION_SPEC } = await import('../t4-execution-contract');
const svc = await import('../../../master-prompts/master-prompt.service');
const { checkMasterPromptContent } = await import('../../../master-prompts/master-prompt-checks');
const { __setActiveMasterPromptsForTests } = await import('../../../master-prompts/master-prompt-runtime');
const fe = await import('@/services/to-process/document-field-evidence');

const RACINE = process.cwd();
const lire = (p: string) => readFileSync(join(RACINE, p), 'utf8');
const LIVRE = lire('src/services/ai/prompts/agenda/t4_master_v1.txt');
const LEGACY_TXT = lire('src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt');
const LEGACY: Exec = { mode: 'LEGACY_TEMPLATE', inputContractVersion: null, outputContractVersion: null, allowedTasks: null };
const NORMALE: Exec = { mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] };
const V3V4: Exec = { mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v3', outputContractVersion: 't4_output_v4', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY', 'AGENDA_REPRESENTATION'] };
const diag = (execution: Exec | null, content = LIVRE) => compat.assessT4Compatibility({ spec: T4_EXECUTION_SPEC, execution, content, referenceText: LIVRE });

beforeEach(() => { base.rows = []; base.inserts = []; base.switches = 0; vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { __setActiveMasterPromptsForTests(null); fe.__setT4AssessmentConfigForTests(null); vi.restoreAllMocks(); });

describe('L98A-T01 — diagnostic de compatibilité', () => {
  it('cas constaté : mode historique, texte livré → INCOMPATIBLE, brouillon au même texte proposé', () => {
    const d = diag(LEGACY);
    expect(d).toMatchObject({ compatible: false, textReady: true, remedy: 'PREPARE_SAME_TEXT', target: NORMALE });
    expect(d.issues.map((i) => i.code)).toEqual(['LEGACY_TEMPLATE']);
  });
  it('mode historique, ancien gabarit à emplacements → repartir du texte de référence', () => {
    const d = diag(LEGACY, LEGACY_TXT);
    expect(d.remedy).toBe('RESTART_FROM_REFERENCE');
    expect(d.issues.map((i) => i.code)).toEqual(['LEGACY_TEMPLATE', 'TEXT_WITHOUT_INTERVENTION']);
  });
  it('contrat de sortie antérieur (v1, v2) ou CLASSIFY_EVENT décochée : incompatible, motif nommé', () => {
    expect(diag({ ...NORMALE, inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1' }).issues.map((i) => i.code)).toEqual(['OUTPUT_CONTRACT_TOO_OLD']);
    expect(diag({ ...NORMALE, outputContractVersion: 't4_output_v2' }).issues[0].message).toMatch(/t4_output_v2.*t4_output_v3/);
    const sans = diag({ ...NORMALE, allowedTasks: ['VERIFY_COMPLETION'] });
    expect(sans).toMatchObject({ compatible: false, remedy: 'PREPARE_SAME_TEXT' });
    expect(sans.target.allowedTasks).toEqual(['CLASSIFY_EVENT', 'VERIFY_COMPLETION']);
  });
  it('configuration normale ou suivante : compatible, rien à faire', () => {
    expect(diag(NORMALE)).toMatchObject({ compatible: true, textReady: true, issues: [], remedy: 'NONE' });
    expect(diag(V3V4)).toMatchObject({ compatible: true, remedy: 'NONE' });
    // Texte propre au PO qui décrit l'évaluation : reconnu sans être identique au texte livré.
    expect(compat.t4TextCarriesIntervention('Règles… si `event_context.toProcessAssessment` est présent, remplis `intervention`.', LIVRE)).toBe(true);
    expect(compat.t4TextCarriesIntervention(LEGACY_TXT, LIVRE)).toBe(false);
  });
});

describe('L98A-T02 — configuration T4 active normale', () => {
  it('défauts du texte livré : contexte structuré, t4_input_v2 / t4_output_v3, trois TASK', () => {
    expect(T4_EXECUTION_SPEC.defaults).toEqual(NORMALE);
    expect(compat.conformingT4Execution(T4_EXECUTION_SPEC, LEGACY)).toEqual(NORMALE);
  });
  it('version suivante déjà choisie (v3 / v4, AGENDA_REPRESENTATION) : conservée telle quelle', () => {
    expect(compat.conformingT4Execution(T4_EXECUTION_SPEC, V3V4)).toEqual(V3V4);
    expect(compat.conformingT4Execution(T4_EXECUTION_SPEC, { ...NORMALE, allowedTasks: null })).toEqual({ ...NORMALE, allowedTasks: null });
  });
});

describe('L98A-T03 — même règle que le moteur « À traiter »', () => {
  const capable = async (execution: Exec | null) => {
    __setActiveMasterPromptsForTests([{ id: 1, treatment: 'T4', versionNumber: 7, content: LIVRE, execution }]);
    fe.__setT4AssessmentConfigForTests(null);
    return (await fe.t4AssessmentConfig()).interventionCapable;
  };
  it('avant (LEGACY_TEMPLATE) : incompatible ; après la procédure (configuration conforme) : compatible', async () => {
    for (const e of [LEGACY, { ...NORMALE, outputContractVersion: 't4_output_v2' }, NORMALE, V3V4]) {
      expect(await capable(e), JSON.stringify(e)).toBe(compat.t4ExecutionInterventionCapable(e));
    }
    expect(await capable(LEGACY)).toBe(false);
    expect(await capable(diag(LEGACY).target)).toBe(true);
  });
  it('la version préparée est activable (aucun contrôle bloquant du BO)', () => {
    expect(checkMasterPromptContent('T4', LIVRE, diag(LEGACY).target).blocking).toEqual([]);
  });
});

describe('L98A-T04 — « Préparer une version conforme » (rattrapage idempotent, jamais d’activation)', () => {
  it('brouillon au MÊME texte, configuration conforme ; second appel : même brouillon, aucun doublon', async () => {
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: LEGACY }));
    const d1 = await svc.prepareConformingT4Draft(5);
    expect(d1).toMatchObject({ status: 'DRAFT', content: LIVRE, execution: NORMALE, basedOnId: 1 });
    expect(base.inserts).toHaveLength(1);
    const d2 = await svc.prepareConformingT4Draft(5);
    expect(d2.id).toBe(d1.id);
    expect(base.inserts).toHaveLength(1);
    // La version active n'a pas bougé et rien n'a été activé.
    expect(base.rows.find((r) => r.id === 1)).toMatchObject({ status: 'ACTIVE', execution: LEGACY });
    expect(base.switches).toBe(0);
  });
  it('refus : déjà compatible, texte sans évaluation, autre brouillon ouvert', async () => {
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: NORMALE }));
    await expect(svc.prepareConformingT4Draft(5)).rejects.toMatchObject({ code: 'ALREADY_COMPATIBLE' });
    base.rows = [ligne({ id: 1, content: LEGACY_TXT, execution: LEGACY })];
    await expect(svc.prepareConformingT4Draft(5)).rejects.toMatchObject({ code: 'TEXT_NOT_COMPATIBLE' });
    base.rows = [ligne({ id: 1, content: LIVRE, execution: LEGACY }), ligne({ id: 2, status: 'DRAFT', content: `${LIVRE}\nmodif`, execution: LEGACY })];
    await expect(svc.prepareConformingT4Draft(5)).rejects.toMatchObject({ code: 'DRAFT_EXISTS' });
    expect(base.inserts).toHaveLength(0);
  });
});

describe('L98A-T05 — BO › Configuration IA : diagnostic exposé', () => {
  it('détail du prompt T4 : version active incompatible (ce qui manque), brouillon préparé compatible', async () => {
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: LEGACY }));
    const avant = await svc.getPromptDetail('T4');
    expect(avant.t4Compatibility?.active).toMatchObject({ compatible: false, remedy: 'PREPARE_SAME_TEXT' });
    expect(avant.t4Compatibility?.draft).toBeNull();
    await svc.prepareConformingT4Draft(5);
    const apres = await svc.getPromptDetail('T4');
    expect(apres.t4Compatibility?.draft).toMatchObject({ compatible: true, remedy: 'NONE', issues: [] });
    expect(apres.draft?.issues).toEqual([]);
  });
  it('autres prompts : aucun diagnostic T4', async () => {
    base.rows.push(ligne({ id: 3, treatment: 'T3', masterPromptCode: 't3_master_v1', content: lire('src/services/ai/prompts/reconciliation/t3_master_v1.txt') }));
    expect((await svc.getPromptDetail('T3')).t4Compatibility).toBeNull();
  });
});

describe('L98A-T06 — écran, route, guide', () => {
  it('écran : encadré de compatibilité (actif et brouillon), bouton de préparation, aucune activation automatique', () => {
    const ui = lire('src/app/admin/ai-config/_components/MasterPrompts.tsx');
    expect(ui).toContain('data-testid="t4-compatibility"');
    expect(ui).toContain('Préparer une version conforme');
    expect(ui).toContain('{ conformT4: true }');
    expect(ui).toMatch(/T4CompatibilityPanel compat=\{detail\.t4Compatibility\.draft\}/);
  });
  it('route : `conformT4` réservé à T4, appelle le rattrapage', () => {
    const route = lire('src/app/api/admin/ai/master-prompts/[treatment]/draft/route.ts');
    expect(route).toContain('prepareConformingT4Draft(guard.ctx.adminUserId)');
    expect(route).toContain("t.treatment !== 'T4'");
  });
  it('guide du PO : étape 8, deux procédures, vérification', () => {
    const g = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
    for (const m of ['## 9. Étape 8 — T4', 'Préparer une version conforme', 'Repartir du texte de référence (Contexte structuré)', 't4_output_v3', 'T4_INCOMPATIBLE', 'KEPT_T4_INCOMPATIBLE']) expect(g, m).toContain(m);
  });
});
