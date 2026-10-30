/**
 * Lot 101B — ticket P1 « Notifications de sécurité — supprimer les affichages
 * in-app redondants avec les e-mails » (décision PO du 30/10/2026).
 *
 *   U01 inventaire EXHAUSTIF de la catégorie « Sécurité » : e-mail
 *       obligatoire conservé, cloche et push supprimés (catalogue), motif ;
 *   U02 obligation d'informer / canal obligatoire / in-app DÉCOUPLÉS ;
 *       autres catégories inchangées (aucune autre cloche supprimée, cloches
 *       obligatoires des autres catégories conservées) ;
 *   U03 dispatcher : ligne d'AVANT le déploiement (`mandatory_bell`) →
 *       aucune cloche (donc aucun toast), e-mail envoyé, cloche / push tracés
 *       `channel_retired` (ni envoi, ni échec) ; échec d'e-mail → `failed`
 *       sans cloche ; activation BO « in-app » sans effet ;
 *   U04 réémission : jamais de cloche ni de push, l'e-mail en échec seul ;
 *   U05 lecture client : types masqués = les 8 types de sécurité, filtre dans
 *       `GET /api/notifications` (liste, pastille, « Tout lu »), aucune règle
 *       dans les composants ;
 *   U06 préférences, BO et push natif : même politique (web = mobile) ;
 *   U07 messages fonctionnels liés à une action conservés (erreur, session
 *       expirée, réauthentification, échec, « Appareil déconnecté »).
 * Scénarios bout en bout (vraies routes, PostgreSQL) :
 * `src/test/e2e/scenarios/l101b-securite-sans-in-app.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Doublures du dispatcher (même schéma que activation-canal.test.ts) ──────
const inserted: Array<Record<string, unknown>> = [];
const unsafe = vi.fn();
vi.mock('@/db', () => ({
  db: { insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }) },
  pgClient: { unsafe: (...args: unknown[]) => unsafe(...args) },
}));
const delivered: string[] = [];
let emailOutcome: { status: string; errorCode?: string } = { status: 'sent' };
vi.mock('../channels', () => ({
  deliverBell: async () => { delivered.push('bell'); return { status: 'sent', notificationId: 1 }; },
  deliverEmail: async () => { delivered.push('email'); return emailOutcome; },
}));
vi.mock('../mobile-push', async (orig) => ({
  ...(await orig<typeof import('../mobile-push')>()),
  deliverMobilePush: async () => { delivered.push('push'); return [{ installationRowId: 'dev-1', outcome: { status: 'sent' } }]; },
}));
// Ancienne préférence « push sécurité activé » (défaut d'avant le lot 101B).
vi.mock('../policy-resolver', () => ({ resolveChannels: async () => ({ bell: true, push: true, email: true }) }));
vi.mock('@/lib/mobile/push-installations', () => ({ countActiveInstallations: async () => 0 }));
let claimed: Array<Record<string, unknown>> = [];
const processed: Array<[string, string]> = [];
vi.mock('../outbox', () => ({
  claimByIds: async () => claimed,
  claimPending: async () => claimed,
  markProcessed: async (id: string, status: string) => { processed.push([id, status]); },
  markGrouped: async () => {},
  reopenGroupedBy: async () => [],
  releaseOrFail: async () => {},
}));

const { NOTIFICATION_CATALOG, getCatalogEntry, RETIRED_SECURITY_IN_APP } = await import('../catalog');
const { applyRetiredChannels, bellRetiredTypes, CHANNEL_RETIRED_ERROR_CODE } = await import('../retired-channels');
const { processOutboxIds } = await import('../dispatcher');
const { mobilePushPolicy } = await import('../mobile-push');
const { categoryPushAvailable, categoryEmailScope, applyPreferenceChanges } = await import('../preference-matrix');
const { retirerCanauxSupprimes, canauxAReemettre } = await import('@/services/notifications/notification-reemission.service');
const { listEventDefinitions } = await import('@/services/admin/communications.service');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Inventaire du ticket + événement du lot 100D. */
const SECURITY_EVENTS = [
  'AUTH_IDENTITY_LINKED', 'AUTH_IDENTITY_UNLINKED', 'EMAIL_CHANGED', 'EMAIL_CHANGE_REQUESTED',
  'NEW_DEVICE_LOGIN', 'OTHER_SESSIONS_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED',
];
const all = () => Object.values(NOTIFICATION_CATALOG).filter((e): e is NonNullable<typeof e> => !!e);

