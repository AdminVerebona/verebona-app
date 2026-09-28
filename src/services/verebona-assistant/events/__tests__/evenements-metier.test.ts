/**
 * Événements métier de l'assistant — CDC §25.7, §31.4.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ unsafe: vi.fn(async (_sql: string, _p?: unknown[]) => [] as unknown[]) }));
vi.mock('@/db', () => ({ pgClient: { unsafe: h.unsafe }, ensureMigrations: vi.fn(async () => {}) }));

const bus = await import('../business-events');
const { registerAssistantBusinessEventHandlers, resetAssistantHandlersForTests, purgeAccountModelCache } = await import('../handlers');
const { cachedRetrieve, clearRetrievalCache, retrievalCacheSize } = await import('../../core/retrieval-cache');
const { routeForIntent } = await import('../../core/intent-router.service');

const INPUT = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'mes factures', clientRequestId: 'c', locale: 'fr-FR' };
const ROUTE = routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't');

beforeEach(() => {
  bus.resetBusinessEventsForTests();
  resetAssistantHandlersForTests();
  clearRetrievalCache();
  h.unsafe.mockReset();
  h.unsafe.mockImplementation(async () => []);
});

describe('bus d’événements (§25.7)', () => {
  it('catalogue fermé des 14 événements du CDC', () => {
    expect(bus.ASSISTANT_BUSINESS_EVENTS).toHaveLength(14);
    expect(bus.isAssistantBusinessEvent('DOCUMENT_DELETED')).toBe(true);
    expect(bus.isAssistantBusinessEvent('ASSISTANT_SENDS_MESSAGE')).toBe(false);
  });

  it('un type hors catalogue est ignoré ; les compteurs suivent les émissions', async () => {
    await bus.emitBusinessEvent({ type: 'NOPE' as never, accountId: 1 });
    await bus.emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: 1, entityId: 4 });
    await bus.emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: 1, entityId: 5 });
    expect(bus.businessEventCounters().ASSET_UPDATED).toBe(2);
  });

  it('un abonné en échec n’empêche ni les autres ni l’émetteur', async () => {
    const vus: string[] = [];
    bus.onBusinessEvent('casse', () => { throw new Error('boum'); });
    bus.onBusinessEvent('ok', (e) => { vus.push(e.type); });
    await expect(bus.emitBusinessEvent({ type: 'PLAN_CHANGED', accountId: 2 })).resolves.toBeUndefined();
    expect(vus).toEqual(['PLAN_CHANGED']);
  });
});

describe('consommateurs : caches de l’assistant (§31.4)', () => {
  it('tout événement du compte invalide son cache de retrieval, pas celui des autres', async () => {
    registerAssistantBusinessEventHandlers();
    const f = vi.fn(async () => []);
    await cachedRetrieve(ROUTE, INPUT, f, 300);
    await cachedRetrieve(ROUTE, { ...INPUT, accountId: 8 }, f, 300);
    expect(retrievalCacheSize()).toBe(2);
    await bus.emitBusinessEvent({ type: 'DOCUMENT_ANALYSIS_COMPLETED', accountId: 7, entityId: 12 });
    expect(retrievalCacheSize()).toBe(1);
    // Événement global (article d'aide publié) : tout est vidé.
    await bus.emitBusinessEvent({ type: 'HELP_ENTRY_PUBLISHED', accountId: null });
    expect(retrievalCacheSize()).toBe(0);
  });

  it('une suppression purge les réponses modèle en cache des fils du compte', async () => {
    registerAssistantBusinessEventHandlers();
    h.unsafe.mockImplementation(async (sql: string) => (/FROM verebona_conversations/.test(sql) ? [{ id: 5 }, { id: 6 }] : [1, 1]));
    await bus.emitBusinessEvent({ type: 'DOCUMENT_DELETED', accountId: 7, entityId: 12 });
    const purge = h.unsafe.mock.calls.find(([sql]) => /DELETE FROM ai_operation_idempotency/.test(String(sql)));
    expect(purge?.[1]).toEqual([['assistant:c5:%', 'assistant:c6:%']]);
  });

  it('une mise à jour ne purge pas les réponses modèle (clé = contenu : elles se renouvellent seules)', async () => {
    registerAssistantBusinessEventHandlers();
    await bus.emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: 7 });
    expect(h.unsafe).not.toHaveBeenCalled();
  });

  it('compte sans fil : rien à purger', async () => {
    expect(await purgeAccountModelCache(7)).toBe(0);
  });
});

describe('points d’émission branchés (§25.7)', () => {
  const lire = async (p: string) => (await import('fs')).readFileSync((await import('path')).join(process.cwd(), p), 'utf8');
  it.each([
    ['src/app/api/assets/route.ts', 'ASSET_CREATED'],
    ['src/app/api/assets/route.ts', 'ASSET_DELETED'],
    ['src/services/coherence/impact-propagation.service.ts', 'ASSET_UPDATED'],
    ['src/services/coherence/impact-propagation.service.ts', 'DOCUMENT_ANALYSIS_COMPLETED'],
    ['src/app/api/documents/[id]/route.ts', 'DOCUMENT_UPDATED'],
    ['src/app/api/files/[id]/route.ts', 'DOCUMENT_DELETED'],
    ['src/services/coherence/impact-propagation.service.ts', 'AGENDA_ITEM_CREATED'],
    ['src/app/api/agenda/[id]/route.ts', 'AGENDA_ITEM_UPDATED'],
    ['src/app/api/agenda/[id]/route.ts', 'AGENDA_ITEM_DELETED'],
    ['src/app/api/v2/to-process/[publicId]/resolve/route.ts', 'TO_PROCESS_ITEM_UPDATED'],
    ['src/services/billing/subscription-sync.service.ts', 'PLAN_CHANGED'],
    ['src/services/duo/duo-exit.service.ts', 'ACCOUNT_PERMISSION_CHANGED'],
  ])('%s émet %s', async (fichier, type) => {
    expect(await lire(fichier)).toContain(`'${type}'`);
  });
});
