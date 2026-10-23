/**
 * Lot 82C (CDC Pilotage IA V2 LOG-06, R65 ; décisions PO n° 01 et 10 du
 * 22/10) — la purge de l'assistant ne fait plus perdre aucune trace IA par
 * ancienneté : ni expurgation des étapes (`ai_pipeline_step`), ni
 * suppression des étapes (même avec AI_LOG_ARCHIVE=off), ni suppression des
 * traces d'exécution T2 (`verebona_request_runs`, `verebona_ai_runs`).
 * L'historique conversationnel affiché à l'utilisateur garde sa durée.
 *
 * Remplace l'ancien test « purge et archivage » (lot 25) qui attendait la
 * suppression des étapes quand l'archivage était coupé.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) } }));
const purgeConversationData = vi.fn(async () => ({ conversations: 0, messages: 0, cachedModelResponses: 0 }));
vi.mock('@/services/verebona-assistant/core/conversation.service', () => ({
  purgeConversationData: (...a: unknown[]) => purgeConversationData(...(a as [])),
  purgeMessagesWhere: vi.fn(async () => 0),
}));

const { purgeAssistantData } = await import('../purge-assistant-logs.job');

const requetes = () => unsafe.mock.calls.map((c) => String(c[0]));
const toucheTraceIa = (q: string) => /(DELETE\s+FROM|UPDATE)\s+(ai_pipeline_step|ai_usage_event|ai_call_diagnostics|ai_call_captures|verebona_request_runs|verebona_ai_runs)\b/i.test(q);

beforeEach(() => { unsafe.mockReset(); unsafe.mockResolvedValue([]); purgeConversationData.mockClear(); vi.unstubAllEnvs(); });

describe('L82C-RET — purge de l’assistant sans perte de trace IA', () => {
  it('L82C-RET-01 — archivage actif : aucune écriture sur les traces IA', async () => {
    await purgeAssistantData();
    expect(requetes().filter(toucheTraceIa)).toEqual([]);
  });

  it('L82C-RET-02 — archivage coupé (AI_LOG_ARCHIVE=off) : toujours aucune suppression d’étape', async () => {
    vi.stubEnv('AI_LOG_ARCHIVE', 'off');
    await purgeAssistantData();
    expect(requetes().filter(toucheTraceIa)).toEqual([]);
  });

  it('L82C-RET-03 — l’historique conversationnel expiré reste purgé (comportement utilisateur inchangé)', async () => {
    unsafe.mockImplementation(async (q: string) => (/FROM verebona_conversations/.test(q) ? [{ id: 7 }] : []));
    await purgeAssistantData();
    expect(purgeConversationData).toHaveBeenCalledWith(expect.anything(), [7]);
  });
});
