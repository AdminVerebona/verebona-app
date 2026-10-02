/**
 * Modules Gemini historiques migrés sur la passerelle — plan de retrait
 * WF-41 (E-05) ; CDC BO IA PROV-UI-05, WF-21, OPS-011, OPS-008, WF-07, WF-08.
 *
 * Passerelle simulée : chaque module doit l'appeler avec SON usage et SON
 * opération du référentiel, le prompt historique inchangé, ses paramètres
 * d'origine (tentatives, JSON natif, plafond de sortie, pièces jointes), et
 * retomber sur son repli d'origine quand elle refuse l'appel (`AI_BLOCKED`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiGatewayRequest, AiGatewayResponse } from '../types';
import { AiGatewayError } from '../errors';

// ── Passerelle simulée ───────────────────────────────────────────────────────
const execute = vi.fn();
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute } }));

/** Réponse de passerelle : le schéma de l'appelant est appliqué comme par la vraie. */
function answer(text: string, model = 'm-principal') {
  return async (req: AiGatewayRequest<string>): Promise<AiGatewayResponse<string>> => {
    const r = req.outputSchema.safeParse(text);
    if (!r.success) {
      throw new AiGatewayError('ALL_MODELS_FAILED', req.operationCode, 'sortie invalide', {
        recoverable: true, lastFailureCode: 'INVALID_OUTPUT',
      });
    }
    return {
      data: r.data, provider: 'fake', model, promptVersion: 'x@file', usedFallback: false,
      inputTokens: 10, outputTokens: 5, costMicros: 42, durationMs: 1, traceId: 't', fromCache: false,
    };
  };
}
const blocked = async (req: AiGatewayRequest<string>) => {
  throw new AiGatewayError('AI_BLOCKED', req.operationCode, 'Arrêt d’urgence engagé');
};
const lastRequest = () => execute.mock.calls.at(-1)![0] as AiGatewayRequest<string>;

// ── Base simulée (tables par nom) ────────────────────────────────────────────
type Row = Record<string, unknown>;
let selectRows: Record<string, Row[]> = {};
vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  const select = () => {
    let table = '';
    const c: Record<string, unknown> = {
      from: (t: never) => { table = getTableName(t); return c; },
      innerJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: async () => selectRows[table] ?? [],
      then: (res: (v: unknown) => unknown) => Promise.resolve(selectRows[table] ?? []).then(res),
    };
    return c;
  };
  const write = () => () => {
    const c: Record<string, unknown> = {
      set: () => c, values: () => c, where: () => c, returning: async () => [],
      catch: () => Promise.resolve([]),
      then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
    };
    return c;
  };
  const unsafe = async () => [];
  return {
    db: { select, update: write(), insert: write(), delete: write(), $client: { unsafe } },
    pgClient: { unsafe },
  };
});

const startOperation = vi.fn(async () => 555);
const completeOperation = vi.fn(async () => undefined);
vi.mock('@/services/document-ai/ai-usage-tracker', () => ({
  AiUsageTracker: { startOperation, completeOperation },
}));
vi.mock('@/services/coherence/impact-propagation.service', () => ({ emitAssetUpdated: async () => undefined }));

// Chaîne de la version figée de T1 (dernier recours de l'analyse documentaire).
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({
    primaryModel: 'm-a', fallbackModels: ['m-b', 'm-c'], maxOutputTokens: null,
    reasoningPrimary: null, reasoningByRank: [], promptPreamble: null, configVersionId: 1, visibleNumber: 1,
  }),
}));

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ currentAccountId: 7, userId: 3, planType: 'PREMIUM' }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

const { callGeminiWithFallback, PROMPT_VERSIONS } = await import('@/services/document-ai/gemini-client');
const { applyAiEnrichmentAndCoherence } = await import('@/services/document-ai/enrich-and-coherence.service');
const { applyAiSuggestionsToAsset } = await import('@/services/document-ai/apply-ai-suggestions');
const { POST: aiSuggestionsPost } = await import('@/app/api/assets/[id]/ai-suggestions/route');
const { getOperation } = await import('@/services/ai/registry/operations');
const { LEGACY_PROMPT_VARIABLE } = await import('../legacy-prompt');

const ASSET = { id: 11, accountId: 7, name: 'Maison', category: 'IMMOBILIER', status: 'ACTIVE', keyCharacteristics: '{}' };
const DOC = {
  id: 21, originalFilename: 'acte.pdf', documentType: 'ACTE_TRANSACTION', retainedTitle: 'Acte',
  extractedText: 'Acte de vente, surface habitable 120 m2, construite en 1990.', description: null,
};

beforeEach(() => {
  execute.mockReset();
  startOperation.mockClear();
  completeOperation.mockClear();
  selectRows = {};
});

