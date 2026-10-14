/**
 * Lot 53 (53B) — retour PO D24 « T5 retiré : CONTRÔLER / MAINTENIR » :
 * prouver qu'aucun déclencheur FONCTIONNEL T5 ne subsiste, que l'historique
 * reste accessible, que les sondes opérationnelles sont distinguées des
 * traitements T5, et que le BO affiche le libellé « retiré ».
 * (Accès réel à l'historique sur PostgreSQL : l53b-d24-t5-retire.e2e.ts.)
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function fichiers(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === '__tests__' || n === 'node_modules' || n === 'migrations' || n === 'e2e' || n === '__fixtures__') continue;
      fichiers(p, out);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.(test|spec|e2e)\.tsx?$/.test(n)) {
      out.push(p);
    }
  }
  return out;
}
const SOURCES = fichiers(SRC).map((p) => ({ path: relative(ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

describe('PO-D24 — aucun déclencheur fonctionnel T5', () => {
  it('PO-D24-01 — aucun exécutant, aucune mise en file, aucune tâche planifiée, aucun cron, aucun appel modèle T5', async () => {
    const motifs: Array<[RegExp, string]> = [
      [/registerJobHandler\(\s*['"]T5['"]/, 'exécutant de file T5'],
      [/treatment:\s*['"]T5['"]/, 'mise en file / configuration T5'],
      [/enqueue\([^)]*['"]T5['"]/, 'mise en file T5'],
      [/operationCode:\s*['"]t5_(analyze|modify)['"]/, 'opération t5_* au registre'],
      [/['"]t5_master_v1['"]/, 'prompt maître T5'],
      [/runPromptControl|promptControlService|prompt-control\.service/, 'service Prompt Control'],
    ];
    const trouves: string[] = [];
    for (const f of SOURCES) for (const [re, quoi] of motifs) if (re.test(f.text)) trouves.push(`${f.path} : ${quoi}`);
    expect(trouves).toEqual([]);

    // Référentiel opérationnel : cinq traitements ; la boucle de file ne parcourt que T1, T3, T4.
    const t = await import('../treatments');
    expect([...t.TREATMENTS]).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(t.listBatchTreatments()).toEqual(['T1', 'T3', 'T4']);
    expect(t.isRetiredTreatment('T5')).toBe(true);
    // Registre : aucune opération t5_*.
    const { AI_OPERATIONS } = await import('../../registry/operations') as unknown as { AI_OPERATIONS?: Record<string, unknown> };
    if (AI_OPERATIONS) expect(Object.keys(AI_OPERATIONS).filter((k) => /^t5_/.test(k))).toEqual([]);

    // Tâches planifiées et crons : aucune ne vise T5 / Prompt Control.
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog') as unknown as { SCHEDULED_TASKS?: Array<{ code: string; label: string }> };
    const catalogue = readFileSync(join(SRC, 'services/scheduling/scheduled-tasks.catalog.ts'), 'utf8');
    expect(catalogue).not.toMatch(/prompt-control|PromptControl|\bT5\b|t5_/i);
    if (SCHEDULED_TASKS) expect(SCHEDULED_TASKS.filter((x) => /t5|prompt.?control/i.test(`${x.code} ${x.label}`))).toEqual([]);
    expect(readdirSync(join(SRC, 'app/api/cron')).filter((n) => /t5|prompt/i.test(n))).toEqual([]);
    expect(readdirSync(join(SRC, 'app/api/cron/ai')).filter((n) => /t5|prompt-control/i.test(n))).toEqual([]);
  });

  it('PO-D24-02 — la route historique /api/admin/ai/prompt-control ne fait plus rien : 410 « retiré », ni base ni modèle', async () => {
    const src = readFileSync(join(SRC, 'app/api/admin/ai/prompt-control/route.ts'), 'utf8');
    expect(src).not.toMatch(/from '@\/db'|gateway|generateWithFallback|callAi|pgClient/);
    vi.resetModules();
    vi.doMock('@/lib/auth-guards', () => ({ requireAdmin: async () => 1, isSessionError: () => false, sessionErrorResponse: () => null }));
    const route = await import('@/app/api/admin/ai/prompt-control/route');
    const { NextRequest } = await import('next/server');
    for (const m of ['GET', 'POST', 'PUT', 'PATCH'] as const) {
      const r = await route[m](new NextRequest('http://x/api/admin/ai/prompt-control', { method: m }));
      expect(r.status, m).toBe(410);
      const b = await r.json() as { error: string; message: string };
      expect(b.error).toBe('T5_RETIRED');
      expect(b.message).toContain('retiré');
    }
    vi.doUnmock('@/lib/auth-guards');
  });
});

describe('PO-D24 — libellé « retiré » dans le BO, sondes distinguées', () => {
  it('PO-D24-03 — journaux, versions, coûts et prompts maîtres : T5 affiché « retiré »', async () => {
    const { executionScopeLabel } = await import('@/services/ai/telemetry/execution-filters');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 't5_analyze' })).toBe('T5 (retiré)');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 't5_modify' })).toBe('T5 (retiré)');
    const page = readFileSync(join(SRC, 'app/admin/ai-config/page.tsx'), 'utf8');
    expect(page).toContain('(traitement retiré), conservé pour l’audit et jamais appliqué.');
    expect(readFileSync(join(SRC, 'services/ai/telemetry/cost-report.repository.ts'), 'utf8')).toContain('historique T5 retiré');
    const mp = readFileSync(join(SRC, 'app/admin/ai-config/_components/MasterPrompts.tsx'), 'utf8');
    // Même composant sur ordinateur et sur mobile : bloc repliable, retour à la ligne.
    expect(mp).toContain('function RetiredPromptHistory');
    expect(mp).toContain('historique en lecture seule');
    expect(mp).toMatch(/whitespace-pre-wrap break-words/);
    // Lecture seule : aucune action (ni bouton, ni appel d'écriture) dans le bloc.
    const bloc = mp.slice(mp.indexOf('function RetiredPromptHistory'), mp.indexOf('// ─── Section'));
    expect(bloc).not.toMatch(/<Button|apiClient\.(post|put|patch|delete)|onClick/);
  });

  it('PO-D24-04 — sondes opérationnelles : usage technique « Technique », jamais T5', async () => {
    const { executionScopeLabel } = await import('@/services/ai/telemetry/execution-filters');
    for (const op of ['model_operational_probe', 'model_qualification_probe', 'provider_test', 'evaluate_prompt']) {
      expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: op }), op).toBe('Technique');
    }
    const t = await import('../treatments');
    expect(t.isTechnicalUseCase('AI_GOVERNANCE')).toBe(true);
    // La sonde planifiée (synchronisation du catalogue de modèles) existe et n'est pas un traitement.
    const catalogue = readFileSync(join(SRC, 'services/scheduling/scheduled-tasks.catalog.ts'), 'utf8');
    expect(catalogue).toContain("code: 'ai-catalog-sync'");
  });
});
