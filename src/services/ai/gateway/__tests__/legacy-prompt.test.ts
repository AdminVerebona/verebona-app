/**
 * Passerelle — extensions requises par la migration des modules historiques
 * (plan de retrait WF-41) : prompt relayé sans préambule, sortie texte brute,
 * mode JSON natif, filtre de repli, code du dernier échec, pièces jointes en
 * mémoire et URI natives, et garde d'exploitation (`AI_BLOCKED`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', () => ({
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { executeLegacyPrompt } = await import('../legacy-prompt');
const { FakeProvider, setAiProvider } = await import('../providers');
const { primePricingCache, clearPricingCache } = await import('../pricing/pricing.repository');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { setRuntimeSnapshotLoader } = await import('../../queue/runnable-guard');
const { buildGenerationConfig } = await import('../providers/gemini-generation-config');
const { prepareAttachmentParts } = await import('../providers/gemini-files');
const { validateOutput } = await import('../output-validator');
const { z } = await import('zod');
const { GeminiProvider } = await import('../providers/gemini.provider');
const { setProviderSecretResolver } = await import('../../provider/provider-secret');
const { AI_OPERATIONS } = await import('../../registry/operations');
const { assertAiRegistryStartup } = await import('../../registry');

const PRIX = (model: string) => ({
  provider: 'gemini', model, inputMicros: 0.1, outputMicros: 0.4, currency: 'USD',
  source: 'manual' as const, verified: true, fetchedAt: new Date(),
});

let fake: InstanceType<typeof FakeProvider>;

/** Version T3 avec préambule administré et chaîne de trois modèles. */
function t3() {
  return {
    ...emptyTreatmentConfig('T3'),
    prompt: 'PRÉAMBULE ADMINISTRÉ T3',
    primaryModel: 'm-a', fallback1: 'm-b', fallback2: 'm-c',
  };
}

const call = (over: Partial<Parameters<typeof executeLegacyPrompt>[0]> = {}) => executeLegacyPrompt({
  useCaseCode: 'DATA_RECONCILIATION',
  operationCode: 'legacy_enrich_coherence',
  accountId: 1,
  prompt: 'PROMPT HISTORIQUE {"a":"$&"}',
  ...over,
});

beforeEach(() => {
  traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  clearPricingCache();
  primePricingCache([PRIX('m-a'), PRIX('m-b'), PRIX('m-c')]);
  __setConfigForTests({ versionId: 9, entries: [t3()] });
});
afterEach(() => {
  __setConfigForTests(null);
  setRuntimeSnapshotLoader(null);
  setProviderSecretResolver(null);
  vi.useRealTimers();
});

describe('prompt historique relayé', () => {
  it('transmis tel quel, sans préambule, en JSON natif ; réponse brute rendue', async () => {
    fake.onAny(() => ({ rawText: 'réponse brute', inputTokens: 3, outputTokens: 2 }));
    const r = await call();
    expect(fake.calls[0].prompt).toBe('PROMPT HISTORIQUE {"a":"$&"}');
    expect(fake.calls[0].jsonResponse).toBe(true);
    expect(fake.calls[0].model).toBe('m-a');
    expect(r.data).toBe('réponse brute');
    // Trace et coût de la passerelle, sous la version figée.
    expect(traces[0]).toMatchObject({ operationCode: 'legacy_enrich_coherence', useCaseCode: 'DATA_RECONCILIATION', configVersionId: 9, status: 'success' });
  });

  it('une opération nominale garde son préambule (non-régression)', async () => {
    fake.onAny(() => ({ rawText: '{"x":1}', inputTokens: 1, outputTokens: 1 }));
    const { AiGateway } = await import('../ai-gateway');
    await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION', operationCode: 'resolve_ambiguity', accountId: 1,
      promptVariables: {}, outputSchema: z.any(), idempotencyKey: 'abcdef0123',
    });
    expect(fake.calls[0].prompt.startsWith('PRÉAMBULE ADMINISTRÉ T3')).toBe(true);
    expect(fake.calls[0].jsonResponse).toBeUndefined();
  });

  it('surcharge ponctuelle du mode JSON (dernier recours texte libre)', async () => {
    fake.onAny(() => ({ rawText: 'x', inputTokens: 1, outputTokens: 1 }));
    await call({ jsonResponse: false, firstModelIndex: 2, maxModelAttempts: 1 });
    expect(fake.calls.map((c) => [c.model, c.jsonResponse])).toEqual([['m-c', undefined]]);
  });

  it('plafond de sortie de l’ancien module appliqué', async () => {
    fake.onAny(() => ({ rawText: 'x', inputTokens: 1, outputTokens: 1 }));
    await call({ maxOutputTokensCap: 8000 });
    expect(fake.calls[0].maxOutputTokens).toBe(8000);
  });
});

