import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', async (orig) => {
  const vrai = await orig<typeof import('@/lib/api-client')>();
  return { ...vrai, apiClient: { refreshToken: vi.fn() } };
});
import { apiClient, HTTP_POLICIES } from '@/lib/api-client';
import { fetchDepot, messageSelonStatut, DelaiDepotDepasse } from '../upload-http';

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(apiClient.refreshToken).mockReset(); vi.useRealTimers(); });

/** `fetch` qui ne répond jamais, sauf abandon de son signal. */
const fetchSuspendu = () => vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
  init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
}));

describe('dépôt de document — erreurs lisibles', () => {
  it('donne un motif par statut quand la réponse n’a pas de message', () => {
    expect(messageSelonStatut(401, 'x')).toMatch(/session a expiré/);
    expect(messageSelonStatut(502, 'x')).toMatch(/momentanément indisponible \(erreur 502\)/);
    expect(messageSelonStatut(400, 'Échec')).toBe('Échec (erreur 400).');
  });

  it('renouvelle la session sur 401 puis rejoue la requête une seule fois', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":1}', { status: 201 }));
    vi.stubGlobal('fetch', f);
    vi.mocked(apiClient.refreshToken).mockResolvedValue(true);
    const res = await fetchDepot('/api/files/presign', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('ne rejoue pas si le renouvellement échoue', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', f);
    vi.mocked(apiClient.refreshToken).mockResolvedValue(false);
    expect((await fetchDepot('/x', {})).status).toBe(401);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('traduit une coupure réseau en message explicite', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    await expect(fetchDepot('/x', {})).rejects.toThrow(/Connexion au serveur impossible/);
  });
});

describe('dépôt de document — politique HTTP commune (lot 24, #12)', () => {
  const P = { attemptTimeoutMs: 1_000, totalBudgetMs: 2_500, maxNetworkRetries: 0, retryDelayMs: 0 };

  it('politique par défaut : celle des écritures d’api-client', () => {
    expect(HTTP_POLICIES.write.maxNetworkRetries).toBe(0);
  });

  it('en-têtes jamais reçus : délai dépassé (pas une annulation), une seule tentative', async () => {
    vi.useFakeTimers();
    const f = fetchSuspendu();
    vi.stubGlobal('fetch', f);
    const p = fetchDepot('/api/files/presign', { method: 'POST' }, P);
    const attendu = expect(p).rejects.toBeInstanceOf(DelaiDepotDepasse);
    await vi.advanceTimersByTimeAsync(1_001);
    await attendu;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('corps bloqué après des en-têtes rapides : couvert par le délai', async () => {
    vi.useFakeTimers();
    const corps = new ReadableStream({ start() { /* jamais terminé */ } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(corps, { status: 200 })));
    const p = fetchDepot('/api/files/confirm', { method: 'POST' }, P);
    const attendu = expect(p).rejects.toBeInstanceOf(DelaiDepotDepasse);
    await vi.advanceTimersByTimeAsync(1_001);
    await attendu;
  });

  it('annulation de l’appelant : AbortError, aucun rejeu', async () => {
    const f = fetchSuspendu();
    vi.stubGlobal('fetch', f);
    const c = new AbortController();
    const p = fetchDepot('/api/files/presign', { method: 'POST', signal: c.signal }, P);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(f).toHaveBeenCalledTimes(1);
    await expect(fetchDepot('/x', { signal: c.signal }, P)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('renouvellement lent : imputé au budget total, le 401 d’origine est rendu', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(new Response('{"code":"AUTH_REQUIRED"}', { status: 401 }));
    vi.stubGlobal('fetch', f);
    vi.mocked(apiClient.refreshToken).mockReturnValue(new Promise(() => undefined));
    const p = fetchDepot('/api/files/confirm', { method: 'POST' }, P);
    await vi.advanceTimersByTimeAsync(2_600);
    const res = await p;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'AUTH_REQUIRED' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('réponse sans corps (204) rendue telle quelle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect((await fetchDepot('/x', {}, P)).status).toBe(204);
  });
});