function row(eventType: string, over: Record<string, unknown> = {}) {
  return {
    id: `ob-${eventType}`, event_type: eventType, recipient_user_id: 7, payload_json: {}, deep_link: null,
    dedupe_key: `k-${eventType}`, category: 'security', account_id: null,
    // Ligne mise en file AVANT le lot 101B : drapeaux de l'ancienne version.
    mandatory_bell: true, mandatory_email: true, attempt_count: 0, ...over,
  };
}

beforeEach(() => {
  inserted.length = 0; delivered.length = 0; processed.length = 0;
  unsafe.mockReset(); unsafe.mockResolvedValue([]);
  emailOutcome = { status: 'sent' };
});

describe('L101B-U01 — inventaire exhaustif des événements de sécurité', () => {
  it('la catégorie « Sécurité » contient exactement les 8 événements inventoriés', () => {
    expect(all().filter((e) => e.category === 'security').map((e) => e.type).sort()).toEqual(SECURITY_EVENTS);
  });

  it.each(SECURITY_EVENTS)('%s : e-mail obligatoire avec gabarit ; cloche et push supprimés (motif BO)', (t) => {
    const e = getCatalogEntry(t)!;
    expect(e).toMatchObject({ category: 'security', priority: 'high', mandatoryEmail: true, mandatoryBell: false, neverBell: false });
    expect(e.defaults).toEqual({ push: false, email: true });
    expect(e.retiredChannels).toEqual({ bell: RETIRED_SECURITY_IN_APP, push: RETIRED_SECURITY_IN_APP });
    expect(e.retiredChannels?.email).toBeUndefined();
    const sample = t === 'NEW_DEVICE_LOGIN' ? { at: '2026-10-30T08:00:00.000Z', deviceLabel: 'iPhone', browserLabel: 'Safari' }
      : t === 'OTHER_SESSIONS_REVOKED' ? { at: '2026-10-30T08:00:00.000Z', count: 2 }
        : t.startsWith('AUTH_IDENTITY') ? { provider: 'google' } : {};
    const r = e.render(sample);
    expect(r.emailTemplateCode).toMatch(/^notif_(security|new_device_login|other_sessions_revoked)$/);
    // Le titre et le texte servent toujours à l'e-mail ({{title}} / {{body}}).
    expect(r.bellTitle.length).toBeGreaterThan(0);
    expect(r.bellBody.length).toBeGreaterThan(0);
  });

  it('motif lisible, sans le mot « Opération »', () => {
    expect(RETIRED_SECURITY_IN_APP).toMatch(/e-mail obligatoire/);
    expect(RETIRED_SECURITY_IN_APP).not.toMatch(/Opération/);
  });
});

describe('L101B-U02 — obligation, canal et in-app découplés ; autres catégories inchangées', () => {
  it('aucune entrée hors sécurité n’a de cloche supprimée', () => {
    expect(all().filter((e) => e.retiredChannels?.bell).map((e) => e.type).sort()).toEqual(SECURITY_EVENTS);
  });

  it('cloches obligatoires des autres catégories conservées (toast d’arrivée inchangé pour elles)', () => {
    const mandatoryBell = all().filter((e) => e.mandatoryBell).map((e) => `${e.category}:${e.type}`).sort();
    expect(mandatoryBell.every((x) => !x.startsWith('security:'))).toBe(true);
    for (const t of ['PAYMENT_FAILED', 'ACCOUNT_DELETION_SCHEDULED', 'DUO_INVITATION_DECLINED']) {
      expect(getCatalogEntry(t)?.mandatoryBell, t).toBe(true);
    }
  });

  it('documents, échéances, abonnements, Duo, transmissions, À traiter : canaux inchangés', () => {
    const tous = { bell: true, push: true, email: true };
    expect(applyRetiredChannels(tous, getCatalogEntry('DEADLINE_DUE_IN_7_DAYS')!).channels).toEqual(tous);
    expect(applyRetiredChannels(tous, getCatalogEntry('DUO_INVITATION_RECEIVED')!).channels).toEqual(tous);
    expect(applyRetiredChannels(tous, getCatalogEntry('TRANSMISSION_ACCEPTED')!).channels).toEqual(tous);
    expect(applyRetiredChannels(tous, getCatalogEntry('DOCUMENT_BATCH_COMPLETED')!).channels).toEqual({ bell: true, push: true, email: false });
    expect(applyRetiredChannels(tous, getCatalogEntry('SUBSCRIPTION_RENEWED')!).channels).toEqual({ bell: true, push: false, email: true });
    expect(getCatalogEntry('TO_PROCESS_DAILY_DIGEST')!.neverBell).toBe(true);
  });

  it('la politique coupe cloche et push, garde l’e-mail (préférences et drapeaux anciens compris)', () => {
    for (const t of SECURITY_EVENTS) {
      expect(applyRetiredChannels({ bell: true, push: true, email: true }, getCatalogEntry(t)!))
        .toEqual({ channels: { bell: false, push: false, email: true }, retired: ['bell', 'push'] });
    }
  });
});

