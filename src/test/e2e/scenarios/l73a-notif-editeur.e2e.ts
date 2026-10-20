/**
 * Lot 73A (point 2) — modèles d'e-mails des NOTIFICATIONS (`notif_*`) dans
 * l'éditeur du BO, sur PostgreSQL 16 réel (toutes les migrations : 0077 crée
 * les gabarits en minuscules, 0483 les versions initiales et la garde), routes
 * du BO appelées avec un vrai jeton, transport Resend SIMULÉ.
 *
 * L73A-NOTIF-E2E-01 État de l'éditeur : gabarit trouvé (code en majuscules ou
 *                   minuscules), événements qui l'utilisent, variables, version
 *                   initiale, verrou d'envoi d'une notification obligatoire.
 * L73A-NOTIF-E2E-02 Enregistrement : personnalisé, version, audit avant / après.
 * L73A-NOTIF-E2E-03 Validations serveur : message retiré, variable non fournie,
 *                   mention de désinscription (actualités) → 422, refus journalisé.
 * L73A-NOTIF-E2E-04 Aperçu : message RÉEL de l'événement choisi (catalogue),
 *                   lien absolu ; événement hors gabarit ignoré.
 * L73A-NOTIF-E2E-05 Test du brouillon : envoyé à l'admin seul, audit, base inchangée.
 * L73A-NOTIF-E2E-06 Envoi RÉEL par l'EmailChannel avec le texte modifié ; nom de
 *                   document piégé neutralisé (point 3), bouton d'action intact.
 * L73A-NOTIF-E2E-07 Garde 0483 : livraison future (UPDATE) n'écrase pas ;
 *                   « Revenir au texte livré » ; restauration d'une version.
 * L73A-NOTIF-E2E-08 Droits : non-administrateur refusé ; code inconnu → 404.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_73a';
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
        return { data: { id: `em_73a_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const SUB_SUBJECT = 'Votre abonnement Verebona';
const SUB_BODY = '{{body}}\n\nAccéder à Verebona : {{actionUrl}}';
const DOC_BODY = '{{body}}\n\nAccéder à Verebona : {{actionUrl}}';
const NEWS_BODY = '{{body}}\n\nAccéder à Verebona : {{actionUrl}}\n\nPour ne plus recevoir ces actualités, gérez vos préférences dans Mon compte > Notifications.';

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'POST', headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const ctx = (code: string) => ({ params: Promise.resolve({ code }) });

scenario('L73A-NOTIF-ED', 'Éditeur du BO : modèles d’e-mails des notifications (notif_*)', ({ sql, make }) => {
  const asEditor = (fn: (tx: typeof sql) => Promise<unknown>) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.email_template_edit', 'on', true)`;
      await fn(tx as unknown as typeof sql);
    });

  beforeEach(async () => {
    etat.calls.length = 0;
    process.env.RESEND_API_KEY = 're_e2e_simule_73a';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    // Gabarits de référence au texte livré (0077), non personnalisés.
    await asEditor(async (tx) => {
      for (const [type, subject, body] of [
        ['notif_subscription', SUB_SUBJECT, SUB_BODY],
        ['notif_document_batch_failed', 'Analyse de vos documents', DOC_BODY],
        ['notif_news', 'Actualités Verebona', NEWS_BODY],
      ] as const) {
        await tx`INSERT INTO email_templates (type, subject, body, updated_at, is_customized, shipped_subject, shipped_body)
                 VALUES (${type}, ${subject}, ${body}, now(), false, ${subject}, ${body})
                 ON CONFLICT (type) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, is_customized = false,
                   customized_at = NULL, updated_by = NULL, shipped_subject = EXCLUDED.subject, shipped_body = EXCLUDED.body,
                   shipped_updated_at = NULL`;
      }
    });
  });

  afterAll(async () => {
    await asEditor(async (tx) => {
      await tx`UPDATE email_templates SET subject = shipped_subject, body = shipped_body, is_customized = false, customized_at = NULL,
                 updated_by = NULL, shipped_updated_at = NULL WHERE type LIKE 'notif\\_%' AND shipped_body IS NOT NULL`;
    });
  });

  async function jeton(user: { id: number; email: string }, role = 'USER') {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: role as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true,
    });
  }
  async function admin() {
    const u = await make.user({ email: `${uid('admin73a')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE', first_name = 'Ada', last_name = 'Admin' WHERE id = ${u.id}`;
    return { ...u, cookie: `access_token=${await jeton(u, 'ADMIN')}` };
  }
  const route = () => import('@/app/api/admin/communications/templates/[code]/route');
  async function etatDe(code: string, cookie: string) {
    const { GET } = await route();
    const res = await GET(req(`/api/admin/communications/templates/${code}`, { method: 'GET', cookie }), ctx(code));
    return { status: res.status, body: await res.json() };
  }
  async function enregistrer(code: string, cookie: string, payload: Record<string, unknown>) {
    const { PUT } = await route();
    const res = await PUT(req(`/api/admin/communications/templates/${code}`, { method: 'PUT', cookie, body: payload }), ctx(code));
    return { status: res.status, body: await res.json() };
  }
  const ligne = async (type: string) => (await sql<{
    id: number; subject: string; body: string; is_customized: boolean; updated_by: number | null;
    shipped_body: string | null; shipped_updated_at: Date | null;
  }[]>`SELECT id, subject, body, is_customized, updated_by, shipped_body, shipped_updated_at FROM email_templates WHERE type = ${type}`)[0];
  const audits = async (adminId: number, action: string) => sql<{ result: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null }[]>`
    SELECT result, old_value, new_value FROM admin_audit_log WHERE admin_user_id = ${adminId} AND action_type = ${action} ORDER BY id`;

  it('L73A-NOTIF-E2E-01 — état de l’éditeur d’un gabarit notif_*', async () => {
    const a = await admin();
    for (const code of ['NOTIF_SUBSCRIPTION', 'notif_subscription']) {
      const s = await etatDe(code, a.cookie);
      expect(s.status, code).toBe(200);
      expect(s.body.state.code).toBe('NOTIF_SUBSCRIPTION');
      expect(s.body.state.kind).toBe('notification');
      expect(s.body.state.format).toBe('text');
      expect(s.body.state.usedBy.map((e: { code: string }) => e.code)).toEqual(expect.arrayContaining(['SUBSCRIPTION_RENEWED', 'SUBSCRIPTION_CANCELLED']));
      expect(s.body.state.variables.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['title', 'body', 'actionUrl']));
      expect(s.body.state.contentLock).toBeNull();
      expect(s.body.state.channelLock).toBeNull(); // notification d'abonnement : e-mail désactivable
    }
    // Version initiale posée par la 0483 (type en majuscules).
    const [v] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_template_versions WHERE template_type = 'NOTIF_SUBSCRIPTION' AND source = 'initial'`;
    expect(v.n).toBe(1);
    // Notification obligatoire (incident de paiement) : envoi non désactivable, texte modifiable.
    const p = await etatDe('NOTIF_PAYMENT_INCIDENT', a.cookie);
    expect(p.status).toBe(200);
    expect(p.body.state.channelLock).toMatch(/obligatoire/i);
    expect(p.body.state.contentLock).toBeNull();
  });

  it('L73A-NOTIF-E2E-02 — enregistrement : personnalisé, version, audit', async () => {
    const a = await admin();
    const s = (await etatDe('NOTIF_SUBSCRIPTION', a.cookie)).body.state;
    const body = 'Bonjour,\n\n{{body}}\n\nGérer mon abonnement : {{actionUrl}}\n\nL’équipe Verebona';
    const r = await enregistrer('NOTIF_SUBSCRIPTION', a.cookie, { subject: '{{title}} — Verebona', body, baseHash: s.baseHash, note: 'Recette 73A' });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    const l = await ligne('notif_subscription');
    expect(l).toMatchObject({ subject: '{{title}} — Verebona', body, is_customized: true, updated_by: a.id, shipped_body: SUB_BODY });
    const [ver] = await sql<{ source: string; note: string | null }[]>`
      SELECT source, note FROM email_template_versions WHERE template_type = 'NOTIF_SUBSCRIPTION' ORDER BY version_no DESC LIMIT 1`;
    expect(ver).toMatchObject({ source: 'admin_edit', note: 'Recette 73A' });
    const [audit] = await audits(a.id, 'EMAIL_TEMPLATE_UPDATE');
    expect(audit.result).toBe('SUCCESS');
    expect(audit.old_value).toMatchObject({ subject: SUB_SUBJECT, body: SUB_BODY, isCustomized: false });
    expect(audit.new_value).toMatchObject({ body, isCustomized: true });
  });

  it('L73A-NOTIF-E2E-03 — validations serveur', async () => {
    const a = await admin();
    const s = (await etatDe('NOTIF_SUBSCRIPTION', a.cookie)).body.state;
    for (const [body, code] of [
      ['Accéder à Verebona : {{actionUrl}}', 'REQUIRED_VARIABLE_MISSING'],
      ['Bonjour {{firstName}},\n\n{{body}}\n\nVoir : {{actionUrl}}', 'UNKNOWN_VARIABLE'],
    ] as const) {
      const r = await enregistrer('NOTIF_SUBSCRIPTION', a.cookie, { subject: SUB_SUBJECT, body, baseHash: s.baseHash });
      expect(r.status, code).toBe(422);
      expect(r.body.issues.map((i: { code: string }) => i.code)).toContain(code);
    }
    const n = (await etatDe('NOTIF_NEWS', a.cookie)).body.state;
    expect(n.limitedReason).toMatch(/ne plus recevoir/);
    const r = await enregistrer('NOTIF_NEWS', a.cookie, { subject: 'Actualités', body: '{{body}}\n\nAccéder à Verebona : {{actionUrl}}', baseHash: n.baseHash });
    expect(r.status).toBe(422);
    expect(r.body.issues.map((i: { code: string }) => i.code)).toContain('REQUIRED_MENTION_MISSING');
    expect((await ligne('notif_subscription')).body).toBe(SUB_BODY);
    expect((await ligne('notif_news')).body).toBe(NEWS_BODY);
    expect((await audits(a.id, 'EMAIL_TEMPLATE_UPDATE')).every((x) => x.result === 'FAILURE')).toBe(true);
  });

  it('L73A-NOTIF-E2E-04 — aperçu avec le message réel de l’événement choisi', async () => {
    const a = await admin();
    const { POST: preview } = await import('@/app/api/admin/communications/templates/[code]/preview/route');
    const draft = { subject: '{{title}}', body: 'Bonjour,\n\n{{body}}\n\nGérer mon abonnement : {{actionUrl}}' };
    const pr = await (await preview(req('/x', { cookie: a.cookie, body: { ...draft, selection: { eventCode: 'SUBSCRIPTION_CANCELLED' } } }), ctx('NOTIF_SUBSCRIPTION'))).json();
    expect(pr.valid).toBe(true);
    expect(pr.subject).toBe('Abonnement résilié');
    expect(pr.html).toContain('Votre abonnement a été résilié.');
    expect(pr.html).toMatch(/href="https:\/\/app\.e2e\.verebona\.test\/[^"]*"/);
    expect(pr.html).not.toMatch(/\{\{|\}\}/);
    expect(pr.incomplete).toBe(false);
    // Événement d'un autre gabarit : ignoré (premier événement du gabarit).
    const pr2 = await (await preview(req('/x', { cookie: a.cookie, body: { ...draft, selection: { eventCode: 'PAYMENT_FAILED' } } }), ctx('NOTIF_SUBSCRIPTION'))).json();
    expect(pr2.subject).toBe('Abonnement renouvelé');
    expect((await ligne('notif_subscription')).body).toBe(SUB_BODY);
  });

  it('L73A-NOTIF-E2E-05 — test du brouillon vers l’administrateur seul', async () => {
    const a = await admin();
    const { POST: test } = await import('@/app/api/admin/communications/templates/[code]/test/route');
    const r = await test(req('/x', { cookie: a.cookie, body: { subject: 'Test {{title}}', body: `${SUB_BODY}\n\nBrouillon 73A.`, selection: { eventCode: 'SUBSCRIPTION_RENEWED' } } }), ctx('NOTIF_SUBSCRIPTION'));
    expect(r.status).toBe(200);
    expect(etat.calls).toHaveLength(1);
    expect(etat.calls[0].to).toBe(a.email);
    expect(etat.calls[0].subject).toBe('Test Abonnement renouvelé');
    expect(etat.calls[0].html).toContain('Brouillon 73A.');
    expect((await ligne('notif_subscription')).body).toBe(SUB_BODY);
    expect((await audits(a.id, 'EMAIL_TEMPLATE_TEST'))[0].result).toBe('SUCCESS');
  });

  it('L73A-NOTIF-E2E-06 — envoi réel par l’EmailChannel : texte modifié, valeur piégée neutralisée', async () => {
    const a = await admin();
    const s = (await etatDe('NOTIF_DOCUMENT_BATCH_FAILED', a.cookie)).body.state;
    const body = 'Bonjour,\n\n{{body}}\n\nVoir le document : {{actionUrl}}\n\nTexte modifié 73A.';
    expect((await enregistrer('NOTIF_DOCUMENT_BATCH_FAILED', a.cookie, { subject: 'Analyse : {{title}}', body, baseHash: s.baseHash })).status).toBe(200);

    const u = await make.user({ email: `${uid('notif73a')}@proton.me` });
    const { getCatalogEntry } = await import('@/lib/notifications/catalog');
    const { renderContent } = await import('@/lib/notifications/content-renderer');
    const { deliverEmail } = await import('@/lib/notifications/channels');
    const entry = getCatalogEntry('ANALYSIS_FAILED_PERSISTENT')!;
    const payload = { assetFileId: 42, documentTitle: '<a href="https://pirate.example">facture.pdf</a>\nCliquez : https://pirate.example/x' };
    const out = await deliverEmail({
      outboxId: '00000000-0000-0000-0000-000000000073', userId: u.id, eventType: 'ANALYSIS_FAILED_PERSISTENT', category: 'documents',
      payload, dedupeKey: `l73a-${u.id}`, mustDeliverBell: false, accountId: null,
    }, entry, renderContent(entry, payload));
    expect(out.status).toBe('sent');
    const mail = etat.calls.find((c) => c.to === u.email)!;
    expect(mail.subject).toBe('Analyse : Analyse impossible');
    expect(mail.html).toContain('Texte modifié 73A.');
    expect(mail.html).toContain(`href="${APP}/documents/42"`);
    expect((mail.html.match(/class="vb-btn"/g) ?? []).length).toBe(1);
    expect(`${mail.html}\n${mail.text}`).not.toMatch(/https?:\/\/pirate|pirate\.example|<a href="https:\/\/pirate/);
    expect(mail.text).toMatch(/^Voir le document : https:\/\/app\.e2e\.verebona\.test\/documents\/42$/m);
    expect(mail.text).toContain('facture․pdf');
  });

  it('L73A-NOTIF-E2E-07 — garde 0483, retour au texte livré, restauration', async () => {
    const a = await admin();
    let s = (await etatDe('NOTIF_SUBSCRIPTION', a.cookie)).body.state;
    const perso = 'Personnalisé.\n\n{{body}}\n\nVoir : {{actionUrl}}';
    await enregistrer('NOTIF_SUBSCRIPTION', a.cookie, { subject: 'Perso', body: perso, baseHash: s.baseHash });
    // Amorçage 0077 rejoué puis livraison future (UPDATE simple) : rien d'écrasé.
    // (Remarque : la garde 0483 range le texte d'un INSERT rejoué en « texte livré » ;
    // rejouer un ancien amorçage APRÈS une livraison plus récente la masquerait.)
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    await sql.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0077_notification_email_templates.sql'), 'utf8'));
    expect((await ligne('notif_subscription')).body).toBe(perso);
    await sql`UPDATE email_templates SET subject = 'Livré lot 99', body = ${`${SUB_BODY}\n\nLivré lot 99.`} WHERE type = 'notif_subscription'`;
    let l = await ligne('notif_subscription');
    expect(l.body).toBe(perso);
    expect(l.shipped_body).toBe(`${SUB_BODY}\n\nLivré lot 99.`);
    s = (await etatDe('NOTIF_SUBSCRIPTION', a.cookie)).body.state;
    expect(s.shipped.newerAt).toBeTruthy();
    // Retour au texte livré.
    const { POST: reset } = await import('@/app/api/admin/communications/templates/[code]/reset/route');
    expect((await reset(req('/x', { cookie: a.cookie, body: { baseHash: s.baseHash } }), ctx('NOTIF_SUBSCRIPTION'))).status).toBe(200);
    l = await ligne('notif_subscription');
    expect(l.body).toBe(`${SUB_BODY}\n\nLivré lot 99.`);
    expect(l.is_customized).toBe(false);
    // Restauration de la version personnalisée.
    s = (await etatDe('NOTIF_SUBSCRIPTION', a.cookie)).body.state;
    const v = s.versions.find((x: { source: string; subject: string }) => x.source === 'admin_edit' && x.subject === 'Perso');
    const { POST: restore } = await import('@/app/api/admin/communications/templates/[code]/restore/route');
    expect((await restore(req('/x', { cookie: a.cookie, body: { versionId: v.id, baseHash: s.baseHash } }), ctx('NOTIF_SUBSCRIPTION'))).status).toBe(200);
    expect((await ligne('notif_subscription')).body).toBe(perso);
  });

  it('L73A-NOTIF-E2E-08 — droits et code inconnu', async () => {
    const u = await make.user({ email: `${uid('user73a')}@verebona.test` });
    const cookie = `access_token=${await jeton(u)}`;
    const { GET, PUT } = await route();
    expect([401, 403]).toContain((await GET(req('/x', { method: 'GET', cookie }), ctx('NOTIF_SUBSCRIPTION'))).status);
    expect([401, 403]).toContain((await PUT(req('/x', { method: 'PUT', cookie, body: { subject: 'x', body: SUB_BODY, baseHash: 'x' } }), ctx('NOTIF_SUBSCRIPTION'))).status);
    const a = await admin();
    expect((await etatDe('NOTIF_INEXISTANT', a.cookie)).status).toBe(404);
    expect((await ligne('notif_subscription')).body).toBe(SUB_BODY);
  });
});
