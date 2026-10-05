import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { verifyRequestOrigin } from '../csrf';

function req(origin: string, headers: Record<string, string> = {}) {
  return new NextRequest('http://10.0.0.1:3000/api/auth/login', { method: 'POST', headers: { origin, ...headers } });
}

describe('CSRF derrière le routeur Scalingo', () => {
  it('accepte une requête de même origine identifiée par x-forwarded-host/proto', () => {
    const r = req('https://preprod.verebona.fr', { 'x-forwarded-host': 'preprod.verebona.fr', 'x-forwarded-proto': 'https' });
    expect(verifyRequestOrigin(r).allowed).toBe(true);
  });

  it('refuse toujours une origine tierce', () => {
    const r = req('https://evil.example', { 'x-forwarded-host': 'preprod.verebona.fr', 'x-forwarded-proto': 'https' });
    expect(verifyRequestOrigin(r)).toMatchObject({ allowed: false, reason: 'FOREIGN_ORIGIN' });
  });

  it('refuse sans Origin ni Referer', () => {
    const r = new NextRequest('http://10.0.0.1:3000/api/files/presign', { method: 'POST' });
    expect(verifyRequestOrigin(r)).toMatchObject({ allowed: false, reason: 'MISSING_ORIGIN' });
  });
});
