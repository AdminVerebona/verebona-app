/**
 * Sources T2 (LOG-UI-07) et accès restreint au contenu (LOG-UI-08, WF-45).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (sql: string, p: unknown[]) => unsafe(sql, p) } }));
// §32.7 (lot 21) : consultation sensible aussi au journal des actions admin.
const audit = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (e: Record<string, unknown>) => audit(e) }));

const { getT2RequestSources, readT2Content, isContentAccessAllowed } = await import('../t2-request-detail.repository');

const REASON = 'Réclamation client n°1234 à instruire';
const logged = () => unsafe.mock.calls.filter(([q]) => /ai_t2_content_access_log/.test(String(q))).map(([, p]) => (p as unknown[])[4]);

beforeEach(() => { unsafe.mockReset(); unsafe.mockResolvedValue([]); audit.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe('sources T2', () => {
  it('liste les sources sans extrait de document', async () => {
    unsafe.mockResolvedValueOnce([{ message_id: 4, source_type: 'document', source_id: 'doc_5', title_snapshot: 'Facture', rank: 1, relevance_score: 0.9, is_available: true }]);
    const s = await getT2RequestSources('req-1');
    expect(s).toEqual([{ messageId: 4, sourceType: 'document', sourceId: 'doc_5', title: 'Facture', rank: 1, relevanceScore: 0.9, isAvailable: true }]);
    expect(String(unsafe.mock.calls[0][0])).not.toMatch(/excerpt_snapshot/);
  });
});

describe('contenu conversationnel : accès restreint', () => {
  it('justification obligatoire', async () => {
    const r = await readT2Content({ adminUserId: 1, requestId: 'r', reason: 'court' });
    expect(r).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
  });

  it('liste restreinte : refus tracé', async () => {
    vi.stubEnv('AI_T2_CONTENT_ADMIN_IDS', '7, 9');
    expect(isContentAccessAllowed(9)).toBe(true);
    const r = await readT2Content({ adminUserId: 1, requestId: 'r', reason: REASON });
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(logged()).toEqual(['DENIED']);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 1, action: 'ASSISTANT_CONTENT_READ', result: 'DENIED', details: expect.objectContaining({ requestId: 'r', result: 'DENIED' }),
    }));
  });

  it('fermé par défaut : sans liste, aucun administrateur n’y accède', async () => {
    vi.stubEnv('AI_T2_CONTENT_ADMIN_IDS', '');
    expect(isContentAccessAllowed(1)).toBe(false);
    const r = await readT2Content({ adminUserId: 1, requestId: 'r', reason: REASON });
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('contenu purgé ou expiré : plus rien n’est rendu', async () => {
    vi.stubEnv('AI_T2_CONTENT_ADMIN_IDS', '1');
    unsafe.mockImplementationOnce(async () => []);
    expect(await readT2Content({ adminUserId: 1, requestId: 'r', reason: REASON })).toMatchObject({ code: 'NOT_FOUND' });
    unsafe.mockImplementationOnce(async () => [{ account_id: 3, role: 'user', content: 'x', created_at: '2026-01-01T00:00:00Z', expires_at: '2026-04-01T00:00:00Z' }]);
    expect(await readT2Content({ adminUserId: 1, requestId: 'r', reason: REASON })).toMatchObject({ code: 'EXPIRED' });
  });

  it('contenu vivant : rendu et accès tracé GRANTED', async () => {
    vi.stubEnv('AI_T2_CONTENT_ADMIN_IDS', '1');
    const now = Date.now();
    unsafe.mockImplementationOnce(async () => [
      { account_id: 3, role: 'user', content: 'Quelle garantie ?', created_at: new Date(now - 86_400_000).toISOString(), expires_at: new Date(now + 86_400_000).toISOString() },
    ]);
    const r = await readT2Content({ adminUserId: 1, requestId: 'r', reason: REASON });
    expect(r).toMatchObject({ ok: true, accountId: 3 });
    expect(logged()).toEqual(['GRANTED']);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ASSISTANT_CONTENT_READ', result: 'SUCCESS' }));
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/Quelle garantie/);
  });
});
