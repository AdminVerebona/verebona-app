/**
 * Erreurs de l'assistant — CDC §4.2, §27.11 : code stable, libellé
 * Verebona, `recoverable`, et REQUEST_TIMEOUT distinct d'une panne.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { runAssistant } = await import('../assistant-orchestrator.service');
const { toApiPayload } = await import('../api-payload');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;

const INPUT = { accountId: 7, userId: 3, planType: 'STANDARD', message: 'Retrouve la facture de mon vélo', clientRequestId: 'c', locale: 'fr-FR' };

function ports(retrieve: Ports['retrieve']): Ports {
  return {
    retrieve,
    resolveSources: async () => [],
    resolveActions: async () => [],
    persist: async () => null,
    hasPendingClarification: async () => false,
  };
}

describe('toApiPayload — error {code, message, recoverable}', () => {
  it('panne : ASSISTANT_UNAVAILABLE, libellé sans texte technique', async () => {
    const r = await runAssistant(INPUT, ports(async () => { throw new Error('ECONNRESET pg'); }));
    const p = toApiPayload(r, 11);
    expect(p.status).toBe('error');
    expect(p.error).toMatchObject({ code: 'ASSISTANT_UNAVAILABLE', recoverable: true });
    expect(p.error?.message).not.toMatch(/ECONNRESET/);
    expect(p.answer).toBe(p.error?.message);
  });

  it('échéance globale dépassée : REQUEST_TIMEOUT', async () => {
    const r = await runAssistant(INPUT, ports(async () => { throw new Error('REQUEST_TIMEOUT'); }));
    expect(toApiPayload(r).error).toMatchObject({ code: 'REQUEST_TIMEOUT', recoverable: true });
    expect(r.answer).toMatch(/trop de temps/);
  });

  it('réponse normale : pas de champ error', async () => {
    const r = await runAssistant({ ...INPUT, message: 'Bonjour' }, ports(async () => []));
    const p = toApiPayload(r);
    expect(p.status).toBe('ready');
    expect(p.error).toBeUndefined();
  });
});
