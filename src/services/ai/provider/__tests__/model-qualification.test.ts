/**
 * Lot 35B — qualification technique automatique (CAT-03) : épreuves réelles
 * par le port fournisseur (injecté ici), échec transitoire ≠ échec.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const Q = await import('../model-qualification.service');
type Input = Parameters<Parameters<typeof Q.qualifyModel>[1]>[0];

/** Fournisseur simulé : chaque épreuve reconnue par sa forme d'appel. */
function fournisseur(over: Partial<Record<'generate' | 'structured' | 'multimodal' | 'thinking', (i: Input) => string | Error>> = {}) {
  const appels: Input[] = [];
  const call = vi.fn(async (i: Input) => {
    appels.push(i);
    const kind = i.responseSchema ? 'structured' : i.attachments.length ? 'multimodal' : i.reasoning === 'étendu' ? 'thinking' : 'generate';
    const r = over[kind]?.(i) ?? (kind === 'structured' ? '{"ok":true,"mot":"verebona"}' : kind === 'multimodal' ? 'Rouge' : kind === 'thinking' ? '51' : 'OK');
    if (r instanceof Error) throw r;
    return { rawText: r, inputTokens: 5, outputTokens: 2 };
  });
  return { call, appels };
}

describe('CAT-03 — épreuves de qualification', () => {
  it('modèle compatible : génération, schéma JSON, multimodal et raisonnement qualifiés', async () => {
    const f = fournisseur();
    const r = await Q.qualifyModel('gemini-9-flash', f.call, { supportsThinking: true, thinkingConfigured: () => true });
    expect(r).toEqual({ generate: true, structured: true, multimodal: true, thinking: true, errors: {} });
    // Schéma JSON imposé (structured output) et image synthétique en entrée.
    expect(f.appels.find((a) => a.responseSchema)?.responseSchema).toEqual(Q.QUALIFICATION_SCHEMA);
    expect(f.appels.find((a) => a.attachments.length)?.attachments[0]).toMatchObject({ mimeType: 'image/png', data: Q.QUALIFICATION_IMAGE_PNG });
  });

  it('JSON non conforme au schéma (clé en trop, type faux, texte libre) : structured = false', async () => {
    for (const sortie of ['{"ok":true,"mot":"v","x":1}', '{"ok":"oui","mot":"v"}', 'Voici : ok', '```json\n{"ok":false,"mot":"v"}\n```']) {
      const r = await Q.qualifyModel('m', fournisseur({ structured: () => sortie }).call, {});
      expect(r.structured, sortie).toBe(false);
    }
    expect(Q.conformsToQualificationSchema('```json\n{"ok":true,"mot":"verebona"}\n```')).toBe(true);
  });

  it('entrée image refusée (400) : multimodal = false, le reste qualifié', async () => {
    const r = await Q.qualifyModel('m', fournisseur({ multimodal: () => new Error('400 INVALID_ARGUMENT image input not supported') }).call, { thinkingConfigured: () => true });
    expect(r).toMatchObject({ generate: true, structured: true, multimodal: false, thinking: true });
    expect(r.errors.multimodal).toMatch(/400/);
  });

  it('génération refusée (404) : échec définitif, autres épreuves non jouées', async () => {
    const f = fournisseur({ generate: () => new Error('404 model not found for API version v1beta') });
    const r = await Q.qualifyModel('m', f.call, {});
    expect(r).toMatchObject({ generate: false, structured: null, multimodal: null, thinking: null });
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it('échec transitoire (429, délai, 503) : NON CONCLUANT (null), jamais false — rien n’est enregistré', async () => {
    for (const e of ['429 RESOURCE_EXHAUSTED', 'Timeout après 30000 ms', '503 UNAVAILABLE']) {
      const r = await Q.qualifyModel('m', fournisseur({ generate: () => new Error(e) }).call, {});
      expect(r.generate, e).toBeNull();
      expect(await Q.recordQualification('m', 'cle', r)).toBe(false);
    }
    const r = await Q.qualifyModel('m', fournisseur({ structured: () => new Error('429 quota') }).call, {});
    expect(r).toMatchObject({ generate: true, structured: null });
  });

  it('raisonnement : refusé par le catalogue Google → false sans appel ; famille sans réglage connu → déclaration Google', async () => {
    const f = fournisseur();
    expect((await Q.qualifyModel('m', f.call, { supportsThinking: false })).thinking).toBe(false);
    expect(f.appels.some((a) => a.reasoning === 'étendu')).toBe(false);
    expect((await Q.qualifyModel('m', fournisseur().call, { supportsThinking: true, thinkingConfigured: () => false })).thinking).toBe(true);
    expect((await Q.qualifyModel('m', fournisseur().call, { supportsThinking: null, thinkingConfigured: () => false })).thinking).toBeNull();
  });

  it('la clé n’apparaît jamais dans les erreurs conservées', async () => {
    const r = await Q.qualifyModel('m', fournisseur({ multimodal: () => new Error('400 bad request key=cle-secrete-123') }).call, { secret: 'cle-secrete-123' });
    expect(r.errors.multimodal).not.toContain('cle-secrete-123');
  });

  it('requalification : jamais qualifié, version changée, échec > 7 j, succès > 30 j', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const q = (over: Partial<import('../model-qualification.service').StoredQualification>) => ({
      generate: true, structured: true, multimodal: true, thinking: null, errors: {}, qualifiedAt: '2026-10-05T00:00:00Z', version: Q.QUALIFICATION_VERSION, ...over,
    });
    expect(Q.needsQualification(undefined, now)).toBe(true);
    expect(Q.needsQualification(q({}), now)).toBe(false);
    expect(Q.needsQualification(q({ version: 'qualif-v0' }), now)).toBe(true);
    expect(Q.needsQualification(q({ structured: false, qualifiedAt: '2026-10-01T00:00:00Z' }), now)).toBe(true);
    expect(Q.needsQualification(q({ qualifiedAt: '2026-09-01T00:00:00Z' }), now)).toBe(true);
  });
});
