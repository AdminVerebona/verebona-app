/**
 * Lot 74 (74B) — point 4 : « Déplacer vers l'espace Duo » (réponse PO à Q1).
 * PostgreSQL 16 réel, VRAIES routes : inscription, vérification d'adresse,
 * invitation Duo, acceptation, changement d'espace, aperçu, déplacement,
 * départ du Duo. Seules l'activation de l'offre du titulaire (chemin réel du
 * BO / webhook, `applyPlanChange`) et les DONNÉES du bien (documents, agenda,
 * équipements…) sont posées directement : le téléversement S3 n'est pas
 * joignable en e2e.
 *
 * Identifiants L74B-xx :
 *   01 visibilité : membre actif des deux espaces → cible Duo ; titulaire sans
 *      second espace, utilisateur hors Duo → aucune cible ;
 *   02 aperçu exact sans écriture : ce qui part, ce qui reste, données
 *      personnelles, quotas après ; confirmation obligatoire ;
 *   03 déplacement complet : bien, documents et dérivés (index plein texte),
 *      liens, équipements, pièces, agenda, événements, « À traiter »,
 *      journal + historique des deux comptes ; conversations et préférences
 *      NON déplacées ; visible du titulaire, plus de l'espace personnel ;
 *      aucune incohérence pour le rattrapage automatique ;
 *   04 isolation : deux comptes, les autres biens et données ne bougent pas ;
 *      un compte étranger ne voit rien ;
 *   05 rejeu : même demande rejouée, demandes simultanées → un seul effet ;
 *   06 quotas du compte cible (biens, documents) : refus explicite, rien
 *      d'écrit ;
 *   07 non-membre refusé : utilisateur hors Duo, titulaire sur un bien qui
 *      n'est pas dans son espace, membre parti du Duo ;
 *   08 aperçu périmé (contenu changé entre l'aperçu et la confirmation) ;
 *   09 migration 0536 rejouable.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { activerParLien } from '../activation';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return { calls: [] as Array<{ to: string; html: string; subject?: string }>, n: 0 };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; html: string; subject?: string }) => {
        etat.calls.push(p);
        etat.n += 1;
        return { data: { id: `em_l74b_${etat.n}` }, error: null };
      },
    };
  },
}));

const PASSWORD = 'MembreDuo1!x';
type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test',
    'x-forwarded-for': `93.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.9`,
  };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const ck = (access?: string) => (access ? `access_token=${access}` : undefined);
const params = (p: Record<string, string | number>): { params: Promise<any> } => ({
  params: Promise.resolve(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))),
});

scenario('L74B', 'Déplacer un bien vers l’espace Duo', ({ sql, make }) => {
  beforeEach(async () => {
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
  });

  async function cgvu(): Promise<string> {
    const [cur] = await sql<{ version_code: string }[]>`
      SELECT version_code FROM legal_document_versions WHERE document_type = 'CGVU' AND status = 'CURRENT' LIMIT 1`;
    if (cur) return cur.version_code;
    const code = `E2E-${uid('cgvu')}`;
    await sql`INSERT INTO legal_document_versions
      (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key)
      VALUES ('CGVU', ${code}, 'CGVU e2e', 'CURRENT', 'e2e', now(), now(), '<p>CGVU</p>', ${'0'.repeat(64)}, ${`/cgvu/${code}`}, ${`legal/${code}.html`})`;
    return code;
  }

  // ── Parcours réels ────────────────────────────────────────────────────
  async function inscrire(email: string) {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(req('/api/users', {
      body: { email, password: PASSWORD, firstName: 'Inès', lastName: 'Membre', acceptedTerms: true, termsVersion: await cgvu() },
    }));
    return { status: res.status };
  }
  async function activer(email: string) {
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    const mail = etat.calls.filter((c) => c.to === email && /verify-email\?token=/.test(c.html)).at(-1);
    const m = /href="([^"]*\/api\/auth\/verify-email\?token=[^"]+)"/.exec(mail?.html ?? '');
    expect(m, `e-mail de vérification reçu par ${email}`).toBeTruthy();
    // Lot 96A (Q9) : le lien mène à la page qui exige le mot de passe de l'inscription.
    const res = await activerParLien(m![1].replace(/&amp;/g, '&'), PASSWORD);
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    return { access: (res as WithCookies).cookies.get('access_token')?.value };
  }
  async function claims(access: string | undefined) {
    if (!access) return null;
    const { verifyAccessToken } = await import('@/lib/jwt');
    return verifyAccessToken(access);
  }
  async function jeton(user: { id: number; email: string }, accountId: number | null) {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({
      id: user.id, email: user.email, role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never,
      ...(accountId ? { currentAccountId: accountId } : {}), hasActiveAccount: true,
    });
  }
  async function duoActif(m: string) {
    const owner = await make.user({ email: `${uid('titulaire')}@proton.me` });
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand', is_active = true WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: 'premium_duo', name: `Duo ${m}` });
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: acc.id, ownerUserId: owner.id, oldPlanType: 'STANDARD', newPlanType: 'PREMIUM_DUO',
      newSubStatus: 'ACTIVE', newPremiumUntil: null, newMaxMembers: 2, source: 'e2e:l74b', sendEmails: false,
    });
    const [{ duo_account_id: duoId }] = await sql<{ duo_account_id: number }[]>`SELECT duo_account_id FROM accounts WHERE id = ${acc.id}`;
    const maison = await make.asset(acc, { category: 'IMMOBILIER', name: `${m}-maison-duo` });
    return { owner, acc, duoId, maison, tok: await jeton(owner, acc.id) };
  }
  async function changerEspace(access: string | undefined, accountId: number) {
    const { POST } = await import('@/app/api/auth/switch-account/route');
    const r = await POST(req('/api/auth/switch-account', { body: { accountId }, cookie: ck(access) }));
    expect(r.status).toBe(200);
    return (r as WithCookies).cookies.get('access_token')?.value;
  }
  /** Utilisateur déjà inscrit (compte personnel + essai), devenu membre du Duo, session rouverte sur son espace personnel. */
  async function membreDesDeux(d: Awaited<ReturnType<typeof duoActif>>, prefix: string) {
    const email = `${uid(prefix)}@proton.me`;
    expect((await inscrire(email)).status).toBe(201);
    const v = await activer(email);
    const perso = (await claims(v.access))!.currentAccountId!;
    const { POST: inviter } = await import('@/app/api/duo/invitation/route');
    expect((await inviter(req('/api/duo/invitation', { body: { email }, cookie: ck(d.tok) }))).status).toBe(200);
    const [{ t: token }] = await sql<{ t: string }[]>`SELECT pending_invite_token AS t FROM duo_accounts WHERE id = ${d.duoId}`;
    const { POST: join } = await import('@/app/api/duo/join/route');
    const j = await join(req('/api/duo/join', { body: { token }, cookie: ck(v.access) }));
    expect(j.status, await j.clone().text()).toBe(200);
    const surDuo = (j as WithCookies).cookies.get('access_token')?.value;
    const access = await changerEspace(surDuo, perso);
    const [u] = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = ${email}`;
    return { email, user: { id: u.id, email }, perso, persoRow: { id: perso, ownerUserId: u.id }, access: access!, surDuo: surDuo! };
  }
  /** Bien personnel garni : documents (dont un partagé avec un autre bien), équipement, pièce, agenda, événement, « À traiter », extraction indexée. */
  async function bienGarni(m: { persoRow: { id: number; ownerUserId: number }; user: { id: number } }, nom: string) {
    const velo = await make.asset(m.persoRow, { category: 'VEHICULE', name: nom });
    const autre = await make.asset(m.persoRow, { category: 'VEHICULE', name: `${nom}-autre` });
    const f1 = await make.assetFile(m.persoRow, { assetId: velo.id });
    await sql`UPDATE asset_files SET original_filename = ${`${nom}-facture.pdf`}, upload_status = 'COMPLETED', size = 1000 WHERE id = ${f1.id}`;
    const fPartage = await make.assetFile(m.persoRow, { assetId: velo.id });
    await sql`UPDATE asset_files SET original_filename = ${`${nom}-assurance-commune.pdf`} WHERE id = ${fPartage.id}`;
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${m.persoRow.id}, ${fPartage.id}, ${autre.id}, 'SECONDARY', 'USER', 'ACTIVE')`;
    const [ext] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, full_text) VALUES (${m.persoRow.id}, ${f1.id}, 'Facture', ${`révision ${nom} pneus`}) RETURNING id`;
    const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${velo.id}, 'Compteur') RETURNING id`;
    await sql`INSERT INTO substructures (asset_id, name) VALUES (${velo.id}, 'Garage')`;
    const g1 = await make.agendaItem(m.persoRow, { assetIds: [velo.id], title: `${nom}-revision` });
    await sql`INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement) VALUES (${m.persoRow.id}, ${m.user.id}, ${velo.id}, 'ENTRETIEN', ${`${nom}-vidange`}, now())`;
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${m.persoRow.id}, 'ASSET', ${velo.id}, 'mileage', 'COMPLETE', 'R', 'Kilométrage ?')`;
    return { velo, autre, f1, fPartage, ext: ext.id, equip: equip.id, g1 };
  }
  async function cibles(access: string | undefined, assetId: number) {
    const { GET } = await import('@/app/api/assets/[id]/move-to-space/route');
    const r = await GET(req(`/api/assets/${assetId}/move-to-space`, { cookie: ck(access) }), params({ id: assetId }));
    return { status: r.status, body: await r.json() as { targets?: Array<{ accountId: number; roleLabel: string }> } };
  }
  async function deplacer(access: string | undefined, assetId: number, body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/assets/[id]/move-to-space/route');
    const r = await POST(req(`/api/assets/${assetId}/move-to-space`, { body, cookie: ck(access) }), params({ id: assetId }));
    return { status: r.status, body: await r.json() as Record<string, any> };
  }
  async function listeBiens(access: string | undefined) {
    const { GET } = await import('@/app/api/assets/route');
    const r = await GET(req('/api/assets', { cookie: ck(access) }));
    return { status: r.status, text: await r.text() };
  }
  const compteDe = async (table: string, id: number) =>
    (await sql.unsafe<{ a: number }[]>(`SELECT account_id AS a FROM ${table} WHERE id = $1`, [id]))[0]?.a;

  // ── L74B-01 ────────────────────────────────────────────────────────────
  it('L74B-01 — action visible seulement pour un membre actif des deux espaces', async () => {
    const d = await duoActif('VISIBLE');
    const m = await membreDesDeux(d, 'visible');
    const b = await bienGarni(m, 'VIS-velo');
    const c = await cibles(m.access, b.velo.id);
    expect(c.status).toBe(200);
    expect(c.body.targets).toEqual([{ accountId: d.acc.id, name: 'Duo VISIBLE', role: 'member', roleLabel: 'Membre' }]);
    // Titulaire du Duo, sans autre espace : rien à proposer.
    expect((await cibles(d.tok, d.maison.id)).body.targets).toEqual([]);
    // Utilisateur hors Duo : rien.
    const seul = await make.account({ plan: 'premium' });
    const bien = await make.asset(seul);
    expect((await cibles(await jeton(seul.owner, seul.id), bien.id)).body.targets).toEqual([]);
    // Sans session : 401.
    expect((await cibles(undefined, b.velo.id)).status).toBe(401);
  });

  // ── L74B-02 ────────────────────────────────────────────────────────────
  it('L74B-02 — aperçu exact, sans écriture ; confirmation explicite exigée', async () => {
    const d = await duoActif('APERCU');
    const m = await membreDesDeux(d, 'apercu');
    const b = await bienGarni(m, 'APE-velo');
    const r = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body.preview;
    expect(p).toMatchObject({
      assetName: 'APE-velo',
      from: { accountId: m.perso }, to: { accountId: d.acc.id, name: 'Duo APERCU' },
      moves: { equipments: 1, rooms: 1, agendaItems: 1, events: 1, toProcessActions: 1 },
      stays: { sharedAgendaItems: 0 },
    });
    expect(p.moves.documents.map((x: { title: string }) => x.title)).toEqual(['APE-velo-facture.pdf']);
    expect(p.stays.sharedDocuments.map((x: { title: string }) => x.title)).toEqual(['APE-velo-assurance-commune.pdf']);
    expect(p.personal.join(' ')).toMatch(/conversations.*préférences/);
    expect(p.quotas.assets).toEqual({ used: 2, limit: 15 });
    expect(p.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // Rien n'a été écrit.
    expect(await compteDe('assets', b.velo.id)).toBe(m.perso);
    expect(await compteDe('asset_files', b.f1.id)).toBe(m.perso);
    expect(await sql`SELECT 1 FROM asset_space_moves WHERE asset_id = ${b.velo.id}`).toHaveLength(0);
    // Sans confirmation (ou sans empreinte) : refusé.
    expect((await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id })).body.code).toBe('CONFIRMATION_REQUIRED');
    expect((await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, confirm: true })).status).toBe(400);
    expect(await compteDe('assets', b.velo.id)).toBe(m.perso);
  });

  // ── L74B-03 / L74B-04 ──────────────────────────────────────────────────
  it('L74B-03 / L74B-04 — déplacement complet, journalisé ; données personnelles et autres biens intacts ; isolation', async () => {
    const d = await duoActif('COMPLET');
    const m = await membreDesDeux(d, 'complet');
    const b = await bienGarni(m, 'CPL-velo');
    // Données personnelles du membre dans son espace : conversation, préférence.
    const [conv] = await sql<{ id: number }[]>`
      INSERT INTO verebona_conversations (account_id, user_id, title, expires_at) VALUES (${m.perso}, ${m.user.id}, 'CPL-velo ?', now() + interval '30 days') RETURNING id`;
    await sql`INSERT INTO notification_preferences (user_id, category, channel, enabled) VALUES (${m.user.id}, 'documents', 'push', false)`;
    const prefsAvant = await sql`SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ${m.user.id} ORDER BY id`;
    // Un compte étranger, garni, qui ne doit pas bouger.
    const etranger = await make.account({ plan: 'premium' });
    const bienEtranger = await make.asset(etranger, { name: 'CPL-etranger' });

    const ap = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    const ok = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, confirm: true, fingerprint: ap.body.preview.fingerprint });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, mode: 'apply', alreadyMoved: false, toAccountId: d.acc.id });

    // Le bien et tout ce qui s'y rattache sont dans le Duo.
    expect(await compteDe('assets', b.velo.id)).toBe(d.acc.id);
    expect(await compteDe('asset_files', b.f1.id)).toBe(d.acc.id);
    expect(await compteDe('document_extractions', b.ext)).toBe(d.acc.id);
    expect(await compteDe('agenda_items', b.g1.id)).toBe(d.acc.id);
    expect((await sql<{ a: number }[]>`SELECT account_id AS a FROM events WHERE asset_id = ${b.velo.id}`).map((r) => r.a)).toEqual([d.acc.id]);
    expect((await sql<{ a: number }[]>`SELECT account_id AS a FROM to_process_actions WHERE target_type = 'ASSET' AND target_id = ${b.velo.id}`).map((r) => r.a)).toEqual([d.acc.id]);
    expect((await sql<{ asset_id: number }[]>`SELECT asset_id FROM equipments WHERE id = ${b.equip}`)[0].asset_id).toBe(b.velo.id);
    // Index de recherche plein texte : l'extraction est trouvée depuis le Duo, plus depuis l'espace personnel.
    const fts = (a: number) => sql`SELECT id FROM document_extractions WHERE account_id = ${a}
      AND to_tsvector('french', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(supplier_name, '') || ' ' || coalesce(full_text, '')) @@ plainto_tsquery('french', 'pneus')`;
    expect((await fts(d.acc.id)).map((r) => r.id)).toContain(b.ext);
    expect((await fts(m.perso)).map((r) => r.id)).not.toContain(b.ext);
    // Document partagé avec un autre bien : reste, lien vers le bien retiré.
    expect(await compteDe('asset_files', b.fPartage.id)).toBe(m.perso);
    expect(await sql`SELECT 1 FROM document_asset_links WHERE file_id = ${b.fPartage.id} AND asset_id = ${b.velo.id} AND status = 'ACTIVE'`).toHaveLength(0);
    // Conversations et préférences : non déplacées.
    expect(await compteDe('verebona_conversations', conv.id)).toBe(m.perso);
    expect(await sql`SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ${m.user.id} ORDER BY id`).toEqual(prefsAvant);
    // Visible du titulaire, plus de l'espace personnel ; l'autre bien reste.
    expect((await listeBiens(d.tok)).text).toContain('CPL-velo');
    const perso = await listeBiens(m.access);
    expect(perso.text).not.toContain('"CPL-velo"');
    expect(perso.text).toContain('CPL-velo-autre');
    expect(await compteDe('assets', b.autre.id)).toBe(m.perso);
    // Isolation : le compte étranger n'a rien reçu ni perdu.
    expect(await compteDe('assets', bienEtranger.id)).toBe(etranger.id);
    expect((await listeBiens(await jeton(etranger.owner, etranger.id))).text).not.toContain('CPL-velo');
    // Journal + historique des deux comptes.
    const [j] = await sql<{ id: number; from_account_id: number; to_account_id: number; user_id: number; asset_name: string; report: Record<string, any> }[]>`
      SELECT id, from_account_id, to_account_id, user_id, asset_name, report FROM asset_space_moves WHERE asset_id = ${b.velo.id}`;
    expect(j).toMatchObject({ from_account_id: m.perso, to_account_id: d.acc.id, user_id: m.user.id, asset_name: 'CPL-velo' });
    expect(j.report.transfer.movedFileIds).toEqual([b.f1.id]);
    expect(j.report.transfer.keptFileIds).toEqual([b.fPartage.id]);
    expect(await sql`SELECT action_type FROM account_audit_log WHERE account_id = ${m.perso} AND action_type = 'ASSET_MOVED_OUT'`).toHaveLength(1);
    expect(await sql`SELECT action_type FROM account_audit_log WHERE account_id = ${d.acc.id} AND action_type = 'ASSET_MOVED_IN'`).toHaveLength(1);
    const { loadAccountHistory } = await import('@/services/admin/account-history.service');
    expect((await loadAccountHistory(d.acc.id)).map((h) => h.event)).toContain('Bien reçu d’un autre espace');
    // Plus aucune donnée du bien restée dans l'espace personnel (rattrapage automatique : rien à faire).
    const { findMisplacedAssetData } = await import('@/services/assets/asset-account-backfill');
    expect((await findMisplacedAssetData(500, { proven: null })).filter((c) => c.assetId === b.velo.id)).toEqual([]);
    // Le journal vaut preuve : une donnée restée derrière (état reconstitué
    // hors gardes) serait remise en cohérence par le rattrapage automatique.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement) VALUES (${m.perso}, ${m.user.id}, ${b.velo.id}, 'ENTRETIEN', 'CPL-reste', now())`;
    });
    expect((await findMisplacedAssetData(500)).filter((c) => c.assetId === b.velo.id))
      .toEqual([{ assetId: b.velo.id, toAccountId: d.acc.id, fromAccountId: m.perso }]);
  });

  // ── L74B-05 ────────────────────────────────────────────────────────────
  it('L74B-05 — rejeu et demandes simultanées : un seul déplacement', async () => {
    const d = await duoActif('REJEU');
    const m = await membreDesDeux(d, 'rejeu');
    const b = await bienGarni(m, 'REJ-velo');
    const ap = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    const corps = { targetAccountId: d.acc.id, confirm: true, fingerprint: ap.body.preview.fingerprint };
    const [x, y] = await Promise.all([deplacer(m.access, b.velo.id, corps), deplacer(m.access, b.velo.id, corps)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect([x.body.alreadyMoved, y.body.alreadyMoved].sort()).toEqual([false, true]);
    expect(x.body.moveId).toBe(y.body.moveId);
    // Rejouée plus tard (double clic, réseau) : même résultat, rien de plus.
    const z = await deplacer(m.access, b.velo.id, corps);
    expect(z.body).toMatchObject({ ok: true, alreadyMoved: true, moveId: x.body.moveId });
    expect(await sql`SELECT 1 FROM asset_space_moves WHERE asset_id = ${b.velo.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM account_audit_log WHERE account_id = ${d.acc.id} AND action_type = 'ASSET_MOVED_IN'`).toHaveLength(1);
    expect(await compteDe('asset_files', b.f1.id)).toBe(d.acc.id);
  });

  // ── L74B-06 ────────────────────────────────────────────────────────────
  it('L74B-06 — quotas du compte cible vérifiés avant : refus explicite, rien d’écrit', async () => {
    const d = await duoActif('QUOTA');
    const m = await membreDesDeux(d, 'quota');
    const b = await bienGarni(m, 'QUO-velo');
    // Biens : le Duo est à sa limite (15).
    for (let i = 0; i < 14; i += 1) await make.asset(d.acc, { name: `QUOTA-plein-${i}` });
    const r = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ASSET_QUOTA_REACHED');
    expect(r.body.message).toMatch(/15 bien.*Rien n’a été déplacé/);
    expect(await compteDe('assets', b.velo.id)).toBe(m.perso);
    expect(await compteDe('asset_files', b.f1.id)).toBe(m.perso);
    // Même refus à la confirmation, quelle que soit l'empreinte.
    const c = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, confirm: true, fingerprint: r.body.preview?.fingerprint ?? 'x' });
    expect(c.body.code).toBe('ASSET_QUOTA_REACHED');
    expect(await sql`SELECT 1 FROM asset_space_moves WHERE asset_id = ${b.velo.id}`).toHaveLength(0);

    // Documents : une place de bien, mais le Duo est à 225 documents.
    await sql`DELETE FROM assets WHERE account_id = ${d.acc.id} AND name LIKE 'QUOTA-plein-%'`;
    await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, upload_status)
              SELECT ${d.owner.id}, ${d.acc.id}, ${d.maison.id}, 'e2e/plein/' || g, 'application/pdf', 'COMPLETED' FROM generate_series(1, 225) g`;
    const r2 = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    expect(r2.body.code).toBe('DOCUMENT_QUOTA_REACHED');
    expect(r2.body.message).toMatch(/225 documents/);
    expect(await compteDe('asset_files', b.f1.id)).toBe(m.perso);
  });

  // ── L74B-07 ────────────────────────────────────────────────────────────
  it('L74B-07 — non-membre refusé : hors Duo, bien hors de l’espace courant, membre parti', async () => {
    const d = await duoActif('REFUS');
    const m = await membreDesDeux(d, 'refus');
    const b = await bienGarni(m, 'REF-velo');
    // Utilisateur hors Duo, sur son propre bien, vers ce Duo : refusé.
    const intrus = await make.account({ plan: 'premium' });
    const bienIntrus = await make.asset(intrus, { name: 'REF-intrus' });
    const i = await deplacer(await jeton(intrus.owner, intrus.id), bienIntrus.id, { targetAccountId: d.acc.id, preview: true });
    expect(i.status).toBe(403);
    expect(i.body.code).toBe('MOVE_NOT_ALLOWED');
    // Le titulaire du Duo ne peut pas « aspirer » le bien du membre (pas dans son espace).
    const t = await deplacer(d.tok, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    expect(t.status).toBe(409); // même compte que sa session : SAME_ACCOUNT, rien n'est lu
    const t2 = await deplacer(await jeton(d.owner, intrus.id), b.velo.id, { targetAccountId: d.acc.id, preview: true });
    expect(t2.status).toBe(401); // session sur un compte dont il n'est pas membre
    // Membre parti du Duo (route réelle) : plus de cible, refus.
    const { POST: quitter } = await import('@/app/api/duo/leave/route');
    expect((await quitter(req('/api/duo/leave', { body: {}, cookie: ck(m.surDuo) }))).status).toBe(200);
    expect((await cibles(m.access, b.velo.id)).body.targets).toEqual([]);
    const p = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    expect(p.body.code).toBe('MOVE_NOT_ALLOWED');
    expect(await compteDe('assets', b.velo.id)).toBe(m.perso);
    expect(await compteDe('assets', bienIntrus.id)).toBe(intrus.id);
  });

  // ── L74B-08 ────────────────────────────────────────────────────────────
  it('L74B-08 — contenu changé entre l’aperçu et la confirmation : nouvel aperçu exigé', async () => {
    const d = await duoActif('PERIME');
    const m = await membreDesDeux(d, 'perime');
    const b = await bienGarni(m, 'PER-velo');
    const ap = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, preview: true });
    const nouveau = await make.assetFile(m.persoRow, { assetId: b.velo.id });
    const r = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, confirm: true, fingerprint: ap.body.preview.fingerprint });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREVIEW_STALE');
    expect(r.body.preview.moves.documents.map((x: { id: number }) => x.id)).toContain(nouveau.id);
    expect(await compteDe('assets', b.velo.id)).toBe(m.perso);
    const ok = await deplacer(m.access, b.velo.id, { targetAccountId: d.acc.id, confirm: true, fingerprint: r.body.preview.fingerprint });
    expect(ok.status).toBe(200);
    expect(await compteDe('asset_files', nouveau.id)).toBe(d.acc.id);
  });

  // ── L74B-10 (point 5) ──────────────────────────────────────────────────
  it('L74B-10 — invitation générique : plus aucun lien mort /mon-compte/partage ; route conservée, réservée au titulaire', async () => {
    const d = await duoActif('PARTAGE');
    await sql`UPDATE accounts SET max_members = 3 WHERE id = ${d.acc.id}`;
    // Gabarit ACCOUNT_INVITATION : posé en exploitation par l'amorçage (cron/seed).
    await (await import('@/db/seeds/account_membership_email_templates')).seedAccountMembershipEmailTemplates();
    const { POST } = await import('@/app/api/accounts/[accountId]/members/invite/route');
    const inviter = (email: string, tok = d.tok) =>
      POST(req(`/api/accounts/${d.acc.id}/members/invite`, { body: { email }, cookie: ck(tok) }), params({ accountId: d.acc.id }));
    // Personne déjà inscrite : invitation enregistrée, mais ni e-mail ni
    // notification vers une page inexistante.
    const deja = await make.account({ plan: 'standard' });
    const avant = etat.calls.length;
    const r = await inviter(deja.owner.email);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ success: true, notified: false, notice: 'EXISTING_USER_ACCEPTANCE_UNAVAILABLE' });
    expect(await sql`SELECT status FROM account_memberships WHERE account_id = ${d.acc.id} AND user_id = ${deja.owner.id}`).toEqual([{ status: 'pending' }]);
    await (await import('@/lib/auth/anti-enumeration')).settleDetachedAuthTasks();
    expect(etat.calls.slice(avant).filter((c) => c.to === deja.owner.email)).toEqual([]);
    expect(await sql`SELECT 1 FROM notification_outbox WHERE event_type = 'ACCOUNT_INVITATION' AND recipient_user_id = ${deja.owner.id}`).toHaveLength(0);
    // Personne non inscrite : le lien d'inscription (qui fonctionne) est conservé.
    const nouveau = `${uid('nouveau')}@proton.me`;
    const r2 = await inviter(nouveau);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ success: true, notified: true });
    const mail = etat.calls.filter((c) => c.to === nouveau).at(-1);
    expect(mail?.html ?? '').toMatch(/\/signup\?inviteToken=/);
    // Aucun e-mail, jamais, vers /mon-compte/partage.
    expect(etat.calls.filter((c) => c.html.includes('/mon-compte/partage'))).toEqual([]);
    // Réservée au titulaire (faille 72D toujours fermée).
    const intrus = await make.account({ plan: 'standard' });
    expect((await inviter(`${uid('x')}@proton.me`, await jeton(intrus.owner, intrus.id))).status).toBe(403);
    // Liens de la cloche, du push et des e-mails de notification : page réelle ou Mon compte.
    const { NOTIFICATION_CATALOG } = await import('@/lib/notifications/catalog');
    const liens = Object.values(NOTIFICATION_CATALOG).map((e) => e!.deepLink({ inviteToken: 'tok123', assetId: 1 } as never));
    expect(liens.filter((l) => String(l).includes('/mon-compte/partage'))).toEqual([]);
    expect(NOTIFICATION_CATALOG.DUO_INVITATION_RECEIVED!.deepLink({ inviteToken: 'tok123' } as never)).toBe('/duo/join/tok123');
    expect(NOTIFICATION_CATALOG.ACCOUNT_INVITATION!.deepLink({ inviteToken: 'tok123' } as never)).toBe('/mon-compte');
  });

  // ── L74B-11 / L74B-12 (point 6) ────────────────────────────────────────
  async function admin() {
    const a = await make.user({ email: `${uid('adm74b')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${a.id}`;
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({ id: a.id, email: a.email, role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
  }
  async function ficheBo(tok: string, userId: number) {
    const { GET } = await import('@/app/api/admin/users/[id]/route');
    const r = await GET(req(`/api/admin/users/${userId}`, { cookie: ck(tok) }), params({ id: userId }));
    expect(r.status).toBe(200);
    return await r.json() as Record<string, any>;
  }

  it('L74B-11 — BO fiche utilisateur : Duo (Titulaire / Membre, statut) lu dans account_memberships', async () => {
    const tok = await admin();
    const d = await duoActif('BOFICHE');
    const m = await membreDesDeux(d, 'bofiche');
    const fm = await ficheBo(tok, m.user.id);
    expect(fm.duoMemberships).toEqual([expect.objectContaining({
      accountId: d.acc.id, role: 'member', roleLabel: 'Membre', status: 'active', statusLabel: 'Actif', duoStatus: 'ACTIVE',
    })]);
    expect(fm.legacyDuoAnomaly).toBe(false);
    // Espace personnel : titulaire (et non « second utilisateur » parce qu'il est membre d'un Duo ailleurs).
    expect(fm.memberships.find((x: { accountId: number }) => x.accountId === m.perso).role).toBe('holder');
    expect(fm.memberships.find((x: { accountId: number }) => x.accountId === d.acc.id).role).toBe('second');
    const ft = await ficheBo(tok, d.owner.id);
    expect(ft.duoMemberships).toEqual([expect.objectContaining({ accountId: d.acc.id, roleLabel: 'Titulaire', statusLabel: 'Actif' })]);
    // Départ (route réelle) : statut « Parti ».
    const { POST: quitter } = await import('@/app/api/duo/leave/route');
    expect((await quitter(req('/api/duo/leave', { body: {}, cookie: ck(m.surDuo) }))).status).toBe(200);
    expect((await ficheBo(tok, m.user.id)).duoMemberships).toEqual([expect.objectContaining({ accountId: d.acc.id, roleLabel: 'Membre', status: 'left', statusLabel: 'Parti' })]);
    // Source unique : un ancien membre Duo SANS adhésion (avant rattrapage 72D) n'est
    // pas présenté comme membre — il est signalé à rattacher.
    const ancien = await make.account({ plan: 'standard' });
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot) VALUES (${d.duoId}, ${ancien.owner.id}, 'ACTIVE', 1)`;
    const fa = await ficheBo(tok, ancien.owner.id);
    expect(fa.duoMemberships).toEqual([]);
    expect(fa.legacyDuoAnomaly).toBe(true);
  });

  it('L74B-12 — BO liste des comptes : composition du Duo (Titulaire / Membre, statut) depuis account_memberships', async () => {
    const tok = await admin();
    const d = await duoActif('BOLISTE');
    const m = await membreDesDeux(d, 'boliste');
    const { GET } = await import('@/app/api/admin/accounts/route');
    const r = await GET(req(`/api/admin/accounts?q=${encodeURIComponent('Duo BOLISTE')}`, { cookie: ck(tok) }));
    expect(r.status).toBe(200);
    const body = await r.json() as { accounts: Array<{ id: number; duo: any }> };
    const duo = body.accounts.find((a) => a.id === d.acc.id)!;
    expect(duo.duo).toEqual({
      status: 'ACTIVE',
      members: [
        { role: 'owner', roleLabel: 'Titulaire', email: d.owner.email, status: 'active', statusLabel: 'Actif' },
        { role: 'member', roleLabel: 'Membre', email: m.email, status: 'active', statusLabel: 'Actif' },
      ],
    });
    const r2 = await GET(req(`/api/admin/accounts?q=${encodeURIComponent(m.email)}`, { cookie: ck(tok) }));
    const perso = (await r2.json() as { accounts: Array<{ id: number; duo: unknown }> }).accounts.find((a) => a.id === m.perso)!;
    expect(perso.duo).toBeNull();
    // Fiche compte : Duo de CE compte, membres lus dans account_memberships.
    const { GET: fiche } = await import('@/app/api/admin/accounts/[id]/route');
    const f = await (await fiche(req(`/api/admin/accounts/${d.acc.id}`, { cookie: ck(tok) }), params({ id: d.acc.id }))).json() as Record<string, any>;
    expect(f.duoAccount.id).toBe(d.duoId);
    expect(f.duoAccount.members.map((x: { roleLabel: string; email: string }) => [x.roleLabel, x.email]))
      .toEqual(expect.arrayContaining([['Titulaire', d.owner.email], ['Membre', m.email]]));
    const fp = await (await fiche(req(`/api/admin/accounts/${m.perso}`, { cookie: ck(tok) }), params({ id: m.perso }))).json() as Record<string, any>;
    expect(fp.duoAccount).toBeNull();
  });

  // ── L74B-09 ────────────────────────────────────────────────────────────
  it('L74B-09 — migration 0536 rejouable sans effet', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { runMigrationSql } = await import('@/db/migration-index');
    const texte = await readFile(join(process.cwd(), 'src/db/migrations', '0536_l74b_asset_space_moves.sql'), 'utf-8');
    for (const passe of [1, 2]) {
      const cnx = await sql.reserve();
      try {
        await expect(runMigrationSql({ unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> }, texte), `passe ${passe}`).resolves.toMatchObject({ status: 'applied' });
      } finally { cnx.release(); }
    }
  });
});