describe('L101B-U03 — dispatcher : aucune cloche, e-mail envoyé, supervision juste', () => {
  it('« Ancien événement en attente » (drapeau cloche obligatoire d’avant le lot 101B) : e-mail seul, statut envoyé', async () => {
    claimed = [row('NEW_DEVICE_LOGIN', { payload_json: { at: '2026-10-29T08:00:00.000Z', deviceLabel: 'iPhone', browserLabel: 'Safari' } })];
    const s = await processOutboxIds(['ob-NEW_DEVICE_LOGIN']);
    expect(delivered).toEqual(['email']);
    expect(s).toMatchObject({ sent: 1, failed: 0 });
    expect(processed).toEqual([['ob-NEW_DEVICE_LOGIN', 'sent']]);
    const traces = inserted.map((v) => [v.channel, v.status, v.lastErrorCode]);
    expect(traces).toEqual([
      ['bell', 'skipped_unavailable', CHANNEL_RETIRED_ERROR_CODE],
      ['push', 'skipped_unavailable', CHANNEL_RETIRED_ERROR_CODE],
      ['email', 'sent', null],
    ]);
  });

  it.each(SECURITY_EVENTS)('%s : jamais de cloche ni de push, même si l’admin réactive « in-app » et « push »', async (t) => {
    unsafe.mockResolvedValue([]); // aucun canal désactivé : tout est « actif » au BO
    claimed = [row(t)];
    await processOutboxIds([`ob-${t}`]);
    expect(delivered).toEqual(['email']);
  });

  it('« Échec d’envoi d’e-mail » : échec tracé (reprise possible), aucune cloche réactivée', async () => {
    emailOutcome = { status: 'failed', errorCode: 'email_send_error' };
    claimed = [row('PASSWORD_CHANGED')];
    const s = await processOutboxIds(['ob-PASSWORD_CHANGED']);
    expect(delivered).toEqual(['email']);
    expect(s).toMatchObject({ failed: 1, sent: 0 });
    expect(processed).toEqual([['ob-PASSWORD_CHANGED', 'failed']]);
    expect(inserted.filter((v) => v.status === 'failed').map((v) => v.channel)).toEqual(['email']);
  });

  it('autre catégorie à cloche obligatoire : cloche toujours livrée (non-régression)', async () => {
    claimed = [row('PAYMENT_FAILED', { category: 'account', payload_json: {} })];
    await processOutboxIds(['ob-PAYMENT_FAILED']);
    expect(delivered).toContain('bell');
  });
});

describe('L101B-U04 — réémission : jamais de cloche ni de push de sécurité', () => {
  it('canaux en échec cloche + e-mail → seul l’e-mail est réémis', () => {
    const e = getCatalogEntry('NEW_DEVICE_LOGIN');
    expect(retirerCanauxSupprimes({ canaux: ['bell', 'email'] }, e)).toEqual({ canaux: ['email'] });
    expect(retirerCanauxSupprimes({ canaux: ['bell'] }, e)).toEqual({ canaux: [] });
    expect(retirerCanauxSupprimes({ canaux: ['push'], mobileInstallationIds: ['m1'] }, e)).toEqual({ canaux: [] });
  });

  it('autres catégories : la cloche en échec reste réémise', () => {
    expect(retirerCanauxSupprimes({ canaux: ['bell', 'email'] }, getCatalogEntry('PAYMENT_FAILED'))).toEqual({ canaux: ['bell', 'email'] });
  });

  it('e-mail de sécurité en échec : réémission de l’e-mail seul', () => {
    const r = canauxAReemettre([{ channel: 'email', status: 'failed' }, { channel: 'bell', status: 'skipped_unavailable' }]);
    expect(retirerCanauxSupprimes(r!, getCatalogEntry('PASSWORD_CHANGED'))).toEqual({ canaux: ['email'] });
  });
});