describe('masquage (§5.6) : exemption des prompts historiques relayés', () => {
  // Numéros que ces modules doivent extraire : SIRET (14 chiffres), n° de
  // série (16 chiffres), IBAN fournisseur. Masqués, ils disparaissaient du
  // texte DOCX alors que le même document en PDF restait intact.
  const texte = 'SIRET 73282932000074 — série 4970101234567890 — IBAN FR76 3000 6000 0112 3456 7890 189';

  it('le relais LEGACY_PROMPT est transmis sans masquage', async () => {
    fake.onAny(() => ({ rawText: 'x', inputTokens: 1, outputTokens: 1 }));
    await call({ prompt: texte });
    expect(fake.calls[0].prompt).toBe(texte);
    expect(fake.calls[0].prompt).not.toMatch(/MASQUE/);
  });

  it('une opération nominale reste masquée (non-régression)', async () => {
    fake.onAny(() => ({ rawText: '{"x":1}', inputTokens: 1, outputTokens: 1 }));
    const { AiGateway } = await import('../ai-gateway');
    await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION', operationCode: 'resolve_ambiguity', accountId: 1,
      promptVariables: { LEGACY_PROMPT: texte }, outputSchema: z.any(), idempotencyKey: 'abcdef0124',
    });
    // Le prompt de `resolve_ambiguity` n'a pas ce marqueur : on vérifie
    // directement la fonction de masquage avec et sans exemption.
    const { redactVariables } = await import('../redaction');
    expect(redactVariables({ LEGACY_PROMPT: texte }).LEGACY_PROMPT).toMatch(/\[CARTE_MASQUEE\]|\[IBAN_MASQUE\]/);
    expect(redactVariables({ LEGACY_PROMPT: texte }, ['LEGACY_PROMPT']).LEGACY_PROMPT).toBe(texte);
  });

  it('exemption réservée aux opérations `legacyPrompt` (contrôle de démarrage)', () => {
    for (const op of Object.values(AI_OPERATIONS)) {
      if (op.legacyPrompt) expect(op.unredactedVariables, op.operationCode).toEqual(['LEGACY_PROMPT']);
      else expect(op.unredactedVariables, op.operationCode).toBeUndefined();
    }
    const op = AI_OPERATIONS.resolve_ambiguity;
    op.unredactedVariables = ['X'];
    try {
      expect(() => assertAiRegistryStartup()).toThrow(/unredactedVariables/);
    } finally {
      delete op.unredactedVariables;
    }
    expect(() => assertAiRegistryStartup()).not.toThrow();
  });
});

