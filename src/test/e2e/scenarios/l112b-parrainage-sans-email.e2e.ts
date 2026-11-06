/**
 * Lot 112B — suppression de l'invitation de parrainage PAR E-MAIL, sur
 * PostgreSQL 16 réel (toutes les migrations, dont 1405).
 *
 *   L112B-E2E-01 base à jour : table `referral_email_sends`, gabarit
 *                `REFERRAL_INVITATION` et son historique d'édition absents
 *   L112B-E2E-02 base « ancienne » (table remplie, gabarit PERSONNALISÉ dans le
 *                BO, canal désactivé, historique d'envois) : 1405 supprime table,
 *                gabarit, versions et réglage ; `email_logs`, liens et autres
 *                gabarits intacts ; rejouable sans effet
 *   L112B-E2E-03 BO › Communications : l'invitation n'est plus listée ; l'ancien
 *                envoi garde un libellé d'historique
 *   L112B-E2E-04 diagnostic global : aucune table de parrainage non classée
 *   L112B-E2E-05 Mon compte › Parrainage : lien /r/<code> toujours servi (non-régression)
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { runMigrationSql } from '@/db/migration-index';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  return { session: { userId: 0, currentAccountId: 0 as number | null } };
});

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

const migration = (f: string) => readFile(join(process.cwd(), 'src/db/migrations', f), 'utf8');

scenario('L112B', 'Parrainage sans invitation par e-mail : route, gabarit et table supprimés', ({ sql, make }) => {
  const tableExiste = async () =>
    (await sql<{ t: string | null }[]>`SELECT to_regclass('public.referral_email_sends')::text AS t`)[0].t !== null;
  const gabarits = async () =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_templates WHERE upper(type) = 'REFERRAL_INVITATION'`)[0].n;
  const versions = async () =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_template_versions WHERE template_type = 'REFERRAL_INVITATION'`)[0].n;

  async function parrain(code: string) {
    const acc = await make.account({ plan: 'premium' });
    const [link] = await sql<{ id: number }[]>`
      INSERT INTO referral_links (account_id, code, created_by_user_id, is_active, created_at, updated_at)
      VALUES (${acc.id}, ${code}, ${acc.ownerUserId}, true, now(), now()) RETURNING id`;
    etat.session.userId = acc.ownerUserId;
    etat.session.currentAccountId = acc.id;
    return { acc, linkId: link.id };
  }

  it('L112B-E2E-01 — base à jour : ni table d’envois, ni gabarit, ni historique d’édition', async () => {
    expect(await tableExiste()).toBe(false);
    expect(await gabarits()).toBe(0);
    expect(await versions()).toBe(0);
    expect(existsSync(join(process.cwd(), 'src/app/api/referral/send-email/route.ts'))).toBe(false);
    // Les autres gabarits sont toujours là.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_templates WHERE type = 'DUO_INVITATION'`;
    expect(n).toBe(1);
  });

  it('L112B-E2E-02 — base antérieure : 1405 supprime tout ce qui servait à l’envoi, garde l’historique, est rejouable', async () => {
    const { acc, linkId } = await parrain('E2E112B1');
    // État d'une base antérieure : table recréée (0068), gabarit livré (0301), puis
    // PERSONNALISÉ dans le BO (garde 0483), une version d'édition, canal désactivé.
    await runMigrationSql(sql, await migration('0068_referral_v1.sql'));
    await runMigrationSql(sql, await migration('0301_referral_invitation_email_template.sql'));
    expect(await tableExiste()).toBe(true);
    expect(await gabarits()).toBe(1);
    await sql`INSERT INTO referral_email_sends (referral_link_id, sender_account_id, recipient_email_hash)
              VALUES (${linkId}, ${acc.id}, 'e2e-hash-112b')`;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.email_template_edit', 'on', true)`;
      await tx`UPDATE email_templates SET subject = 'Objet retouché {{senderName}}', is_customized = true, customized_at = now()
               WHERE type = 'REFERRAL_INVITATION'`;
    });
    await sql`INSERT INTO email_template_versions (template_type, version_no, subject, body, source)
              VALUES ('REFERRAL_INVITATION', 9001, 'Objet retouché', 'Corps', 'admin_edit')
              ON CONFLICT (template_type, version_no) DO NOTHING`;
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active)
              VALUES ('email:REFERRAL_INVITATION', 'email', false)
              ON CONFLICT (event_code, channel) DO UPDATE SET is_active = false`;
    await sql`INSERT INTO email_logs (template_code, recipient_email, subject, status, sent_at)
              VALUES ('REFERRAL_INVITATION', 'ami.112b@exemple.fr', 'Camille vous invite', 'sent', now()),
                     ('DUO_INVITATION', 'duo.112b@exemple.fr', 'Invitation Duo', 'sent', now())`;
    // Sans la levée de la garde, un DELETE ordinaire est ignoré pour un gabarit personnalisé.
    await sql`DELETE FROM email_templates WHERE type = 'REFERRAL_INVITATION'`;
    expect(await gabarits()).toBe(1);

    const m1405 = await migration('1405_l112b_parrainage_sans_email.sql');
    await runMigrationSql(sql, m1405);
    await runMigrationSql(sql, m1405);

    expect(await tableExiste()).toBe(false);
    expect(await gabarits()).toBe(0);
    expect(await versions()).toBe(0);
    const [{ reglages }] = await sql<{ reglages: number }[]>`
      SELECT count(*)::int AS reglages FROM communication_channel_settings WHERE event_code = 'email:REFERRAL_INVITATION'`;
    expect(reglages).toBe(0);
    // Historique des envois conservé (parrainage ET autres e-mails).
    const logs = await sql<{ template_code: string }[]>`
      SELECT template_code FROM email_logs WHERE recipient_email IN ('ami.112b@exemple.fr', 'duo.112b@exemple.fr') ORDER BY template_code`;
    expect(logs.map((l) => l.template_code)).toEqual(['DUO_INVITATION', 'REFERRAL_INVITATION']);
    // Le lien de parrainage et les autres gabarits sont intacts ; la garde est revenue.
    const [{ liens }] = await sql<{ liens: number }[]>`SELECT count(*)::int AS liens FROM referral_links WHERE id = ${linkId}`;
    expect(liens).toBe(1);
    const [{ duo }] = await sql<{ duo: number }[]>`SELECT count(*)::int AS duo FROM email_templates WHERE type = 'DUO_INVITATION'`;
    expect(duo).toBe(1);
    const [{ garde }] = await sql<{ garde: string }[]>`SELECT coalesce(current_setting('verebona.email_template_edit', true), '') AS garde`;
    expect(garde).not.toBe('on');
  });

  it('L112B-E2E-03 — BO › Communications : plus d’invitation de parrainage par e-mail ; historique lisible', async () => {
    const { getCommunicationsOverview, communicationTypeLabel } = await import('@/services/admin/communications.service');
    const events = (await getCommunicationsOverview()).flatMap((g) => g.events);
    expect(events.map((e) => e.code)).not.toContain('email:REFERRAL_INVITATION');
    expect(events.map((e) => e.emailTemplateCode)).not.toContain('REFERRAL_INVITATION');
    expect(events.map((e) => e.code)).toContain('email:DUO_INVITATION');
    expect(communicationTypeLabel('REFERRAL_INVITATION')).toMatch(/supprimée/);
  });

  it('L112B-E2E-04 — diagnostic global : toutes les tables de parrainage présentes sont classées', async () => {
    const rows = await sql<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'referral%'`;
    const tables = rows.map((r) => r.t).sort();
    expect(tables).not.toContain('referral_email_sends');
    const { classifyDiagTables } = await import('@/services/admin/diagnostics-export/coverage');
    const { classifyTables } = await import('@/services/admin/diagnostics-export/recette-catalog');
    // Ni « à classer » (présente, non déclarée), ni « absente » (déclarée, retirée de la base).
    const diag = classifyDiagTables(tables);
    expect(diag.unclassified).toEqual([]);
    expect(diag.missing).not.toContain('referral_email_sends');
    const recette = classifyTables(tables);
    expect(recette.unclassified).toEqual([]);
    expect(recette.missing).not.toContain('referral_email_sends');
  });

  it('L112B-E2E-05 — Mon compte › Parrainage sert toujours le lien /r/<code>', async () => {
    await parrain('E2E112B2');
    const { GET } = await import('@/app/api/referral/me/route');
    const res = await GET(new NextRequest(`${APP}/api/referral/me`));
    expect(res.status).toBe(200);
    expect((await res.json()).link.url).toBe(`${APP}/r/E2E112B2`);
  });
});
