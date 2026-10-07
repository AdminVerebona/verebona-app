/**
 * Lot 32, point 5 — BO « Exécution IA » : l'exécution est copiable.
 *
 *  · AC5.1 : l'export contient l'exécution COMPLÈTE (appel, trace, configuration
 *    appliquée, chaîne de modèles, étapes, entrées/sorties du modèle, erreurs,
 *    coûts, instantanés, modifications, job, sources T2) dans un format stable ;
 *  · AC5.2 : la rédaction en place est respectée — prompt rendu absent (non
 *    conservé), sortie de l'assistant en empreinte, textes libres masqués,
 *    contenu conversationnel T2 jamais inclus ;
 *  · AC5.3 : route admin (garde, 400/404, téléchargement `.json`) ;
 *  · AC5.4 : panneau — boutons « Copier », « Télécharger .json » et copie par bloc JSON.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  detail: null as unknown,
  admin: true,
}));
vi.mock('@/services/ai/telemetry/execution-log.repository', () => ({
  getExecutionDetail: vi.fn(async () => h.detail),
}));
vi.mock('@/app/api/admin/ai/config-versions/_shared', () => ({
  requireAdminContext: vi.fn(async () => (h.admin
    ? { ok: true, ctx: { adminUserId: 1 } }
    : { ok: false, response: NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }) })),
  toErrorResponse: () => NextResponse.json({ error: 'INTERNAL' }, { status: 500 }),
}));

const { buildExecutionExport, outputKindOf, executionExportFileName, EXECUTION_EXPORT_FORMAT } = await import('../execution-export');
const route = await import('@/app/api/admin/ai/executions/[id]/export/route');

const IBAN = 'FR76 3000 6000 0112 3456 7890 189';
const at = new Date('2026-10-07T10:12:00Z');

const appel = (over: Record<string, unknown> = {}) => ({
  id: 2622, createdAt: at, useCaseCode: 'RECONCILIATION', treatment: 'T3', operationCode: 't3_value_conflict',
  accountId: 13, userId: 4, provider: 'gemini', model: 'gemini-2.5-pro', modelRank: 'primary', usedFallback: false,
  inputTokens: 6193, outputTokens: 69, costMicros: 8432, durationMs: 11000, status: 'success',
  errorCode: null, errorMessage: null, configVersionId: 4, configVisibleNumber: 4,
  appVersion: '6a6415f608474fa68d35f4c62136d4c829dfb98c', jobId: 575, promptVersion: 't3_master_v1@pv2:1f4366350487',
  objectType: 'asset', objectId: '9', trigger: 'manual', origin: 'manual', callerMode: null,
  task: 'VALUE_CONFLICT', masterPromptCode: 't3_master_v1', masterPromptVersion: 't3_master_v1@pv2:1f4366350487',
  reasoning: 'étendu', maxOutputTokens: 8192, engine: 'new', callTrigger: 'manual', ...over,
});

const detail = () => ({
  call: appel(),
  traceId: '25658b69-8bdf-4b01-828c-cc7e9ab951bd',
  calls: [
    appel({ id: 2621, model: 'gemini-3.5-flash', modelRank: 'primary', status: 'error', errorCode: 'OUTPUT_INVALID', errorMessage: `Sortie invalide ${IBAN}`, costMicros: 1000, inputTokens: 100, outputTokens: 10, durationMs: 500 }),
    appel({ modelRank: 'fallback_1' }),
  ],
  steps: [
    { stepName: 'model_call', stepOrder: 2, provider: 'gemini', model: 'gemini-2.5-pro', durationMs: 11000, status: 'success', costMicros: 8432, isFallback: true, fallbackReason: 'OUTPUT_INVALID', errorCode: null, errorMessage: null, promptVersion: 'p', outputPreview: `{"decision":"keep","iban":"${IBAN}"}` },
    { stepName: 'model_call', stepOrder: 1, provider: 'gemini', model: 'gemini-3.5-flash', durationMs: 500, status: 'error', costMicros: 1000, isFallback: false, fallbackReason: null, errorCode: 'OUTPUT_INVALID', errorMessage: 'JSON invalide', promptVersion: 'p', outputPreview: 'sha256:0123456789ab len:42' },
  ],
  job: {
    id: 575, treatment: 'T3', status: 'DONE', origin: 'manual', triggerCode: 'manual', attempts: 1, configVersionId: 4,
    createdAt: at, startedAt: at, finishedAt: at, lastError: `Erreur ${IBAN}`, accountId: 13, targetType: 'asset', targetId: '9',
  },
  inputs: [
    { label: 'Version de prompt', value: 't3_master_v1@pv2:1f4366350487' },
    { label: 'Tarif figé', value: { source: 'public_catalog', currency: 'USD', verified: false, inputMicros: 1.25, outputMicros: 10 } },
    { label: 'Charge utile du job', value: { kind: 'asset', note: `iban ${IBAN}`, ids: [1, 2] } },
  ],
  modifications: [{ kind: 'keep', label: 'Bien 9 · mileage', detail: 'CONFLICT (high)', at: at.toISOString() }],
  t2: { requestId: 'req-1', sources: [{ messageId: 1, sourceType: 'asset', sourceId: 'asset_9', title: 'Cupra', rank: 1, relevanceScore: 0.9, isAvailable: true }] },
});

beforeEach(() => { h.detail = detail(); h.admin = true; });

describe('AC5.1 — export complet et structuré', () => {
  it('toutes les rubriques du panneau, plus entrées/sorties du modèle, erreurs et coûts', () => {
    const x = buildExecutionExport(detail() as never, at);
    expect(x.format).toBe(EXECUTION_EXPORT_FORMAT);
    expect(x.exportedAt).toBe(at.toISOString());
    expect(x.callId).toBe(2622);
    expect(x.traceId).toBe('25658b69-8bdf-4b01-828c-cc7e9ab951bd');
    expect(x.summary).toMatchObject({ treatment: 'T3', operationCode: 't3_value_conflict', status: 'success', model: 'gemini-2.5-pro' });
    expect(x.appliedConfiguration).toMatchObject({ engine: 'new', trigger: 'manual', task: 'VALUE_CONFLICT', reasoning: 'étendu', maxOutputTokens: 8192, configVisibleNumber: 4 });
    expect(x.calls.map((c) => [c.id, c.modelRank, c.status])).toEqual([[2621, 'primary', 'error'], [2622, 'fallback_1', 'success']]);
    // Étapes triées, sorties du modèle reprises.
    expect(x.steps.map((s) => s.stepOrder)).toEqual([1, 2]);
    expect(x.modelIO.responses.map((r) => [r.stepOrder, r.kind])).toEqual([[1, 'digest'], [2, 'excerpt']]);
    expect(x.modelIO).toMatchObject({ promptVersion: 't3_master_v1@pv2:1f4366350487', task: 'VALUE_CONFLICT', masterPrompt: { code: 't3_master_v1' } });
    // Erreurs agrégées : appel, étape, job.
    expect(x.errors.map((e) => e.where)).toEqual(['appel 2621 (gemini-3.5-flash)', 'étape model_call', 'job 575']);
    // Coûts de la chaîne entière.
    expect(x.costs).toEqual({ totalCostMicros: 9432, totalCostUsd: 0.009432, inputTokens: 6293, outputTokens: 79, totalDurationMs: 11500, calls: 2, failedCalls: 1 });
    expect(x.inputs.find((i) => i.label === 'Tarif figé')?.value).toEqual({ source: 'public_catalog', currency: 'USD', verified: false, inputMicros: 1.25, outputMicros: 10 });
    expect(x.modifications).toHaveLength(1);
    expect(x.job).toMatchObject({ id: 575, target: { type: 'asset', id: '9' } });
    expect(x.t2?.sources).toHaveLength(1);
    // JSON pur (sérialisable, dates ISO).
    expect(JSON.parse(JSON.stringify(x)).calls[0].createdAt).toBe(at.toISOString());
  });
  it('exécution sans trace, sans job ni étape : export minimal valide', () => {
    const d = { ...detail(), traceId: null, calls: [], steps: [], job: null, inputs: [], modifications: [], t2: null };
    const x = buildExecutionExport(d as never, at);
    expect(x.calls.map((c) => c.id)).toEqual([2622]);
    expect(x.errors).toEqual([]);
    expect(x.job).toBeNull();
    expect(x.t2).toBeNull();
    expect(x.modelIO.responses).toEqual([]);
  });
});

describe('AC5.2 — la rédaction en place est respectée', () => {
  it('prompt rendu jamais exporté (non conservé), sortie de l’assistant en empreinte', () => {
    const x = buildExecutionExport(detail() as never, at);
    expect(x.modelIO.renderedPrompt).toBeNull();
    expect(x.modelIO.renderedPromptNote).toMatch(/non conservé/);
    expect(x.modelIO.responses[0].text).toBe('sha256:0123456789ab len:42');
    expect(outputKindOf('sha256:0123456789ab len:42')).toBe('digest');
    expect(outputKindOf('{"a":1}')).toBe('excerpt');
  });
  it('textes libres masqués (IBAN) ; identifiants techniques intacts', () => {
    const txt = JSON.stringify(buildExecutionExport(detail() as never, at));
    expect(txt).not.toContain('FR76 3000');
    expect(txt).toContain('[IBAN_MASQUE]');
    expect(txt).toContain('6a6415f608474fa68d35f4c62136d4c829dfb98c');
    expect(txt).toContain('25658b69-8bdf-4b01-828c-cc7e9ab951bd');
  });
  it('contenu conversationnel T2 jamais inclus', () => {
    const x = buildExecutionExport(detail() as never, at);
    expect(x.t2?.contentNote).toMatch(/non inclus/);
    expect(Object.keys(x.t2 ?? {})).toEqual(['requestId', 'sources', 'contentNote']);
  });
});

describe('AC5.3 — route admin', () => {
  const get = (id: string, q = '') => route.GET(new NextRequest(`http://x/api/admin/ai/executions/${id}/export${q}`), { params: Promise.resolve({ id }) });
  it('JSON de l’export ; `?download=1` : fichier .json', async () => {
    const r = await get('2622');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.headers.get('content-disposition')).toBeNull();
    const body = await r.json();
    expect(body.format).toBe(EXECUTION_EXPORT_FORMAT);
    expect(body.callId).toBe(2622);
    const d = await get('2622', '?download=1');
    expect(d.headers.get('content-disposition')).toMatch(/^attachment; filename="execution-ia-appel-2622-.*\.json"$/);
  });
  it('identifiant invalide → 400 ; inconnu → 404 ; non admin → refus', async () => {
    expect((await get('abc')).status).toBe(400);
    h.detail = null;
    expect((await get('5')).status).toBe(404);
    h.admin = false;
    expect((await get('5')).status).toBe(403);
  });
  it('nom de fichier', () => {
    expect(executionExportFileName(12, at)).toBe('execution-ia-appel-12-2026-10-07-10-12-00.json');
  });
});

describe('AC5.4 — panneau : copier, télécharger, copie par bloc', () => {
  const ROOT = join(__dirname, '../../../../..');
  const page = readFileSync(join(ROOT, 'src/app/admin/ai-executions/page.tsx'), 'utf8');
  const comp = readFileSync(join(ROOT, 'src/app/admin/ai-executions/_components/CopyJson.tsx'), 'utf8');
  it('boutons d’en-tête branchés sur l’export serveur', () => {
    expect(page).toMatch(/<ExecutionExportButtons callId=\{detail\.call\.id\} \/>/);
    expect(comp).toMatch(/\/api\/admin\/ai\/executions\/\$\{callId\}\/export/);
    expect(comp).toMatch(/\n\s*Télécharger \.json\n/);
    expect(comp).toMatch(/'Copié' : 'Copier'/);
    expect(comp).toMatch(/navigator\.clipboard\.writeText/);
  });
  it('copie par bloc JSON : instantanés, sorties d’étape, cascade T2', () => {
    expect(page).toMatch(/<CopyBlockButton value=\{i\.value\} label=\{i\.label\} \/>/);
    expect(page).toMatch(/<CopyBlockButton value=\{s\.outputPreview\}/);
    expect(page).toMatch(/<CopyBlockButton value=\{r\.cascade\}/);
  });
});
