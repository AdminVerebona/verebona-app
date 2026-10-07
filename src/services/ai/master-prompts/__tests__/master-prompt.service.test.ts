/**
 * BO-IA-PROMPTS-01 — service des prompts maîtres, sans base (dépôt simulé).
 * Un test nommé par critère d'acceptation ; le parcours complet par les
 * routes, sur PostgreSQL, est dans `src/test/e2e/scenarios/bo-ia-prompts-01.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MasterPromptVersionRow, MasterPromptTestRunRow } from '../master-prompt.repository';

const FICHIER_T2 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/assistant/t2_master_v1.txt'), 'utf8');
const FICHIER_T1 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');

const versions = new Map<number, MasterPromptVersionRow>();
const runs: MasterPromptTestRunRow[] = [];
const repo = {
  masterPromptTablesReady: vi.fn(async () => true),
  getPromptVersion: vi.fn(async (id: number) => versions.get(id) ?? null),
  getActive: vi.fn(async (_env: string, t: string) => [...versions.values()].find((v) => v.treatment === t && v.status === 'ACTIVE') ?? null),
  getDraft: vi.fn(async (_env: string, t: string) => [...versions.values()].find((v) => v.treatment === t && v.status === 'DRAFT') ?? null),
  listPromptVersions: vi.fn(async (_env: string, t: string) => [...versions.values()].filter((v) => v.treatment === t).sort((a, b) => b.versionNumber - a.versionNumber)),
  listTestRuns: vi.fn(async (ids: number[]) => runs.filter((r) => ids.includes(r.promptVersionId)).sort((a, b) => b.id - a.id)),
  listActivations: vi.fn(async () => []),
  userEmails: vi.fn(async (ids: number[]) => new Map(ids.map((i) => [i, `admin${i}@verebona.test`]))),
  ensureInitialVersion: vi.fn(),
  insertDraft: vi.fn(async (p: Record<string, unknown>) => {
    const v = row({ id: 100 + versions.size, treatment: String(p.treatment), versionNumber: versions.size + 1, status: 'DRAFT', content: String(p.content), basedOnId: p.basedOnId as number });
    versions.set(v.id, v);
    return v;
  }),
  updateDraftContent: vi.fn(async (p: { id: number; content: string }) => {
    const v = versions.get(p.id);
    if (!v || v.status !== 'DRAFT') return null;
    const n = { ...v, content: p.content, contentSha256: sha(p.content) };
    versions.set(p.id, n);
    return n;
  }),
  deleteDraft: vi.fn(),
  switchActivePrompt: vi.fn(async (p: { treatment: string; targetId: number; action: string }) => {
    const previous = [...versions.values()].find((v) => v.treatment === p.treatment && v.status === 'ACTIVE') ?? null;
    if (previous) versions.set(previous.id, { ...previous, status: 'PREVIOUS' });
    const current = { ...versions.get(p.targetId)!, status: 'ACTIVE' as const, activatedAt: new Date() };
    versions.set(current.id, current);
    return { previous, current, activationId: 1 };
  }),
  insertTestRun: vi.fn(async (p: { promptVersionId: number; treatment: string; contentSha256: string }) => {
    runs.push({ id: runs.length + 1, promptVersionId: p.promptVersionId, treatment: p.treatment, contentSha256: p.contentSha256, status: 'RUNNING',
      scenariosTotal: 0, scenariosPassed: 0, scenariosFailed: 0, failures: [], error: null, requestedBy: 7, startedAt: new Date(), finishedAt: null });
    return runs.length;
  }),
  finishTestRun: vi.fn(async (id: number, r: { status: 'DONE' | 'ERROR'; total: number; passed: number; failed: number; failures: never[] }) => {
    const x = runs.find((y) => y.id === id)!;
    Object.assign(x, { status: r.status, scenariosTotal: r.total, scenariosPassed: r.passed, scenariosFailed: r.failed, failures: r.failures, finishedAt: new Date() });
  }),
  getTestRun: vi.fn(async (id: number) => runs.find((r) => r.id === id) ?? null),
};
const { createHash } = await import('node:crypto');
const sha = (s: string) => createHash('sha256').update(s.replace(/\r\n?/g, '\n')).digest('hex');
vi.mock('../master-prompt.repository', () => ({ ...repo, contentSha256: (s: string) => sha(s) }));
const bump = vi.fn(async (_r: string) => true);
const invalidate = vi.fn();
vi.mock('../../config/config-cache-version', () => ({ bumpConfigVersionCounter: (r: string) => bump(r) }));
vi.mock('../../config/config-resolver', () => ({ invalidateConfigCache: () => invalidate('config') }));
vi.mock('../../telemetry/execution-context', () => ({ invalidateConfigVersionCache: () => invalidate('trace') }));
const audit = vi.fn();
vi.mock('@/db', () => ({ db: { insert: () => ({ values: async (v: unknown) => audit(v) }) } }));
// La garde historique du corpus ne doit JAMAIS être consultée.
const garde = vi.fn();
vi.mock('../../governance/master-corpus/activation-guard', () => ({ checkMasterActivation: (v: unknown) => garde(v) }));
vi.mock('../../governance/master-corpus/repository', () => ({ latestCorpusRun: (...a: unknown[]) => garde(a) }));

const svc = await import('../master-prompt.service');

function row(o: Partial<MasterPromptVersionRow> & { id: number; treatment: string; versionNumber: number; status: MasterPromptVersionRow['status']; content: string }): MasterPromptVersionRow {
  return {
    environment: 'local', masterPromptCode: `${o.treatment.toLowerCase()}_master_v1`, contentSha256: sha(o.content), origin: 'admin',
    basedOnId: null, createdBy: 7, createdAt: new Date(), updatedBy: 7, updatedAt: new Date(), activatedBy: null, activatedAt: null, firstActivatedAt: null,
    ...o,
  };
}
const actif = (t: string, content: string, id = 1, n = 1) => versions.set(id, row({ id, treatment: t, versionNumber: n, status: 'ACTIVE', content }));
const brouillon = (t: string, content: string, id = 2, n = 2) => versions.set(id, row({ id, treatment: t, versionNumber: n, status: 'DRAFT', content, basedOnId: 1 }));

beforeEach(() => {
  versions.clear();
  runs.length = 0;
  for (const f of [...Object.values(repo), bump, invalidate, audit, garde]) (f as ReturnType<typeof vi.fn>).mockClear();
});

describe('BO-IA-PROMPTS-01 — service', () => {
  it('AC01 — une version active n’est jamais modifiée en place', async () => {
    actif('T2', FICHIER_T2);
    await expect(svc.saveDraft('T2', 1, 'nouveau texte', 7)).rejects.toMatchObject({ code: 'VERSION_NOT_EDITABLE' });
    expect(versions.get(1)!.content).toBe(FICHIER_T2);
    expect(repo.updateDraftContent).not.toHaveBeenCalled();
  });

  it('AC02 — « Modifier » crée un brouillon distinct, copie de l’Actif', async () => {
    actif('T2', FICHIER_T2);
    const d = await svc.startDraft('T2', 7);
    expect(d).toMatchObject({ status: 'DRAFT', basedOnId: 1, content: FICHIER_T2 });
    expect(d.id).not.toBe(1);
    await svc.saveDraft('T2', d.id, `${FICHIER_T2}\nRègle.`, 7);
    expect(versions.get(1)!.content).toBe(FICHIER_T2);
    // Rouvrir reprend le même brouillon.
    expect((await svc.startDraft('T2', 7)).id).toBe(d.id);
  });

  it('AC03 / AC04 — activation sans aucun test ni corpus : acceptée, avertissement informatif', async () => {
    actif('T2', FICHIER_T2);
    brouillon('T2', `${FICHIER_T2}\nRègle AC03.`);
    const r = await svc.activateDraft('T2', 2, 7);
    expect(r).toMatchObject({ activeVersionNumber: 2, previousVersionNumber: 1 });
    expect(r.notices).toContain('Cette version n’a pas encore été testée avec le corpus.');
    expect(garde).not.toHaveBeenCalled();
  });

  it('AC05 — dernier test rouge : activation acceptée, échecs signalés', async () => {
    actif('T2', FICHIER_T2);
    const texte = `${FICHIER_T2}\nRègle AC05.`;
    brouillon('T2', texte);
    runs.push({ id: 1, promptVersionId: 2, treatment: 'T2', contentSha256: sha(texte), status: 'DONE', scenariosTotal: 50, scenariosPassed: 47,
      scenariosFailed: 3, failures: [], error: null, requestedBy: 7, startedAt: new Date(), finishedAt: new Date() });
    const r = await svc.activateDraft('T2', 2, 7);
    expect(r.notices).toContain('3 scénarios en échec sur 50.');
    expect(repo.switchActivePrompt).toHaveBeenCalledWith(expect.objectContaining({ testSummary: 'Testée : 3 échec(s) sur 50' }));
  });

  it('AC06 — activer T2 ne lit ni T1, ni T3, T4, T6', async () => {
    actif('T2', FICHIER_T2);
    brouillon('T2', `${FICHIER_T2}\nRègle AC06.`);
    versions.set(10, row({ id: 10, treatment: 'T1', versionNumber: 1, status: 'DRAFT', content: 'cassé' }));
    await svc.activateDraft('T2', 2, 7);
    const lus = [...repo.getActive.mock.calls, ...repo.getDraft.mock.calls, ...repo.listPromptVersions.mock.calls].map((c) => c[1]);
    expect(new Set(lus)).toEqual(new Set(['T2']));
    expect(repo.listTestRuns.mock.calls.flatMap((c) => c[0])).toEqual([2]);
  });

  it('AC07 / AC08 — messages d’activation sans commande ni référence technique', async () => {
    actif('T2', FICHIER_T2);
    brouillon('T2', `${FICHIER_T2}\nRègle.`);
    const r = await svc.activateDraft('T2', 2, 7);
    expect(r.notices.join(' ')).not.toMatch(/npm|ai:corpus|sha|empreinte|\bCI\b|préprod|\.txt|src\//i);
    const d = await svc.getPromptDetail('T2');
    expect(d.active!.test.message).toBe('Cette version n’a pas encore été testée.');
    expect(d.active!.technical.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC09 — défaut technique réel : refus 422, aucune bascule', async () => {
    actif('T2', FICHIER_T2);
    brouillon('T2', FICHIER_T2.replace(/\{\{MODE\}\}/g, 'MODE'));
    await expect(svc.activateDraft('T2', 2, 7)).rejects.toMatchObject({ code: 'TECHNICAL_CHECK_FAILED', httpStatus: 422 });
    expect(repo.switchActivePrompt).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();
  });

  it('AC10 — l’ancienne version est conservée et l’opération journalisée (prompt, versions, utilisateur)', async () => {
    actif('T2', FICHIER_T2);
    brouillon('T2', `${FICHIER_T2}\nRègle.`);
    await svc.activateDraft('T2', 2, 7);
    expect(versions.get(1)!.status).toBe('PREVIOUS');
    expect(repo.switchActivePrompt).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T2', targetId: 2, action: 'activate', userId: 7, userEmail: 'admin7@verebona.test',
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'ai_master_prompt_activate', adminUserId: 7,
      beforeValue: expect.objectContaining({ treatment: 'T2', versionNumber: 1 }), afterValue: expect.objectContaining({ versionNumber: 2 }),
    }));
  });

  it('AC11 — réactiver une ancienne version ; refusé pour un brouillon ou l’active', async () => {
    versions.set(1, row({ id: 1, treatment: 'T2', versionNumber: 1, status: 'PREVIOUS', content: FICHIER_T2 }));
    actif('T2', `${FICHIER_T2}\nv2`, 2, 2);
    const r = await svc.reactivateVersion('T2', 1, 7);
    expect(r).toMatchObject({ activeVersionNumber: 1, previousVersionNumber: 2 });
    expect(versions.get(2)!.status).toBe('PREVIOUS');
    expect(repo.switchActivePrompt).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollback' }));
    await expect(svc.reactivateVersion('T2', 1, 7)).rejects.toMatchObject({ code: 'NOT_REACTIVABLE' });
    brouillon('T2', FICHIER_T2, 3, 3);
    await expect(svc.reactivateVersion('T2', 3, 7)).rejects.toMatchObject({ code: 'NOT_REACTIVABLE' });
    await expect(svc.activateDraft('T2', 1, 7)).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
  });

  it('AC12 / AC13 — test du corpus lancé à la demande, résultat rattaché à la version, attendu / obtenu', async () => {
    actif('T1', FICHIER_T1);
    brouillon('T1', FICHIER_T1.replace(/BRANCHE TASK = GROUP_UPLOAD/g, 'SECTION'));
    const vert = await svc.runPromptTest('T1', 1, 7);
    expect(vert).toMatchObject({ status: 'DONE', failed: 0, current: true });
    expect(vert.total).toBeGreaterThan(0);
    const rouge = await svc.runPromptTest('T1', 2, 7);
    expect(rouge.status).toBe('DONE');
    expect(rouge.failed).toBeGreaterThan(0);
    expect(rouge.failures[0]).toMatchObject({
      scenario: expect.any(String), branch: expect.any(String), expected: expect.any(String), obtained: expect.stringMatching(/rendu|aucun/i),
    });
    expect(repo.insertTestRun).toHaveBeenLastCalledWith(expect.objectContaining({ promptVersionId: 2, contentSha256: versions.get(2)!.contentSha256 }));
  });

  it('AC14 — un test d’un contenu antérieur n’est jamais présenté comme celui du texte actuel', () => {
    const run = (current: boolean, id: number) => ({
      id, status: 'DONE' as const, startedAt: new Date().toISOString(), finishedAt: null, total: 10, passed: 10, failed: 0, failures: [],
      error: null, current, requestedBy: null,
    });
    expect(svc.testStateOf([run(false, 3)])).toMatchObject({
      state: 'never', label: 'Non testé', message: 'Cette version n’a pas encore été testée.', previous: { id: 3 },
    });
    expect(svc.testStateOf([run(false, 4), run(true, 3)])).toMatchObject({ state: 'done', label: 'Tests 10/10', run: { id: 3 } });
  });

  it('AC15 — chaque bascule invalide les caches de tous les conteneurs (clé partagée) puis les locaux', async () => {
    actif('T2', FICHIER_T2);
    brouillon('T2', `${FICHIER_T2}\nRègle.`);
    await svc.activateDraft('T2', 2, 7);
    expect(bump).toHaveBeenCalledWith('prompt:T2:v2');
    expect(invalidate).toHaveBeenCalledWith('config');
    expect(invalidate).toHaveBeenCalledWith('trace');
  });

  it('T5 n’est pas administrable', () => {
    expect(() => svc.assertAdministrable('T5')).toThrow(/dépôt/);
    expect(svc.ADMIN_MASTER_TREATMENTS).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
  });
});
