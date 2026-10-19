/**
 * Lot 70A — éditeur des modèles d'e-mails transactionnels (BO › Communications ›
 * E-mails transactionnels), sur PostgreSQL 16 réel (toutes les migrations, dont
 * 0483), routes du BO appelées avec un vrai jeton, transport Resend SIMULÉ.
 *
 * MAIL-ED-E2E-01 Migration 0483 : colonnes, versions initiales, texte livré,
 *                déclencheurs ; rejouée sans effet.
 * MAIL-ED-E2E-02 Édition d'un gabarit texte : enregistré, personnalisé, version,
 *                audit avant / après.
 * MAIL-ED-E2E-03 Validations serveur (variable inconnue, obligatoire retirée,
 *                script, injection d'en-tête) : 422, rien d'écrit, refus journalisé.
 * MAIL-ED-E2E-04 Droits : utilisateur non administrateur refusé partout (401/403).
 * MAIL-ED-E2E-05 Gabarit HTML (WELCOME) édité par zones : liens et structure
 *                intacts ; aperçu du brouillon (rendu d'envoi).
 * MAIL-ED-E2E-06 Versions : restauration, retour au texte livré (plus personnalisé).
 * MAIL-ED-E2E-07 Livraison future : UPDATE de migration, amorçage « DELETE puis
 *                INSERT » et « DO UPDATE » n'écrasent pas un gabarit personnalisé ;
 *                texte livré plus récent signalé ; non personnalisé mis à jour.
 * MAIL-ED-E2E-08 Envoi RÉEL par la file durable avec le contenu modifié, aucune
 *                variable non remplacée.
 * MAIL-ED-E2E-09 Test du brouillon AVANT enregistrement : envoyé à l'admin, base
 *                inchangée ; brouillon invalide → rien n'est envoyé.
 * MAIL-ED-E2E-10 Concurrence : texte changé depuis l'ouverture → 409.
 * MAIL-ED-E2E-11 Gabarit légal (LEGAL_CONFIRMATION) : contenu non modifiable (403) ;
 *                gabarit non désactivable (DUO_INVITATION) : modifiable.
 * MAIL-ED-E2E-12 Variable attendue mais non fournie par l'appelant : jamais
 *                d'accolades chez le destinataire.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_70a';
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
        return { data: { id: `em_70a_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const VERIF_SUBJECT = 'Vérifiez votre adresse email - Verebona';
const VERIF_BODY = 'Bonjour {{firstName}},\n\nMerci de vous être inscrit sur Verebona. Pour activer votre compte, veuillez vérifier votre adresse email en cliquant sur le lien ci-dessous :\n\n{{verificationUrl}}\n\nCe lien est valide pendant 24 heures.\n\nCordialement,\nL\'équipe Verebona';

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'POST', headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const ctx = (code: string, extra: Record<string, string> = {}) => ({ params: Promise.resolve({ code, ...extra }) });

scenario('L70A-MAIL-ED', 'Éditeur des modèles d’e-mails transactionnels dans le BO', ({ sql, make }) => {
  const types = ['EMAIL_VERIFICATION', 'WELCOME', 'DUO_INVITATION', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', 'LEGAL_CONFIRMATION', 'DOWNGRADE_NOTIFICATION'];
  let originals: Array<{ type: string; subject: string; body: string; is_customized: boolean }> = [];

  /** Écriture « comme l'éditeur » (réglage de transaction) : préparation et remise en état. */
  const asEditor = (fn: (tx: typeof sql) => Promise<unknown>) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.email_template_edit', 'on', true)`;
      await fn(tx as unknown as typeof sql);
    });

  beforeEach(async () => {
    etat.calls.length = 0;
    process.env.RESEND_API_KEY = 're_e2e_simule_70a';
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true, sender_name = 'Verebona',
                sender_email = 'bonjour@preprod.verebona.fr', reply_to_email = 'support@verebona.fr'`;
    const { WELCOME_HTML, LEGAL_CONFIRMATION_HTML } = await import('@/lib/email/email-html-templates');
    // Gabarits de référence, non personnalisés, au texte livré.
    await asEditor(async (tx) => {
      for (const [type, subject, body] of [
        ['EMAIL_VERIFICATION', VERIF_SUBJECT, VERIF_BODY],
        ['WELCOME', 'Bienvenue sur Verebona !', WELCOME_HTML],
        ['LEGAL_CONFIRMATION', 'Confirmation — vos conditions générales Verebona', LEGAL_CONFIRMATION_HTML],
        ['DOWNGRADE_NOTIFICATION', 'Votre offre Verebona a changé', 'Bonjour {{firstName}},\n\nVotre compte est passé à une offre inférieure.\n\nRevoir mon offre : {{actionUrl}}\n\nMerci d’utiliser {{appName}}.'],
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
    // Remise en état : aucun gabarit laissé personnalisé pour les scénarios suivants.
    await asEditor(async (tx) => {
      for (const o of originals) {
        await tx`UPDATE email_templates SET subject = ${o.subject}, body = ${o.body}, is_customized = ${o.is_customized},
                   customized_at = NULL, updated_by = NULL, shipped_updated_at = NULL WHERE type = ${o.type}`;
      }
      await tx`UPDATE email_templates SET is_customized = false, customized_at = NULL WHERE is_customized`;
    });
  });

  async function jeton(user: { id: number; email: string }, role = 'USER') {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: role as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true,
    });
  }
  async function admin() {
    const u = await make.user({ email: `${uid('admin70a')}@verebona.test`, role: 'ADMIN' });
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
    shipped_subject: string | null; shipped_body: string | null; shipped_updated_at: Date | null;
  }[]>`SELECT id, subject, body, is_customized, updated_by, shipped_subject, shipped_body, shipped_updated_at FROM email_templates WHERE type = ${type}`)[0];
  const audits = async (adminId: number, action: string) => sql<{ result: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null; details: string | null }[]>`
    SELECT result, old_value, new_value, details FROM admin_audit_log WHERE admin_user_id = ${adminId} AND action_type = ${action} ORDER BY id`;

  it('MAIL-ED-E2E-01 — migration 0483 : colonnes, versions initiales, texte livré, déclencheurs ; rejouable', async () => {
    originals = await sql`SELECT type, subject, body, is_customized FROM email_templates WHERE type IN ${sql(types)}`;
    const cols = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'email_templates'`;
    expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining(['is_customized', 'customized_at', 'shipped_subject', 'shipped_body', 'shipped_updated_at']));
    const trg = await sql<{ tgname: string }[]>`SELECT tgname FROM pg_trigger WHERE tgrelid = 'email_templates'::regclass AND NOT tgisinternal`;
    expect(trg.map((t) => t.tgname).sort()).toEqual(['email_templates_guard_delete_trg', 'email_templates_guard_insert_trg', 'email_templates_guard_update_trg']);
    // Gabarit inséré par une migration antérieure (0477) : version initiale + texte livré.
    const [j7] = await sql<{ subject: string; body: string; shipped_body: string | null; is_customized: boolean }[]>`
      SELECT subject, body, shipped_body, is_customized FROM email_templates WHERE type = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'`;
    expect(j7.is_customized).toBe(false);
    expect(j7.shipped_body).toBe(j7.body);
    const [v] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_template_versions WHERE template_type = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' AND source = 'initial'`;
    expect(v.n).toBe(1);
    // Rejouée : aucun effet (pas de doublon de version).
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0483_email_template_editor.sql'), 'utf8')); });
    const [v2] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_template_versions WHERE template_type = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'`;
    expect(v2.n).toBe(1);
  });

  it('MAIL-ED-E2E-02 — édition d’un gabarit texte : enregistré, personnalisé, version, audit avant / après', async () => {
    const a = await admin();
    const s = await etatDe('EMAIL_VERIFICATION', a.cookie);
    expect(s.status).toBe(200);
    expect(s.body.state.format).toBe('text');
    expect(s.body.state.isCustomized).toBe(false);
    expect(s.body.state.channelLock).toBeTruthy(); // non désactivable…
    expect(s.body.state.contentLock).toBeNull(); // …mais modifiable
    expect(s.body.state.variables.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['firstName', 'verificationUrl']));
    const body = VERIF_BODY.replace('Merci de vous être inscrit sur Verebona.', 'Bienvenue {{firstName}} : plus qu’une étape.');
    const r = await enregistrer('EMAIL_VERIFICATION', a.cookie, { subject: 'Activez votre compte Verebona', body, baseHash: s.body.state.baseHash, note: 'Test e2e' });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    const l = await ligne('EMAIL_VERIFICATION');
    expect(l.subject).toBe('Activez votre compte Verebona');
    expect(l.body).toBe(body);
    expect(l.is_customized).toBe(true);
    expect(l.updated_by).toBe(a.id);
    expect(l.shipped_body).toBe(VERIF_BODY); // texte livré conservé
    const versions = await sql<{ source: string; created_by_email: string | null; note: string | null }[]>`
      SELECT source, created_by_email, note FROM email_template_versions WHERE template_type = 'EMAIL_VERIFICATION' ORDER BY version_no DESC LIMIT 1`;
    expect(versions[0]).toMatchObject({ source: 'admin_edit', created_by_email: a.email, note: 'Test e2e' });
    const [audit] = await audits(a.id, 'EMAIL_TEMPLATE_UPDATE');
    expect(audit.result).toBe('SUCCESS');
    expect(audit.old_value).toMatchObject({ subject: VERIF_SUBJECT, body: VERIF_BODY, isCustomized: false });
    expect(audit.new_value).toMatchObject({ subject: 'Activez votre compte Verebona', body, isCustomized: true });
  });

  it('MAIL-ED-E2E-03 — validations serveur : 422, rien d’écrit, refus journalisés', async () => {
    const a = await admin();
    const { body: s } = await etatDe('EMAIL_VERIFICATION', a.cookie);
    const base = { subject: VERIF_SUBJECT, baseHash: s.state.baseHash };
    const cas: Array<[Record<string, unknown>, string]> = [
      [{ ...base, body: `${VERIF_BODY}\n{{jetonSecret}}` }, 'UNKNOWN_VARIABLE'],
      [{ ...base, body: VERIF_BODY.replace('{{verificationUrl}}', 'https://exemple.fr') }, 'REQUIRED_VARIABLE_MISSING'],
      [{ ...base, body: `${VERIF_BODY}\n<script>alert(1)</script>` }, 'SCRIPT'],
      [{ ...base, body: `${VERIF_BODY}\n<b onmouseover="x()">a</b>` }, 'FORBIDDEN_ATTRIBUTE'],
      [{ ...base, body: `${VERIF_BODY}\nVoir : javascript:alert(1)` }, 'JAVASCRIPT_URL'],
      [{ ...base, subject: 'Bonjour\r\nBcc: pirate@example.com', body: VERIF_BODY }, 'SUBJECT_HEADER_INJECTION'],
    ];
    for (const [payload, code] of cas) {
      const r = await enregistrer('EMAIL_VERIFICATION', a.cookie, payload);
      expect(r.status, code).toBe(422);
      expect(r.body.issues.map((i: { code: string }) => i.code)).toContain(code);
    }
    expect((await ligne('EMAIL_VERIFICATION')).body).toBe(VERIF_BODY);
    const refus = await audits(a.id, 'EMAIL_TEMPLATE_UPDATE');
    expect(refus).toHaveLength(cas.length);
    expect(refus.every((x) => x.result === 'FAILURE')).toBe(true);
    // J−7 : montant obligatoire.
    const j7 = await etatDe('SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', a.cookie);
    const r = await enregistrer('SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', a.cookie, {
      subject: j7.body.state.subject, body: j7.body.state.body.split('{{amountLabel}}').join('le montant habituel'), baseHash: j7.body.state.baseHash,
    });
    expect(r.status).toBe(422);
    expect(r.body.issues.map((i: { message: string }) => i.message).join(' ')).toMatch(/montant du renouvellement/);
  });

  it('MAIL-ED-E2E-04 — droits : utilisateur non administrateur refusé partout', async () => {
    const u = await make.user({ email: `${uid('user70a')}@verebona.test` });
    const cookie = `access_token=${await jeton(u)}`;
    const { GET, PUT } = await route();
    const { POST: preview } = await import('@/app/api/admin/communications/templates/[code]/preview/route');
    const { POST: test } = await import('@/app/api/admin/communications/templates/[code]/test/route');
    const { POST: restore } = await import('@/app/api/admin/communications/templates/[code]/restore/route');
    const { POST: reset } = await import('@/app/api/admin/communications/templates/[code]/reset/route');
    const p = '/api/admin/communications/templates/EMAIL_VERIFICATION';
    const statuts = [
      (await GET(req(p, { method: 'GET', cookie }), ctx('EMAIL_VERIFICATION'))).status,
      (await PUT(req(p, { method: 'PUT', cookie, body: { subject: 'x', body: VERIF_BODY, baseHash: 'x' } }), ctx('EMAIL_VERIFICATION'))).status,
      (await preview(req(`${p}/preview`, { cookie, body: {} }), ctx('EMAIL_VERIFICATION'))).status,
      (await test(req(`${p}/test`, { cookie, body: { subject: 'x', body: VERIF_BODY } }), ctx('EMAIL_VERIFICATION'))).status,
      (await restore(req(`${p}/restore`, { cookie, body: { versionId: 1, baseHash: 'x' } }), ctx('EMAIL_VERIFICATION'))).status,
      (await reset(req(`${p}/reset`, { cookie, body: { baseHash: 'x' } }), ctx('EMAIL_VERIFICATION'))).status,
      (await GET(req(p, { method: 'GET' }), ctx('EMAIL_VERIFICATION'))).status, // sans session
    ];
    for (const st of statuts) expect([401, 403]).toContain(st);
    expect((await ligne('EMAIL_VERIFICATION')).body).toBe(VERIF_BODY);
    expect(etat.calls).toHaveLength(0);
  });

  it('MAIL-ED-E2E-05 — gabarit HTML (WELCOME) édité par zones ; aperçu du brouillon', async () => {
    const a = await admin();
    const { body: s } = await etatDe('WELCOME', a.cookie);
    expect(s.state.format).toBe('html');
    const zones: string[] = s.state.zones.map((z: { text: string }) => z.text);
    const i = zones.findIndex((t) => t.startsWith('Votre compte est maintenant activé'));
    zones[i] = 'Votre espace est prêt, {{firstName}}. Connectez-vous :';
    // Aperçu AVANT enregistrement.
    const { POST: preview } = await import('@/app/api/admin/communications/templates/[code]/preview/route');
    const pr = await (await preview(req('/api/admin/communications/templates/WELCOME/preview', { cookie: a.cookie, body: { subject: s.state.subject, zones } }), ctx('WELCOME'))).json();
    expect(pr.valid).toBe(true);
    expect(pr.html).toContain('Votre espace est prêt, Ada. Connectez-vous :');
    expect(pr.html).not.toMatch(/\{\{|\}\}/);
    expect(pr.html).toContain('data-ogsc'); // règles du mode sombre présentes (aperçu « Sombre »)
    expect((await ligne('WELCOME')).body).not.toContain('Votre espace est prêt');
    // Enregistrement.
    const r = await enregistrer('WELCOME', a.cookie, { subject: s.state.subject, zones, baseHash: s.state.baseHash });
    expect(r.status).toBe(200);
    const l = await ligne('WELCOME');
    expect(l.body).toContain('Votre espace est prêt, {{firstName}}. Connectez-vous :');
    expect(l.body).toContain('href="{{loginUrl}}"');
    expect(l.body.match(/<[^>]+>/g)).toEqual(s.state.body.match(/<[^>]+>/g)); // structure identique
    // Une zone ne peut pas recevoir de balise ; le HTML complet ne s'édite pas directement.
    const { body: s2 } = await etatDe('WELCOME', a.cookie);
    const z2 = s2.state.zones.map((z: { text: string }) => z.text);
    z2[i] = '<img src=x onerror=alert(1)>';
    expect((await enregistrer('WELCOME', a.cookie, { subject: s2.state.subject, zones: z2, baseHash: s2.state.baseHash })).status).toBe(422);
    expect((await enregistrer('WELCOME', a.cookie, { subject: s2.state.subject, body: '<html><body><script></script></body></html>', baseHash: s2.state.baseHash })).status).toBe(422);
  });

  it('MAIL-ED-E2E-06 — versions : restauration puis retour au texte livré', async () => {
    const a = await admin();
    let s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    const v1Body = VERIF_BODY.replace('Cordialement,', 'Bien à vous,');
    await enregistrer('EMAIL_VERIFICATION', a.cookie, { subject: VERIF_SUBJECT, body: v1Body, baseHash: s.baseHash });
    s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    const v1 = s.versions[0];
    await enregistrer('EMAIL_VERIFICATION', a.cookie, { subject: 'Autre objet', body: v1Body, baseHash: s.baseHash });
    s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    // Comparaison : contenu complet d'une version.
    const { GET: version } = await import('@/app/api/admin/communications/templates/[code]/versions/[id]/route');
    const vr = await (await version(req(`/x`, { method: 'GET', cookie: a.cookie }), { params: Promise.resolve({ code: 'EMAIL_VERIFICATION', id: String(v1.id) }) })).json();
    expect(vr.version.body).toBe(v1Body);
    // Restauration.
    const { POST: restore } = await import('@/app/api/admin/communications/templates/[code]/restore/route');
    const rr = await restore(req('/x', { cookie: a.cookie, body: { versionId: v1.id, baseHash: s.baseHash } }), ctx('EMAIL_VERIFICATION'));
    expect(rr.status).toBe(200);
    let l = await ligne('EMAIL_VERIFICATION');
    expect(l.subject).toBe(VERIF_SUBJECT);
    expect(l.body).toBe(v1Body);
    expect(l.is_customized).toBe(true);
    const [restAudit] = await audits(a.id, 'EMAIL_TEMPLATE_RESTORE');
    expect(restAudit.new_value).toMatchObject({ body: v1Body });
    // Retour au texte livré.
    s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    expect(s.shipped.available).toBe(true);
    const { POST: reset } = await import('@/app/api/admin/communications/templates/[code]/reset/route');
    expect((await reset(req('/x', { cookie: a.cookie, body: { baseHash: s.baseHash } }), ctx('EMAIL_VERIFICATION'))).status).toBe(200);
    l = await ligne('EMAIL_VERIFICATION');
    expect(l.body).toBe(VERIF_BODY);
    expect(l.is_customized).toBe(false);
    expect(l.updated_by).toBeNull(); // comme un gabarit jamais enregistré depuis le BO (règle de 0465)
    const hist = await sql<{ source: string; restored_from_version: number | null }[]>`
      SELECT source, restored_from_version FROM email_template_versions WHERE template_type = 'EMAIL_VERIFICATION' ORDER BY version_no DESC LIMIT 2`;
    expect(hist.map((h) => h.source)).toEqual(['reset_shipped', 'restore']);
    expect(hist[1].restored_from_version).toBe(v1.versionNo);
    expect((await audits(a.id, 'EMAIL_TEMPLATE_RESET'))[0].new_value).toMatchObject({ isCustomized: false });
  });

  it('MAIL-ED-E2E-07 — une livraison future n’écrase jamais un gabarit personnalisé', async () => {
    const a = await admin();
    const s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    const perso = VERIF_BODY.replace('Cordialement,', 'Texte personnalisé,');
    await enregistrer('EMAIL_VERIFICATION', a.cookie, { subject: 'Objet perso', body: perso, baseHash: s.baseHash });
    const LIVRE = `${VERIF_BODY}\n\nNouveau texte livré au lot 99.`;
    // 1. Migration future (UPDATE simple, sans précaution).
    await sql`UPDATE email_templates SET subject = 'Objet livré lot 99', body = ${LIVRE}, updated_at = now() WHERE type = 'EMAIL_VERIFICATION'`;
    let l = await ligne('EMAIL_VERIFICATION');
    expect(l.subject).toBe('Objet perso');
    expect(l.body).toBe(perso);
    expect(l.is_customized).toBe(true);
    expect(l.shipped_body).toBe(LIVRE);
    expect(l.shipped_updated_at).not.toBeNull();
    // 2. Amorçage « DELETE puis INSERT » (seeds) et « ON CONFLICT DO UPDATE ».
    await sql`DELETE FROM email_templates WHERE type = 'EMAIL_VERIFICATION'`;
    await sql`INSERT INTO email_templates (type, subject, body) VALUES ('EMAIL_VERIFICATION', 'Objet seed', ${`${LIVRE} (seed)`})`;
    await sql`INSERT INTO email_templates (type, subject, body) VALUES ('EMAIL_VERIFICATION', 'Objet upsert', ${`${LIVRE} (upsert)`})
              ON CONFLICT (type) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, updated_by = NULL`;
    l = await ligne('EMAIL_VERIFICATION');
    expect(l.body).toBe(perso);
    expect(l.updated_by).toBe(a.id);
    // Insertion ignorée (gabarit personnalisé) : le dernier texte reçu devient le texte livré.
    expect(l.shipped_body).toBe(`${LIVRE} (upsert)`);
    expect((await sql`SELECT 1 FROM email_templates WHERE type = 'EMAIL_VERIFICATION'`).length).toBe(1);
    // Migration 0465 rejouée : sans effet sur un gabarit personnalisé.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    await sql.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0465_l66c_emails_charte_2026.sql'), 'utf8'));
    expect((await ligne('EMAIL_VERIFICATION')).body).toBe(perso);
    // Le BO signale le texte livré plus récent et propose d'y revenir.
    const st = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    expect(st.shipped.newerAt).toBeTruthy();
    expect(st.shipped.body).toBe(`${LIVRE} (upsert)`);
    // Gabarit NON personnalisé : la livraison s'applique comme avant.
    await sql`UPDATE email_templates SET body = ${'Bonjour {{firstName}},\n\nTexte livré.\n\nRevoir mon offre : {{actionUrl}}'} WHERE type = 'DOWNGRADE_NOTIFICATION'`;
    const d = await ligne('DOWNGRADE_NOTIFICATION');
    expect(d.body).toContain('Texte livré.');
    expect(d.shipped_body).toBe(d.body);
    expect(d.shipped_updated_at).toBeNull();
  });

  it('MAIL-ED-E2E-08 — envoi réel par la file durable avec le contenu modifié, aucune variable non remplacée', async () => {
    const a = await admin();
    const s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    const body = 'Bonjour {{firstName}},\n\nTexte modifié depuis le BO pour la recette 70A.\n\nActiver mon compte : {{verificationUrl}}\n\nÀ bientôt.';
    expect((await enregistrer('EMAIL_VERIFICATION', a.cookie, { subject: 'Activez votre compte, {{firstName}}', body, baseHash: s.baseHash })).status).toBe(200);
    const u = await make.user({ email: `${uid('verif70a')}@proton.me` });
    await sql`UPDATE users SET is_active = false, first_name = 'Lina' WHERE id = ${u.id}`;
    const { enqueueVerificationEmail, processEmailJob } = await import('@/services/email/transactional-email-jobs.service');
    const { jobId } = await enqueueVerificationEmail({ userId: u.id, email: u.email });
    const out = await processEmailJob(jobId, new Date(Date.now() + 1_000));
    expect(out.status).toBe('accepted');
    const mail = etat.calls.find((c) => c.to === u.email)!;
    expect(mail.subject).toBe('Activez votre compte, Lina');
    expect(mail.html).toContain('Texte modifié depuis le BO pour la recette 70A.');
    expect(mail.html).toContain('>Activer mon compte</a>'); // bouton de la charte, libellé saisi
    expect(mail.html).toMatch(/href="https:\/\/app\.e2e\.verebona\.test\/api\/auth\/verify-email\?token=[^"]+"/);
    expect(`${mail.subject}${mail.html}${mail.text ?? ''}`).not.toMatch(/\{\{|\}\}/);
    const [log] = await sql<{ status: string; error_message: string | null }[]>`
      SELECT status, error_message FROM email_logs WHERE email_job_id = ${jobId} ORDER BY id DESC LIMIT 1`;
    expect(log).toMatchObject({ status: 'sent', error_message: null });
  });

  it('MAIL-ED-E2E-09 — test du brouillon AVANT enregistrement ; brouillon invalide jamais envoyé', async () => {
    const a = await admin();
    const s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    const { POST: test } = await import('@/app/api/admin/communications/templates/[code]/test/route');
    const draft = { subject: 'Brouillon {{firstName}}', body: `${VERIF_BODY}\n\nLigne du brouillon non enregistré.` };
    const r = await test(req('/x', { cookie: a.cookie, body: draft }), ctx('EMAIL_VERIFICATION'));
    expect(r.status).toBe(200);
    expect(etat.calls).toHaveLength(1);
    expect(etat.calls[0].to).toBe(a.email); // jamais un autre destinataire
    expect(etat.calls[0].subject).toBe('Brouillon Ada');
    expect(etat.calls[0].html).toContain('Ligne du brouillon non enregistré.');
    // Lien signé indisponible pour l'administrateur : lien NEUTRE (sans jeton), bouton rendu.
    expect(etat.calls[0].html).toContain('href="https://app.e2e.verebona.test/?apercu-lien=verificationUrl"');
    expect(etat.calls[0].html).not.toMatch(/token=/);
    expect((await ligne('EMAIL_VERIFICATION')).body).toBe(s.body); // base inchangée
    const [audit] = await audits(a.id, 'EMAIL_TEMPLATE_TEST');
    expect(audit.result).toBe('SUCCESS');
    const ko = await test(req('/x', { cookie: a.cookie, body: { subject: 'x', body: `${VERIF_BODY}\n<script>x</script>` } }), ctx('EMAIL_VERIFICATION'));
    expect(ko.status).toBe(422);
    expect(etat.calls).toHaveLength(1);
  });

  it('MAIL-ED-E2E-10 — concurrence : texte changé depuis l’ouverture → 409, rien d’écrasé', async () => {
    const a = await admin();
    const b = await admin();
    const s = (await etatDe('EMAIL_VERIFICATION', a.cookie)).body.state;
    expect((await enregistrer('EMAIL_VERIFICATION', b.cookie, { subject: 'Par B', body: VERIF_BODY, baseHash: s.baseHash })).status).toBe(200);
    const r = await enregistrer('EMAIL_VERIFICATION', a.cookie, { subject: 'Par A', body: VERIF_BODY, baseHash: s.baseHash });
    expect(r.status).toBe(409);
    expect((await ligne('EMAIL_VERIFICATION')).subject).toBe('Par B');
  });

  it('MAIL-ED-E2E-11 — gabarit légal non modifiable ; gabarit non désactivable modifiable', async () => {
    const a = await admin();
    const s = (await etatDe('LEGAL_CONFIRMATION', a.cookie)).body.state;
    expect(s.contentLock).toMatch(/CDC 7/);
    const r = await enregistrer('LEGAL_CONFIRMATION', a.cookie, { subject: 'Autre', zones: s.zones.map((z: { text: string }) => z.text), baseHash: s.baseHash });
    expect(r.status).toBe(403);
    expect((await audits(a.id, 'EMAIL_TEMPLATE_UPDATE'))[0].result).toBe('DENIED');
    // DUO_INVITATION : non désactivable, texte modifiable.
    const d = (await etatDe('DUO_INVITATION', a.cookie)).body.state;
    expect(d.channelLock).toBeTruthy();
    expect(d.contentLock).toBeNull();
    const body = d.format === 'text' ? `${d.body}\n\nÀ très vite sur Verebona.` : undefined;
    const zones = d.format === 'html' ? d.zones.map((z: { text: string }, i: number) => (i === d.zones.length - 1 ? `${z.text} !` : z.text)) : undefined;
    const ok = await enregistrer('DUO_INVITATION', a.cookie, { subject: d.subject, body, zones, baseHash: d.baseHash });
    expect(ok.status).toBe(200);
  });

  it('MAIL-ED-E2E-12 — variable non fournie par l’appelant : jamais d’accolades chez le destinataire', async () => {
    // Gabarit hérité (hors éditeur) qui attend {{appName}}, que l'appelant ne fournit pas.
    const { emailService } = await import('@/lib/email/email-service');
    const to = `${uid('down70a')}@proton.me`;
    const res = await emailService.send({ templateCode: 'DOWNGRADE_NOTIFICATION', to, variables: { firstName: 'Max', actionUrl: `${APP}/mon-compte/offres` } });
    expect(res.success).toBe(true);
    const mail = etat.calls.find((c) => c.to === to)!;
    expect(`${mail.subject}${mail.html}`).not.toMatch(/\{\{|\}\}/);
    const [log] = await sql<{ error_message: string | null }[]>`SELECT error_message FROM email_logs WHERE id = ${res.logId!}`;
    expect(log.error_message).toMatch(/appName/); // signalé dans le journal (lot 49)
  });
});
