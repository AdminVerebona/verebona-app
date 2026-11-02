/**
 * Lot 102A — cycle de vie des comptes : états restreints, conservation
 * 90 jours, purge — sur PostgreSQL 16 réel (toutes les migrations, dont 0900
 * et 0901), stockage objet SIMULÉ, e-mails simulés.
 *
 * L102A-E2E-01 Fin d'essai : lecture seule, purge programmée à fin + 90 j par
 *              la tâche existante ; rattrapage d'un ancien essai avec préavis ;
 *              bandeau « Lecture seule jusqu'au … » servi par trial-status.
 * L102A-E2E-02 Annulation par (re)souscription : purge annulée, jamais une
 *              suppression engagée par le back-office.
 * L102A-E2E-03 Fin d'abonnement payant : purge à fin + 90 j ; impayé et essai
 *              jamais payé exclus ; resouscription : annulée.
 * L102A-E2E-04 Rétractation SANS suppression : compte conservé en lecture
 *              seule, purge à +90 j (motif RETRACTATION), aucune demande RGPD.
 * L102A-E2E-05 Purge complète à l'échéance : plus AUCUNE ligne du compte
 *              (données dérivées : IA, extractions, relations, cartes,
 *              agenda, notifications…), objets du stockage simulé supprimés,
 *              factures détachées conservées, registre minimal, idempotence,
 *              supervision.
 * L102A-E2E-06 J+80 : envoyé avec la date réelle et les jours restants si une
 *              purge est programmée ; jamais sinon (contrôle avant envoi).
 * L102A-E2E-07 Suppression volontaire : accès coupé et traitements arrêtés
 *              tout de suite, suppression au plus tôt (balayage horaire),
 *              registre, rejeu après une « restauration ».
 */
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'secret-e2e-l102a';
  return {
    session: { userId: 0, currentAccountId: 0 as number | null, email: '' },
    emails: [] as Array<{ templateCode: string; to: string; variables: Record<string, string> }>,
  };
});

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ ...etat.session }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/lib/email/email-service', () => ({
  emailService: {
    send: async (o: { templateCode: string; to: string; variables: Record<string, string> }) => { etat.emails.push(o); return { success: true }; },
  },
}));
vi.mock('@/lib/stripe', () => ({ getStripeServer: () => { throw new Error('Stripe non attendu'); }, getStripeKeyMode: () => null }));

const DAY = 86_400_000;
const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);

/** Tables de conservation légale isolées (détachées, pseudonymisées) et registres. */
const SURVIVORS = new Set([
  'legal_acceptances', 'withdrawal_requests', 'withdrawal_events', 'scheduled_account_deletions', 'pending_blob_deletions',
  'gdpr_requests', 'invoices', 'account_deletion_registry',
]);

