/**
 * PROV-UI-05, WF-21 — la clé activée dans le BO sert réellement au runtime.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getProviderSecret, invalidateProviderSecretCache, setProviderSecretResolver,
} from '../provider-secret';
import { GeminiProvider } from '../../gateway/providers/gemini.provider';

afterEach(() => setProviderSecretResolver(null));

describe('clé fournisseur au runtime', () => {
  it('lit la clé administrée, la met en cache, la relit après activation', async () => {
    let cle = 'cle-A';
    const resolver = vi.fn(async () => cle);
    setProviderSecretResolver(resolver);

    await expect(getProviderSecret()).resolves.toBe('cle-A');
    cle = 'cle-B';
    // Cache (60 s) : pas de relecture à chaque appel.
    await expect(getProviderSecret()).resolves.toBe('cle-A');
    expect(resolver).toHaveBeenCalledTimes(1);

    // `activateCandidate` vide le cache : la nouvelle clé sert immédiatement.
    invalidateProviderSecretCache();
    await expect(getProviderSecret()).resolves.toBe('cle-B');
  });

  it('source illisible : repli sur la variable d’environnement', async () => {
    setProviderSecretResolver(async () => { throw new Error('base indisponible'); });
    process.env.GEMINI_API_KEY = 'cle-env';
    await expect(getProviderSecret()).resolves.toBe('cle-env');
  });

  it('isConfigured suit la même source que call()', async () => {
    const p = new GeminiProvider();
    setProviderSecretResolver(async () => null);
    await expect(p.isConfigured()).resolves.toBe(false);
    await expect(p.call({ model: 'm', prompt: 'x', attachments: [], timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    setProviderSecretResolver(async () => 'cle-bo');
    await expect(p.isConfigured()).resolves.toBe(true);
  });
});
