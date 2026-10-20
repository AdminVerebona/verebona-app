/**
 * Lot 73A (point 1) — rappel d'export dans les e-mails de fin d'accès au
 * Premium Duo, livré par la migration 0527 sous la garde 0483 ; PostgreSQL 16
 * réel, transport Resend SIMULÉ.
 *
 * L73A-DUO-E2E-01 Gabarits NON personnalisés : nouveau texte appliqué, version
 *                 « texte livré » ajoutée ; migration rejouée sans effet.
 * L73A-DUO-E2E-02 Gabarit PERSONNALISÉ : texte conservé, nouveau texte rangé en
 *                 « texte livré plus récent » signalé dans le BO (date stable si
 *                 rejouée) ; « Revenir au texte livré » applique le rappel.
 * L73A-DUO-E2E-03 Envoi réel (« Retirer » → file durable) : rappel et bouton
 *                 « Exporter mes données » vers Mon compte › Mes données ; prénom
 *                 du titulaire piégé neutralisé (point 3) dans le texte et le HTML.
 */
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_73a_duo';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return { calls: [] as Array<{ to: string; subject: string; html: string; text?: string }> };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string; text?: string }) => {
        etat.calls.push(p);
        return { data: { id: `em_73a_duo_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const MIG_0527 = readFileSync(join(process.cwd(), 'src/db/migrations/0527_l73a_duo_rappel_export.sql'), 'utf8');
/** Texte livré au lot 64 / 65 (0459, 0462). */
const oldText = (file: string) => {
  const sql = readFileSync(join(process.cwd(), `src/db/migrations/${file}`), 'utf8');
  const m = /SELECT '([A-Z_]+)',\s*'((?:[^']|'')*)',\s*E'((?:[^']|'')*)'/.exec(sql)!;
  return { type: m[1], subject: m[2].replace(/''/g, "'"), body: m[3].replace(/''/g, "'").replace(/\\n/g, '\n') };
};
const OLD = [oldText('0459_duo_membership_ended_email.sql'), oldText('0462_duo_membership_left_email.sql')];

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, { method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const ctx = (code: string) => ({ params: Promise.resolve({ code }) });

scenario('L73A-DUO', 'Duo : rappel d’export dans les e-mails de fin d’accès (texte livré 0527, garde 0483)', ({ sql, make }) => {
  const asEditor = (fn: (tx: typeof sql) => Promise<unknown>) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.email_template_edit', 'on', true)`;
      await fn(tx as unknown as typeof sql);
    });
  /** Remet les deux gabarits au texte du lot 64 / 65, non personnalisés, sans version « shipped_update ». */
  const remettreLot65 = () => asEditor(async (tx) => {
    for (const o of OLD) {
      await tx`UPDATE email_templates SET subject = ${o.subject}, body = ${o.body}, is_customized = false, customized_at = NULL, updated_by = NULL,
                 shipped_subject = ${o.subject}, shipped_body = ${o.body}, shipped_updated_at = NULL WHERE upper(type) = ${o.type}`;
      await tx`DELETE FROM email_template_versions WHERE template_type = ${o.type} AND source = 'shipped_update'`;
    }
  });
  const ligne = async (type: string) => (await sql<{
    subject: string; body: string; is_customized: boolean; shipped_body: string | null; shipped_updated_at: Date | null; placeholders: string | null;
  }[]>`SELECT subject, body, is_customized, shipped_body, shipped_updated_at, placeholders FROM email_templates WHERE upper(type) = ${type}`)[0];
  const migrer = () => sql.begin(async (tx) => { await tx.unsafe(MIG_0527); });

  beforeEach(async () => {
    etat.calls.length = 0;
    process.env.RESEND_API_KEY = 're_e2e_simule_73a_duo';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await sql`UPDATE transactional_email_jobs SET status = 'cancelled' WHERE status IN ('pending', 'sending')`;
  });

  afterAll(async () => {
    // Texte livré du lot 73 rétabli, non personnalisé.
    await remettreLot65();
    await migrer();
  });

  it('L73A-DUO-E2E-01 — gabarits non personnalisés : texte appliqué, version ajoutée, rejouable', async () => {
    const { DEFAULT_EMAIL_TEMPLATES: D } = await import('@/lib/email-defaults');
    await remettreLot65();
    await migrer();
    for (const type of ['DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT'] as const) {
      const l = await ligne(type);
      expect(l.body).toBe(D[type].body);
      expect(l.subject).toBe(D[type].subject);
      expect(l.shipped_body).toBe(D[type].body);
      expect(l.is_customized).toBe(false);
      expect(JSON.parse(l.placeholders!)).toContain('dataExportUrl');
      const v = await sql<{ source: string; body: string }[]>`
        SELECT source, body FROM email_template_versions WHERE template_type = ${type} ORDER BY version_no DESC LIMIT 1`;
      expect(v[0]).toMatchObject({ source: 'shipped_update', body: D[type].body });
    }
    await migrer();
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_template_versions WHERE template_type IN ('DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT') AND source = 'shipped_update'`;
    expect(n.n).toBe(2);
  });

  it('L73A-DUO-E2E-02 — gabarit personnalisé : jamais écrasé, texte livré plus récent signalé', async () => {
    const { DEFAULT_EMAIL_TEMPLATES: D } = await import('@/lib/email-defaults');
    await remettreLot65();
    const perso = OLD[0].body.replace('Cordialement,', 'Bien à vous (texte du support),');
    await asEditor(async (tx) => {
      await tx`UPDATE email_templates SET body = ${perso}, is_customized = true, customized_at = now() WHERE upper(type) = 'DUO_MEMBERSHIP_ENDED'`;
    });
    await migrer();
    let l = await ligne('DUO_MEMBERSHIP_ENDED');
    expect(l.body).toBe(perso);
    expect(l.is_customized).toBe(true);
    expect(l.shipped_body).toBe(D.DUO_MEMBERSHIP_ENDED.body);
    expect(l.shipped_updated_at).not.toBeNull();
    const signale = new Date(l.shipped_updated_at!).toISOString();
    // Aucune version « texte livré » pour un gabarit personnalisé (texte non appliqué).
    const [v] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_template_versions WHERE template_type = 'DUO_MEMBERSHIP_ENDED' AND source = 'shipped_update'`;
    expect(v.n).toBe(0);
    // Rejouée : rien ne bouge (date de signalement comprise).
    await migrer();
    l = await ligne('DUO_MEMBERSHIP_ENDED');
    expect(l.body).toBe(perso);
    expect(new Date(l.shipped_updated_at!).toISOString()).toBe(signale);

    // BO : signalé, puis « Revenir au texte livré ».
    const adm = await make.user({ email: `${uid('admin73duo')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${adm.id}`;
    const { generateAccessToken } = await import('@/lib/jwt');
    const cookie = `access_token=${await generateAccessToken({ id: adm.id, email: adm.email, role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true })}`;
    const { GET } = await import('@/app/api/admin/communications/templates/[code]/route');
    const st = (await (await GET(req('/x', { method: 'GET', cookie }), ctx('DUO_MEMBERSHIP_ENDED'))).json()).state;
    expect(st.shipped.newerAt).toBeTruthy();
    expect(st.shipped.body).toContain('Exporter mes données : {{dataExportUrl}}');
    const { POST: reset } = await import('@/app/api/admin/communications/templates/[code]/reset/route');
    expect((await reset(req('/x', { cookie, body: { baseHash: st.baseHash } }), ctx('DUO_MEMBERSHIP_ENDED'))).status).toBe(200);
    l = await ligne('DUO_MEMBERSHIP_ENDED');
    expect(l.body).toBe(D.DUO_MEMBERSHIP_ENDED.body);
    expect(l.is_customized).toBe(false);
  });

  it('L73A-DUO-E2E-03 — envoi réel : rappel d’export, lien « Mes données », prénom piégé neutralisé', async () => {
    await remettreLot65();
    await migrer();
    const owner = await make.user({ email: `titulaire-${uid('l73a')}@test.invalid`, planType: 'PREMIUM_DUO' });
    await sql`UPDATE users SET first_name = ${'Claire https://pirate.example <b>x</b>'} WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: 'premium_duo' });
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, duo_subscription_started_at, activated_at)
      VALUES (${owner.id}, 'ACTIVE', now() - interval '2 days', now()) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId}, plan_type = 'PREMIUM_DUO', max_members = 2 WHERE id = ${acc.id}`;
    const membre = await make.user({ planType: 'PREMIUM_DUO' });
    await sql`UPDATE users SET first_name = 'Marc' WHERE id = ${membre.id}`;
    await make.account({ owner: membre, plan: 'standard' });
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at)
              VALUES (${duoId}, ${owner.id}, 'ACTIVE', 0, now()), (${duoId}, ${membre.id}, 'ACTIVE', 1, now())`;

    const { removeDuoMember } = await import('@/services/duo/duo-exit.service');
    expect(await removeDuoMember(acc.ownerUserId)).toMatchObject({ ok: true, status: 'REMOVED' });
    const { runTransactionalEmailRetry } = await import('@/services/email/transactional-email-jobs.service');
    await runTransactionalEmailRetry({ now: () => new Date(Date.now() + 1_000), deadline: Date.now() + 30_000 });
    const m = etat.calls.find((c) => c.to === membre.email)!;
    expect(m).toBeTruthy();
    expect(m.text).toMatch(/vous ne pouvez plus en exporter les biens vous-même/);
    expect(m.text).toMatch(/^Exporter mes données : https:\/\/app\.e2e\.verebona\.test\/mon-compte#mes-donnees$/m);
    expect(m.html).toContain(`href="${APP}/mon-compte#mes-donnees"`);
    expect(m.html).toContain('>Exporter mes données</a>');
    // Point 3 : prénom du titulaire piégé — ni lien, ni balise, dans le texte comme dans le HTML.
    expect(`${m.text}\n${m.html}`).not.toMatch(/https?:\/\/pirate|pirate\.example|<b>x<\/b>/);
    expect(m.text).toContain('partagiez avec Claire https[:]//pirate․example x a pris fin.');
    expect(m.text).not.toMatch(/&amp;|&lt;|&gt;/);
  });
});
