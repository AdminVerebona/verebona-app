/**
 * Retours sur les articles — CDC Centre d'aide V1 FEEDBACK-01, FEEDBACK-02.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) }, ensureMigrations: vi.fn(async () => {}) }));
const loadHelpCorpus = vi.fn(async (): Promise<unknown> => null);
vi.mock('@/services/verebona-assistant/core/help-corpus.service', () => ({ loadHelpCorpus: () => loadHelpCorpus() }));

const svc = await import('../help-feedback.service');
const { POST: vote } = await import('@/app/api/public/help-feedback/route');
const { POST: comment } = await import('@/app/api/public/help-feedback/comment/route');

const req = (url: string, body: unknown, ip = '203.0.113.7') => new NextRequest(`https://app.verebona.fr${url}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-real-ip': ip, origin: 'https://www.verebona.fr' },
});

beforeEach(() => { unsafe.mockReset(); svc.resetFeedbackRateLimit(); vi.stubEnv('NEXT_PUBLIC_PUBLIC_SITE_URL', 'https://www.verebona.fr'); });

describe('FEEDBACK-01 — vote sans authentification', () => {
  it('enregistre ID d’article, choix et version', async () => {
    unsafe.mockResolvedValue([{ id: '11111111-1111-1111-1111-111111111111' }]);
    const res = await vote(req('/api/public/help-feedback', { articleId: 'AID-DOC-001', helpful: true, contentVersion: 'v1' }));
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.verebona.fr');
    expect(unsafe.mock.calls[0][1].slice(0, 3)).toEqual(['AID-DOC-001', true, 'v1']);
    expect(await res.json()).toEqual({ feedbackId: '11111111-1111-1111-1111-111111111111', commentToken: null });
  });

  it('rend un jeton de commentaire pour « Non », et n’en stocke que le condensat', async () => {
    unsafe.mockResolvedValue([{ id: '11111111-1111-1111-1111-111111111111' }]);
    const body = await (await vote(req('/api/public/help-feedback', { articleId: 'AID-DOC-001', helpful: false }))).json();
    expect(body.commentToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const stored = unsafe.mock.calls[0][1][3] as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(body.commentToken);
  });

  it('refuse un article absent du corpus publié ici', async () => {
    loadHelpCorpus.mockResolvedValueOnce({ articles: [{ id: 'AID-DOC-001' }] });
    expect((await vote(req('/api/public/help-feedback', { articleId: 'AID-DOC-999', helpful: true }))).status).toBe(400);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('refuse un article mal formé ou un choix absent', async () => {
    expect((await vote(req('/api/public/help-feedback', { articleId: 'creer-un-bien', helpful: true }))).status).toBe(400);
    expect((await vote(req('/api/public/help-feedback', { articleId: 'AID-DOC-001' }))).status).toBe(400);
    expect(unsafe).not.toHaveBeenCalled();
  });
});

describe('FEEDBACK-02 — commentaire limité, nettoyé, débit limité', () => {
  it('retire balises, caractères de contrôle et borne la longueur', () => {
    expect(svc.sanitizeComment('  <b>Il manque</b>\u0000 l’étape\n\n\n\nfinale  ')).toBe('bIl manque/b l’étape\n\nfinale');
    expect(svc.sanitizeComment('x'.repeat(5000))!.length).toBe(svc.MAX_COMMENT_LENGTH);
    expect(svc.sanitizeComment('   ')).toBeNull();
    expect(svc.sanitizeComment(42)).toBeNull();
  });

  it('n’accepte un commentaire qu’avec le jeton du vote', async () => {
    unsafe.mockResolvedValue([]);
    const res = await comment(req('/api/public/help-feedback/comment', {
      feedbackId: '11111111-1111-1111-1111-111111111111', commentToken: 'faux', comment: 'Il manque une étape.',
    }));
    expect(res.status).toBe(409);
  });

  it('enregistre le commentaire nettoyé', async () => {
    unsafe.mockResolvedValue([{ id: 'x' }]);
    const res = await comment(req('/api/public/help-feedback/comment', {
      feedbackId: '11111111-1111-1111-1111-111111111111', commentToken: 'jeton', comment: '<script>x</script> manque',
    }));
    expect(res.status).toBe(200);
    expect(unsafe.mock.calls[0][1][2]).toBe('scriptx/script manque');
  });

  it('limite le débit par adresse', async () => {
    unsafe.mockResolvedValue([{ id: '11111111-1111-1111-1111-111111111111' }]);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await vote(req('/api/public/help-feedback', { articleId: 'AID-DOC-001', helpful: true }))).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    expect((await vote(req('/api/public/help-feedback', { articleId: 'AID-DOC-001', helpful: true }, '198.51.100.1'))).status).toBe(201);
  });
});
