import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiClient: { refreshToken: vi.fn() } }));
import { apiClient } from '@/lib/api-client';
import { fetchDepot, messageSelonStatut } from '../upload-http';

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(apiClient.refreshToken).mockReset(); });

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