describe('pièces jointes : un seul envoi par exécution de la passerelle', () => {
  const FILES = 'https://generativelanguage.googleapis.com';
  // Réseau simulé, SDK Gemini compris (il passe par `fetch`) : seul `m-c`
  // répond si `modelesOk` le dit ; chaque génération est enregistrée.
  const generations: Array<{ model: string; body: string }> = [];
  function simulerReseau(opts: { echecTelechargement?: string; modelesOk?: string[] } = {}) {
    let n = 0;
    generations.length = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const gen = url.match(/models\/([^:]+):generateContent/);
      if (gen) {
        generations.push({ model: gen[1], body: String(init?.body ?? '') });
        if (!(opts.modelesOk ?? []).includes(gen[1])) return new Response('{"error":{"message":"indisponible"}}', { status: 503 });
        return Response.json({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        });
      }
      if (url.startsWith('https://s3/')) {
        if (opts.echecTelechargement && url.includes(opts.echecTelechargement)) return new Response('', { status: 403 });
        return new Response(new Uint8Array([1, 2, 3]));
      }
      if (url.includes('/upload/')) {
        n += 1;
        return Response.json({ file: { uri: `${FILES}/v1beta/files/f${n}`, name: `files/f${n}`, state: 'ACTIVE' } });
      }
      if (init?.method === 'DELETE') return new Response('{}');
      return Response.json({ state: 'ACTIVE' });
    });
  }
  const uploads = (spy: ReturnType<typeof simulerReseau>) => spy.mock.calls.filter(([u]) => String(u).includes('/upload/'));
  const suppressions = (spy: ReturnType<typeof simulerReseau>) => spy.mock.calls.filter(([, i]) => i?.method === 'DELETE');

  it('chaîne de 3 tentatives : 1 téléchargement, 1 upload, 1 suppression', async () => {
    setAiProvider(new GeminiProvider());
    setProviderSecretResolver(async () => 'cle');
    const spy = simulerReseau({ modelesOk: ['m-c'] });

    const r = await call({ attachments: [{ url: 'https://s3/doc.pdf', mimeType: 'application/pdf' }] });

    expect(r).toMatchObject({ model: 'm-c', data: 'ok' });
    expect(generations.map((g) => g.model)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(spy.mock.calls.filter(([u]) => String(u) === 'https://s3/doc.pdf')).toHaveLength(1);
    expect(uploads(spy)).toHaveLength(1);
    expect(suppressions(spy)).toHaveLength(1);
    // Le même fichier est référencé par les trois tentatives.
    for (const g of generations) expect(g.body).toContain(`${FILES}/v1beta/files/f1`);
  });

  it('chaîne entièrement en échec : fichier supprimé quand même, une fois', async () => {
    setAiProvider(new GeminiProvider());
    setProviderSecretResolver(async () => 'cle');
    const spy = simulerReseau();
    await expect(call({ attachments: [{ url: 'https://s3/doc.pdf', mimeType: 'application/pdf' }] }))
      .rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(uploads(spy)).toHaveLength(1);
    expect(suppressions(spy)).toHaveLength(1);
  });

  it('échec sur la pièce k : les fichiers 1..k-1 déjà envoyés sont supprimés', async () => {
    const spy = simulerReseau({ echecTelechargement: 'deux.pdf' });
    await expect(prepareAttachmentParts([
      { url: 'https://s3/un.pdf', mimeType: 'application/pdf' },
      { url: 'https://s3/deux.pdf', mimeType: 'application/pdf' },
    ], 'cle')).rejects.toThrow(/403/);
    expect(uploads(spy)).toHaveLength(1);
    expect(suppressions(spy).map(([u]) => String(u))).toEqual([`${FILES}/v1beta/files/f1?key=cle`]);
  });
});

describe('repli sur réponse inexploitable', () => {
  it('le filtre de l’appelant fait passer au modèle suivant', async () => {
    fake.on('m-a', () => ({ rawText: '', inputTokens: 1, outputTokens: 0 }));
    fake.on('m-b', () => ({ rawText: '{"ok":1}', inputTokens: 1, outputTokens: 1 }));
    const r = await call({ accept: (t) => t.trim().length > 0 });
    expect(r).toMatchObject({ model: 'm-b', usedFallback: true, data: '{"ok":1}' });
  });

  it('ALL_MODELS_FAILED porte le code du dernier échec', async () => {
    fake.on('m-a', () => { throw new Error('503'); });
    fake.onAny(() => ({ rawText: 'pas du json', inputTokens: 1, outputTokens: 1 }));
    await expect(call({ accept: () => false }))
      .rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' });
  });

  it('nombre de tentatives de l’ancien module respecté', async () => {
    fake.onAny(() => { throw new Error('503'); });
    await expect(call({ maxModelAttempts: 1 })).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'PROVIDER_UNAVAILABLE' });
    expect(fake.calls).toHaveLength(1);
  });
});

