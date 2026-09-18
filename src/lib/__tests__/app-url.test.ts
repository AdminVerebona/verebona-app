import { describe, it, expect, vi } from 'vitest';
import { getAppBaseUrl } from '@/lib/app-url';

const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers: new Headers(headers) });
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('getAppBaseUrl', () => {
  it('privilégie NEXT_PUBLIC_APP_URL, sans slash final ni chemin', () => {
    expect(getAppBaseUrl(
      req('http://localhost:26057/api/billing/create-checkout-session'),
      env({ NEXT_PUBLIC_APP_URL: 'https://app.preprod.verebona.fr/' }),
    )).toBe('https://app.preprod.verebona.fr');
  });

  it('utilise les en-têtes du proxy à défaut', () => {
    expect(getAppBaseUrl(
      req('http://localhost:26057/x', { 'x-forwarded-host': 'app.preprod.verebona.fr', 'x-forwarded-proto': 'https' }),
      env({}),
    )).toBe('https://app.preprod.verebona.fr');
  });

  it('retient la première valeur d\'en-têtes multiples', () => {
    expect(getAppBaseUrl(
      req('http://localhost:26057/x', { 'x-forwarded-host': 'app.verebona.fr, proxy.interne', 'x-forwarded-proto': 'https,http' }),
      env({}),
    )).toBe('https://app.verebona.fr');
  });

  it('se rabat sur Host puis sur l\'URL en local', () => {
    expect(getAppBaseUrl(req('http://localhost:3001/x', { host: 'localhost:3001' }), env({}))).toBe('http://localhost:3001');
    expect(getAppBaseUrl(req('http://localhost:3001/x'), env({}))).toBe('http://localhost:3001');
  });

  it('signale une URL déduite locale hors environnement local', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getAppBaseUrl(req('http://localhost:26057/x', { host: 'localhost:26057' }), env({ NEXT_PUBLIC_APP_ENV: 'preprod' }));
    expect(warn).toHaveBeenCalled();
  });

  it('ignore une valeur configurée invalide', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(getAppBaseUrl(
      req('http://x/y', { 'x-forwarded-host': 'app.verebona.fr', 'x-forwarded-proto': 'https' }),
      env({ NEXT_PUBLIC_APP_URL: 'pas une url' }),
    )).toBe('https://app.verebona.fr');
  });

  it('ignore une adresse configurée locale quand la requête arrive par un hôte public', () => {
    // Cas constaté : NEXT_PUBLIC_APP_URL=http://localhost:3001 recopiée sur
    // l'hébergement, Stripe renvoyait vers localhost après paiement.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getAppBaseUrl(
      req('http://localhost:26057/x', { 'x-forwarded-host': 'app.preprod.verebona.fr', 'x-forwarded-proto': 'https' }),
      env({ NEXT_PUBLIC_APP_URL: 'http://localhost:3001' }),
    )).toBe('https://app.preprod.verebona.fr');
  });

  it('APP_URL, lue à l’exécution, passe avant NEXT_PUBLIC_APP_URL', () => {
    expect(getAppBaseUrl(
      req('http://localhost:26057/x'),
      env({ APP_URL: 'https://app.verebona.fr', NEXT_PUBLIC_APP_URL: 'https://autre.exemple' }),
    )).toBe('https://app.verebona.fr');
  });

  it('garde une adresse locale configurée en développement local', () => {
    expect(getAppBaseUrl(
      req('http://localhost:3001/x', { host: 'localhost:3001' }),
      env({ NEXT_PUBLIC_APP_URL: 'http://localhost:3001' }),
    )).toBe('http://localhost:3001');
  });
});
