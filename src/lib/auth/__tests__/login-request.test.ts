/**
 * Connexion (mobile, 5 oct. 2026) : une reprise automatique sur coupure
 * réseau, journal sans identifiants.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { postLogin, isNetworkError, type LoginNetworkLog } from '../login-request';

const creds = { email: 'jean@exemple.fr', password: 'S3cret-Mot-De-Passe' };
const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

function deps(fetchImpl: (...a: unknown[]) => Promise<Response>) {
  const logs: LoginNetworkLog[] = [];
  const sleep = vi.fn(async () => {});
  return { logs, sleep, d: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep, log: (l: LoginNetworkLog) => logs.push(l), online: () => true } };
}

describe('postLogin', () => {
  it('coupure réseau puis succès : une seule reprise, transparente', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce(ok());
    const { logs, sleep, d } = deps(f);
    const r = await postLogin(creds, d);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([expect.objectContaining({ event: 'login.network_error', attempt: 1, willRetry: true, online: true, errorName: 'TypeError', errorMessage: 'Load failed' })]);
  });

  it('coupure persistante : deux tentatives au plus, puis l’erreur remonte', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { logs, d } = deps(f);
    await expect(postLogin(creds, d)).rejects.toBeInstanceOf(TypeError);
    expect(f).toHaveBeenCalledTimes(2);
    expect(logs.map((l) => l.willRetry)).toEqual([true, false]);
  });

  it('réponse du serveur (401, 429, 500) : jamais rejouée', async () => {
    for (const status of [401, 429, 500]) {
      const f = vi.fn().mockResolvedValue(new Response('{}', { status }));
      const { d } = deps(f);
      expect((await postLogin(creds, d)).status).toBe(status);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('annulation volontaire (AbortError) : pas de reprise', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const f = vi.fn().mockRejectedValue(abort);
    const { d } = deps(f);
    await expect(postLogin(creds, d)).rejects.toBe(abort);
    expect(f).toHaveBeenCalledTimes(1);
    expect(isNetworkError(abort)).toBe(false);
  });

  it('journal sans mot de passe ni e-mail ; requête identique à chaque tentative', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce(ok());
    const { logs, d } = deps(f);
    await postLogin(creds, d);
    const journal = JSON.stringify(logs);
    expect(journal).not.toContain(creds.password);
    expect(journal).not.toContain(creds.email);
    expect(f.mock.calls[0]).toEqual(f.mock.calls[1]);
    expect(f.mock.calls[0][0]).toBe('/api/auth/login');
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
  });
});

describe('écran de connexion', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/(auth)/login/page.tsx'), 'utf8');
  it('utilise postLogin', () => {
    expect(page).toContain('await postLogin({ email, password })');
  });
});