describe('garde d’exploitation', () => {
  it('arrêt d’urgence : AI_BLOCKED, aucun appel fournisseur', async () => {
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: true, states: {} }));
    fake.onAny(() => ({ rawText: 'x', inputTokens: 1, outputTokens: 1 }));
    await expect(call()).rejects.toMatchObject({ code: 'AI_BLOCKED' });
    expect(fake.calls).toHaveLength(0);
  });

  it('traitement du module désactivé : bloqué pour lui seul', async () => {
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: false, states: { T1: 'DISABLED' } }));
    fake.onAny(() => ({ rawText: 'action', inputTokens: 1, outputTokens: 1 }));
    await expect(call({ useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'legacy_document_analysis' }))
      .rejects.toMatchObject({ code: 'AI_BLOCKED' });
    await expect(call()).resolves.toMatchObject({ data: 'action' });
  });
});

describe('briques de l’adaptateur', () => {
  it('mode JSON natif projeté dans generationConfig', () => {
    expect(buildGenerationConfig({ model: 'x', jsonResponse: true }))
      .toEqual({ temperature: 0, responseMimeType: 'application/json' });
    expect(buildGenerationConfig({ model: 'x' })).toEqual({ temperature: 0 });
  });

  it('sortie texte : la réponse brute est validée telle quelle', () => {
    expect(validateOutput('texte libre', z.string(), 'op', 'text')).toBe('texte libre');
    expect(() => validateOutput('texte libre', z.string(), 'op')).toThrow();
  });

  it('données en mémoire et URI natives : ni téléchargement, ni fichier temporaire', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { parts, temporaryFileUris } = await prepareAttachmentParts([
      { url: 'docx#image-0', mimeType: 'image/png', data: 'QUJD' },
      { url: 'gs://bucket/doc.pdf', mimeType: 'application/pdf' },
      { url: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'video/mp4' },
    ], 'cle');
    expect(parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
      { fileData: { fileUri: 'gs://bucket/doc.pdf', mimeType: 'application/pdf' } },
      { fileData: { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'video/mp4' } },
    ]);
    expect(temporaryFileUris).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Files API : attend l’état ACTIVE avant de rendre l’URI', async () => {
    vi.useFakeTimers();
    const etats = ['PROCESSING', 'ACTIVE'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://s3/')) return new Response(new Uint8Array([1, 2, 3]));
      if (url.includes('/upload/')) {
        return Response.json({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/v1', name: 'files/v1', state: 'PROCESSING' } });
      }
      return Response.json({ state: etats.shift() });
    });
    const pending = prepareAttachmentParts([{ url: 'https://s3/video.mp4', mimeType: 'video/mp4' }], 'cle');
    await vi.runAllTimersAsync();
    const { temporaryFileUris } = await pending;
    vi.useRealTimers();
    expect(temporaryFileUris).toEqual(['https://generativelanguage.googleapis.com/v1beta/files/v1']);
    const sondages = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/v1beta/files/v1?'));
    expect(sondages).toHaveLength(2);
  });
});

describe('régressions', () => {
  const racine = process.cwd();
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
  // Chemins relatifs normalisés en « / » : sous Windows, `join` produit des « \ »
  // et les préfixes autorisés ne correspondraient plus.
  const fichiers = () => walk(join(racine, 'src')).map((p) => relative(racine, p).split(sep).join('/'));

  it('aucun module applicatif ne lit process.env.GEMINI_API_KEY', () => {
    // Seuls la résolution de la clé (provider/) et l'adaptateur peuvent nommer
    // la variable : l'environnement n'est qu'un amorçage.
    const AUTORISES = ['src/services/ai/provider/', 'src/services/ai/gateway/providers/gemini.provider.ts', 'src/test/'];
    const fautifs = fichiers()
      .filter((rel) => !AUTORISES.some((a) => rel.startsWith(a)))
      .filter((rel) => /process\.env\.GEMINI_API_KEY/.test(readFileSync(join(racine, rel), 'utf8')));
    expect(fautifs).toEqual([]);
  });

  it('plus aucun appel Gemini hors adaptateur de la passerelle', () => {
    const fautifs = fichiers()
      .filter((rel) => !rel.startsWith('src/services/ai/gateway/providers/'))
      .filter((rel) => {
        const src = readFileSync(join(racine, rel), 'utf8');
        return /from\s+['"]@google\/generative-ai['"]|new\s+GoogleGenerativeAI|from\s+['"][^'"]*legacy-gemini-access['"]|upload\/v1beta\/files/.test(src);
      });
    expect(fautifs).toEqual([]);
  });
});