describe('L101B-U05 — lecture client : notifications historiques non servies, aucun masquage dans les composants', () => {
  it('types masqués = exactement les 8 événements de sécurité', () => {
    expect(bellRetiredTypes(NOTIFICATION_CATALOG)).toEqual(SECURITY_EVENTS);
  });

  it('GET /api/notifications filtre liste ET pastille ; « Tout lu » ne touche pas les lignes retirées (audit)', () => {
    const src = read('src/app/api/notifications/route.ts');
    expect(src).toContain('bellRetiredTypes(NOTIFICATION_CATALOG)');
    expect(src.match(/visibleTo\(payload\.userId/g)?.length).toBe(4); // liste (2 variantes), compteur, Tout lu
    expect(src).not.toMatch(/\.delete\(notifications\)|DELETE FROM notifications/);
  });

  it('la cloche et l’accueil ne portent aucune règle propre aux types de sécurité', () => {
    for (const p of ['src/components/NotificationBell.tsx', 'src/components/mobile/mobile-account-panel.tsx', 'src/components/TopBar.tsx']) {
      expect(read(p), p).not.toMatch(new RegExp(SECURITY_EVENTS.join('|')));
    }
  });

  it('détection « nouvel appareil » inchangée (méthodes, première connexion, clé d’idempotence)', async () => {
    const m = await import('@/lib/auth/new-device-alert');
    expect([...m.NEW_DEVICE_ALERT_METHODS].sort()).toEqual(['apple', 'email_link', 'google', 'password']);
    expect(m.NEW_DEVICE_ALERT_ON_ACCOUNT_CREATION).toBe(false);
    expect(read('src/lib/auth/new-device-alert.ts')).toContain('dedupeKey: `security:new-device:${input.userId}:${input.client.deviceKey ?? `sid-${input.sid}`}`');
  });
});

describe('L101B-U06 — préférences, BO et application native : même politique', () => {
  it('Mon compte › Notifications : push « Sécurité » plus proposé ; e-mails toujours envoyés', async () => {
    expect(categoryPushAvailable('security')).toBe(false);
    expect(categoryEmailScope('security').optional).toEqual([]);
    expect(categoryEmailScope('security').essential).toContain('connexion depuis un nouvel appareil');
    expect(categoryEmailScope('security').essential).toContain('autres appareils déconnectés à votre demande');
    expect(await applyPreferenceChanges(1, [{ category: 'security', channel: 'push', enabled: true }]))
      .toEqual({ ok: false, error: 'CHANNEL_RETIRED:security:push' });
    expect(await applyPreferenceChanges(1, [{ category: 'security', channel: 'email', enabled: false }]))
      .toEqual({ ok: false, error: 'EMAIL_MANDATORY:security' });
  });

  it('push natif (FCM) : catalogue mobile §18.3 « non » pour la sécurité', () => {
    for (const t of SECURITY_EVENTS) expect(mobilePushPolicy(getCatalogEntry(t)!), t).toBe('no');
    expect(mobilePushPolicy(getCatalogEntry('DEADLINE_DUE_IN_7_DAYS')!)).toBe('yes');
  });

  it('BO › Communications : e-mail verrouillé seul ; in-app et push affichés « supprimés » avec le motif', () => {
    const defs = listEventDefinitions([]);
    for (const t of SECURITY_EVENTS) {
      const d = defs.find((x) => x.code === t)!;
      expect(d.channels.map((c) => [c.channel, c.locked]), t).toEqual([['email', true]]);
      expect(d.retiredChannels.map((r) => r.channel).sort(), t).toEqual(['in_app', 'push']);
    }
    const duo = defs.find((x) => x.code === 'DUO_INVITATION_DECLINED')!;
    expect(duo.channels.find((c) => c.channel === 'in_app')).toMatchObject({ locked: true });
  });
});

describe('L101B-U07 — messages fonctionnels liés à une action conservés', () => {
  it('confirmations contextuelles de Mon compte › Sécurité (appareil déconnecté, autres appareils, mot de passe)', () => {
    const card = read('src/components/account/security/SecurityCard.tsx');
    expect(card).toContain('toast.success(`${s.deviceLabel} est déconnecté.`)');
    expect(card).toContain('Vos autres appareils ont été déconnectés.');
    expect(card).toContain("toast.error(errorMessage(e, 'La déconnexion de cet appareil a échoué.'))");
    expect(card).toContain('Mot de passe modifié.');
  });

  it('session expirée, réauthentification, erreur d’authentification', () => {
    expect(read('src/app/(auth)/login/page.tsx')).toContain('Votre session a expiré. Merci de vous reconnecter.');
    expect(read('src/lib/auth/reauth.ts')).toMatch(/export function reauthRequiredResponse/);
    expect(read('src/components/account/security/ReauthProvider.tsx').length).toBeGreaterThan(0);
    expect(read('src/components/account/security/SignInMethodsBlock.tsx')).toContain('SECURITY_RETURN_MESSAGES.linked');
  });
});
