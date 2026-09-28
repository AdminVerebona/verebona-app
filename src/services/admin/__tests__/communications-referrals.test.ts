/**
 * Communications (CDC BO §10) et parrainage (CDC BO §8) — logique pure.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const {
  listEventDefinitions,
  buildCommunicationsView,
  findChannelDefinition,
  resolveTemplateVariables,
  settingKey,
  MISSING_DATA_MARK,
} = await import('../communications.service');
const { describeReferralEvent, toReferralStatus } = await import('../referrals.service');

describe('Communications — organisation (COM-001 à COM-005)', () => {
  const defs = listEventDefinitions(['WELCOME', 'notif_payment_incident', 'CONTACT_NOTIFICATION']);

  it('regroupe par événement, avec les seuls canaux disponibles', () => {
    const trial = defs.find((d) => d.code === 'TRIAL_ENDING')!;
    expect(trial.channels.map((c) => c.channel)).toEqual(['email', 'push', 'in_app']);
    // « À traiter » n'a jamais de cloche.
    const toProcess = defs.find((d) => d.code === 'TO_PROCESS_ITEM_CREATED')!;
    expect(toProcess.channels.map((c) => c.channel)).not.toContain('in_app');
    // Transmission reçue : pas d'e-mail (un seul e-mail par transmission).
    const transmission = defs.find((d) => d.code === 'TRANSMISSION_RECEIVED')!;
    expect(transmission.channels.map((c) => c.channel)).not.toContain('email');
  });

  it('les canaux obligatoires du catalogue sont verrouillés, jamais le push', () => {
    const payment = defs.find((d) => d.code === 'PAYMENT_FAILED')!;
    const byChannel = Object.fromEntries(payment.channels.map((c) => [c.channel, c.locked]));
    expect(byChannel).toEqual({ email: true, push: false, in_app: true });
  });

  it('e-mails transactionnels préfixés ; gabarits notif_* rattachés au catalogue', () => {
    const codes = defs.filter((d) => d.kind === 'transactional').map((d) => d.code);
    expect(codes).toContain('email:WELCOME');
    expect(codes).toContain('email:CONTACT_NOTIFICATION');
    expect(codes.some((c) => c.includes('NOTIF_'))).toBe(false);
    expect(new Set(codes).size).toBe(codes.length);
    expect(defs.find((d) => d.code === 'email:PASSWORD_RESET')!.channels[0].locked).toBe(true);
    expect(defs.find((d) => d.code === 'email:WELCOME')!.channels[0].locked).toBe(false);
  });

  it('statut par canal : absence de ligne = actif ; verrouillé toujours actif', () => {
    const settings = new Map([
      [settingKey('TRIAL_ENDING', 'push'), false],
      [settingKey('PAYMENT_FAILED', 'email'), false],
    ]);
    const stats = new Map([[settingKey('TRIAL_ENDING', 'email'), { sentCount: 12, lastSentAt: new Date('2026-09-01T08:00:00Z') }]]);
    const groups = buildCommunicationsView(defs, settings, stats);
    const events = groups.flatMap((g) => g.events);
    const trial = events.find((e) => e.code === 'TRIAL_ENDING')!;
    expect(trial.channels.find((c) => c.channel === 'push')!.active).toBe(false);
    expect(trial.channels.find((c) => c.channel === 'email')).toMatchObject({ active: true, sentCount: 12, lastSentAt: '2026-09-01T08:00:00.000Z' });
    expect(events.find((e) => e.code === 'PAYMENT_FAILED')!.channels.find((c) => c.channel === 'email')!.active).toBe(true);
    // COM-004 / COM-005 : ni échecs, ni variables, ni date de modification.
    for (const key of ['failedCount', 'failures', 'placeholders', 'variables', 'updatedAt']) {
      expect(Object.keys(trial.channels[0])).not.toContain(key);
      expect(Object.keys(trial)).not.toContain(key);
    }
  });

  it('refuse un canal inexistant pour l’événement', () => {
    expect(findChannelDefinition(defs, 'TO_PROCESS_ITEM_CREATED', 'in_app')).toBeNull();
    expect(findChannelDefinition(defs, 'INCONNU', 'email')).toBeNull();
    expect(findChannelDefinition(defs, 'TRIAL_ENDING', 'push')).not.toBeNull();
  });
});

describe('Communications — prévisualisation (COM-007, COM-009)', () => {
  const ctx = { firstName: 'Ada', lastName: 'Admin', email: 'ada@verebona.fr', accountName: 'Maison Ada', planLabel: 'PREMIUM' };

  it('données de l’administrateur ; absentes signalées, jamais inventées', () => {
    const { variables, missingCount } = resolveTemplateVariables(
      ['Bonjour {{firstName}}', '{{assetName}} — {{ loginUrl }} {{logoUrl}}'],
      ctx,
      'https://app.test/',
    );
    expect(variables.firstName).toBe('Ada');
    expect(variables.loginUrl).toBe('https://app.test/login');
    expect(variables.assetName).toBe(MISSING_DATA_MARK);
    expect(variables).not.toHaveProperty('logoUrl');
    expect(missingCount).toBe(1);
    expect(Object.values(variables).join(' ')).not.toMatch(/John|Doe|Geoffroy|Maupilier/);
  });
});

describe('Parrainage — détail (REF-007, REF-008)', () => {
  const base = {
    id: 1, referredAccountId: 9, referredAccountName: 'Filleul', usedAt: new Date('2026-09-01T00:00:00Z'),
    firstBilledAt: null, rewardAppliedAt: null, rewardedAt: null, rewardGrantedAt: null, updatedAt: null, metadata: null,
  };

  it('en cours : date prévisionnelle = premier paiement + délai de rétractation', () => {
    const v = describeReferralEvent({ ...base, status: 'link_used', firstBilledAt: new Date('2026-09-10T00:00:00Z') });
    expect(v.status).toBe('in_progress');
    expect(v.forecastRewardAt).toBe('2026-09-24T00:00:00.000Z');
    expect(v.rewardedAt).toBeNull();
  });

  it('en cours sans paiement : date prévisionnelle inconnue', () => {
    expect(describeReferralEvent({ ...base, status: 'link_used' }).forecastRewardAt).toBeNull();
  });

  it('validé : date réelle et avantage', () => {
    const v = describeReferralEvent({ ...base, status: 'reward_granted', rewardAppliedAt: new Date('2026-09-25T00:00:00Z') });
    expect(v).toMatchObject({ status: 'validated', rewardedAt: '2026-09-25T00:00:00.000Z', forecastRewardAt: null });
    expect(v.reward).toContain('mois offert');
  });

  it('annulé : date d’annulation issue du motif d’inéligibilité', () => {
    const v = describeReferralEvent({
      ...base, status: 'canceled', metadata: { rewardIneligibility: { reason: 'PAYMENT_REFUNDED', at: '2026-09-20T00:00:00.000Z' } },
    });
    expect(v).toMatchObject({ status: 'canceled', canceledAt: '2026-09-20T00:00:00.000Z', reward: null });
    // Le motif technique n'est pas exposé.
    expect(JSON.stringify(v)).not.toContain('PAYMENT_REFUNDED');
  });

  it('statut inconnu traité comme en cours', () => {
    expect(toReferralStatus('link_used')).toBe('in_progress');
    expect(toReferralStatus('whatever')).toBe('in_progress');
  });
});
