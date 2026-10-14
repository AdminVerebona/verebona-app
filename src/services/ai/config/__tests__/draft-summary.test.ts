/**
 * DRF-01 — versions non actives détaillées du tableau de bord IA (lot 54 :
 * plus de brouillons).
 */
import { describe, it, expect, vi } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) } }));

const { listDraftSummaries, authorName } = await import('../draft-summary.repository');

describe('listDraftSummaries', () => {
  it('joint l’origine et l’auteur, versions non actives et non supprimées de l’environnement', async () => {
    unsafe.mockResolvedValueOnce([
      {
        id: 9, uid: 'abc', visible_number: 4, current_revision_number: 2, label: null, created_at: '2026-09-20T10:00:00Z',
        base_version_id: 3, base_visible_number: 3, base_label: 'Sept.', first_name: 'Alice', last_name: 'Martin', email: 'a@x.fr',
      },
      { id: 10, uid: 'def', label: 'Premier', is_stale: false, created_at: '2026-09-21T10:00:00Z', base_version_id: null },
    ]);
    const r = await listDraftSummaries('preprod', 5);
    expect(r[0]).toEqual({
      id: 9, uid: 'abc', visibleNumber: 4, revisionNumber: 2, label: null, isStale: false, createdAt: '2026-09-20T10:00:00.000Z',
      base: { id: 3, visibleNumber: 3, label: 'Sept.' }, author: 'Alice Martin',
    });
    expect(r[1]).toMatchObject({ base: null, author: null });
    const [sql, params] = unsafe.mock.calls[0];
    expect(String(sql)).toMatch(/status <> 'ACTIVE' AND v\.deleted_at IS NULL/);
    expect(params).toEqual(['preprod', 5]);
  });

  it('auteur : nom complet, sinon e-mail', () => {
    expect(authorName({ first_name: '', last_name: '', email: 'b@x.fr' })).toBe('b@x.fr');
  });
});
