/**
 * Durées de conservation de l'assistant — CDC Assistant §24.1, §29.7, §43.
 *
 * · historique conversationnel : 90 jours — décision produit « 3 mois »
 *   (CDC Centre d'aide GAP-16), qui prime sur les 7 jours du §24.1 ;
 * · journaux : 90 j (logs techniques sans contenu), 30 j (traces détaillées
 *   expurgées), 13 mois (agrégats, feedback) — §29.7.
 * La décision « 3 mois » du Centre d'aide (GAP-16) reste possible par
 * environnement.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn() } }));
vi.mock('@/services/verebona-assistant/core/conversation.service', () => ({
  purgeConversationData: vi.fn(), purgeMessagesWhere: vi.fn(),
}));

const { loadAssistantConfig } = await import('../config/assistant-config');
const { retentionPolicy } = await import('@/services/ai/assistant/retention/purge-assistant-logs.job');

const ENV = 'VEREBONA_ASSISTANT_HISTORY_DAYS';
const initial = process.env[ENV];

afterEach(() => {
  if (initial === undefined) delete process.env[ENV];
  else process.env[ENV] = initial;
  delete process.env.AI_TRACE_TECHNICAL_RETENTION_DAYS;
});

describe('durée d’historique (§24.1)', () => {
  it('vaut 90 jours (3 mois) sans configuration explicite', () => {
    delete process.env[ENV];
    expect(loadAssistantConfig().historyDays).toBe(90);
  });

  it('reste surchargeable par environnement (ex. 7 j du §24.1)', () => {
    process.env[ENV] = '7';
    expect(loadAssistantConfig().historyDays).toBe(7);
  });

  it('une valeur invalide retombe sur les 90 jours décidés', () => {
    process.env[ENV] = 'trois mois';
    expect(loadAssistantConfig().historyDays).toBe(90);
  });
});

describe('politique de purge (§29.7)', () => {
  it('distingue historique et journaux', () => {
    delete process.env[ENV];
    expect(retentionPolicy()).toEqual({
      conversationDays: 90, detailedTraceDays: 30, technicalLogDays: 90, aggregateMonths: 13, feedbackMonths: 13,
    });
  });

  it('la purge lit la même variable que l’assistant, à chaque exécution', () => {
    process.env[ENV] = '30';
    process.env.AI_TRACE_TECHNICAL_RETENTION_DAYS = 'x';
    const p = retentionPolicy();
    expect(p.conversationDays).toBe(30);
    expect(p.technicalLogDays).toBe(90);
  });
});
