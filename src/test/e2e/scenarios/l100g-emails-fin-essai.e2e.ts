/**
 * Lot 100G — séquence d'e-mails de fin d'essai (décision PO « Questions PO 3 »,
 * E, E1, E2, F), sur PostgreSQL 16 réel (toutes les migrations, dont 0886 /
 * 0887), Resend SIMULÉ, HORLOGE FIGÉE (`now` passé au traitement).
 *
 * Chaque scénario a ses propres comptes (essais en 2033) et le traitement est
 * restreint à ces comptes : jamais d'interférence avec un autre fichier.
 *
 * L100G-E2E-01 J−2 puis J0 : textes E1, lien « offres » vers le parcours Web,
 *              modèle et version journalisés ; rejoué : aucun doublon.
 * L100G-E2E-02 Campagne commerciale : désactivée par défaut, puis sans
 *              consentement (en attente), puis J+3, J+10, J+30, J+60 envoyés
 *              (désinscription + en-têtes « en un clic ») ; rien après J+60 ;
 *              J+80 BLOQUÉ (politique de conservation non fixée).
 * L100G-E2E-03 Désinscription sans connexion : signée, idempotente ; plus
 *              aucune relance ; la notification de service n'est pas un
 *              contournement (J0 envoyé, sans offre de relance) ; lien falsifié refusé.
 * L100G-E2E-04 Chaque motif de non-envoi sur l'état actuel : souscription
 *              active, paiement en cours, compte supprimé, suspendu, en
 *              suppression, doublon (ancien circuit), hors fenêtre, e-mail
 *              désactivé dans le BO ; fenêtre refermée : dernier motif conservé.
 * L100G-E2E-05 Échec d'envoi : 3 tentatives (même clé d'idempotence), puis
 *              échec définitif → synthèse BO « Incident ».
 * L100G-E2E-06 Conversion attribuée au dernier e-mail envoyé ; journal BO.
 * L100G-E2E-07 Contenus en base : textes E1 à l'identique, aucune mention d'un
 *              essai de 60 jours ou de 59 €, anciens modèles retirés.
 */
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_100g';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'secret-e2e-l100g';
  return {
    calls: [] as Array<{ to: string; subject: string; html: string; text: string; headers?: Record<string, string> }>,
    keys: [] as Array<string | undefined>,
    fail: false,
  };
});

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }, o?: { idempotencyKey?: string }) => {
        etat.keys.push(o?.idempotencyKey);
        if (etat.fail) return { data: null, error: { name: 'validation_error', statusCode: 422, message: 'refus simulé' } };
        etat.calls.push(p);
        return { data: { id: `em_100g_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const END = '2033-03-10T14:05:00.000Z'; // 15 h 05 à Paris
const D = (iso: string) => new Date(iso);

scenario('L100G', 'E-mails de fin d’essai : séquence, contrôles avant envoi, journal', ({ sql, make }) => {
  let adminId = 0;

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
  });

  beforeEach(async () => {
    etat.calls.length = 0;
    etat.keys.length = 0;
    etat.fail = false;
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await sql`DELETE FROM trial_lifecycle_settings`;
    await sql`DELETE FROM communication_channel_settings WHERE event_code IN ('TRIAL_ENDED', 'TRIAL_ENDING', 'email:TRIAL_FOLLOWUP_J3')`;
  });

  /** Titulaire en essai (ou essai expiré en lecture seule). */
  async function essai(o: { status?: 'trialing' | 'readonly'; endsAt?: string; firstName?: string } = {}) {
    const email = `essai-${uid('l100g')}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET first_name = ${o.firstName ?? 'Léa'} WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: null });
    const ends = o.endsAt ?? END;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_consumed, trial_started_at, trial_ends_at)
              VALUES (${acc.id}, 'premium', ${o.status ?? 'readonly'}, true, ${new Date(new Date(ends).getTime() - 7 * 86_400_000).toISOString()}, ${ends})`;
    return { ...acc, email };
  }
  const run = async (now: string, ids: number[]) =>
    (await import('@/services/trial-lifecycle/sequence.service')).runTrialLifecycle({ now: D(now), accountIds: ids, deadline: Date.now() + 60_000 });
  const message = async (accountId: number, milestone: string) => {
    const [m] = await sql<{ id: number; status: string; reason: string | null; template_code: string; template_version: number | null; attempt_count: number; email_log_id: number | null; legal_basis: string | null }[]>`
      SELECT id, status, reason, template_code, template_version, attempt_count, email_log_id, legal_basis FROM trial_lifecycle_messages WHERE account_id = ${accountId} AND milestone = ${milestone}`;
    return m;
  };
  const events = (accountId: number) => sql<{ event_type: string; milestone: string | null; reason: string | null; template_code: string | null; template_version: number | null; detail: Record<string, unknown> }[]>`
    SELECT event_type, milestone, reason, template_code, template_version, detail FROM trial_lifecycle_events WHERE account_id = ${accountId} ORDER BY id`;
  const mailsTo = (email: string) => etat.calls.filter((c) => c.to === email);
  const settings = async (patch: Record<string, unknown>) => {
    const { saveTrialLifecycleSettings } = await import('@/services/trial-lifecycle/settings.service');
    const r = await saveTrialLifecycleSettings({ patch, admin: { id: adminId, email: 'po@test.invalid' } });
    expect(r.ok).toBe(true);
  };
  const consent = (userId: number) => sql`
    INSERT INTO news_consents (user_id, consented, source, version, consented_at) VALUES (${userId}, true, 'e2e', '2026-07', now())
    ON CONFLICT (user_id) DO UPDATE SET consented = true, revoked_at = NULL`;
  const version = async (code: string) => (await sql<{ v: number }[]>`SELECT max(version_no)::int AS v FROM email_template_versions WHERE template_type = ${code}`)[0].v;

  it('L100G-E2E-01 — J−2 puis J0 : textes E1, lien vers les offres Web, modèle et version, aucun doublon', async () => {
    const a = await essai({ status: 'trialing' });
    await run('2033-03-08T13:00:00Z', [a.id]); // avant J−2 (14 h 05 UTC) : rien
    expect(mailsTo(a.email)).toHaveLength(0);

    const r = await run('2033-03-08T15:00:00Z', [a.id]);
    expect(r.sent).toBe(1);
    const [j2] = mailsTo(a.email);
    expect(j2.subject).toBe('Votre essai gratuit Verebona se termine bientôt');
    expect(j2.html).toContain('Bonjour Léa,');
    expect(j2.html).toContain('Votre essai gratuit Verebona se termine dans deux jours.');
    expect(j2.html).toContain('jusqu’au 10 mars 2033 à 15 h 05.');
    expect(j2.html).toContain('Aucun prélèvement automatique n’aura lieu à la fin de votre essai.');
    expect(j2.html).toMatch(new RegExp(`class="vb-btn" href="${APP}/mon-compte/offres"[^>]*>Découvrir les offres Verebona<`));
    expect(j2.headers).toBeUndefined(); // service : aucun en-tête de désinscription
    expect(await message(a.id, 'J_MINUS_2')).toMatchObject({ status: 'sent', template_code: 'NOTIF_TRIAL_ENDING', template_version: await version('NOTIF_TRIAL_ENDING'), attempt_count: 1, legal_basis: null });

    // J0 : tant que la tâche « fin des essais » n'a pas basculé le compte, attente motivée.
    await run('2033-03-10T15:00:00Z', [a.id]);
    expect(await message(a.id, 'J0')).toMatchObject({ status: 'deferred', reason: 'trial_not_yet_expired' });
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${a.id}`;
    await run('2033-03-10T16:00:00Z', [a.id]);
    const j0 = mailsTo(a.email)[1];
    expect(j0.subject).toBe('Votre essai gratuit Verebona est terminé');
    expect(j0.html).toContain('Votre période d’essai gratuite de 7 jours vient de se terminer.');
    expect(j0.html).toContain('Aucun prélèvement automatique n’a été effectué à la fin de votre essai.');
    expect(j0.html).toMatch(new RegExp(`href="${APP}/mon-compte/offres"[^>]*>Découvrir les offres et souscrire<`));
    for (const m of [j2, j0]) {
      expect(m.html).not.toContain('{{');
      expect(`${m.subject}${m.text}`).not.toMatch(/60\s*jours|59\s*€|2 mois/i);
      expect(m.text).not.toMatch(/Cordialement|L’équipe Verebona/);
    }
    expect(await message(a.id, 'J0')).toMatchObject({ status: 'sent', template_code: 'NOTIF_TRIAL_ENDED', template_version: await version('NOTIF_TRIAL_ENDED') });
    expect((await events(a.id)).map((e) => [e.event_type, e.milestone, e.reason])).toEqual([
      ['sent', 'J_MINUS_2', null], ['deferred', 'J0', 'trial_not_yet_expired'], ['sent', 'J0', null],
    ]);
    // Rejoué (double exécution, reprise) : aucun doublon.
    await run('2033-03-10T16:00:00Z', [a.id]);
    await run('2033-03-10T17:00:00Z', [a.id]);
    expect(mailsTo(a.email)).toHaveLength(2);
    // Clé d'idempotence STABLE par message chez le prestataire.
    expect(etat.keys).toEqual([`trial-lifecycle-${(await message(a.id, 'J_MINUS_2')).id}`, `trial-lifecycle-${(await message(a.id, 'J0')).id}`]);
  });

  it('L100G-E2E-02 — campagne commerciale distincte : désactivée par défaut, consentement, J+3 → J+60, arrêt, J+80 bloqué', async () => {
    const a = await essai();
    await run('2033-03-13T15:00:00Z', [a.id]);
    expect(await message(a.id, 'J3')).toMatchObject({ status: 'deferred', reason: 'campaign_disabled' });
    expect(mailsTo(a.email)).toHaveLength(0);

    await settings({ commercialEnabled: true });
    await run('2033-03-13T16:00:00Z', [a.id]);
    expect(await message(a.id, 'J3')).toMatchObject({ status: 'deferred', reason: 'no_consent', legal_basis: 'consent' });
    expect(mailsTo(a.email)).toHaveLength(0);

    await consent(a.ownerUserId);
    await run('2033-03-13T17:00:00Z', [a.id]);
    const [j3] = mailsTo(a.email);
    expect(j3.subject).toBe('Continuez à profiter pleinement de Verebona');
    expect(j3.html).toMatch(new RegExp(`class="vb-btn" href="${APP}/mon-compte/offres"[^>]*>Choisir mon abonnement sur le site Verebona<`));
    expect(j3.html).toMatch(new RegExp(`<a class="vb-link" href="${APP}/desinscription\\?t=${a.ownerUserId}\\.[A-Za-z0-9_-]{32}"[^>]*>Ne plus recevoir ces relances</a>`));
    expect(j3.headers?.['List-Unsubscribe']).toMatch(new RegExp(`^<${APP}/api/public/marketing/unsubscribe\\?t=${a.ownerUserId}\\.`));
    expect(j3.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(await message(a.id, 'J3')).toMatchObject({ status: 'sent', legal_basis: 'consent', template_version: await version('TRIAL_FOLLOWUP_J3') });

    await run('2033-03-20T15:00:00Z', [a.id]);
    await run('2033-04-09T14:30:00Z', [a.id]);
    await run('2033-05-09T15:00:00Z', [a.id]);
    expect(mailsTo(a.email).map((m) => m.subject)).toEqual([
      'Continuez à profiter pleinement de Verebona',
      'Vos documents sont déjà réunis. Continuez à en profiter.',
      'Un document retrouvé au bon moment peut tout changer',
      'Votre espace Verebona reste disponible',
    ]);
    expect(mailsTo(a.email)[3].html).toContain('Il s’agit de notre dernière relance dans le cadre de votre essai gratuit.');
    expect(mailsTo(a.email)[3].html).toContain('Ne plus recevoir de communications commerciales</a>');

    // Après J+60 : plus aucune relance (aucun jalon commercial au-delà).
    for (const day of ['2033-05-12', '2033-05-20', '2033-06-30', '2033-09-01']) await run(`${day}T15:00:00Z`, [a.id]);
    // J+80 : modèle présent, ENVOI IMPOSSIBLE — bloqué côté serveur, même campagne active et consentement.
    await run('2033-05-29T15:00:00Z', [a.id]);
    expect(mailsTo(a.email)).toHaveLength(4);
    expect(await message(a.id, 'J80')).toMatchObject({ status: 'blocked', reason: 'retention_policy_not_set', template_code: 'TRIAL_DATA_RETENTION_J80' });
    // Même avec une suppression « essai abandonné » planifiée : aucune date promise sans purge réelle.
    await sql`INSERT INTO scheduled_account_deletions (account_id, user_id, reason, origin, confirmed_at, scheduled_at, status)
              VALUES (${a.id}, ${a.ownerUserId}, 'TRIAL_ABANDONED', 'system', now(), '2033-06-08T00:00:00Z', 'SCHEDULED')`;
    await run('2033-05-29T16:00:00Z', [a.id]);
    expect(await message(a.id, 'J80')).toMatchObject({ status: 'blocked', reason: 'retention_policy_not_set' });
    expect(mailsTo(a.email)).toHaveLength(4);
    const blocked = (await events(a.id)).filter((e) => e.event_type === 'blocked');
    expect(blocked).toHaveLength(1); // une ligne par changement de motif, pas par passage
    const { getTrialLifecycleSummary } = await import('@/services/trial-lifecycle/supervision.service');
    const s = await getTrialLifecycleSummary(D('2033-05-29T16:30:00Z'));
    expect(s.milestones.find((m) => m.code === 'J80')!.state).toEqual({ active: false, label: 'Bloqué : politique de conservation non fixée' });
    expect(s.retention.locked).toBe(true);
  });

  it('L100G-E2E-03 — désinscription sans connexion, signée, idempotente ; aucun contournement par les notifications de service', async () => {
    await settings({ commercialEnabled: true });
    const a = await essai();
    await consent(a.ownerUserId);
    await run('2033-03-13T15:00:00Z', [a.id]);
    const token = /desinscription\?t=([0-9]+\.[A-Za-z0-9_-]{32})/.exec(mailsTo(a.email)[0].html)![1];
    const { POST } = await import('@/app/api/public/marketing/unsubscribe/route');
    const post = (body: unknown, qs = '') => POST(new NextRequest(`${APP}/api/public/marketing/unsubscribe${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

    const r1 = await post({ t: token });
    expect(r1.status).toBe(200);
    const r2 = await post({}, `?t=${encodeURIComponent(token)}`); // « en un clic », rejoué
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual(await r1.json());
    expect(await sql`SELECT source FROM marketing_oppositions WHERE user_id = ${a.ownerUserId}`).toEqual([{ source: 'email_link' }]);
    expect((await sql<{ consented: boolean }[]>`SELECT consented FROM news_consents WHERE user_id = ${a.ownerUserId}`)[0].consented).toBe(false);
    expect((await events(a.id)).filter((e) => e.event_type === 'unsubscribe')).toHaveLength(1);
    // Lien falsifié : refusé, rien enregistré.
    expect((await post({ t: token.replace(/^\d+/, String(a.ownerUserId + 1)) })).status).toBe(400);
    expect((await post({ t: 'n-importe-quoi' })).status).toBe(400);

    // Plus aucune relance, même en réactivant le consentement aux actualités.
    await consent(a.ownerUserId);
    await run('2033-03-20T15:00:00Z', [a.id]);
    expect(await message(a.id, 'J10')).toMatchObject({ status: 'skipped', reason: 'opposition' });
    expect(mailsTo(a.email)).toHaveLength(1);

    // Opposé AVANT la fin d'essai : la notification de service J0 part (information
    // due, sans lien de relance) ; les relances, jamais.
    const b = await essai({ status: 'trialing', endsAt: '2033-03-11T14:05:00Z' });
    const { recordOpposition } = await import('@/services/trial-lifecycle/opposition.service');
    await recordOpposition(b.ownerUserId, 'email_link');
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${b.id}`;
    await run('2033-03-11T15:00:00Z', [b.id]);
    expect(mailsTo(b.email).map((m) => m.subject)).toEqual(['Votre essai gratuit Verebona est terminé']);
    expect(mailsTo(b.email)[0].html).not.toContain('desinscription');
    await run('2033-03-14T15:00:00Z', [b.id]);
    expect(await message(b.id, 'J3')).toMatchObject({ status: 'skipped', reason: 'opposition' });
    expect(mailsTo(b.email)).toHaveLength(1);
  });

  it('L100G-E2E-04 — chaque motif de non-envoi, relu sur l’état actuel juste avant l’envoi', async () => {
    const J0 = '2033-03-10T15:00:00Z';
    const cas = {
      souscrit: await essai(), paiement: await essai(), supprime: await essai(), suspendu: await essai(),
      enSuppression: await essai(), doublon: await essai(), coupe: await essai(), tard: await essai(), coupeBO: await essai(),
    };
    await sql`UPDATE account_subscriptions SET first_billed_at = '2033-03-10T14:30:00Z', status = 'active' WHERE account_id = ${cas.souscrit.id}`;
    await sql`UPDATE accounts SET checkout_session_id = 'cs_e2e_l100g', checkout_session_created_at = '2033-03-10T14:50:00Z' WHERE id = ${cas.paiement.id}`;
    await sql`UPDATE users SET status = 'DELETED' WHERE id = ${cas.supprime.ownerUserId}`;
    await sql`UPDATE users SET status = 'SUSPENDED' WHERE id = ${cas.suspendu.ownerUserId}`;
    await sql`INSERT INTO scheduled_account_deletions (account_id, user_id, reason, origin, confirmed_at, scheduled_at, status)
              VALUES (${cas.enSuppression.id}, ${cas.enSuppression.ownerUserId}, 'VOLUNTARY', 'user', now(), '2033-04-09T00:00:00Z', 'SCHEDULED')`;
    // Doublon : e-mail TRIAL_ENDED déjà envoyé par l'ANCIEN circuit (notifications).
    const [ob] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, account_id, recipient_user_id, payload_json, dedupe_key, status, scheduled_for, created_at)
      VALUES ('TRIAL_ENDED', ${cas.doublon.id}, ${cas.doublon.ownerUserId}, '{}'::jsonb, ${`account:trial-ended:${cas.doublon.id}`}, 'sent', '2033-03-10T14:10:00Z', '2033-03-10T14:10:00Z')
      RETURNING id`;
    await sql`INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, attempt_count, attempted_at, sent_at, created_at)
              VALUES (${ob.id}, ${cas.doublon.ownerUserId}, 'email', 'sent', 1, '2033-03-10T14:10:00Z', '2033-03-10T14:10:00Z', '2033-03-10T14:10:00Z')`;
    // E-mail « Fin d'essai » désactivé dans BO › Communications.
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active, updated_at) VALUES ('TRIAL_ENDED', 'email', false, now())
              ON CONFLICT (event_code, channel) DO UPDATE SET is_active = false`;

    const ids = Object.values(cas).filter((c) => c !== cas.tard && c !== cas.coupe).map((c) => c.id);
    await run(J0, ids);
    expect(await message(cas.coupeBO.id, 'J0')).toMatchObject({ status: 'deferred', reason: 'channel_disabled_by_admin' });
    expect(await message(cas.doublon.id, 'J0')).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(await message(cas.souscrit.id, 'J0')).toMatchObject({ status: 'skipped', reason: 'subscription_active' });
    expect(await message(cas.paiement.id, 'J0')).toMatchObject({ status: 'deferred', reason: 'payment_in_progress' });
    expect(await message(cas.supprime.id, 'J0')).toMatchObject({ status: 'skipped', reason: 'account_deleted' });
    expect(await message(cas.suspendu.id, 'J0')).toMatchObject({ status: 'deferred', reason: 'account_suspended' });
    expect(await message(cas.enSuppression.id, 'J0')).toMatchObject({ status: 'skipped', reason: 'account_deletion_pending' });
    expect(etat.calls).toHaveLength(0);
    // Interrupteur du BO réactivé dans la fenêtre : envoi au passage suivant.
    await sql`DELETE FROM communication_channel_settings WHERE event_code = 'TRIAL_ENDED'`;
    await run('2033-03-10T16:00:00Z', [cas.coupeBO.id]);
    expect(await message(cas.coupeBO.id, 'J0')).toMatchObject({ status: 'sent' });
    expect(mailsTo(cas.coupeBO.email)).toHaveLength(1);
    etat.calls.length = 0;

    // Coupure par variable : jamais envoyé, motif tracé.
    process.env.TRIAL_LIFECYCLE_EMAILS = 'off';
    try {
      await run(J0, [cas.coupe.id]);
    } finally {
      delete process.env.TRIAL_LIFECYCLE_EMAILS;
    }
    expect(await message(cas.coupe.id, 'J0')).toMatchObject({ status: 'deferred', reason: 'disabled_by_env' });

    // Tâche arrêtée pendant toute la fenêtre (48 h) : jamais d'envoi tardif.
    await run('2033-03-12T15:00:00Z', [cas.tard.id]);
    expect(await message(cas.tard.id, 'J0')).toMatchObject({ status: 'skipped', reason: 'out_of_window' });
    // Fenêtre refermée sur un message en attente : clos avec son dernier motif.
    await run('2033-03-12T15:00:00Z', [cas.suspendu.id]);
    const susp = await message(cas.suspendu.id, 'J0');
    expect(susp).toMatchObject({ status: 'skipped', reason: 'account_suspended' });
    expect((await events(cas.suspendu.id)).at(-1)).toMatchObject({ event_type: 'not_sent', reason: 'account_suspended', detail: { windowExpired: true } });
    expect(etat.calls).toHaveLength(0);
  });

  it('L100G-E2E-05 — échec d’envoi : 3 tentatives, même clé, puis échec définitif (synthèse « Incident »)', async () => {
    const a = await essai();
    etat.fail = true;
    await run('2033-03-10T15:00:00Z', [a.id]);
    await run('2033-03-10T16:00:00Z', [a.id]);
    await run('2033-03-10T17:00:00Z', [a.id]);
    await run('2033-03-10T18:00:00Z', [a.id]); // 4e passage : plus aucune tentative
    const m = await message(a.id, 'J0');
    expect(m).toMatchObject({ status: 'failed', reason: 'send_failed', attempt_count: 3 });
    expect(new Set(etat.keys)).toEqual(new Set([`trial-lifecycle-${m.id}`]));
    expect(etat.keys).toHaveLength(3);
    const ev = (await events(a.id)).filter((e) => e.event_type === 'failed');
    expect(ev.map((e) => e.detail.final)).toEqual([false, false, true]);
    const [log] = await sql<{ status: string }[]>`SELECT status FROM email_logs WHERE id = ${m.email_log_id}`;
    expect(log.status).toBe('failed');
    const { getTrialLifecycleSummary } = await import('@/services/trial-lifecycle/supervision.service');
    const s = await getTrialLifecycleSummary(new Date());
    expect(s.health).toBe('INCIDENT');
    expect(s.healthLabel).toBe('Incident');
  });

  it('L100G-E2E-06 — conversion attribuée au dernier e-mail envoyé ; journal BO filtrable', async () => {
    await settings({ commercialEnabled: true });
    const a = await essai();
    await consent(a.ownerUserId);
    await run('2033-03-10T15:00:00Z', [a.id]);
    await run('2033-03-13T15:00:00Z', [a.id]);
    await sql`UPDATE account_subscriptions SET first_billed_at = '2033-03-15T10:00:00Z', contract_concluded_at = '2033-03-15T10:00:00Z', status = 'active' WHERE account_id = ${a.id}`;
    await run('2033-03-20T15:00:00Z', [a.id]);
    await run('2033-03-21T15:00:00Z', [a.id]); // rejoué : une seule conversion
    expect(await message(a.id, 'J10')).toMatchObject({ status: 'skipped', reason: 'subscription_active' });
    const conv = (await events(a.id)).filter((e) => e.event_type === 'conversion');
    expect(conv).toHaveLength(1);
    expect(conv[0]).toMatchObject({ milestone: 'J3', template_code: 'TRIAL_FOLLOWUP_J3' });
    const { listTrialLifecycleJournal } = await import('@/services/trial-lifecycle/supervision.service');
    const j = await listTrialLifecycleJournal({ accountId: a.id, eventType: 'sent' });
    expect(j.rows.map((r) => r.milestone)).toEqual(['J3', 'J0']);
    expect(JSON.stringify(j)).not.toContain(a.email); // aucune adresse d'utilisateur au BO
    const settingsLog = await listTrialLifecycleJournal({ eventType: 'settings_changed' });
    expect(settingsLog.rows[0]).toMatchObject({ actor: 'admin' });
  });

  it('L100G-E2E-07 — contenus en base : E1 à l’identique, aucune mention 60 jours / 59 €, un seul circuit', async () => {
    const { TRIAL_SHIPPED_TEMPLATES, OBSOLETE_TRIAL_MENTION } = await import('@/services/trial-lifecycle/templates');
    for (const t of TRIAL_SHIPPED_TEMPLATES) {
      const [row] = await sql<{ subject: string; body: string }[]>`SELECT subject, body FROM email_templates WHERE upper(type) = upper(${t.type})`;
      expect(row, t.type).toEqual({ subject: t.subject, body: t.body });
    }
    const all = await sql<{ type: string; subject: string; body: string }[]>`SELECT type, subject, body FROM email_templates`;
    expect(all.filter((r) => OBSOLETE_TRIAL_MENTION.test(`${r.subject}\n${r.body}`)).map((r) => r.type)).toEqual([]);
    // Migration rejouée : aucun changement, aucune version en double.
    const before = await sql`SELECT template_type, count(*)::int AS n FROM email_template_versions GROUP BY template_type ORDER BY template_type`;
    const { readFileSync } = await import('node:fs');
    await sql.unsafe(readFileSync('src/db/migrations/0887_l100g_modeles_fin_essai.sql', 'utf8'));
    expect(await sql`SELECT template_type, count(*)::int AS n FROM email_template_versions GROUP BY template_type ORDER BY template_type`).toEqual(before);
    // Ancien modèle retiré : jamais envoyé, même appelé directement.
    const { emailService } = await import('@/lib/email/email-service');
    const r = await emailService.send({ templateCode: 'TRIAL_ENDED', to: 'x@test.invalid', variables: {} });
    expect(r).toMatchObject({ success: false, error: 'COMMUNICATION_RETIRED' });
    expect(etat.calls).toHaveLength(0);
  });
});
