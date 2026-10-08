/**
 * D-J5 (lot 16b-3) — contrat de l'adaptateur Gemini sur `@google/genai`.
 *
 * Le SDK est simulé : on vérifie ce que l'adaptateur lui ENVOIE (client Gemini
 * API et non Vertex, contenu, `generationConfig`, aucune nouvelle tentative du
 * SDK) et ce qu'il REND à la passerelle (texte, jetons, erreurs), à
 * comportement identique à l'ancien `@google/generative-ai` 0.24.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  ctor: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (req: unknown) => sdk.generateContent(req) };
    constructor(opts: unknown) { sdk.ctor(opts); }
  },
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', SAFETY: 'SAFETY', RECITATION: 'RECITATION', LANGUAGE: 'LANGUAGE' },
}));

const secret = vi.hoisted(() => ({ value: 'cle-bo' as string | null }));
vi.mock('../../../provider/provider-secret', () => ({ getProviderSecret: async () => secret.value }));

const files = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ parts: [] as unknown[], temporaryFileUris: [] as string[] })),
  cleanup: vi.fn(async () => undefined),
}));
vi.mock('../gemini-files', () => ({
  prepareAttachmentParts: (...a: unknown[]) => files.prepare(...(a as [])),
  cleanupTemporaryFiles: (...a: unknown[]) => files.cleanup(...(a as [])),
}));

// `src/test/setup.ts` importe déjà les adaptateurs (fournisseur simulé par
// défaut) : modules rechargés pour que les simulations ci-dessus s'appliquent.
vi.resetModules();
const { GeminiProvider, GeminiAttachmentSession, responseText } = await import('../gemini.provider');
const { AiGatewayError } = await import('../../errors');

const reponse = (over: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 50 },
  ...over,
});

const appel = (over: Record<string, unknown> = {}) => ({
  model: 'gemini-3.1-flash-lite', prompt: 'PROMPT', attachments: [], timeoutMs: 5_000, ...over,
});

beforeEach(() => {
  sdk.ctor.mockReset();
  sdk.generateContent.mockReset().mockResolvedValue(reponse());
  files.prepare.mockReset().mockResolvedValue({ parts: [], temporaryFileUris: [] });
  files.cleanup.mockReset().mockResolvedValue(undefined);
  secret.value = 'cle-bo';
});

describe('requête envoyée au SDK', () => {
  it('Gemini API (jamais Vertex), clé du BO, prompt puis pièces, generationConfig inchangé, sans nouvelle tentative du SDK', async () => {
    files.prepare.mockResolvedValue({ parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }], temporaryFileUris: [] });
    await new GeminiProvider().call(appel({
      attachments: [{ url: 'https://s3/x.png', mimeType: 'image/png' }],
      maxOutputTokens: 800, reasoning: 'minimal', jsonResponse: true,
    }));

    expect(sdk.ctor).toHaveBeenCalledWith({ apiKey: 'cle-bo', vertexai: false });
    const req = sdk.generateContent.mock.calls[0][0] as {
      model: string; contents: unknown[]; config: Record<string, unknown>;
    };
    expect(req.model).toBe('gemini-3.1-flash-lite');
    expect(req.contents).toEqual([{ text: 'PROMPT' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }]);
    const { abortSignal, ...config } = req.config;
    expect(config).toEqual({
      temperature: 0, maxOutputTokens: 800, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json',
    });
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    // Ni retryOptions, ni httpOptions, ni réglages de sécurité ajoutés.
    expect(Object.keys(req.config)).not.toEqual(expect.arrayContaining(['httpOptions']));
    expect(req.config).not.toHaveProperty('safetySettings');
  });

  it('Gemini 2.5 : budget de raisonnement ; standard / absent : rien de transmis', async () => {
    await new GeminiProvider().call(appel({ model: 'gemini-2.5-pro', reasoning: 'étendu' }));
    expect((sdk.generateContent.mock.calls[0][0] as { config: Record<string, unknown> }).config.thinkingConfig)
      .toEqual({ thinkingBudget: 32_768 });
    await new GeminiProvider().call(appel({ reasoning: 'standard' }));
    expect(sdk.generateContent.mock.calls[1][0].config).not.toHaveProperty('thinkingConfig');
    expect(sdk.generateContent.mock.calls[1][0].config).not.toHaveProperty('maxOutputTokens');
    expect(sdk.generateContent.mock.calls[1][0].config).not.toHaveProperty('responseMimeType');
  });

  it('sans clé (BO ni environnement) : PROVIDER_UNAVAILABLE non récupérable, aucun appel', async () => {
    secret.value = null;
    const e = await new GeminiProvider().call(appel()).catch((x) => x);
    expect(e).toBeInstanceOf(AiGatewayError);
    expect(e).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', recoverable: false });
    expect(sdk.generateContent).not.toHaveBeenCalled();
  });
});

describe('réponse rendue à la passerelle', () => {
  it('texte du premier candidat (raisonnement exclu) et jetons d’entrée / de sortie', async () => {
    sdk.generateContent.mockResolvedValue(reponse({
      candidates: [{ content: { parts: [{ text: 'pensée', thought: true }, { text: '{"ok":true}' }] }, finishReason: 'STOP' }],
    }));
    const out = await new GeminiProvider().call(appel());
    expect(out).toMatchObject({ rawText: '{"ok":true}', inputTokens: 120, outputTokens: 30 });
    // Lot 33D : métadonnées natives conservées pour le rapport d'appel.
    expect(out.meta).toMatchObject({ finishReason: 'STOP', thoughtsTokens: 50 });
  });

  it('sans usage : jetons à 0 ; réponse vide : chaîne vide (sortie invalide pour le validateur)', async () => {
    sdk.generateContent.mockResolvedValue({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
    expect(await new GeminiProvider().call(appel())).toMatchObject({ rawText: '', inputTokens: 0, outputTokens: 0, meta: { finishReason: 'STOP' } });
    expect(responseText({})).toBe('');
  });

  it('génération bloquée (sécurité, récitation, langue) : erreur, comme l’ancien `text()`', async () => {
    for (const raison of ['SAFETY', 'RECITATION', 'LANGUAGE']) {
      expect(() => responseText({ candidates: [{ finishReason: raison as never, content: { parts: [{ text: 'x' }] } }] }))
        .toThrow(`Candidate was blocked due to ${raison}`);
    }
    // MAX_TOKENS n'est pas un blocage : le texte (tronqué) est rendu, le validateur tranche.
    expect(responseText({ candidates: [{ finishReason: 'MAX_TOKENS' as never, content: { parts: [{ text: '{"a"' }] } }] })).toBe('{"a"');
  });

  it('prompt refusé (aucun candidat) : erreur « bloqué » avec le motif', () => {
    expect(() => responseText({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' as never } }))
      .toThrow('Text not available. Response was blocked due to PROHIBITED_CONTENT');
  });

  it('erreur du SDK (HTTP 429, réseau) : rendue telle quelle — la passerelle passe au modèle suivant', async () => {
    const err = Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), { status: 429 });
    sdk.generateContent.mockRejectedValue(err);
    await expect(new GeminiProvider().call(appel())).rejects.toBe(err);
  });
});

describe('délai et annulation', () => {
  it('délai dépassé : TIMEOUT récupérable, puis requête annulée', async () => {
    let signal: AbortSignal | undefined;
    sdk.generateContent.mockImplementation((req: { config: { abortSignal: AbortSignal } }) => {
      signal = req.config.abortSignal;
      return new Promise((_, rej) => signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    });
    const e = await new GeminiProvider().call(appel({ timeoutMs: 20 })).catch((x) => x);
    expect(e).toBeInstanceOf(AiGatewayError);
    expect(e).toMatchObject({ code: 'TIMEOUT', recoverable: true });
    expect(signal?.aborted).toBe(true);
  });

  it('réponse dans le délai : rien n’est annulé', async () => {
    await new GeminiProvider().call(appel());
    expect((sdk.generateContent.mock.calls[0][0] as { config: { abortSignal: AbortSignal } }).config.abortSignal.aborted).toBe(false);
  });
});

describe('pièces jointes (Files API, données en ligne)', () => {
  it('sans session : préparées puis nettoyées, y compris en cas d’échec', async () => {
    files.prepare.mockResolvedValue({ parts: [{ fileData: { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'application/pdf' } }], temporaryFileUris: ['https://generativelanguage.googleapis.com/v1beta/files/abc'] });
    await new GeminiProvider().call(appel({ attachments: [{ url: 'https://s3/doc.pdf', mimeType: 'application/pdf' }] }));
    expect(files.prepare).toHaveBeenCalledWith([{ url: 'https://s3/doc.pdf', mimeType: 'application/pdf' }], 'cle-bo');
    expect(files.cleanup).toHaveBeenCalledWith(['https://generativelanguage.googleapis.com/v1beta/files/abc'], 'cle-bo');

    sdk.generateContent.mockRejectedValue(new Error('boum'));
    files.cleanup.mockClear();
    await expect(new GeminiProvider().call(appel({ attachments: [{ url: 'https://s3/doc.pdf', mimeType: 'application/pdf' }] }))).rejects.toThrow('boum');
    expect(files.cleanup).toHaveBeenCalledWith(['https://generativelanguage.googleapis.com/v1beta/files/abc'], 'cle-bo');
  });

  it('avec session de la passerelle : préparation unique réutilisée par les replis, nettoyage par la session', async () => {
    files.prepare.mockResolvedValue({ parts: [{ text: 'contenu' }], temporaryFileUris: ['u1'] });
    const p = new GeminiProvider();
    const session = p.openAttachmentSession([{ url: 'https://s3/doc.pdf', mimeType: 'application/pdf' }]);
    expect(session).toBeInstanceOf(GeminiAttachmentSession);
    await p.call(appel({ attachmentSession: session }));
    await p.call(appel({ model: 'gemini-3.5-flash', attachmentSession: session }));
    expect(files.prepare).toHaveBeenCalledTimes(1);
    expect(sdk.generateContent.mock.calls[1][0].contents).toEqual([{ text: 'PROMPT' }, { text: 'contenu' }]);
    // L'appel ne nettoie rien : c'est la session qui libère.
    expect(files.cleanup).toHaveBeenCalledWith([], 'cle-bo');
    await session.release();
    expect(files.cleanup).toHaveBeenLastCalledWith(['u1'], 'cle-bo');
  });
});
