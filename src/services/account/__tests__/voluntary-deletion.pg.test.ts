/**
 * Suppression volontaire — scénario complet sur PostgreSQL (cascades réelles).
 *
 * OPT-IN : exécuté seulement si `ACCOUNT_DELETION_IT_DATABASE_URL` désigne une
 * base JETABLE au schéma à jour (drizzle-kit push + migrations). Les tests
 * unitaires n'ouvrent jamais de connexion : sans la variable, tout est ignoré.
 *
 *   ACCOUNT_DELETION_IT_DATABASE_URL=postgres://… npx vitest run voluntary-deletion.pg
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const IT_URL = process.env.ACCOUNT_DELETION_IT_DATABASE_URL;

describe.skipIf(!IT_URL)('suppression volontaire — PostgreSQL', () => {
  type Sql = typeof import('@/db').pgClient;
  let sql: Sql;
  let svc: typeof import('@/services/account/voluntary-deletion.service');
  let exec: typeof import('@/services/account/scheduled-deletion.service');
  const tag = `it${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = IT_URL;
    sql = (await import('@/db')).pgClient;
    svc = await import('@/services/account/voluntary-deletion.service');
    exec = await import('@/services/account/scheduled-deletion.service');
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** Titulaire Duo + second utilisateur, chacun avec son compte ; contenus croisés. */
  async function fixture(name: string) {
    const bcrypt = (await import('bcrypt')).default;
    const hash = await bcrypt.hash('motdepasse', 4);
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status) VALUES (${`${tag}-${name}-owner@test.invalid`}, ${hash}, 'ACTIVE') RETURNING id`;
    const [member] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status) VALUES (${`${tag}-${name}-member@test.invalid`}, ${hash}, 'ACTIVE') RETURNING id`;
    const [accO] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES ('O', ${owner.id}) RETURNING id`;
    const [accM] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES ('M', ${member.id}) RETURNING id`;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES
      (${accO.id}, ${owner.id}, 'owner', 'active'), (${accM.id}, ${member.id}, 'owner', 'active'),
      (${accO.id}, ${member.id}, 'member', 'active')`;
    const [duo] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status) VALUES (${owner.id}, 'ACTIVE') RETURNING id`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot) VALUES
      (${duo.id}, ${owner.id}, 'ACTIVE', 0), (${duo.id}, ${member.id}, 'ACTIVE', 1)`;
    await sql`UPDATE users SET plan_type = 'PREMIUM_DUO' WHERE id IN (${owner.id}, ${member.id})`;

    // Biens : du titulaire, créé par le membre dans l'espace du titulaire, du membre chez lui.
    const [aOwner] = await sql<{ id: number }[]>`
      INSERT INTO assets (user_id, account_id, duo_id, category, name) VALUES (${owner.id}, ${accO.id}, ${duo.id}, 'VEHICULE', 'bien titulaire') RETURNING id`;
    const [aShared] = await sql<{ id: number }[]>`
      INSERT INTO assets (user_id, account_id, duo_id, category, name) VALUES (${member.id}, ${accO.id}, ${duo.id}, 'VEHICULE', 'bien ajouté par le membre') RETURNING id`;
    const [aMember] = await sql<{ id: number }[]>`
      INSERT INTO assets (user_id, account_id, category, name) VALUES (${member.id}, ${accM.id}, 'VEHICULE', 'bien personnel du membre') RETURNING id`;
    await sql`INSERT INTO documents (user_id, asset_id, file_url, file_name, mime_type, document_type) VALUES
      (${member.id}, ${aShared.id}, 'u', 'partage.pdf', 'application/pdf', 'FACTURE'),
      (${member.id}, ${aMember.id}, 'u', 'perso.pdf', 'application/pdf', 'FACTURE')`;
    await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key) VALUES
      (${member.id}, ${accO.id}, ${aShared.id}, ${`${tag}/${name}/partage.pdf`}),
      (${member.id}, ${accM.id}, ${aMember.id}, ${`${tag}/${name}/perso.pdf`}),
      (${owner.id}, ${accO.id}, ${aOwner.id}, ${`${tag}/${name}/titulaire.pdf`})`;
    await sql`INSERT INTO deadlines (account_id, user_id, label) VALUES (${accO.id}, ${member.id}, 'échéance partagée')`;
    await sql`INSERT INTO invoices (account_id, user_id, stripe_invoice_id, stripe_customer_id, amount, status) VALUES
      (${accO.id}, ${owner.id}, ${`in_${tag}_${name}`}, 'cus_x', 4900, 'paid')`;
    await sql`INSERT INTO verebona_conversations (account_id, user_id, expires_at) VALUES
      (${accO.id}, ${member.id}, now() + interval '7 days')`;
    // Assistant : plans exécutés et annulables (« Annuler », migration 0207)
    // — leurs étapes portent des valeurs de fiches à ne jamais laisser.
    const plan = async (id: string, accountId: number, userId: number) => {
      await sql`INSERT INTO verebona_command_plans (plan_id, account_id, user_id, status, summary, actions_payload, params_hash, expires_at, undo_until)
        VALUES (${id}, ${accountId}, ${userId}, 'EXECUTED', 's', '[]', 'h', now(), now() + interval '15 minutes')`;
      await sql`INSERT INTO verebona_command_undo_steps (plan_id, account_id, user_id, action_id, command, target_type, target_id, inverse_op, before_json, version_after)
        VALUES (${id}, ${accountId}, ${userId}, 'a1', 'UPDATE_ASSET_FIELD', 'asset', 1, 'RESTORE_ASSET_FIELDS', '{"keyCharacteristics":"{}"}'::jsonb, 'v')`;
    };
    const plans = { ownerInO: `${tag}-${name}-oo`, memberInO: `${tag}-${name}-mo`, memberInM: `${tag}-${name}-mm` };
    await plan(plans.ownerInO, accO.id, owner.id);
    await plan(plans.memberInO, accO.id, member.id);
    await plan(plans.memberInM, accM.id, member.id);
    return { owner: owner.id, member: member.id, accO: accO.id, accM: accM.id, duo: duo.id, aOwner: aOwner.id, aShared: aShared.id, aMember: aMember.id, plans };
  }
  const undoSteps = (planId: string) => sql`SELECT 1 FROM verebona_command_undo_steps WHERE plan_id = ${planId}`;
  const planRow = (planId: string) => sql`SELECT 1 FROM verebona_command_plans WHERE plan_id = ${planId}`;

  // Aucun e-mail réel : notifications et confirmation finale simulées.
  const deps = () => ({
    ...svc.defaultDeps,
    notify: async () => undefined,
    sendFinalEmail: async () => true,
  });

  it('second utilisateur : clôture, puis suppression à J+30 — détaché, le titulaire garde les biens du Duo', async () => {
    const f = await fixture('membre');
    const t0 = new Date('2026-10-01T09:00:00Z');

    const closed = await svc.closeAccountForDeletion(
      { userId: f.member, confirmation: 'SUPPRIMER MON COMPTE', password: 'motdepasse', now: t0 }, deps());
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.sharing).toBe('duo_member');
    expect(closed.schedule.scope).toBe('user');
    expect(closed.schedule.scheduledAt.getTime() - t0.getTime()).toBe(30 * 86_400_000);

    const [u] = await sql<{ status: string }[]>`SELECT status FROM users WHERE id = ${f.member}`;
    expect(u.status).toBe('PENDING_DELETION');
    const [dm] = await sql<{ status: string }[]>`SELECT status FROM duo_memberships WHERE user_id = ${f.member}`;
    expect(dm.status).toBe('LEFT');

    // Idempotence de la clôture.
    const again = await svc.closeAccountForDeletion(
      { userId: f.member, confirmation: 'SUPPRIMER MON COMPTE', password: 'motdepasse', now: t0 }, deps());
    expect(again.ok && again.alreadyClosed).toBe(true);

    // J+29 : rien ne se passe.
    const early = await svc.runAccountDeletionSweep({ now: new Date(t0.getTime() + 29 * 86_400_000) }, deps());
    expect(early.deletions.executed).toBe(0);

    // J+30 : suppression.
    const due = new Date(t0.getTime() + 30 * 86_400_000 + 60_000);
    const r = await svc.runAccountDeletionSweep({ now: due }, deps());
    expect(r.failures).toEqual([]);
    expect(r.deletions.executed).toBeGreaterThanOrEqual(1);

    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${f.accM}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM assets WHERE id = ${f.aMember}`).toHaveLength(0);
    // Le titulaire, son compte et TOUS les biens de l'espace partagé restent.
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.owner}`).toHaveLength(1);
    const [shared] = await sql<{ user_id: number }[]>`SELECT user_id FROM assets WHERE id = ${f.aShared}`;
    expect(shared.user_id).toBe(f.owner);
    const [doc] = await sql<{ user_id: number }[]>`SELECT user_id FROM documents WHERE asset_id = ${f.aShared}`;
    expect(doc.user_id).toBe(f.owner);
    const [dl] = await sql<{ user_id: number }[]>`SELECT user_id FROM deadlines WHERE account_id = ${f.accO}`;
    expect(dl.user_id).toBe(f.owner);
    // Conversation de l'assistant du membre : supprimée (donnée personnelle).
    expect(await sql`SELECT 1 FROM verebona_conversations WHERE user_id = ${f.member}`).toHaveLength(0);
    // Plans et étapes d'annulation du membre, y compris dans l'espace du
    // titulaire qui survit ; ceux du titulaire restent.
    for (const id of [f.plans.memberInO, f.plans.memberInM]) {
      expect(await planRow(id), id).toHaveLength(0);
      expect(await undoSteps(id), id).toHaveLength(0);
    }
    expect(await planRow(f.plans.ownerInO)).toHaveLength(1);
    expect(await undoSteps(f.plans.ownerInO)).toHaveLength(1);
    // Fichier personnel en file de purge S3, pas celui de l'espace partagé.
    const purge = (await sql<{ storage_path: string }[]>`
      SELECT storage_path FROM pending_blob_deletions WHERE storage_path LIKE ${`${tag}/membre/%`}`).map((x) => x.storage_path);
    expect(purge).toEqual([`${tag}/membre/perso.pdf`]);

    // Trace et confirmation finale ; l'adresse relevée est effacée après envoi.
    const [trace] = await sql<{ status: string; notify_email: string | null; final_email_sent_at: Date | null }[]>`
      SELECT status, notify_email, final_email_sent_at FROM scheduled_account_deletions WHERE id = ${closed.schedule.id}`;
    expect(trace.status).toBe('EXECUTED');
    expect(trace.notify_email).toBeNull();
    expect(trace.final_email_sent_at).not.toBeNull();

    // Rejouer le balayage est sans effet.
    const replay = await exec.executeScheduledDeletion(closed.schedule.id, { now: due });
    expect(replay).toEqual({ status: 'skipped', reason: 'STATUS_EXECUTED' });
  });

  it('titulaire : le Duo prend fin, le second utilisateur et son compte restent ; factures conservées', async () => {
    const f = await fixture('titulaire');
    const t0 = new Date('2026-10-01T09:00:00Z');
    const closed = await svc.closeAccountForDeletion(
      { userId: f.owner, confirmation: 'SUPPRIMER MON COMPTE', password: 'motdepasse', now: t0 }, deps());
    expect(closed.ok && closed.sharing).toBe('duo_owner');
    const [dm] = await sql<{ status: string }[]>`SELECT status FROM duo_memberships WHERE user_id = ${f.member}`;
    expect(dm.status).toBe('REMOVED');
    const [mm] = await sql<{ status: string }[]>`
      SELECT status FROM account_memberships WHERE user_id = ${f.member} AND account_id = ${f.accO}`;
    expect(mm.status).toBe('removed');

    const r = await svc.runAccountDeletionSweep({ now: new Date(t0.getTime() + 31 * 86_400_000) }, deps());
    expect(r.failures).toEqual([]);

    expect(await sql`SELECT 1 FROM users WHERE id = ${f.owner}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${f.accO}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM accounts WHERE id = ${f.accM}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM assets WHERE id = ${f.aMember}`).toHaveLength(1);
    const [inv] = await sql<{ account_id: number | null; user_id: number | null; amount: number }[]>`
      SELECT account_id, user_id, amount FROM invoices WHERE stripe_invoice_id = ${`in_${tag}_titulaire`}`;
    expect(inv).toEqual({ account_id: null, user_id: null, amount: 4900 });
  });

  it('annulation : accès rétabli, la suppression n’a jamais lieu', async () => {
    const f = await fixture('annulation');
    const t0 = new Date('2026-10-01T09:00:00Z');
    const closed = await svc.closeAccountForDeletion(
      { userId: f.member, confirmation: 'SUPPRIMER MON COMPTE', password: 'motdepasse', now: t0 }, deps());
    expect(closed.ok).toBe(true);
    // Back-office : la demande est visible dans le registre RGPD, avec son
    // état et la date prévue (lecture seule, GDP-008).
    const repo = await import('@/services/gdpr/gdpr-request.repository');
    const [reg] = await sql<{ id: number }[]>`
      SELECT id FROM gdpr_requests WHERE source_ref = ${`scheduled_deletion:${closed.ok ? closed.schedule.id : 0}`}`;
    const detail = await repo.getGdprRequest(reg.id);
    expect(detail?.origin).toBe('system');
    expect(detail?.rightType).toBe('erasure');
    expect(detail?.deletion?.status).toBe('SCHEDULED');
    expect(detail?.deletion?.scheduledAt).toBe('2026-10-31T09:00:00.000Z');

    const c = await svc.cancelAccountDeletion({ userId: f.member, now: new Date(t0.getTime() + 86_400_000) }, deps());
    expect(c.ok).toBe(true);
    const [u] = await sql<{ status: string }[]>`SELECT status FROM users WHERE id = ${f.member}`;
    expect(u.status).toBe('ACTIVE');
    await svc.runAccountDeletionSweep({ now: new Date(t0.getTime() + 40 * 86_400_000) }, deps());
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(1);
  });

  it('registre RGPD : une demande manuelle s’enregistre (dates transmises en ISO)', async () => {
    const repo = await import('@/services/gdpr/gdpr-request.repository');
    const f = await fixture('manuelle');
    const r = await repo.createManualRequest(
      { userId: f.owner, rightType: 'access', channel: 'email', receivedDate: '2026-09-20', status: 'received' },
      f.owner, null, new Date('2026-09-28T08:00:00Z'));
    expect(r.ok).toBe(true);
  });

  it('portée « account » (rétractation) inchangée : compte et ses deux utilisateurs supprimés, factures conservées', async () => {
    const f = await fixture('retractation');
    // Modèle historique : le second utilisateur n'a pas de compte propre.
    await sql`DELETE FROM accounts WHERE id = ${f.accM}`;
    const s = await exec.scheduleDeletion({
      accountId: f.accO, userId: f.owner, reason: 'WITHDRAWAL', confirmedAt: new Date('2026-09-01T00:00:00Z'),
    });
    expect(s.scope).toBe('account');
    const r = await exec.executeScheduledDeletion(s.id, { now: new Date('2026-10-02T00:00:00Z') });
    expect(r.status).toBe('executed');
    expect(r.preserved?.invoices).toBe(1);
    expect(await sql`SELECT 1 FROM users WHERE id IN (${f.owner}, ${f.member})`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM invoices WHERE stripe_invoice_id = ${`in_${tag}_retractation`}`).toHaveLength(1);
    // Assistant : plus aucun plan ni étape d'annulation du compte supprimé.
    expect(await sql`SELECT 1 FROM verebona_command_undo_steps WHERE account_id = ${f.accO}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM verebona_command_plans WHERE account_id = ${f.accO}`).toHaveLength(0);
  });

  it('clés étrangères des étapes d’annulation (0207) : cascade depuis le plan, le compte et l’utilisateur', async () => {
    const f = await fixture('cascade');
    await sql`DELETE FROM verebona_command_plans WHERE plan_id = ${f.plans.ownerInO}`;
    expect(await undoSteps(f.plans.ownerInO)).toHaveLength(0);
    await sql`DELETE FROM accounts WHERE id = ${f.accM}`;
    expect(await undoSteps(f.plans.memberInM)).toHaveLength(0);
    await sql`DELETE FROM account_memberships WHERE user_id = ${f.member}`;
    await sql`DELETE FROM duo_memberships WHERE user_id = ${f.member}`;
    await sql`UPDATE assets SET user_id = ${f.owner} WHERE user_id = ${f.member}`;
    await sql`UPDATE asset_files SET user_id = ${f.owner} WHERE user_id = ${f.member}`;
    await sql`UPDATE documents SET user_id = ${f.owner} WHERE user_id = ${f.member}`;
    await sql`UPDATE deadlines SET user_id = ${f.owner} WHERE user_id = ${f.member}`;
    await sql`DELETE FROM users WHERE id = ${f.member}`;
    expect(await undoSteps(f.plans.memberInO)).toHaveLength(0);
    // Orphelins refusés : une étape sans plan ne peut pas être créée.
    await expect(sql`INSERT INTO verebona_command_undo_steps (plan_id, account_id, user_id, action_id, command, target_type, target_id, inverse_op, version_after)
      VALUES ('inexistant', ${f.accO}, ${f.owner}, 'a1', 'CREATE_AGENDA_ITEM', 'agenda_item', 1, 'DELETE_AGENDA_ITEM', 'v')`).rejects.toThrow(/foreign key/);
  });

  const DAY = 86_400_000;
  const closeNow = async (userId: number, t0: Date) => {
    const r = await svc.closeAccountForDeletion(
      { userId, confirmation: 'SUPPRIMER MON COMPTE', password: 'motdepasse', now: t0 }, deps());
    if (!r.ok) throw new Error(r.code);
    return r.schedule;
  };

  it('concurrence : annulation pendant une exécution réservée → refusée ; rien n’est incohérent', async () => {
    const f = await fixture('course1');
    const t0 = new Date('2026-10-01T09:00:00Z');
    const s = await closeNow(f.member, t0);
    const due = new Date(t0.getTime() + 30 * DAY + 60_000);
    const claim = await exec.claimUserDeletion(s.id, due);
    expect(claim.ok).toBe(true);
    const c = await svc.cancelAccountDeletion({ userId: f.member, now: due }, deps());
    expect(c).toEqual({ ok: false, code: 'IN_PROGRESS' });
    const r = await exec.executeScheduledDeletion(s.id, { now: due });
    expect(r.status).toBe('executed');
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(0);
  });

  it('concurrence : annulation gagnante avant la réservation → le balayage ne fait rien (ni Stripe, ni Duo)', async () => {
    const f = await fixture('course2');
    const t0 = new Date('2026-10-01T09:00:00Z');
    const s = await closeNow(f.owner, t0);
    const due = new Date(t0.getTime() + 30 * DAY + 60_000);
    expect((await svc.cancelAccountDeletion({ userId: f.owner, now: due }, deps())).ok).toBe(true);
    const cancelNow = vi.fn(async () => []);
    const r = await svc.runAccountDeletionSweep({ now: due }, { ...deps(), billing: { ...svc.defaultDeps.billing, cancelNow } });
    expect(cancelNow).not.toHaveBeenCalled();
    expect(r.failures).toEqual([]);
    const [row] = await sql<{ status: string }[]>`SELECT status FROM scheduled_account_deletions WHERE id = ${s.id}`;
    expect(row.status).toBe('CANCELLED');
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.owner} AND status = 'ACTIVE'`).toHaveLength(1);
  });

  it('concurrence réelle : exécution et annulation simultanées → un seul gagnant, état cohérent', async () => {
    const f = await fixture('course3');
    const t0 = new Date('2026-10-01T09:00:00Z');
    const s = await closeNow(f.member, t0);
    const due = new Date(t0.getTime() + 30 * DAY + 60_000);
    const [e, c] = await Promise.allSettled([
      exec.executeScheduledDeletion(s.id, { now: due }),
      exec.cancelUserDeletion(f.member, 'test', due),
    ]);
    const [row] = await sql<{ status: string }[]>`SELECT status FROM scheduled_account_deletions WHERE id = ${s.id}`;
    const userLeft = (await sql`SELECT 1 FROM users WHERE id = ${f.member}`).length;
    if (row.status === 'EXECUTED') {
      expect(userLeft).toBe(0);
      expect(e.status === 'fulfilled' && e.value.status).toBe('executed');
    } else {
      expect(row.status).toBe('CANCELLED');
      expect(c.status).toBe('fulfilled');
      expect(await sql`SELECT 1 FROM users WHERE id = ${f.member} AND status = 'ACTIVE'`).toHaveLength(1);
      expect(e.status === 'fulfilled' && e.value.status).toBe('skipped');
    }
  });

  it('échec d’exécution : reprogrammée (1 j), réservation rendue, puis exécutée à la tentative suivante', async () => {
    const f = await fixture('echec');
    const t0 = new Date('2026-10-01T09:00:00Z');
    const s = await closeNow(f.member, t0);
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION it_block_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'suppression bloquée (test)'; END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS it_block_delete ON users;
      CREATE TRIGGER it_block_delete BEFORE DELETE ON users FOR EACH ROW
        WHEN (OLD.id = ${f.member}) EXECUTE FUNCTION it_block_delete();`);
    const due = new Date(t0.getTime() + 30 * DAY + 60_000);
    const anomalies: string[] = [];
    const d = { ...deps(), reportAnomaly: async (i: { reason: string }) => { anomalies.push(i.reason); } };
    const r1 = await svc.runAccountDeletionSweep({ now: due }, d);
    expect(r1.deletions.failed).toBe(1);
    expect(anomalies[0]).toContain('suppression bloquée');
    const [row] = await sql<{ status: string; attempt_count: number; next_attempt_at: Date; processing_started_at: Date | null }[]>`
      SELECT status, attempt_count, next_attempt_at, processing_started_at FROM scheduled_account_deletions WHERE id = ${s.id}`;
    expect(row).toMatchObject({ status: 'SCHEDULED', attempt_count: 1, processing_started_at: null });
    expect(new Date(row.next_attempt_at).getTime()).toBe(due.getTime() + DAY);
    // L'écran reste celui de la suppression (« scheduled »), pas de boucle.
    expect((await svc.getAccountDeletionStatus(f.member, due)).status).toBe('scheduled');
    // Pas de nouvel essai avant l'échéance du report.
    expect((await svc.runAccountDeletionSweep({ now: new Date(due.getTime() + DAY / 2) }, d)).deletions.failed).toBe(0);
    await sql.unsafe('DROP TRIGGER it_block_delete ON users');
    const r2 = await svc.runAccountDeletionSweep({ now: new Date(due.getTime() + DAY + 60_000) }, d);
    expect(r2.failures).toEqual([]);
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(0);
  });

  it('utilisateur non clôturé à l’échéance : FAILED terminal, signalé une fois, plus jamais retraité', async () => {
    const f = await fixture('nonclos');
    const t0 = new Date('2026-10-01T09:00:00Z');
    const s = await closeNow(f.member, t0);
    await sql`UPDATE users SET status = 'ACTIVE' WHERE id = ${f.member}`;
    const due = new Date(t0.getTime() + 30 * DAY + 60_000);
    const reported = vi.fn(async () => undefined);
    await svc.runAccountDeletionSweep({ now: due }, { ...deps(), reportAnomaly: reported });
    await svc.runAccountDeletionSweep({ now: due }, { ...deps(), reportAnomaly: reported });
    expect(reported).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ status: string; failure_reason: string }[]>`
      SELECT status, failure_reason FROM scheduled_account_deletions WHERE id = ${s.id}`;
    expect(row.status).toBe('FAILED');
    expect(row.failure_reason).toContain('USER_NOT_CLOSED');
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(1);
  });

  it('arriéré : une échéance de plus de 7 jours n’est pas exécutée sans live explicite', async () => {
    const f = await fixture('arriere');
    const t0 = new Date('2026-08-01T09:00:00Z');
    const s = await closeNow(f.member, t0);
    const now = new Date(t0.getTime() + 40 * DAY);
    const reported = vi.fn(async () => undefined);
    const r = await svc.runAccountDeletionSweep({ now }, { ...deps(), reportAnomaly: reported });
    expect(r.backlog.map((b) => b.scheduleId)).toContain(s.id);
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(1);
    await svc.runAccountDeletionSweep({ now }, { ...deps(), reportAnomaly: reported });
    expect(reported.mock.calls.filter(() => true).length).toBeGreaterThanOrEqual(1);
    const [row] = await sql<{ anomaly_reported_at: Date | null }[]>`
      SELECT anomaly_reported_at FROM scheduled_account_deletions WHERE id = ${s.id}`;
    expect(row.anomaly_reported_at).not.toBeNull();
    await svc.runAccountDeletionSweep({ now, includeBacklog: true }, deps());
    expect(await sql`SELECT 1 FROM users WHERE id = ${f.member}`).toHaveLength(0);
  });

  it('factures : portée user — une facture de l’utilisateur sur un compte conservé garde son compte', async () => {
    const f = await fixture('factures');
    await sql`INSERT INTO invoices (account_id, user_id, stripe_invoice_id, stripe_customer_id, amount, status)
      VALUES (${f.accO}, ${f.member}, ${`in_${tag}_membre_sur_titulaire`}, 'cus_y', 100, 'paid')`;
    const t0 = new Date('2026-10-01T09:00:00Z');
    await closeNow(f.member, t0);
    await svc.runAccountDeletionSweep({ now: new Date(t0.getTime() + 30 * DAY + 60_000) }, deps());
    const [inv] = await sql<{ account_id: number | null; user_id: number | null }[]>`
      SELECT account_id, user_id FROM invoices WHERE stripe_invoice_id = ${`in_${tag}_membre_sur_titulaire`}`;
    expect(inv).toEqual({ account_id: f.accO, user_id: null });
  });
});

