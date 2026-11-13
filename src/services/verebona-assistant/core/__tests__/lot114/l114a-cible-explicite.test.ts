/**
 * Lot 114A (Trello #753, CDC T2 §6.1, D03-D04, M06, tests U04-U07) — PRIORITÉ
 * DE LA CIBLE EXPLICITE.
 *
 *   T01  « la Polo » nommée dans le message l'emporte sur la Clio du fil ;
 *   T02  reprise anaphorique (« et son assurance ? ») : la cible du fil reste ;
 *   T03  le choix d'une clarification fait toujours foi ;
 *   T04  bien nommé > page (inchangé).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { resolveAssistantTargets } = await import('../../assistant-targets');

const biens = async () => [{ id: 1, name: 'Clio' }, { id: 2, name: 'Polo' }];
const fil = { type: 'asset' as const, id: 1, label: 'Clio', method: 'thread' } as never;

describe('L114A-T — la désignation du message courant gagne sur le fil', () => {
  it('T01 — « la Polo » alors que le fil parlait de la Clio', async () => {
    const t = await resolveAssistantTargets({ accountId: 1, message: 'Quand expire l’assurance de la Polo ?', reference: fil } as never, null, biens);
    expect(t.asset).toMatchObject({ id: 2, origin: 'message' });
    expect(t.primary).toMatchObject({ id: 2 });
  });

  it('T02 — anaphore sans désignation : le fil s’impose', async () => {
    const t = await resolveAssistantTargets({ accountId: 1, message: 'Et son assurance ?', reference: fil } as never, null, biens);
    expect(t.asset).toMatchObject({ id: 1, origin: 'thread' });
  });

  it('T03 — choix d’une clarification : jamais remplacé par le message rejoué', async () => {
    const t = await resolveAssistantTargets({
      accountId: 1, message: 'Quand expire l’assurance de la Polo ?',
      resume: { clarificationId: 'c', intent: 'ACCOUNT_DATA_QUESTION', assetId: 1, chainDepth: 1, choiceLabel: 'Clio' },
    } as never, null, biens);
    expect(t.asset).toMatchObject({ id: 1, origin: 'clarification' });
  });

  it('T04 — bien nommé > page', async () => {
    const t = await resolveAssistantTargets({ accountId: 1, message: 'échéances de la Polo', pageContext: { assetId: '1' } } as never, null, biens);
    expect(t.asset).toMatchObject({ id: 2, origin: 'message' });
  });
});
