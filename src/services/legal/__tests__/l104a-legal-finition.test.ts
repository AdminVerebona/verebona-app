/**
 * Lot 104A — finitions légales côté application (ticket « légal — finition »).
 *
 *   L104A-C  P1-C : aucune version CGUV importée sans vérification POSITIVE
 *            des octets de son texte figé (textUrl absent, réseau, 404,
 *            délai, SHA faux → refus ; conforme → accepté)
 *   L104A-D  P1-D : rattachement d'une archive APP_LEGACY seulement si
 *            empreinte publique === empreinte historique ET octets vérifiés
 *   L104A-E  P1-E : « non requis » ≠ « contrôle impossible » ; panne → écritures
 *            refusées (503 CGUV_CHECK_UNAVAILABLE), exemptions préservées
 *
 * Aucun appel réseau : `fetchImpl` injecté ; base simulée (`@/db` moqué).
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'down', row: null as Record<string, unknown> | null, calls: 0 }));
vi.mock('@/db', () => ({
  db: {},
  pgClient: Object.assign(async () => {
    db.calls += 1;
    if (db.mode === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    return db.row ? [db.row] : [];
  }, {}),
}));
vi.mock('@/services/admin/anomaly.service', () => ({
  reportAnomaly: vi.fn(async () => 1),
  autoResolveAnomaly: vi.fn(async () => true),
  buildFingerprint: (...p: string[]) => p.join(':'),
}));
vi.mock('../cguv-referential.service', async (orig) => {
  const real = await orig<typeof import('../cguv-referential.service')>();
  return { ...real, getPublicCurrentCguv: vi.fn(async () => ({ versionCode: '2026-11-15-v1', permalinkUrl: 'https://www.verebona.fr/legal/cguv/versions/2026-11-15-v1', changeSummary: 'Résumé', effectiveAt: new Date('2026-11-15T09:00:00Z') })) };
});

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const TEXT = '<!doctype html><meta charset="utf-8"><p>CGUV — version figée</p>';
const SHA = createHash('sha256').update(TEXT, 'utf8').digest('hex');
const URL_TXT = 'https://www.verebona.fr/legal/cguv/versions/2026-11-15-v1.html';
const ok = async () => new Response(TEXT, { status: 200 });

describe('L104A-C — vérification positive des octets avant import (P1-C)', () => {
  it('L104A-C1 — textUrl absent : refus explicite (jamais « sans conclusion »)', async () => {
    const { verifyTextBytes } = await import('../cguv-manifest');
    const r = await verifyTextBytes(null, SHA, { fetchImpl: ok });
    expect(r).toMatchObject({ ok: false, reason: 'TEXT_URL_MISSING' });
  });

  it('L104A-C2 — réseau indisponible (ancien « null ») : refus', async () => {
    const { verifyTextBytes, verifyTextSha256 } = await import('../cguv-manifest');
    const down = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    expect(await verifyTextBytes(URL_TXT, SHA, { fetchImpl: down })).toMatchObject({ ok: false, reason: 'NETWORK' });
    // Compatibilité : l'ancienne fonction rend toujours null… mais l'import ne l'utilise plus.
    expect(await verifyTextSha256(URL_TXT, SHA, { fetchImpl: down })).toBeNull();
    expect(lire('src/services/legal/cguv-referential.service.ts')).not.toMatch(/verifyTextSha256\(/);
  });

  it('L104A-C3 — 404, erreur HTTP, délai dépassé : refus', async () => {
    const { verifyTextBytes } = await import('../cguv-manifest');
    expect(await verifyTextBytes(URL_TXT, SHA, { fetchImpl: async () => new Response('', { status: 404 }) })).toMatchObject({ ok: false, reason: 'HTTP_NOT_FOUND' });
    expect(await verifyTextBytes(URL_TXT, SHA, { fetchImpl: async () => new Response('', { status: 500 }) })).toMatchObject({ ok: false, reason: 'HTTP_ERROR' });
    const slow = (_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    expect(await verifyTextBytes(URL_TXT, SHA, { fetchImpl: slow, timeoutMs: 20 })).toMatchObject({ ok: false, reason: 'TIMEOUT' });
  });

  it('L104A-C4 — SHA faux (octets servis différents) ou empreinte attendue invalide : refus', async () => {
    const { verifyTextBytes } = await import('../cguv-manifest');
    expect(await verifyTextBytes(URL_TXT, 'a'.repeat(64), { fetchImpl: ok })).toMatchObject({ ok: false, reason: 'SHA_MISMATCH', sha256: SHA });
    expect(await verifyTextBytes(URL_TXT, 'pas-une-empreinte', { fetchImpl: ok })).toMatchObject({ ok: false, reason: 'EXPECTED_SHA_INVALID' });
  });

  it('L104A-C5 — texte accessible et conforme : seul cas accepté (octets exacts, sans transformation)', async () => {
    const { verifyTextBytes } = await import('../cguv-manifest');
    expect(await verifyTextBytes(URL_TXT, SHA, { fetchImpl: ok })).toEqual({ ok: true, sha256: SHA, bytes: Buffer.byteLength(TEXT) });
    // Un octet de plus (fin de ligne ajoutée par un serveur) suffit à refuser.
    expect(await verifyTextBytes(URL_TXT, SHA, { fetchImpl: async () => new Response(`${TEXT}\n`) })).toMatchObject({ ok: false, reason: 'SHA_MISMATCH' });
  });

  it('L104A-C6 — type d’écart par cause (Supervision regroupée, BO, journal)', async () => {
    const { anomalyKindFor } = await import('../cguv-referential.service');
    expect(anomalyKindFor('TEXT_URL_MISSING')).toBe('TEXT_URL_MISSING');
    expect(anomalyKindFor('SHA_MISMATCH')).toBe('HASH_MISMATCH');
    for (const r of ['HTTP_NOT_FOUND', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK', 'TOO_LARGE'] as const) expect(anomalyKindFor(r)).toBe('TEXT_UNAVAILABLE');
  });

  it('L104A-C7 — import et activation conditionnés à `ok: true` ; saisie BO soumise à la même règle', () => {
    const src = lire('src/services/legal/cguv-referential.service.ts');
    expect(src).toMatch(/const check = await verify\(v\.textUrl, v\.sha256\);\s*if \(!check\.ok\) \{[\s\S]{0,300}continue;/);
    expect(src).toMatch(/CURRENT_NOT_VERIFIED/);
    expect(src).toMatch(/recordManualCguvVersion[\s\S]*verifyTextBytes\(v\.textUrl, v\.sha256/);
    expect(src).not.toMatch(/verifyTexts/);
  });
});

describe('L104A-D — rattachement d’une archive APP_LEGACY (P1-D)', () => {
  const verifyWith = (fetchImpl: (u: string) => Promise<Response>) => async (url: string | null, sha: string | null) => {
    const { verifyTextBytes } = await import('../cguv-manifest');
    return verifyTextBytes(url, sha, { fetchImpl });
  };

  it('L104A-D1 — archive identique (même empreinte, octets vérifiés) : rattachée', async () => {
    const { decideLegacyLink } = await import('../cguv-referential.service');
    expect(await decideLegacyLink({ historicSha256: SHA, publicSha256: SHA, textUrl: URL_TXT }, verifyWith(ok))).toEqual({ link: true });
  });

  it('L104A-D2 — fichier public modifié : empreinte annoncée différente, ou octets différents → pas de rattachement', async () => {
    const { decideLegacyLink } = await import('../cguv-referential.service');
    const r1 = await decideLegacyLink({ historicSha256: SHA, publicSha256: 'b'.repeat(64), textUrl: URL_TXT }, verifyWith(ok));
    expect(r1).toMatchObject({ link: false });
    expect((r1 as { detail: string }).detail).toMatch(/différente de l’empreinte historique/);
    // Le manifeste annonce la bonne empreinte mais le fichier servi a changé.
    const r2 = await decideLegacyLink({ historicSha256: SHA, publicSha256: SHA, textUrl: URL_TXT }, verifyWith(async () => new Response('<p>texte régénéré</p>')));
    expect(r2).toMatchObject({ link: false });
  });

  it('L104A-D3 — fichier absent (404) ou textUrl manquant : pas de rattachement', async () => {
    const { decideLegacyLink } = await import('../cguv-referential.service');
    expect(await decideLegacyLink({ historicSha256: SHA, publicSha256: SHA, textUrl: URL_TXT }, verifyWith(async () => new Response('', { status: 404 })))).toMatchObject({ link: false });
    expect(await decideLegacyLink({ historicSha256: SHA, publicSha256: SHA, textUrl: null }, verifyWith(ok))).toMatchObject({ link: false });
    expect(await decideLegacyLink({ historicSha256: null, publicSha256: SHA, textUrl: URL_TXT }, verifyWith(ok))).toMatchObject({ link: false });
  });

  it('L104A-D4 — reprise après correction : même décision, fichier corrigé → rattachée', async () => {
    const { decideLegacyLink } = await import('../cguv-referential.service');
    let body = '<p>mauvais fichier</p>';
    const site = async () => new Response(body);
    expect((await decideLegacyLink({ historicSha256: SHA, publicSha256: SHA, textUrl: URL_TXT }, verifyWith(site))).link).toBe(false);
    body = TEXT;
    expect((await decideLegacyLink({ historicSha256: SHA, publicSha256: SHA, textUrl: URL_TXT }, verifyWith(site))).link).toBe(true);
  });

  it('L104A-D5 — preuve et permalien : un rattachement incohérent n’est jamais utilisé (archive d’origine)', async () => {
    const { hasVerifiedPublicLink } = await import('../cguv-referential.service');
    expect(hasVerifiedPublicLink({ sha256: SHA, publicPermalink: 'https://x/legal/cguv/versions/a', publicSha256: SHA })).toBe(true);
    expect(hasVerifiedPublicLink({ sha256: SHA, publicPermalink: 'https://x/legal/cguv/versions/a', publicSha256: 'e'.repeat(64) })).toBe(false);
    expect(hasVerifiedPublicLink({ sha256: SHA, publicPermalink: null, publicSha256: null })).toBe(false);
    expect(lire('src/services/legal/legal-redirects.ts')).toMatch(/found\.source === 'APP_LEGACY' && !hasVerifiedPublicLink\(found\)/);
  });
});

describe('L104A-E — réacceptation : contrôle impossible ≠ non requis (P1-E)', () => {
  beforeEach(async () => {
    db.mode = 'ok'; db.row = null; db.calls = 0;
    const { serverCacheClear } = await import('@/lib/server-cache');
    serverCacheClear();
  });

  it('L104A-E1 — panne de base : la garde LÈVE CGUV_CHECK_UNAVAILABLE (jamais « non requis ») ; l’état servi vaut « unavailable »', async () => {
    db.mode = 'down';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = await import('../cguv-reacceptance.service');
    await expect(svc.isReacceptanceRequired(7)).rejects.toThrow('CGUV_CHECK_UNAVAILABLE');
    expect(await svc.getReacceptanceState(7)).toMatchObject({ required: false, status: 'unavailable' });
    await svc.flushReacceptanceSupervision();
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    expect(reportAnomaly).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: 'other:legal-reacceptance:unavailable' }));
    // Journal sans secret : code stable, identifiant interne, aucune donnée de session.
    expect(String(err.mock.calls[0]?.[0])).toMatch(/CGUV_CHECK_UNAVAILABLE utilisateur=7/);
    err.mockRestore();
  });

  it('L104A-E2 — état inconnu : version substantielle due sans version en vigueur → contrôle impossible', async () => {
    const { decideReacceptance } = await import('../cguv-reacceptance.service');
    expect(decideReacceptance({ substantial_code: '2026-11-15-v1', accepted: false, has_current: false })).toMatchObject({ status: 'unavailable', reason: 'NO_CURRENT_VERSION' });
  });

  it('L104A-E3 — vraie version non substantielle / acceptée / transition : non requis ; substantielle non acceptée : requis', async () => {
    const { decideReacceptance } = await import('../cguv-reacceptance.service');
    expect(decideReacceptance({ substantial_code: null, accepted: null, has_current: true })).toEqual({ status: 'not_required' });
    expect(decideReacceptance({ substantial_code: '2026-11-15-v1', accepted: true, has_current: true })).toEqual({ status: 'not_required' });
    expect(decideReacceptance({ substantial_code: '2026-11-15-v1', accepted: false, has_current: true })).toEqual({ status: 'required', substantialVersionCode: '2026-11-15-v1' });
  });

  it('L104A-E4 — acceptation et cache : seul « non requis » est mis en cache ; oubli à l’acceptation et à toute évolution du référentiel', async () => {
    const svc = await import('../cguv-reacceptance.service');
    db.row = { substantial_code: null, accepted: null, has_current: true, next_effective_at: null };
    expect(await svc.isReacceptanceRequired(9)).toBe(false);
    expect(await svc.isReacceptanceRequired(9)).toBe(false);
    expect(db.calls).toBe(1); // second appel servi par le cache
    // Publication d'une version substantielle : le cache n'est plus servi.
    svc.onCguvReferentialChanged();
    db.row = { substantial_code: '2026-11-15-v1', accepted: false, has_current: true, next_effective_at: null };
    expect(await svc.isReacceptanceRequired(9)).toBe(true);
    expect(await svc.isReacceptanceRequired(9)).toBe(true);
    expect(db.calls).toBe(3); // « requis » jamais mis en cache
    // Panne APRÈS un « non requis » en cache : le cache (≤ 60 s) reste valable, puis la garde refuse.
    db.row = { substantial_code: null, accepted: null, has_current: true, next_effective_at: null };
    svc.forgetReacceptanceCache(9);
    expect(await svc.isReacceptanceRequired(9)).toBe(false);
  });

  it('L104A-E5 — effectiveAt : le cache d’un « non requis » n’enjambe jamais l’entrée en vigueur de la prochaine version substantielle', async () => {
    const { notRequiredCacheMs, REACCEPTANCE_NOT_REQUIRED_CACHE_MS } = await import('../cguv-reacceptance.service');
    const now = Date.parse('2026-11-15T08:59:50Z');
    expect(notRequiredCacheMs(null, now)).toBe(REACCEPTANCE_NOT_REQUIRED_CACHE_MS);
    expect(notRequiredCacheMs('2026-11-15T09:00:00Z', now)).toBe(10_000);
    expect(notRequiredCacheMs('2026-11-16T09:00:00Z', now)).toBe(REACCEPTANCE_NOT_REQUIRED_CACHE_MS);
    const src = lire('src/services/legal/cguv-reacceptance.service.ts');
    expect(src).toMatch(/COALESCE\(effective_at, published_at\) <= now\(\)/);
    expect(src).toMatch(/v\.published_at >= s\.published_at/); // acceptation d'une version postérieure
  });

  it('L104A-E6 — réponse HTTP : 503 au code stable, message explicite, Retry-After ; jamais une déconnexion', async () => {
    const { sessionErrorToResponse, isKnownSessionError } = await import('@/lib/auth/session-errors');
    const e = new Error('CGUV_CHECK_UNAVAILABLE');
    expect(isKnownSessionError(e)).toBe(true);
    const res = sessionErrorToResponse(e, 'req-104a');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = await res.json();
    expect(body.code).toBe('CGUV_CHECK_UNAVAILABLE');
    expect(body.message).toMatch(/CGUV/);
    expect(body.message).toMatch(/exporter/);
  });

  it.each([
    ['GET', '/api/assets'], ['POST', '/api/users/me/gdpr-export'], ['GET', '/api/users/me/gdpr-export/download'],
    ['POST', '/api/auth/logout'], ['POST', '/api/me/legal/cguv/accept'], ['GET', '/api/legal/cguv/current'],
    ['POST', '/api/billing/cancel-subscription'], ['POST', '/api/withdrawal/public/request'], ['DELETE', '/api/users/me/deletion'],
  ])('L104A-E7 — exemption d’API conservée pendant un contrôle impossible : %s %s', async (method, path) => {
    const { isApiAllowedDuringReacceptance } = await import('@/lib/legal/reacceptance-gate');
    expect(isApiAllowedDuringReacceptance(path, method)).toBe(true);
  });

  it('L104A-E8 — web et mobile : bandeau « modifications suspendues » (même coquille), écran dédié seulement si une version est à accepter', async () => {
    const { reacceptanceStatusOf, REACCEPTANCE_UNAVAILABLE, NO_REACCEPTANCE } = await import('@/lib/legal/reacceptance-gate');
    expect(reacceptanceStatusOf(REACCEPTANCE_UNAVAILABLE)).toBe('unavailable');
    expect(reacceptanceStatusOf(NO_REACCEPTANCE)).toBe('not_required');
    expect(reacceptanceStatusOf({ required: true })).toBe('required'); // serveur antérieur
    const shell = lire('src/components/DashboardLayout.tsx');
    expect(shell).toMatch(/CGUV_CHECK_UNAVAILABLE_EVENT/);
    expect(shell).toMatch(/<CguvCheckUnavailableNotice \/>/);
    expect(lire('src/lib/api-client.ts')).toMatch(/errorData\.code === CGUV_CHECK_UNAVAILABLE_CODE/);
    // Mobile : la vue de l'application utilise la même coquille, lien de lecture via LegalLink (103A).
    expect(lire('src/components/shell/CguvReacceptanceScreen.tsx')).toMatch(/<LegalLink /);
  });
});