scenario('L102A', 'Cycle de vie des comptes : états restreints, conservation 90 jours, purge', ({ sql, make }) => {
  async function essaiTermine(endsAt: Date, status: 'trialing' | 'readonly' = 'trialing') {
    const owner = await make.user({ email: `essai-${uid('l102a')}@test.invalid` });
    const acc = await make.account({ owner, plan: null });
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_consumed, trial_started_at, trial_ends_at)
              VALUES (${acc.id}, 'premium', ${status}, true, ${new Date(endsAt.getTime() - 7 * DAY).toISOString()}, ${endsAt.toISOString()})`;
    return acc;
  }
  const purgeOf = async (accountId: number) => {
    const rows = await sql<{ id: number; reason: string; origin: string; status: string; confirmed_at: Date; scheduled_at: Date; cancellation_reason: string | null }[]>`
      SELECT id, reason, origin, status, confirmed_at, scheduled_at, cancellation_reason FROM scheduled_account_deletions
       WHERE account_id = ${accountId} ORDER BY id DESC`;
    return rows.map((r) => ({ ...r, confirmed_at: new Date(r.confirmed_at), scheduled_at: new Date(r.scheduled_at) }));
  };

  /** Lignes encore rattachées aux identifiants (toutes tables, hors conservations légales isolées). */
  async function restesDu(ids: Record<string, number[]>): Promise<string[]> {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT c.table_name, c.column_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = current_schema() AND c.data_type IN ('integer', 'bigint')
         AND (c.column_name ~ '(^|_)(account|user|asset|file|document|agenda_item)_id$')`;
    const restes: string[] = [];
    for (const { table_name: t, column_name: c } of cols) {
      if (SURVIVORS.has(t)) continue;
      const kind = Object.keys(ids).find((k) => c === `${k}_id` || c.endsWith(`_${k}_id`));
      if (!kind) continue;
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)} WHERE ${sql(c)} IN ${sql(ids[kind])}`;
      if (n > 0) restes.push(`${t}.${c}=${n}`);
    }
    return restes;
  }

  it('L102A-E2E-01 — fin d’essai : lecture seule, purge à fin + 90 j (tâche existante), rattrapage avec préavis, bandeau', async () => {
    const now = new Date();
    const fin = new Date(now.getTime() - 3_600_000);
    const a = await essaiTermine(fin);
    const ancien = await essaiTermine(new Date(now.getTime() - 200 * DAY), 'readonly');

    const { runTrialExpiry } = await import('@/services/trial-expiry.job');
    const r = await runTrialExpiry(now);
    expect(r.purgesScheduled).toBeGreaterThanOrEqual(2);

    const [p] = await purgeOf(a.id);
    expect(p).toMatchObject({ reason: 'TRIAL_ABANDONED', origin: 'system', status: 'SCHEDULED' });
    expect(p.confirmed_at.toISOString()).toBe(fin.toISOString());
    expect(days(p.scheduled_at, fin)).toBe(90);
    // Ancien essai (aucune date annoncée) : jamais purgé sans 30 jours de préavis.
    const [pa] = await purgeOf(ancien.id);
    expect(days(pa.scheduled_at, now)).toBe(30);

    // Rejouée : aucun doublon, date jamais déplacée.
    await runTrialExpiry(new Date(now.getTime() + 3_600_000));
    expect(await purgeOf(a.id)).toHaveLength(1);

    // Lecture seule : lecture et export oui, écriture et IA non.
    const { getEntitlements } = await import('@/services/entitlements.service');
    expect(await getEntitlements(a.id)).toMatchObject({ canWrite: false, canRead: true, isRestricted: true });
    const { getAccountProcessingEligibility } = await import('@/services/account/processing-eligibility');
    expect((await getAccountProcessingEligibility(a.id)).eligible).toBe(false);

    // Bandeau Mon compte : date RÉELLE de suppression.
    etat.session = { userId: a.ownerUserId, currentAccountId: a.id, email: a.owner.email };
    const { GET } = await import('@/app/api/billing/trial-status/route');
    const body = await (await GET(new NextRequest('http://localhost/api/billing/trial-status'))).json();
    expect(body.restrictedState).toMatchObject({ reason: 'FIN_ESSAI', purgeAt: p.scheduled_at.toISOString(), cancelledBySubscription: true });
    expect(body.restrictedState.daysLeft).toBe(90);
  });

  it('L102A-E2E-02 — (re)souscription : purge annulée ; une suppression engagée par le back-office ne l’est jamais', async () => {
    const a = await essaiTermine(new Date(Date.now() - 2 * 3_600_000));
    const { scheduleTrialPurges, liftRestrictedState, getRestrictedState } = await import('@/services/account/restricted-state.service');
    await scheduleTrialPurges({ accountIds: [a.id] });
    expect((await getRestrictedState(a.id))?.reason).toBe('FIN_ESSAI');

    const cancelled = await liftRestrictedState(a.id, 'Nouvelle souscription conclue');
    expect(cancelled?.status).toBe('CANCELLED');
    expect((await purgeOf(a.id))[0]).toMatchObject({ status: 'CANCELLED', cancellation_reason: 'Nouvelle souscription conclue' });
    expect(await getRestrictedState(a.id)).toBeNull();
    // Jamais reprogrammée ensuite par le rattrapage (une purge de fin d'essai a existé).
    await scheduleTrialPurges({ accountIds: [a.id] });
    expect((await purgeOf(a.id)).filter((x) => x.status === 'SCHEDULED')).toHaveLength(0);

    const b = await make.account();
    await sql`INSERT INTO scheduled_account_deletions (account_id, user_id, reason, origin, confirmed_at, scheduled_at, status)
              VALUES (${b.id}, ${b.ownerUserId}, 'ADMIN', 'admin', now(), now() + interval '1 day', 'SCHEDULED')`;
    expect(await liftRestrictedState(b.id, 'Nouvelle souscription conclue')).toBeNull();
    expect((await purgeOf(b.id))[0].status).toBe('SCHEDULED');
  });

  it('L102A-E2E-03 — fin d’abonnement payant : purge à fin + 90 j ; impayé et essai jamais payé exclus ; resouscription : annulée', async () => {
    const { onPaidSubscriptionEnded, liftRestrictedState, getAdminRestrictedState } = await import('@/services/account/restricted-state.service');
    const a = await make.account({ plan: 'premium' });
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${a.id}`;
    const fin = new Date(Date.now() - DAY);
    const r = await onPaidSubscriptionEnded(a.id, fin);
    expect(r?.status).toBe('scheduled');
    const [p] = await purgeOf(a.id);
    expect(p).toMatchObject({ reason: 'SUBSCRIPTION_ENDED', origin: 'system', status: 'SCHEDULED' });
    expect(days(p.scheduled_at, fin)).toBe(90);
    // Événement rejoué : idempotent.
    expect((await onPaidSubscriptionEnded(a.id, new Date()))?.status).toBe('existing');
    expect(await purgeOf(a.id)).toHaveLength(1);
    const { getEntitlements } = await import('@/services/entitlements.service');
    expect(await getEntitlements(a.id)).toMatchObject({ canWrite: false, canRead: true });

    // Impayé en cours : le cycle de 90 jours (GAP-06) garde la main.
    const imp = await make.account({ plan: 'premium' });
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${imp.id}`;
    await sql`UPDATE accounts SET past_due_grace_started_at = now() - interval '10 days' WHERE id = ${imp.id}`;
    expect(await onPaidSubscriptionEnded(imp.id, fin)).toMatchObject({ status: 'skipped', reason: 'UNPAID_CYCLE' });
    // Jamais payé : relève de la fin d'essai.
    const jamais = await make.account({ plan: null });
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${jamais.id}, 'premium', 'canceled')`;
    expect(await onPaidSubscriptionEnded(jamais.id, fin)).toBeNull();

    // BO : état, date de purge ; resouscription : annulation visible.
    expect((await getAdminRestrictedState(a.id, a.ownerUserId)).current).toMatchObject({ reason: 'FIN_ABONNEMENT', purgeAt: p.scheduled_at.toISOString() });
    await liftRestrictedState(a.id, 'Nouvelle souscription conclue');
    const bo = await getAdminRestrictedState(a.id, a.ownerUserId);
    expect(bo.current).toBeNull();
    expect(bo.history[0]).toMatchObject({ reasonCode: 'SUBSCRIPTION_ENDED', status: 'CANCELLED', cancellationReason: 'Nouvelle souscription conclue' });
  });

  it('L102A-E2E-04 — rétractation : compte CONSERVÉ en lecture seule, purge à +90 j, aucune demande RGPD ; resouscription : annulée', async () => {
    const a = await make.account({ plan: 'premium' });
    const bien = await make.asset(a);
    const ref = `RET-L102A-${uid('r')}`;
    await sql`INSERT INTO withdrawal_requests (public_reference, account_id, user_id, status, cancellation_status)
              VALUES (${ref}, ${a.id}, ${a.ownerUserId}, 'received', 'pending')`;
    const fakeStripe = { subscriptions: {}, invoices: {}, refunds: {} } as never;
    const { processWithdrawal } = await import('@/services/withdrawal/withdrawal-processor.service');
    const r = await processWithdrawal(ref, { stripe: fakeStripe });
    expect(r.retention).toBe('scheduled');

    expect(await sql`SELECT 1 FROM accounts WHERE id = ${a.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM assets WHERE id = ${bien.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM users WHERE id = ${a.ownerUserId} AND status = 'ACTIVE'`).toHaveLength(1);
    const [s] = await sql<{ s: string }[]>`SELECT subscription_status AS s FROM accounts WHERE id = ${a.id}`;
    expect(s.s).toBe('WITHDRAWN');
    const [p] = await purgeOf(a.id);
    expect(p).toMatchObject({ reason: 'WITHDRAWAL', origin: 'system', status: 'SCHEDULED' });
    expect(days(p.scheduled_at, p.confirmed_at)).toBe(90);
    expect(await sql`SELECT 1 FROM gdpr_requests WHERE source_ref = ${`deletion:${p.id}`}`).toHaveLength(0);
    // Rejoué (balayage) : rien de plus.
    expect((await processWithdrawal(ref, { stripe: fakeStripe })).status).toBe('skipped');
    expect(await purgeOf(a.id)).toHaveLength(1);

    const { liftRestrictedState } = await import('@/services/account/restricted-state.service');
    expect((await liftRestrictedState(a.id, 'Nouvelle souscription conclue'))?.status).toBe('CANCELLED');
  });

  it('L102A-E2E-05 — purge à l’échéance : plus aucune ligne du compte (données dérivées comprises), stockage simulé vidé, conservations légales isolées', async () => {
    const a = await make.account({ plan: 'premium' });
    const bien = await make.asset(a);
    const f1 = await make.assetFile(a, { assetId: bien.id });
    const f2 = await make.assetFile(a, { assetId: bien.id });
    const doc = await make.document({ id: bien.id, accountId: a.id, userId: a.ownerUserId });
    const evt = await make.agendaItem(a, { assetIds: [bien.id] });
    // Données dérivées : extraction IA, preuve de champ, relation document ↔ bien, carte « À traiter », notification, recherche.
    await sql`INSERT INTO document_extractions (account_id, file_id) VALUES (${a.id}, ${f1.id})`;
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt)
              VALUES (${a.id}, ${bien.id}, 'brand', '"Renault"'::jsonb, 'FILE', ${f1.id}, 'HIGH', ${uid('fp')}, 'Renault')`;
    // Relation document ↔ bien (posée par le dépôt ; ajoutée si absente).
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin)
              SELECT ${a.id}, ${f1.id}, ${bien.id}, 'PRIMARY', 'AI'
               WHERE NOT EXISTS (SELECT 1 FROM document_asset_links WHERE file_id = ${f1.id})`;
    expect(await sql`SELECT 1 FROM document_asset_links WHERE file_id = ${f1.id}`).not.toHaveLength(0);
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${evt.id}, ${f2.id})`;
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, action_kind, rule_code, question, field_key)
              VALUES (${a.id}, 'ASSET', ${bien.id}, 'COMPLETE', 'E2E_L102A', 'Quelle est la marque ?', 'brand')`;
    await sql`INSERT INTO notifications (user_id, type) VALUES (${a.ownerUserId}, 'TRIAL_ENDED')`;
    await sql`INSERT INTO ai_search_log (account_id, query_text, offer_code) VALUES (${a.id}, 'facture', 'premium')`;
    // Journal de sécurité (conservation isolée) : connexion du titulaire.
    const [journal] = await sql<{ id: number }[]>`
      INSERT INTO user_activity_log (user_id, user_email, activity_type, ip_address) VALUES (${a.ownerUserId}, ${a.owner.email}, 'LOGIN', '203.0.113.7') RETURNING id`;
    const [facture] = await sql<{ id: number }[]>`
      INSERT INTO invoices (account_id, user_id, stripe_invoice_id, stripe_customer_id, amount, currency, status)
      VALUES (${a.id}, ${a.ownerUserId}, ${`in_l102a_${a.id}`}, 'cus_l102a', 5900, 'eur', 'paid') RETURNING id`;

    // Stockage objet simulé : les fichiers du compte y sont présents.
    const keys = (await sql<{ k: string }[]>`SELECT s3_key AS k FROM asset_files WHERE account_id = ${a.id}`).map((r) => r.k);
    const stockage = new Set<string>([...keys, 'autre-compte/garde.pdf']);

    // Fin d'abonnement → état restreint ; purge à l'échéance.
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${a.id}`;
    const { onPaidSubscriptionEnded } = await import('@/services/account/restricted-state.service');
    const entered = await onPaidSubscriptionEnded(a.id, new Date(Date.now() - 91 * DAY));
    expect(entered?.status).toBe('scheduled');
    const [p] = await purgeOf(a.id);
    const ids: Record<string, number[]> = {
      account: [a.id], user: [a.ownerUserId], asset: [bien.id], file: [f1.id, f2.id], document: [doc.id], agenda_item: [evt.id],
    };
    // Le contrôle voit bien les données du compte AVANT la purge (dérivées comprises).
    const avant = await restesDu(ids);
    for (const t of ['document_extractions', 'field_evidence', 'document_asset_links', 'agenda_file_links', 'to_process_actions', 'notifications', 'ai_search_log', 'assets', 'asset_files']) {
      expect(avant.some((r) => r.startsWith(`${t}.`)), t).toBe(true);
    }
    const { executeScheduledDeletion } = await import('@/services/account/scheduled-deletion.service');
    const res = await executeScheduledDeletion(p.id, { now: new Date() });
    expect(res.status).toBe('executed');

    // Plus AUCUNE ligne rattachée au compte, à son titulaire, à ses biens, fichiers, documents, événements.
    expect(await restesDu(ids)).toEqual([]);

    // Conservations légales isolées : facture détachée, trace d'exécution, registre minimal.
    expect(await sql`SELECT account_id, user_id FROM invoices WHERE id = ${facture.id}`).toEqual([{ account_id: null, user_id: null }]);
    expect(await sql`SELECT user_id, user_email FROM user_activity_log WHERE id = ${journal.id}`).toEqual([{ user_id: null, user_email: 'utilisateur supprimé' }]);
    expect((await purgeOf(a.id))[0]).toMatchObject({ status: 'EXECUTED' });
    const [reg] = await sql<{ reason: string; scope: string; user_ids: number[]; account_ids: number[]; source: string }[]>`
      SELECT reason, scope, user_ids, account_ids, source FROM account_deletion_registry WHERE schedule_id = ${p.id}`;
    expect(reg).toEqual({ reason: 'SUBSCRIPTION_ENDED', scope: 'account', user_ids: [a.ownerUserId], account_ids: [a.id], source: 'execution' });

    // Stockage : les objets du compte passent par la file de purge, puis disparaissent ; rien d'autre n'est touché.
    const enFile = (await sql<{ p: string }[]>`SELECT storage_path AS p FROM pending_blob_deletions WHERE storage_path IN ${sql(keys)}`).map((r) => r.p);
    expect(enFile.sort()).toEqual([...keys].sort());
    const { purgePendingBlobs } = await import('@/services/storage/blob-purge.service');
    await purgePendingBlobs({ deleteObject: async (k) => { stockage.delete(k); } });
    expect([...stockage]).toEqual(['autre-compte/garde.pdf']);

    // Idempotent : rejouée, sans effet.
    expect((await executeScheduledDeletion(p.id)).status).toBe('skipped');

    // Supervision / journal BO.
    const { getLifecycleSupervision } = await import('@/services/account/restricted-state.service');
    const sup = await getLifecycleSupervision();
    expect(sup.byReason.find((x) => x.reason === 'FIN_ABONNEMENT')!.executed30d).toBeGreaterThanOrEqual(1);
    expect(sup.registry.entries).toBeGreaterThanOrEqual(1);
  });

  it('L102A-E2E-06 — J+80 : envoyé avec la date réelle et les jours restants si une purge est programmée ; jamais sinon', async () => {
    const END = new Date('2033-03-10T14:05:00.000Z');
    const a = await essaiTermine(END, 'readonly');
    const b = await essaiTermine(END, 'readonly');
    const { scheduleTrialPurges, liftRestrictedState } = await import('@/services/account/restricted-state.service');
    const r = await scheduleTrialPurges({ now: new Date(END.getTime() + 3_600_000), accountIds: [a.id, b.id] });
    expect(r.scheduled).toBe(2);
    // b : souscription puis fin de l'essai payé… plus aucune purge de fin d'essai programmée.
    await liftRestrictedState(b.id, 'Nouvelle souscription conclue');

    const envois: Array<{ templateCode: string; to: string; variables: Record<string, string> }> = [];
    const { runTrialLifecycle } = await import('@/services/trial-lifecycle/sequence.service');
    await runTrialLifecycle({
      now: new Date('2033-05-29T15:00:00Z'), accountIds: [a.id, b.id], deadline: Date.now() + 60_000,
      sender: async (o) => { envois.push(o); return { success: true }; },
    });
    const j80 = envois.filter((e) => e.templateCode === 'TRIAL_DATA_RETENTION_J80');
    expect(j80).toHaveLength(1);
    expect(j80[0].variables).toMatchObject({ daysRemaining: '10', dataDeletionDate: '8 juin 2033' });
    expect(j80[0].variables.exportUrl).toBe('https://app.e2e.verebona.test/mon-compte#mes-donnees');
    const [mb] = await sql<{ status: string; reason: string | null }[]>`
      SELECT status, reason FROM trial_lifecycle_messages WHERE account_id = ${b.id} AND milestone = 'J80'`;
    expect(mb).toEqual({ status: 'blocked', reason: 'deletion_not_scheduled' });
  });

  it('L102A-E2E-07 — suppression volontaire : accès et traitements coupés tout de suite, suppression au plus tôt, registre, rejeu après restauration', async () => {
    const a = await make.account();
    await make.asset(a);
    const t0 = new Date();
    const { closeAccountForDeletion } = await import('@/services/account/voluntary-deletion.service');
    const r = await closeAccountForDeletion({ userId: a.ownerUserId, confirmation: 'SUPPRIMER MON COMPTE', reauthProven: true, now: t0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule.scheduledAt.getTime() - t0.getTime()).toBe(24 * 3_600_000);
    expect(await sql`SELECT 1 FROM users WHERE id = ${a.ownerUserId} AND status = 'PENDING_DELETION'`).toHaveLength(1);
    // Traitements arrêtés (règle pure et SQL).
    const { getAccountProcessingEligibility, filterEligibleAccountIds } = await import('@/services/account/processing-eligibility');
    expect(await getAccountProcessingEligibility(a.id)).toEqual({ eligible: false, reason: 'DELETION_REQUESTED' });
    expect((await filterEligibleAccountIds([a.id])).has(a.id)).toBe(false);

    const { runAccountLifecycleTask } = await import('@/services/account/account-lifecycle.job');
    expect((await runAccountLifecycleTask(new Date(t0.getTime() + 2 * 3_600_000))).executed).toBe(0);
    const passe = await runAccountLifecycleTask(new Date(t0.getTime() + 25 * 3_600_000));
    expect(passe.sweep).toBe('done');
    expect(passe.executed).toBeGreaterThanOrEqual(1);
    expect(await sql`SELECT 1 FROM users WHERE id = ${a.ownerUserId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${a.id}`).toHaveLength(0);
    const [reg] = await sql<{ scope: string; user_ids: number[]; account_ids: number[] }[]>`
      SELECT scope, user_ids, account_ids FROM account_deletion_registry WHERE schedule_id = ${r.schedule.id}`;
    expect(reg).toEqual({ scope: 'user', user_ids: [a.ownerUserId], account_ids: [a.id] });

    // « Restauration » d'une sauvegarde antérieure : utilisateur et compte réapparaissent.
    await sql`INSERT INTO users (id, email, password_hash, status) VALUES (${a.ownerUserId}, ${`revenu-${uid('r')}@test.invalid`}, 'x', 'ACTIVE')`;
    await sql`INSERT INTO accounts (id, name, owner_user_id) VALUES (${a.id}, 'revenu', ${a.ownerUserId})`;
    const { replayDeletionRegistry, exportDeletionRegistry, parseRegistryEntries } = await import('@/services/account/deletion-registry.service');
    // Le fichier téléchargé avant la restauration est valide et relisible.
    const fichier = await exportDeletionRegistry();
    expect(parseRegistryEntries(JSON.parse(JSON.stringify(fichier))).length).toBe(fichier.entries.length);
    const rep = await replayDeletionRegistry();
    expect(rep.failures).toEqual([]);
    expect(rep.replayed).toBeGreaterThanOrEqual(1);
    expect(await sql`SELECT 1 FROM users WHERE id = ${a.ownerUserId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${a.id}`).toHaveLength(0);
    // Rejoué encore : rien à faire.
    const bis = await replayDeletionRegistry();
    expect(bis.replayed).toBe(0);
  });
});
