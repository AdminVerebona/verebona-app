/**
 * Activation des communications par canal — CDC Back-Office V1 COM-002,
 * COM-011, REC-MOD-01 ; notifications obligatoires (CDC notifications §2.11).
 *
 * Le dispatcher ne livre pas un canal désactivé depuis le BO, livre les
 * autres canaux du même événement, et ignore la désactivation d'un canal
 * obligatoire du catalogue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Doublures ───────────────────────────────────────────────────────────────
const inserted: Array<Record<string, unknown>> = [];
const unsafe = vi.fn();
vi.mock('@/db', () => ({
  db: { insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }) },
  pgClient: { unsafe: (...args: unknown[]) => unsafe(...args) },
}));

const delivered: string[] = [];
vi.mock('../channels', () => ({
  deliverBell: async () => { delivered.push('bell'); return { status: 'sent', notificationId: 1 }; },
  deliverEmail: async () => { delivered.push('email'); return { status: 'sent' }; },
  deliverWebPush: async () => { delivered.push('push'); return [{ subscriptionId: 'dev-1', outcome: { status: 'sent' } }]; },
}));

vi.mock('../policy-resolver', () => ({
  resolveChannels: async () => ({ bell: true, push: true, email: true }),
}));

let claimed: Array<Record<string, unknown>> = [];
const processed: Array<[string, string]> = [];
vi.mock('../outbox', () => ({
  claimByIds: async () => claimed,
  claimPending: async () => claimed,
  markProcessed: async (id: string, status: string) => { processed.push([id, status]); },
  releaseOrFail: async () => {},
}));

const { applyChannelActivation, isTransactionalEmailActive, loadDisabledChannels, transactionalEventCode } =
  await import('../channel-activation');
const { processOutboxIds } = await import('../dispatcher');

function outboxRow(eventType: string, over: Record<string, unknown> = {}) {
  return {
    id: `ob-${eventType}`,
    event_type: eventType,
    recipient_user_id: 7,
    payload_json: {},
    deep_link: null,
    dedupe_key: `k-${eventType}`,
    category: null,
    mandatory_bell: false,
    mandatory_email: false,
    attempt_count: 0,
    ...over,
  };
}

/** Simule la table communication_channel_settings. */
function disabledInBase(map: Record<string, string[]>) {
  unsafe.mockImplementation(async (_sql: string, params: unknown[]) =>
    (map[String(params?.[0])] ?? []).map((channel) => ({ channel })),
  );
}

beforeEach(() => {
  inserted.length = 0;
  delivered.length = 0;
  processed.length = 0;
  unsafe.mockReset();
});

describe('applyChannelActivation (pure)', () => {
  const all = { bell: true, push: true, email: true };

  it('coupe uniquement le canal désactivé (REC-MOD-01)', () => {
    const r = applyChannelActivation(all, new Set(['push'] as const), { bell: false, email: false });
    expect(r.channels).toEqual({ bell: true, push: false, email: true });
    expect(r.blocked).toEqual(['push']);
  });

  it('in-app correspond à la cloche', () => {
    const r = applyChannelActivation(all, new Set(['in_app'] as const), { bell: false, email: false });
    expect(r.channels.bell).toBe(false);
    expect(r.blocked).toEqual(['bell']);
  });

  it('un canal obligatoire n’est jamais coupé', () => {
    const r = applyChannelActivation(all, new Set(['email', 'in_app'] as const), { bell: true, email: true });
    expect(r.channels).toEqual(all);
    expect(r.blocked).toEqual([]);
  });

  it('un canal non prévu par les préférences n’est pas signalé comme bloqué', () => {
    const r = applyChannelActivation({ bell: true, push: false, email: false }, new Set(['push', 'email'] as const), { bell: false, email: false });
    expect(r.blocked).toEqual([]);
  });
});

describe('dispatcher', () => {
  it('ne livre pas le canal e-mail désactivé et livre les autres', async () => {
    disabledInBase({ TRIAL_ENDING: ['email'] });
    claimed = [outboxRow('TRIAL_ENDING')];
    await processOutboxIds(['ob-TRIAL_ENDING']);

    expect(delivered).toEqual(['bell', 'push']);
    const emailRow = inserted.find((r) => r.channel === 'email');
    expect(emailRow).toMatchObject({ status: 'skipped_unavailable', lastErrorCode: 'channel_disabled_by_admin', sentAt: null });
    // Un canal ignoré n'est pas un échec : l'événement est « sent ».
    expect(processed).toEqual([['ob-TRIAL_ENDING', 'sent']]);
  });

  it('désactivation du push et de l’in-app : seul l’e-mail part', async () => {
    disabledInBase({ TRIAL_ENDING: ['push', 'in_app'] });
    claimed = [outboxRow('TRIAL_ENDING')];
    await processOutboxIds(['ob-TRIAL_ENDING']);
    expect(delivered).toEqual(['email']);
  });

  it('notification obligatoire : e-mail et cloche livrés malgré une désactivation', async () => {
    disabledInBase({ PAYMENT_FAILED: ['email', 'in_app', 'push'] });
    claimed = [outboxRow('PAYMENT_FAILED')];
    await processOutboxIds(['ob-PAYMENT_FAILED']);
    // Le push, jamais obligatoire, reste coupé.
    expect(delivered).toEqual(['bell', 'email']);
  });

  it('obligation portée par la ligne d’outbox respectée', async () => {
    disabledInBase({ TRIAL_ENDING: ['email'] });
    claimed = [outboxRow('TRIAL_ENDING', { mandatory_email: true })];
    await processOutboxIds(['ob-TRIAL_ENDING']);
    expect(delivered).toContain('email');
  });

  it('lecture impossible : les envois sont maintenus (fail-open)', async () => {
    unsafe.mockRejectedValue(new Error('relation "communication_channel_settings" does not exist'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    claimed = [outboxRow('TRIAL_ENDING')];
    await processOutboxIds(['ob-TRIAL_ENDING']);
    expect(delivered).toEqual(['bell', 'email', 'push']);
  });

  it('la lecture se fait par type d’événement', async () => {
    disabledInBase({});
    await loadDisabledChannels('TRIAL_ENDING');
    expect(unsafe.mock.calls[0][1]).toEqual(['TRIAL_ENDING']);
  });
});

describe('e-mails transactionnels (hors catalogue)', () => {
  it('clé préfixée : pas de collision avec un type du catalogue', () => {
    expect(transactionalEventCode('account_invitation')).toBe('email:ACCOUNT_INVITATION');
  });

  it('désactivé en base → inactif', async () => {
    disabledInBase({ 'email:WELCOME': ['email'] });
    expect(await isTransactionalEmailActive('WELCOME')).toBe(false);
    expect(await isTransactionalEmailActive('TRIAL_CONFIRMATION')).toBe(true);
  });

  it('e-mail verrouillé (sécurité, légal) toujours actif, sans lecture', async () => {
    disabledInBase({ 'email:PASSWORD_RESET': ['email'] });
    expect(await isTransactionalEmailActive('password_reset')).toBe(true);
    expect(unsafe).not.toHaveBeenCalled();
  });
});
