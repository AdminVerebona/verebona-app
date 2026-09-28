/**
 * La purge ne supprime jamais d'étapes IA non archivées : quand l'archivage
 * S3 est actif, c'est lui seul qui les supprime après dépôt de l'archive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) } }));
vi.mock('@/services/verebona-assistant/core/conversation.service', () => ({
  purgeConversationData: vi.fn(async () => ({ conversations: 0 })),
  purgeMessagesWhere: vi.fn(async () => 0),
}));

const { purgeAssistantData, logArchiveEnabled } = await import('../purge-assistant-logs.job');

const deletesOnSteps = () =>
  unsafe.mock.calls.map((c) => String(c[0])).filter((q) => /DELETE\s+FROM\s+ai_pipeline_step/i.test(q));

beforeEach(() => { unsafe.mockReset(); unsafe.mockResolvedValue([]); vi.unstubAllEnvs(); });

describe('purge et archivage des logs IA', () => {
  it('archivage actif par défaut', () => {
    expect(logArchiveEnabled({})).toBe(true);
    expect(logArchiveEnabled({ AI_LOG_ARCHIVE: 'off' })).toBe(false);
  });

  it('archivage actif : aucune suppression d’étape par la purge', async () => {
    const r = await purgeAssistantData();
    expect(r.technicalLogsDeleted).toBe(0);
    expect(deletesOnSteps()).toHaveLength(0);
  });

  it('archivage désactivé : la rétention seule s’applique', async () => {
    vi.stubEnv('AI_LOG_ARCHIVE', 'off');
    await purgeAssistantData();
    expect(deletesOnSteps().length).toBeGreaterThan(0);
  });
});