/** Contrôles communs à tous les modules migrés. */
function expectLegacyCall(req: AiGatewayRequest<string>, useCaseCode: string, operationCode: string) {
  expect(req.useCaseCode).toBe(useCaseCode);
  expect(req.operationCode).toBe(operationCode);
  // L'opération existe et appartient bien à cet usage (sinon USE_CASE_MISMATCH).
  expect(getOperation(operationCode).useCaseCode).toBe(useCaseCode);
  expect(getOperation(operationCode).legacyPrompt).toBe(true);
  expect(typeof req.promptVariables[LEGACY_PROMPT_VARIABLE]).toBe('string');
  expect(req.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('gemini-client (analyse documentaire historique) → SOURCE_ANALYSIS / legacy_document_analysis', () => {
  const base = {
    accountId: 7, sourceIds: [21],
    promptVersion: PROMPT_VERSIONS.detect_groups,
    fileUrls: ['https://s3/doc.pdf', 'https://example.org/page', 'gs://bucket/x.png'],
    mimeType: 'application/pdf',
    fileMimeTypes: ['application/pdf', 'text/html', 'image/png'],
    promptSubstitutions: { COUNT: '3' },
  };

  it('passe par la passerelle avec prompt, pièces jointes et plafond d’origine', async () => {
    execute.mockImplementation(answer('[[0,1],[2]]'));
    const r = await callGeminiWithFallback(base);

    const req = lastRequest();
    expectLegacyCall(req, 'SOURCE_ANALYSIS', 'legacy_document_analysis');
    expect(req.accountId).toBe(7);
    expect(req.sourceIds).toEqual([21]);
    expect(req.maxOutputTokensCap).toBe(3000);
    const prompt = req.promptVariables[LEGACY_PROMPT_VARIABLE] as string;
    // Lien web cité en tête, gabarit substitué, marqueurs résiduels retirés.
    expect(prompt.startsWith('URL du document web : https://example.org/page\n\n')).toBe(true);
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    // PDF par URL (Files API côté adaptateur), URI native référencée telle quelle.
    expect(req.attachments).toEqual([
      expect.objectContaining({ url: 'https://s3/doc.pdf', mimeType: 'application/pdf' }),
      { url: 'gs://bucket/x.png', mimeType: 'image/png' },
    ]);
    expect(getOperation('legacy_document_analysis').jsonResponse).toBe(true);
    expect(r).toMatchObject({ parsed: [[0, 1], [2]], model: 'm-principal', costMicros: 42, inputTokens: 10 });
  });

  it('GEN-005 : rattache les appels à l’opération métier transmise (mesure unique)', async () => {
    execute.mockImplementation(answer('{"a":1}'));
    await callGeminiWithFallback({ ...base, parentOperationId: 555 });
    expect(lastRequest().parentOperationId).toBe(555);
  });

  it('passe de détail : plafond de 8 000 jetons', async () => {
    execute.mockImplementation(answer('{"a":1}'));
    await callGeminiWithFallback({ ...base, promptVersion: PROMPT_VERSIONS.extract_detail });
    expect(lastRequest().maxOutputTokensCap).toBe(8000);
  });

  it('JSON illisible sur toute la chaîne : dernier recours texte libre sur le dernier modèle', async () => {
    execute
      .mockImplementationOnce(answer('pas de json'))
      .mockImplementationOnce(answer('Voici :\n```json\n{"ok":true}\n```', 'm-c'));
    const r = await callGeminiWithFallback(base);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(lastRequest()).toMatchObject({ jsonResponse: false, firstModelIndex: 2, maxModelAttempts: 1 });
    expect(r).toMatchObject({ parsed: { ok: true }, model: 'm-c', usedFallback: true });
  });

  it('dernier recours en échec : résultat vide `{}`', async () => {
    execute.mockImplementation(answer(''));
    const r = await callGeminiWithFallback(base);
    expect(r).toMatchObject({ parsed: {}, rawText: '{}', usedFallback: true });
  });

  it('panne technique : erreur propagée, sans dernier recours', async () => {
    execute.mockImplementation(async (req: AiGatewayRequest<string>) => {
      throw new AiGatewayError('ALL_MODELS_FAILED', req.operationCode, '503', { recoverable: true, lastFailureCode: 'TIMEOUT' });
    });
    await expect(callGeminiWithFallback(base)).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('AI_BLOCKED : propagé tel quel, aucun autre appel', async () => {
    execute.mockImplementation(blocked);
    await expect(callGeminiWithFallback(base)).rejects.toMatchObject({ code: 'AI_BLOCKED' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('enrich-and-coherence → DATA_RECONCILIATION / legacy_enrich_coherence', () => {
  beforeEach(() => {
    selectRows = { assets: [ASSET], asset_files: [DOC], agenda_items: [] };
  });

  it('appel rattaché à l’opération du tracker, JSON natif et 8 000 jetons', async () => {
    execute.mockImplementation(answer('{"sections":{},"coherenceAlerts":[]}'));
    await applyAiEnrichmentAndCoherence({ assetId: 11, accountId: 7 });
    const req = lastRequest();
    expectLegacyCall(req, 'DATA_RECONCILIATION', 'legacy_enrich_coherence');
    expect(req).toMatchObject({ accountId: 7, parentOperationId: 555, maxOutputTokensCap: 8000 });
    expect(req.maxModelAttempts).toBeUndefined(); // chaîne complète de T3, comme les trois modèles d'avant
    expect(getOperation('legacy_enrich_coherence')).toMatchObject({ jsonResponse: true, timeoutMs: 45_000 });
    expect(req.promptVariables[LEGACY_PROMPT_VARIABLE]).toContain('Acte de vente');
    // GEN-005 : le coût n'est plus déclaré au tracker — la passerelle le mesure.
    expect(completeOperation).toHaveBeenCalledWith({ operationId: 555, businessResult: 'success' });
  });

  it('AI_BLOCKED : aucun enrichissement, opération close en erreur', async () => {
    execute.mockImplementation(blocked);
    await expect(applyAiEnrichmentAndCoherence({ assetId: 11, accountId: 7 }))
      .resolves.toEqual({ enriched: false, alertsFound: 0, updatesApplied: 0 });
    expect(completeOperation).toHaveBeenCalledWith(expect.objectContaining({ businessResult: 'error' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('apply-ai-suggestions → DATA_RECONCILIATION / legacy_apply_suggestions', () => {
  beforeEach(() => {
    selectRows = { assets: [ASSET], asset_files: [DOC] };
  });

  it('une seule tentative, JSON natif, 8 000 jetons, fichier source tracé', async () => {
    execute.mockImplementation(answer('{"sections":{}}'));
    await applyAiSuggestionsToAsset({ assetId: 11, accountId: 7, assetFileId: 21 });
    const req = lastRequest();
    expectLegacyCall(req, 'DATA_RECONCILIATION', 'legacy_apply_suggestions');
    expect(req).toMatchObject({ accountId: 7, sourceIds: [21], parentOperationId: 555, maxModelAttempts: 1, maxOutputTokensCap: 8000 });
    expect(getOperation('legacy_apply_suggestions').jsonResponse).toBe(true);
  });

  it('AI_BLOCKED : silencieux (fire-and-forget), opération close en erreur', async () => {
    execute.mockImplementation(blocked);
    await expect(applyAiSuggestionsToAsset({ assetId: 11, accountId: 7 })).resolves.toBeUndefined();
    expect(completeOperation).toHaveBeenCalledWith(expect.objectContaining({ businessResult: 'error' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('route ai-suggestions → DATA_RECONCILIATION / legacy_asset_suggest', () => {
  const call = () => aiSuggestionsPost(
    new Request('http://x/api/assets/11/ai-suggestions', { method: 'POST', body: '{}' }) as never,
    { params: Promise.resolve({ id: '11' }) },
  );
  beforeEach(() => {
    selectRows = { assets: [ASSET], asset_files: [DOC] };
  });

  it('deux tentatives comme avant, compte et utilisateur de la session', async () => {
    execute.mockImplementation(answer('{"sections":{"physical_characteristics":{"livingArea":{"value":120,"confidence":"high"}}}}'));
    const res = await call();
    const req = lastRequest();
    expectLegacyCall(req, 'DATA_RECONCILIATION', 'legacy_asset_suggest');
    expect(req).toMatchObject({ accountId: 7, userId: 3, maxModelAttempts: 2 });
    expect(getOperation('legacy_asset_suggest').jsonResponse).toBeFalsy();
    expect(await res.json()).toMatchObject({ hasUsableSuggestions: true });
  });

  it('AI_BLOCKED : réponse AI_ERROR, comme toute panne IA', async () => {
    execute.mockImplementation(blocked);
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'AI_ERROR' });
  });
});

// Lot 16b-2 : `AgendaClassificationService` (legacy_classify_home_category),
// `lib/gemini-search` (legacy_semantic_search) et `lib/intelligent-search`
// (legacy_intelligent_search) sont SUPPRIMÉS — décision D-H2 pour la
// recherche ; le chemin manuel de l'agenda passe par le master T4
// (`t4-classification.test.ts`).
describe('relais historiques T2 et T4 retirés (lot 16b-2)', () => {
  it('plus aucune opération de relais pour l’assistant ni l’agenda', async () => {
    const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
    for (const code of ['legacy_classify_home_category', 'legacy_semantic_search', 'legacy_intelligent_search']) {
      expect(AI_OPERATIONS[code], code).toBeUndefined();
    }
  });
});

