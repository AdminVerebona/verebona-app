/**
 * Revue lot 21 — la réémission ne sert que les canaux en échec : une cloche
 * (même obligatoire) ou un e-mail déjà livrés ne le sont pas deux fois, et
 * seuls les appareils push en échec sont visés.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: () => [] }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: async () => undefined }));

const { canauxAReemettre } = await import('../notification-reemission.service');
const { lireRestrictionReemission, appliquerRestrictionReemission, REEMISSION_KEY } = await import('@/lib/notifications/reemission-restriction');

const t = (channel: string, status: string, pushSubscriptionId: string | null = null) => ({ channel, status, pushSubscriptionId });

describe('canauxAReemettre', () => {
  it('ligne jamais distribuée : aucune restriction (tous les canaux)', () => {
    expect(canauxAReemettre([])).toBeNull();
  });

  it('cloche livrée, e-mail en échec : seul l’e-mail est réémis', () => {
    expect(canauxAReemettre([t('bell', 'sent'), t('email', 'failed')])).toEqual({ canaux: ['email'] });
  });

  it('push : seuls les appareils en échec, jamais ceux déjà servis', () => {
    const r = canauxAReemettre([t('bell', 'sent'), t('push', 'sent', 'a'), t('push', 'failed', 'b'), t('push', 'failed', 'b')]);
    expect(r).toEqual({ canaux: ['push'], pushSubscriptionIds: ['b'] });
  });

  it('canal en échec puis livré (nouvelle tentative) : non réémis', () => {
    expect(canauxAReemettre([t('email', 'failed'), t('email', 'sent'), t('bell', 'sent')])).toEqual({ canaux: [] });
  });

  it('canaux ignorés (skipped_*) : ni échec ni réémission', () => {
    expect(canauxAReemettre([t('bell', 'sent'), t('push', 'skipped_unavailable')])).toEqual({ canaux: [] });
  });
});

describe('restriction côté dispatcher', () => {
  const tous = { bell: true, email: true, push: true };

  it('retire la clé technique du contenu et coupe les canaux non visés, cloche obligatoire comprise', () => {
    const { payload, restriction } = lireRestrictionReemission({ titre: 'x', [REEMISSION_KEY]: { origine: 'o', canaux: ['email'] } });
    expect(payload).toEqual({ titre: 'x' });
    expect(appliquerRestrictionReemission(tous, restriction)).toEqual({ bell: false, email: true, push: false });
  });

  it('ne réactive jamais un canal coupé par les préférences', () => {
    const { restriction } = lireRestrictionReemission({ [REEMISSION_KEY]: { canaux: ['email', 'push'], pushSubscriptionIds: ['b'] } });
    expect(restriction?.pushSubscriptionIds).toEqual(['b']);
    expect(appliquerRestrictionReemission({ bell: true, email: false, push: true }, restriction)).toEqual({ bell: false, email: false, push: true });
  });

  it('sans restriction : canaux inchangés ; restriction illisible : rien n’est servi', () => {
    expect(appliquerRestrictionReemission(tous, lireRestrictionReemission({ a: 1 }).restriction)).toEqual(tous);
    expect(appliquerRestrictionReemission(tous, lireRestrictionReemission({ [REEMISSION_KEY]: { canaux: 'tout' } }).restriction))
      .toEqual({ bell: false, email: false, push: false });
  });
});
