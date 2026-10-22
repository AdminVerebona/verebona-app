/**
 * Lot 79C — e-mails et notifications, sur PostgreSQL 16 réel : vrai moteur
 * (outbox, dispatcher, livraisons), vraies préférences, vrai service d'e-mail
 * (prestataire simulé), vraies migrations 0620 / 0621.
 *
 *   L79C-E2E-01 (AC02) confirmation d'ajout : ni e-mail ni push — ancienne
 *               préférence active, nouvel événement ET ligne déjà en file
 *               (drapeau obligatoire d'une version antérieure), canal BO actif ;
 *   L79C-E2E-02 (AC03/AC04) échecs d'analyse : file existante, aucun e-mail ;
 *               l'alerte du document est regroupée avec celle du lot ;
 *               réémission BO : jamais d'e-mail ;
 *   L79C-E2E-03 (AC05) « À traiter » : aucune alerte immédiate (file existante,
 *               anciennes préférences) ; le passage n'émet plus rien ;
 *   L79C-E2E-04 (AC06) récapitulatif : facultatif, préférence explicite
 *               conservée, jamais répété à contenu inchangé ;
 *   L79C-E2E-05 (AC07) préférences : facultatifs désactivables, indispensables
 *               toujours envoyés ; affichage = décision du moteur ;
 *   L79C-E2E-06 (AC01) SECURITY_SESSIONS_REVOKED : jamais envoyé, journal « skipped » ;
 *   L79C-E2E-07 DUO_INVITATION_DECLINED : e-mail désactivé par défaut (0620),
 *               choix explicite d'un administrateur préservé ;
 *   L79C-E2E-08 (AC04/AC08) paiement : échec + authentification de la même
 *               facture → un message ; autre facture et rappels conservés ;
 *   L79C-E2E-09 (AC08) renouvellement : sans push ; sans e-mail si le reçu couvre.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  return { mails: [] as Array<{ to: string; subject?: string }>, pushes: [] as Array<{ endpoint: string; payload: Record<string, unknown> }>, n: 0 };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject?: string }) => {
        etat.mails.push(p);
        etat.n += 1;
        return { data: { id: `em_l79c_${etat.n}` }, error: null };
      },
    };
  },
}));
vi.mock('@/lib/notifications/web-push-sender', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications/web-push-sender')>('@/lib/notifications/web-push-sender');
  return {
    ...actual,
    getVapidPublicKey: () => 'cle-publique-e2e',
    sendWebPush: async (target: { endpoint: string }, payload: Record<string, unknown>) => {
      etat.pushes.push({ endpoint: target.endpoint, payload });
      return { ok: true };
    },
  };
});

scenario('L79C', 'E-mails et notifications : suppressions effectives, regroupements, préférences', ({ sql, make }) => {
  beforeEach(async () => {
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@verebona.com', 'support@verebona.com')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
  });

  async function compte() {
    const acc = await make.account({ plan: 'premium' });
    const [u] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${acc.ownerUserId}`;
    await sql`INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, status)
              VALUES (${acc.ownerUserId}, ${`https://push.e2e/${acc.ownerUserId}`}, 'p256', 'auth', 'active')`;
    return { ...acc, userId: acc.ownerUserId, email: u.email, endpoint: `https://push.e2e/${acc.ownerUserId}` };
  }
  async function pref(userId: number, category: string, channel: 'email' | 'push', enabled: boolean, mode = 'immediate') {
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${userId}, ${category}, ${mode}, ${channel}, ${enabled})
              ON CONFLICT (user_id, category, delivery_mode, channel) DO UPDATE SET enabled = EXCLUDED.enabled`;
  }
  /** Ligne d'outbox « déjà en file » (créée avant le déploiement, éventuellement drapeaux d'une version antérieure). */
  async function enFile(c: { id: number; userId: number }, type: string, payload: Record<string, unknown>, over: { mandatoryEmail?: boolean; entityType?: string; entityId?: string; category?: string } = {}) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, entity_type, entity_id, payload_json,
                                       priority, mandatory_bell, mandatory_email, dedupe_key, status, created_at)
      VALUES (${type}, ${over.category ?? 'documents'}, ${c.id}, ${c.userId}, ${over.entityType ?? null}, ${over.entityId ?? null},
              ${JSON.stringify(payload)}::jsonb, 'normal', false, ${over.mandatoryEmail ?? false},
              ${`l79c:${type}:${c.userId}:${Math.random()}`}, 'pending', now() - interval '1 hour')
      RETURNING id`;
    return row.id;
  }
  async function traiter() {
    const { processPending } = await import('@/lib/notifications');
    for (let i = 0; i < 20; i++) if ((await processPending(100)).claimed === 0) break;
  }
  const livraisons = (outboxId: string) => sql<{ channel: string; status: string; last_error_code: string | null }[]>`
    SELECT channel, status, last_error_code FROM notification_deliveries WHERE outbox_id = ${outboxId}::uuid ORDER BY channel`;
  const mailsA = (email: string) => etat.mails.filter((m) => m.to === email || (Array.isArray(m.to) && (m.to as string[]).includes(email)));
  const pushesA = (endpoint: string) => etat.pushes.filter((p) => p.endpoint === endpoint);

  it('L79C-E2E-01 (AC02) confirmation d’ajout : aucun e-mail ni push — ancienne préférence, file existante, canal BO actif', async () => {
    const c = await compte();
    await pref(c.userId, 'documents', 'email', true);
    await pref(c.userId, 'documents', 'push', true);
    // Activation BO explicite de l'ancien canal : ne réactive pas un canal supprimé.
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active) VALUES ('DOCUMENT_UPLOAD_COMPLETED', 'email', true)
              ON CONFLICT (event_code, channel) DO UPDATE SET is_active = true`;
    const ancienne = await enFile(c, 'DOCUMENT_UPLOAD_COMPLETED', { count: 2 }, { mandatoryEmail: true });
    const { emit } = await import('@/lib/notifications');
    await emit({ type: 'DOCUMENT_UPLOAD_COMPLETED', recipientUserIds: [c.userId], accountId: c.id, payload: { count: 1 },
      dedupeKey: `l79c-upload-${c.userId}`, scheduledFor: new Date(Date.now() - 1000) });
    await traiter();

    const [nouvelle] = await sql<{ id: string }[]>`SELECT id FROM notification_outbox WHERE dedupe_key = ${`l79c-upload-${c.userId}:u${c.userId}`}`;
    for (const id of [ancienne, nouvelle.id]) {
      expect(await livraisons(id)).toEqual([
        { channel: 'bell', status: 'sent', last_error_code: null },
        { channel: 'email', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
        { channel: 'push', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
      ]);
    }
    expect(mailsA(c.email)).toHaveLength(0);
    expect(pushesA(c.endpoint)).toHaveLength(0);
    // La confirmation reste dans l'application.
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${c.userId} AND type = 'DOCUMENT_UPLOAD_COMPLETED'`).toHaveLength(2);
    // Statistiques BO : un canal supprimé n'est jamais compté « envoyé ».
    expect(await sql`SELECT 1 FROM notification_deliveries d WHERE d.user_id = ${c.userId} AND d.channel IN ('email','push') AND d.status = 'sent'`).toHaveLength(0);
    await sql`DELETE FROM communication_channel_settings WHERE event_code = 'DOCUMENT_UPLOAD_COMPLETED'`;
  });

  it('L79C-E2E-02 (AC03/AC04) échecs d’analyse : aucun e-mail, alerte du document regroupée avec celle du lot, réémission sans e-mail', async () => {
    const c = await compte();
    await pref(c.userId, 'documents', 'email', true);
    const f1 = await make.assetFile(c, { name: 'Facture garage.pdf' });
    const f2 = await make.assetFile(c, { name: 'Devis.pdf' });
    const [lot] = await sql<{ id: number }[]>`INSERT INTO document_lots (account_id, status) VALUES (${c.id}, 'partially_failed') RETURNING id`;
    await sql`INSERT INTO document_lot_items (lot_id, asset_file_id, position, analysis_status) VALUES (${lot.id}, ${f1.id}, 0, 'failed'), (${lot.id}, ${f2.id}, 1, 'failed')`;

    const lotRow = await enFile(c, 'DOCUMENT_BATCH_FAILED', { lotId: lot.id, analysedCount: 0, failedCount: 2 });
    await traiter();
    const docRow = await enFile(c, 'ANALYSIS_FAILED_PERSISTENT', { assetFileId: f1.id, documentTitle: 'Facture garage' });
    await traiter();

    expect(await livraisons(lotRow)).toEqual([
      { channel: 'bell', status: 'sent', last_error_code: null },
      { channel: 'email', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
      { channel: 'push', status: 'sent', last_error_code: null },
    ]);
    const [doc] = await sql<{ status: string; last_error: string }[]>`SELECT status, last_error FROM notification_outbox WHERE id = ${docRow}::uuid`;
    expect(doc).toEqual({ status: 'cancelled', last_error: `grouped_with:${lotRow}` });
    expect((await livraisons(docRow)).every((l) => l.status === 'skipped_unavailable' && l.last_error_code === 'grouped_incident')).toBe(true);
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${c.userId} AND type IN ('DOCUMENT_BATCH_FAILED', 'ANALYSIS_FAILED_PERSISTENT')`).toHaveLength(1);
    const [cloche] = await sql<{ body: string }[]>`SELECT body FROM notifications WHERE user_id = ${c.userId} AND type = 'DOCUMENT_BATCH_FAILED'`;
    expect(cloche.body).toMatch(/relancer l’analyse depuis la fiche du document/);

    // Réémission BO d'un ancien échec (e-mail ET cloche en échec avant le déploiement).
    const ancien = await enFile(c, 'DOCUMENT_BATCH_PARTIALLY_FAILED', { lotId: lot.id + 100000, analysedCount: 1, failedCount: 1 });
    await sql`UPDATE notification_outbox SET status = 'failed' WHERE id = ${ancien}::uuid`;
    await sql`INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, attempt_count) VALUES
              (${ancien}::uuid, ${c.userId}, 'bell', 'failed', 1), (${ancien}::uuid, ${c.userId}, 'email', 'failed', 1)`;
    const admin = await make.user({ role: 'ADMIN' });
    const { reemettreNotification } = await import('@/services/notifications/notification-reemission.service');
    const r = await reemettreNotification({ outboxId: ancien, actorUserId: admin.id, actorEmail: admin.email, confirme: true });
    expect(r.canaux).toEqual(['bell']);
    await traiter();
    expect(await livraisons(r.nouvelleId)).toEqual([{ channel: 'bell', status: 'sent', last_error_code: null }]);
    // Uniquement l'e-mail en échec : rien à réémettre.
    const seulMail = await enFile(c, 'DOCUMENT_BATCH_FAILED', { lotId: lot.id + 200000, analysedCount: 0, failedCount: 1 });
    await sql`UPDATE notification_outbox SET status = 'partial' WHERE id = ${seulMail}::uuid`;
    await sql`INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, attempt_count) VALUES
              (${seulMail}::uuid, ${c.userId}, 'bell', 'sent', 1), (${seulMail}::uuid, ${c.userId}, 'email', 'failed', 1)`;
    await expect(reemettreNotification({ outboxId: seulMail, actorUserId: admin.id, actorEmail: admin.email, confirme: true }))
      .rejects.toMatchObject({ code: 'RIEN_A_REEMETTRE' });
    expect(mailsA(c.email)).toHaveLength(0);
  });

  it('L79C-E2E-03 (AC05) « À traiter » : aucune alerte immédiate, même en file avec d’anciennes préférences', async () => {
    const c = await compte();
    await pref(c.userId, 'to_process', 'email', true);
    await pref(c.userId, 'to_process', 'push', true);
    const row = await enFile(c, 'TO_PROCESS_ITEM_CREATED', { itemKey: 'x', actionKind: 'ARBITRATE' }, { category: 'to_process' });
    await traiter();
    expect(await livraisons(row)).toEqual([
      { channel: 'email', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
      { channel: 'push', status: 'skipped_unavailable', last_error_code: 'channel_retired' },
    ]);
    expect(mailsA(c.email)).toHaveLength(0);
    expect(pushesA(c.endpoint)).toHaveLength(0);
    // Nouveaux éléments : le passage n'émet plus de ligne sans objet ; l'action reste sur la page.
    const bien = await make.asset(c);
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${c.id}, 'ASSET', ${bien.id}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?')`;
    const { runToProcessScan } = await import('@/lib/notifications/scheduled/to-process-scan');
    expect((await runToProcessScan()).created).toBe(0);
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${c.userId} AND event_type = 'TO_PROCESS_ITEM_CREATED' AND id <> ${row}::uuid`).toHaveLength(0);
  });

  it('L79C-E2E-04 (AC06) récapitulatif : facultatif, choix explicite conservé, jamais répété à contenu inchangé', async () => {
    const sansPref = await compte();
    const avecPref = await compte();
    await pref(avecPref.userId, 'to_process', 'email', true, 'daily_digest'); // activation volontaire existante
    const action = async (c: { id: number; ownerUserId: number }, q: string) => {
      const bien = await make.asset(c);
      return (await sql<{ public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
      VALUES (${c.id}, 'ASSET', ${bien.id}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', ${q})
      RETURNING public_id`)[0].public_id;
    };
    await action(sansPref, 'A ?');
    const a1 = await action(avecPref, 'A ?');
    await action(avecPref, 'B ?');
    const { runToProcessDigest } = await import('@/lib/notifications/scheduled/to-process-digest');
    const recap = (userId: number) => sql<{ payload_json: { total: number } }[]>`
      SELECT payload_json FROM notification_outbox WHERE recipient_user_id = ${userId} AND event_type = 'TO_PROCESS_DAILY_DIGEST' ORDER BY created_at`;
    const jour = (d: number) => new Date(Date.UTC(2026, 10, d, 7, 30));

    await runToProcessDigest(jour(2));
    expect(await recap(sansPref.userId)).toHaveLength(0); // désactivé par défaut
    expect((await recap(avecPref.userId)).map((r) => r.payload_json.total)).toEqual([2]);

    await runToProcessDigest(jour(3)); // contenu inchangé
    expect(await recap(avecPref.userId)).toHaveLength(1);

    await sql`UPDATE to_process_actions SET resolved_at = now() WHERE public_id = ${a1}::uuid`;
    await runToProcessDigest(jour(4)); // seulement une résolution (compteur en baisse) : rien de nouveau
    expect(await recap(avecPref.userId)).toHaveLength(1);

    await action(avecPref, 'C ?'); // même total (2), contenu nouveau
    await runToProcessDigest(jour(5));
    expect((await recap(avecPref.userId)).map((r) => r.payload_json.total)).toEqual([2, 2]);
    const [st] = await sql<{ total: number }[]>`SELECT total FROM to_process_digest_state WHERE user_id = ${avecPref.userId}`;
    expect(st.total).toBe(2);
  });

  it('L79C-E2E-05 (AC07) préférences : facultatifs désactivables, indispensables toujours envoyés ; affichage = moteur', async () => {
    const c = await compte();
    const { buildPreferenceMatrix, applyPreferenceChanges } = await import('@/lib/notifications/preference-matrix');
    const { resolveChannels } = await import('@/lib/notifications');
    const { getCatalogEntry } = await import('@/lib/notifications/catalog');

    const m0 = await buildPreferenceMatrix(c.userId);
    const cat = (m: typeof m0, k: string) => m.categories.find((x) => x.key === k)!;
    for (const k of ['duo', 'account', 'security']) {
      expect(cat(m0, k).immediate.email).toEqual({ enabled: true, locked: false, available: true });
      expect(cat(m0, k).emailScope.essential.length).toBeGreaterThan(0);
    }
    expect(cat(m0, 'documents').immediate.email.available).toBe(false);
    expect(cat(m0, 'to_process').immediate).toEqual({
      push: { enabled: false, locked: false, available: false }, email: { enabled: false, locked: false, available: false },
    });
    expect(cat(m0, 'to_process').digest!.email).toEqual({ enabled: false, locked: false, available: true });

    expect(await applyPreferenceChanges(c.userId, [
      { category: 'duo', channel: 'email', enabled: false },
      { category: 'account', channel: 'email', enabled: false },
      { category: 'security', channel: 'email', enabled: false },
    ])).toEqual({ ok: true });
    expect(await applyPreferenceChanges(c.userId, [{ category: 'documents', channel: 'email', enabled: true }]))
      .toEqual({ ok: false, error: 'CHANNEL_RETIRED:documents:email' });

    const m1 = await buildPreferenceMatrix(c.userId);
    expect(cat(m1, 'duo').immediate.email.enabled).toBe(false);
    // Décision réelle du moteur, cohérente avec l'affichage.
    const email = async (t: string) => (await resolveChannels(c.userId, getCatalogEntry(t)!)).email;
    expect(await email('DUO_MOVE_ACCEPTED')).toBe(false);
    expect(await email('TRIAL_ENDING')).toBe(false);
    expect(await email('NEW_DEVICE_LOGIN')).toBe(false);
    expect(await email('DUO_MOVE_REQUEST')).toBe(true);
    expect(await email('PAYMENT_FAILED')).toBe(true);
    expect(await email('PASSWORD_CHANGED')).toBe(true);
  });

  it('L79C-E2E-06 (AC01) SECURITY_SESSIONS_REVOKED : jamais envoyé, même en test BO — journal « skipped » distinct', async () => {
    const { emailService } = await import('@/lib/email/email-service');
    const avant = etat.mails.length;
    for (const skipChannelCheck of [false, true]) {
      const r = await emailService.send({ templateCode: 'SECURITY_SESSIONS_REVOKED', to: 'securite-l79c@test.invalid', variables: {}, skipChannelCheck });
      expect(r).toMatchObject({ success: false, error: 'COMMUNICATION_RETIRED' });
    }
    expect(etat.mails.length).toBe(avant);
    const logs = await sql<{ status: string; error_message: string }[]>`
      SELECT status, error_message FROM email_logs WHERE recipient_email = 'securite-l79c@test.invalid'`;
    expect(logs).toEqual([
      { status: 'skipped', error_message: 'COMMUNICATION_RETIRED' },
      { status: 'skipped', error_message: 'COMMUNICATION_RETIRED' },
    ]);
  });

  it('L79C-E2E-07 DUO_INVITATION_DECLINED : e-mail désactivé par défaut (0620), choix explicite préservé, cloche intacte', async () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0620_l79c_duo_refus_email_defaut.sql'), 'utf8');
    const { isTransactionalEmailActive } = await import('@/lib/notifications/channel-activation');
    // Valeur automatique (aucune ligne) → désactivé, sans auteur.
    await sql`DELETE FROM communication_channel_settings WHERE event_code = 'email:DUO_INVITATION_DECLINED'`;
    await runMigrationSql(sql as unknown as SqlRunner, migration);
    await runMigrationSql(sql as unknown as SqlRunner, migration); // rejouable
    const [row] = await sql<{ is_active: boolean; updated_by: number | null }[]>`
      SELECT is_active, updated_by FROM communication_channel_settings WHERE event_code = 'email:DUO_INVITATION_DECLINED'`;
    expect(row).toEqual({ is_active: false, updated_by: null });
    expect(await isTransactionalEmailActive('DUO_INVITATION_DECLINED')).toBe(false);
    // Choix explicite d'un administrateur (activation) : jamais écrasé.
    const admin = await make.user({ role: 'ADMIN' });
    await sql`UPDATE communication_channel_settings SET is_active = true, updated_by = ${admin.id} WHERE event_code = 'email:DUO_INVITATION_DECLINED'`;
    await runMigrationSql(sql as unknown as SqlRunner, migration);
    expect(await isTransactionalEmailActive('DUO_INVITATION_DECLINED')).toBe(true);
    await sql`UPDATE communication_channel_settings SET is_active = false, updated_by = NULL WHERE event_code = 'email:DUO_INVITATION_DECLINED'`;
    const { getCatalogEntry } = await import('@/lib/notifications/catalog');
    expect(getCatalogEntry('DUO_INVITATION_DECLINED')!.mandatoryBell).toBe(true);
  });

  it('L79C-E2E-08 (AC04/AC08) paiement : échec + authentification de la même facture → un seul message ; autre facture conservée', async () => {
    const c = await compte();
    const { emit } = await import('@/lib/notifications');
    const passe = new Date(Date.now() - 1000);
    await emit({ type: 'PAYMENT_FAILED', accountId: c.id, entityType: 'invoice', entityId: 'in_l79c_A', payload: { accountId: c.id, deadlineAt: '2027-01-20T00:00:00Z' },
      dedupeKey: `l79c:pf:A:${c.id}`, scheduledFor: passe });
    await emit({ type: 'PAYMENT_ACTION_REQUIRED', accountId: c.id, entityType: 'invoice', entityId: 'in_l79c_A', payload: { accountId: c.id },
      dedupeKey: `l79c:par:A:${c.id}`, scheduledFor: passe });
    await emit({ type: 'PAYMENT_ACTION_REQUIRED', accountId: c.id, entityType: 'invoice', entityId: 'in_l79c_B', payload: { accountId: c.id },
      dedupeKey: `l79c:par:B:${c.id}`, scheduledFor: passe });
    await traiter();

    const rows = await sql<{ event_type: string; entity_id: string; status: string; last_error: string | null }[]>`
      SELECT event_type, entity_id, status, last_error FROM notification_outbox WHERE recipient_user_id = ${c.userId} ORDER BY event_type, entity_id`;
    expect(rows.map((r) => [r.event_type, r.entity_id, r.status])).toEqual([
      ['PAYMENT_ACTION_REQUIRED', 'in_l79c_A', 'cancelled'],
      ['PAYMENT_ACTION_REQUIRED', 'in_l79c_B', 'sent'],
      ['PAYMENT_FAILED', 'in_l79c_A', 'sent'],
    ]);
    const cloches = await sql<{ type: string; body: string }[]>`SELECT type, body FROM notifications WHERE user_id = ${c.userId} ORDER BY type`;
    expect(cloches.map((x) => x.type)).toEqual(['PAYMENT_ACTION_REQUIRED', 'PAYMENT_FAILED']);
    expect(cloches[1].body).toMatch(/Un paiement a échoué[\s\S]*Votre banque demande une validation/);
    // Deux e-mails : l'incident A (un seul message) et l'incident B (autre facture).
    expect(mailsA(c.email)).toHaveLength(2);
  });

  it('L79C-E2E-09 (AC08) renouvellement : sans push ; sans e-mail générique si le reçu Stripe couvre la facture', async () => {
    const c = await compte();
    const { emit } = await import('@/lib/notifications');
    const passe = new Date(Date.now() - 1000);
    await emit({ type: 'SUBSCRIPTION_RENEWED', accountId: c.id, entityType: 'invoice', entityId: 'in_r1', payload: { planCode: 'PREMIUM', receiptCovered: true },
      dedupeKey: `l79c:ren:1:${c.id}`, scheduledFor: passe });
    await traiter();
    expect(mailsA(c.email)).toHaveLength(0);
    expect(pushesA(c.endpoint)).toHaveLength(0);
    await emit({ type: 'SUBSCRIPTION_RENEWED', accountId: c.id, entityType: 'invoice', entityId: 'in_r2', payload: { planCode: 'PREMIUM' },
      dedupeKey: `l79c:ren:2:${c.id}`, scheduledFor: passe });
    await traiter();
    expect(mailsA(c.email)).toHaveLength(1);
    expect(pushesA(c.endpoint)).toHaveLength(0);
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${c.userId} AND type = 'SUBSCRIPTION_RENEWED'`).toHaveLength(2);
  });
});
