/**
 * Lot 54 (54B) — ticket SEC-P0-CORR « Finaliser la sécurisation et
 * l'isolation stricte des comptes », sur PostgreSQL réel (migrations
 * appliquées), avec de VRAIS jetons de session (aucun SessionService simulé) :
 *
 *   SEC-01  utilisateur retiré / parti (compte partagé, parcours réels
 *           d'invitation, d'adhésion, de retrait, de départ) : ancien jeton
 *           refusé ; renouvellement → ses autres espaces ; Premium Duo
 *           (invitation, adhésion, retrait, départ par les routes réelles) :
 *           deux utilisateurs autorisés, révocation effective ; utilisateur à
 *           plusieurs accès : isolation par compte actif ;
 *   SEC-02  SQL direct : aucune relation intercomptes créable (références
 *           directes, Sinistres, photos, changement de propriétaire,
 *           rattachement d'équipement) ; relation historique jamais
 *           bloquante ; migrations 0373/0374 rejouables ;
 *   SEC-03  écriture et changement de propriétaire concurrents : intégrité ;
 *   SEC-04  sinistre A citant contrat / document / photo / facture /
 *           échange de B : aucune exposition (service, route, export) ;
 *   SEC-05  jobs IA à cibles étrangères ou références imbriquées : refusés à
 *           la mise en file et à l'exécution, rejoués compris ;
 *   SEC-06  anomalies injectées détectées (nouvelles catégories) ;
 *   SEC-07  contrôle partiellement échoué : jamais conforme ; historique ;
 *   SEC-09  correction Opérations : simulation, application, recontrôle,
 *           restauration ; rattrapage « Biens déplacés » sans preuve : rien
 *           transféré.
 */
import { beforeAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import type { Factories } from '../factories';

type Sql = Parameters<Parameters<typeof scenario>[2]>[0]['sql'];

const ORIGIN = 'http://localhost:3000';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jeton(user: { id: number; email: string }, accountId: number | null, planType = 'PREMIUM') {
  const { generateAccessToken } = await import('@/lib/jwt');
  return generateAccessToken({
    id: user.id, email: user.email, role: 'USER' as never, planType: planType as never, status: 'ACTIVE' as never,
    ...(accountId ? { currentAccountId: accountId } : {}), hasActiveAccount: true,
  });
}
const req = (token: string, path: string, init: { method?: string; body?: unknown } = {}) => new NextRequest(`${ORIGIN}${path}`, {
  method: init.method ?? 'GET',
  headers: { cookie: `access_token=${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});

async function rejouer(sql: Sql, fichier: string) {
  const texte = await readFile(join(process.cwd(), 'src/db/migrations', fichier), 'utf-8');
  const cnx = await sql.reserve();
  try {
    const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
    await runMigrationSql(runner, texte);
  } finally {
    cnx.release();
  }
}

/** Relation « historique » : gardes contournées (rôle de réplication), comme avant le lot 54. */
async function historique(sql: Sql, ecrire: (tx: Sql) => Promise<unknown>) {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await ecrire(tx as unknown as Sql);
  });
}

async function compte(sql: Sql, make: Factories, m: string) {
  const acc = await make.account({ plan: 'premium' });
  const [owner] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${acc.ownerUserId}`;
  const bien = await make.asset(acc, { category: 'IMMOBILIER', name: `${m}-maison-${acc.id}` });
  const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${bien.id}, ${`${m}-chaudiere`}) RETURNING id`;
  const [piece] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${bien.id}, ${`${m}-salon`}) RETURNING id`;
  const f = await make.assetFile(acc, { assetId: bien.id, name: `${m}-facture.pdf` });
  await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', upload_status = 'COMPLETED', document_type = 'FACTURE',
              original_filename = ${`${m}-facture.pdf`}, retained_title = ${`${m} facture`} WHERE id = ${f.id}`;
  const photoFile = await make.assetFile(acc, { assetId: bien.id, name: `${m}-photo.jpg`, mimeType: 'image/jpeg' });
  const [photo] = await sql<{ id: number }[]>`
    INSERT INTO asset_photos (asset_id, user_id, file_id, caption) VALUES (${bien.id}, ${acc.ownerUserId}, ${photoFile.id}, ${`${m}-photo`}) RETURNING id`;
  const [evt] = await sql<{ id: number }[]>`
    INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
    VALUES (${acc.id}, ${acc.ownerUserId}, ${bien.id}, 'entretien', ${`${m}-entretien`}, now()) RETURNING id`;
  return { acc, user: { id: acc.ownerUserId, email: owner.email }, bien, equip: equip.id, piece: piece.id, fichier: f.id, photo: photo.id, photoFile: photoFile.id, evt: evt.id };
}

scenario('L54B-SEC', 'SEC-P0-CORR — isolation stricte des comptes', ({ sql, make }) => {
  let A: Awaited<ReturnType<typeof compte>>;
  let B: Awaited<ReturnType<typeof compte>>;

  beforeAll(async () => {
    // Les scénarios précédents rejouent 0332/0345 : on remet la garde du lot 54.
    await rejouer(sql, '0373_account_isolation_guard.sql');
    A = await compte(sql, make, 'ALPHA');
    B = await compte(sql, make, 'BRAVO');
  });

  // ── SEC-02 ──────────────────────────────────────────────────────────────
  it('SEC-02-01 — migrations 0373 / 0374 rejouables sans effet ; gardes présentes ; 8 gardes 0332 inchangées', async () => {
    for (const f of ['0373_account_isolation_guard.sql', '0374_account_isolation_checks.sql']) {
      for (const passe of [1, 2]) await expect(rejouer(sql, f), `${f} passe ${passe}`).resolves.toBeUndefined();
    }
    expect(await sql`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%_cross_account_guard'`).toHaveLength(8);
    const gardes = (await sql<{ tgname: string }[]>`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%isolation%guard' ORDER BY 1`).map((r) => r.tgname);
    expect(gardes.length).toBeGreaterThanOrEqual(25);
    expect(await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'account_isolation_checks'`).toHaveLength(1);
  });

  it('SEC-02-02 — SQL direct : aucune relation intercomptes créable, quelle que soit la table', async () => {
    const refus = /CROSS_ACCOUNT_LINK/;
    await expect(sql`UPDATE asset_files SET asset_id = ${B.bien.id} WHERE id = ${A.fichier}`).rejects.toThrow(refus);
    await expect(sql`UPDATE asset_files SET equipment_id = ${B.equip} WHERE id = ${A.fichier}`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO events (account_id, user_id, asset_id, categorie, titre) VALUES (${A.acc.id}, ${A.user.id}, ${B.bien.id}, 'autre', 'x')`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO deadlines (account_id, user_id, label, deadline_date, equipment_id) VALUES (${A.acc.id}, ${A.user.id}, 'x', '2030-01-01', ${B.equip})`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${A.acc.id}, ${A.fichier}, ${B.bien.id}, 'SECONDARY', 'USER', 'ACTIVE')`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, evidence_excerpt, confidence, fingerprint)
                     VALUES (${A.acc.id}, ${A.bien.id}, 'surface', '1'::jsonb, 'document', ${B.fichier}, 'x', 'certain', ${`fp-l54-${A.acc.id}`})`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO ai_field_updates (account_id, asset_id, field_key, new_value) VALUES (${A.acc.id}, ${B.bien.id}, 'mileage', '1')`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
                     VALUES (${A.acc.id}, 'DOCUMENT', ${B.fichier}, 'documentDate', 'COMPLETE', 'L54', 'q')`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO asset_photos (asset_id, user_id, file_id) VALUES (${A.bien.id}, ${A.user.id}, ${B.photoFile})`).rejects.toThrow(refus);
    const g = await make.agendaItem(A.acc, { assetIds: [A.bien.id] });
    await expect(sql`UPDATE agenda_items SET origin_ref_type = 'asset_file', origin_ref_id = ${B.fichier} WHERE id = ${g.id}`).rejects.toThrow(refus);
    await expect(sql`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type) VALUES (${g.id}, ${B.fichier}, 'linked')`).rejects.toThrow(refus);
    await expect(sql`UPDATE equipments SET asset_id = ${B.bien.id} WHERE id = ${A.equip}`).rejects.toThrow(refus);
    // Changement de propriétaire qui laisse ses données derrière lui : refusé.
    await expect(sql`UPDATE assets SET account_id = ${B.acc.id} WHERE id = ${A.bien.id}`).rejects.toThrow(refus);
    // Atomicité : transaction entière annulée, aucune écriture partielle.
    await expect(sql.begin(async (tx) => {
      await tx`UPDATE events SET titre = 'ALPHA-modifie' WHERE id = ${A.evt}`;
      await tx`UPDATE events SET equipment_id = ${B.equip} WHERE id = ${A.evt}`;
    })).rejects.toThrow(refus);
    expect((await sql<{ titre: string }[]>`SELECT titre FROM events WHERE id = ${A.evt}`)[0].titre).toBe('ALPHA-entretien');
    // Les écritures légitimes passent.
    await sql`UPDATE asset_files SET equipment_id = ${A.equip} WHERE id = ${A.fichier}`;
    await sql`INSERT INTO events (account_id, user_id, asset_id, equipment_id, categorie, titre) VALUES (${A.acc.id}, ${A.user.id}, ${A.bien.id}, ${A.equip}, 'autre', 'ALPHA-ok')`;
  });

  it('SEC-02-03 — relation historique incorrecte : jamais bloquante pour une autre écriture ; correction (détachement) admise', async () => {
    const f = await make.assetFile(A.acc, { assetId: null, name: 'ALPHA-histo.pdf' });
    await historique(sql, (tx) => tx`UPDATE asset_files SET asset_id = ${B.bien.id} WHERE id = ${f.id}`);
    await sql`UPDATE asset_files SET retained_title = 'renomme' WHERE id = ${f.id}`;
    await sql`UPDATE asset_files SET asset_id = NULL WHERE id = ${f.id}`;
    expect((await sql<{ asset_id: number | null }[]>`SELECT asset_id FROM asset_files WHERE id = ${f.id}`)[0].asset_id).toBeNull();
  });

  // ── SEC-03 ──────────────────────────────────────────────────────────────
  it('SEC-03-01 — écriture et changement de propriétaire concurrents : l’écriture attend, puis est refusée sans écriture', async () => {
    const nu = await make.asset(A.acc, { category: 'IMMOBILIER', name: 'ALPHA-concurrent' });
    const { POST } = await import('@/app/api/events/route');
    const tok = await jeton(A.user, A.acc.id);
    let liberer!: () => void;
    const portail = new Promise<void>((r) => { liberer = r; });
    const transfert = sql.begin(async (tx) => {
      await tx`UPDATE assets SET account_id = ${B.acc.id} WHERE id = ${nu.id}`;
      await portail;
    });
    await pause(150);
    const ecriture = POST(req(tok, '/api/events', { method: 'POST', body: { title: 'ALPHA-course', categorie: 'entretien', assetId: nu.id } }));
    await pause(400);
    liberer();
    await transfert;
    const r = await ecriture;
    expect(r.status).toBe(404);
    expect(await sql`SELECT id FROM events WHERE titre = 'ALPHA-course'`).toHaveLength(0);
  });

  it('SEC-03-02 — ordre inverse : événement validé d’abord, puis changement de propriétaire sans ses données → refusé', async () => {
    const nu = await make.asset(A.acc, { category: 'IMMOBILIER', name: 'ALPHA-concurrent-2' });
    const { POST } = await import('@/app/api/events/route');
    const r = await POST(req(await jeton(A.user, A.acc.id), '/api/events', { method: 'POST', body: { title: 'ALPHA-avant', categorie: 'entretien', assetId: nu.id } }));
    expect(r.status).toBe(201);
    await expect(sql`UPDATE assets SET account_id = ${B.acc.id} WHERE id = ${nu.id}`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    expect((await sql<{ account_id: number }[]>`SELECT account_id FROM assets WHERE id = ${nu.id}`)[0].account_id).toBe(A.acc.id);
  });

  it('SEC-03-03 — modification : équipement d’un autre compte refusé, rien écrit (route PUT retirée au lot 84A)', async () => {
    // Lot 84A (CDC v5 O-10, E25) : PUT /api/events n'avait plus d'appelant — retiré (plus de surface d'écriture).
    const route = await import('@/app/api/events/route') as Record<string, unknown>;
    expect(route.PUT).toBeUndefined();
    // La garde en base (0373) reste : un rattachement à l'équipement d'un autre compte est refusé, rien n'est écrit.
    await expect(sql`UPDATE events SET equipment_id = ${B.equip} WHERE id = ${A.evt}`).rejects.toThrow(/CROSS_ACCOUNT/);
    expect((await sql<{ titre: string; equipment_id: number | null }[]>`SELECT titre, equipment_id FROM events WHERE id = ${A.evt}`)[0])
      .toEqual({ titre: 'ALPHA-entretien', equipment_id: null });
  });

  // ── SEC-01 ──────────────────────────────────────────────────────────────
  it('SEC-01-01 — membre retiré d’un compte partagé (invitation, adhésion, retrait réels) : ancien jeton refusé, autres espaces conservés', async () => {
    await sql`UPDATE accounts SET plan_type = 'PREMIUM_DUO', max_members = 2 WHERE id = ${A.acc.id}`;
    const membre = await compte(sql, make, 'MEMBRE');
    const { AccountService } = await import('@/services/account-service');
    const inv = await AccountService.inviteMember(A.acc.id, membre.user.email, A.user.id);
    expect(inv.success, inv.error).toBe(true);
    expect((await AccountService.acceptInvite(inv.inviteToken!, membre.user.id)).success).toBe(true);
    const { GET } = await import('@/app/api/events/route');
    const ancien = await jeton(membre.user, A.acc.id);
    const avant = await GET(req(ancien, '/api/events'));
    expect(avant.status).toBe(200);
    expect(await avant.text()).toContain('ALPHA-entretien');
    // Retrait par le titulaire (route réelle).
    const [m] = await sql<{ id: number }[]>`SELECT id FROM account_memberships WHERE account_id = ${A.acc.id} AND user_id = ${membre.user.id}`;
    const { DELETE } = await import('@/app/api/accounts/[accountId]/members/[membershipId]/route');
    const del = await DELETE(req(await jeton(A.user, A.acc.id), `/api/accounts/${A.acc.id}/members/${m.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: String(A.acc.id), membershipId: String(m.id) }) });
    expect(del.status).toBe(200);
    // Même jeton, encore valide : refusé tout de suite.
    const apres = await GET(req(ancien, '/api/events'));
    expect(apres.status).toBe(401);
    expect(await apres.text()).not.toContain('ALPHA-entretien');
    // Son propre espace reste accessible.
    const sien = await GET(req(await jeton(membre.user, membre.acc.id), '/api/events'));
    expect(sien.status).toBe(200);
    expect(await sien.text()).toContain('MEMBRE-entretien');
    // Le renouvellement choisit un compte encore actif (le sien).
    const { resolveSessionAccount } = await import('@/lib/auth/account-suspension');
    const r = resolveSessionAccount(await AccountService.getUserSessionAccounts(membre.user.id), { role: 'USER', preferredAccountId: A.acc.id });
    expect(r.allowed && r.account?.id).toBe(membre.acc.id);
  });

  it('SEC-01-02 — départ volontaire (leaveAccount) : révocation immédiate ; utilisateur à plusieurs accès isolé par compte actif', async () => {
    const membre = await compte(sql, make, 'PARTANT');
    const { AccountService } = await import('@/services/account-service');
    await sql`UPDATE account_memberships SET status = 'removed' WHERE account_id = ${A.acc.id} AND role <> 'owner'`;
    const inv = await AccountService.inviteMember(A.acc.id, membre.user.email, A.user.id);
    expect(inv.success, inv.error).toBe(true);
    await AccountService.acceptInvite(inv.inviteToken!, membre.user.id);
    const { GET } = await import('@/app/api/events/route');
    // Deux accès : chaque jeton ne voit que SON compte actif.
    const surA = await (await GET(req(await jeton(membre.user, A.acc.id), '/api/events'))).text();
    const surSien = await (await GET(req(await jeton(membre.user, membre.acc.id), '/api/events'))).text();
    expect(surA).toContain('ALPHA-entretien');
    expect(surA).not.toContain('PARTANT-entretien');
    expect(surSien).toContain('PARTANT-entretien');
    expect(surSien).not.toContain('ALPHA-entretien');
    const ancien = await jeton(membre.user, A.acc.id);
    expect((await AccountService.leaveAccount(A.acc.id, membre.user.id)).success).toBe(true);
    expect((await GET(req(ancien, '/api/events'))).status).toBe(401);
    // Compte étranger jamais rejoint : jeton refusé (jamais d'accès par le seul identifiant).
    expect((await GET(req(await jeton(membre.user, B.acc.id), '/api/events'))).status).toBe(401);
  });

  it('SEC-01-03 — Premium Duo (invitation, adhésion, retrait, départ par les routes réelles) : compte PARTAGÉ, révocation effective (lot 72D)', async () => {
    // Lot 72D (ticket P0 « compte partagé ») : ce scénario figeait l'ancien
    // modèle à deux comptes séparés (« le membre ne voit pas les données du
    // titulaire »). Le membre rejoint désormais le compte EXISTANT du
    // titulaire : il voit ses données ; un compte étranger reste refusé ; le
    // retrait et le départ coupent l'accès dès la requête suivante.
    const titulaire = await compte(sql, make, 'DUOT');
    const second = await compte(sql, make, 'DUOM');
    const { applyPlanChange } = await import('@/lib/plan-enforcement');
    await applyPlanChange({
      accountId: titulaire.acc.id, ownerUserId: titulaire.user.id, oldPlanType: 'PREMIUM', newPlanType: 'PREMIUM_DUO',
      newSubStatus: 'ACTIVE', newPremiumUntil: null, newMaxMembers: 2, source: 'e2e:l54b', sendEmails: false,
    });
    const [{ duo_account_id: duoId }] = await sql<{ duo_account_id: number }[]>`SELECT duo_account_id FROM accounts WHERE id = ${titulaire.acc.id}`;
    const tokT = await jeton(titulaire.user, titulaire.acc.id, 'PREMIUM_DUO');
    const tokM = await jeton(second.user, second.acc.id);
    const { GET } = await import('@/app/api/events/route');

    const cycle = async () => {
      const { POST: inviter } = await import('@/app/api/duo/invitation/route');
      expect((await inviter(req(tokT, '/api/duo/invitation', { method: 'POST', body: { email: second.user.email } }))).status).toBe(200);
      const [d] = await sql<{ t: string }[]>`SELECT pending_invite_token AS t FROM duo_accounts WHERE id = ${duoId}`;
      // Invitation en attente : aucun accès au compte du titulaire.
      expect((await GET(req(await jeton(second.user, titulaire.acc.id), '/api/events'))).status).toBe(401);
      const { POST: rejoindre } = await import('@/app/api/duo/join/route');
      const j = await rejoindre(req(tokM, '/api/duo/join', { method: 'POST', body: { token: d.t } }));
      expect(j.status, await j.clone().text()).toBe(200);
      return (j as Response & { cookies: { get(n: string): { value: string } | undefined } }).cookies.get('access_token')!.value;
    };
    const surDuo = await cycle();
    // Même compte : le membre voit les données du titulaire ; les siennes restent dans SON espace.
    const vu = await (await GET(req(surDuo, '/api/events'))).text();
    expect(vu).toContain('DUOT-entretien');
    expect(vu).not.toContain('DUOM-entretien');
    const sien = await (await GET(req(tokM, '/api/events'))).text();
    expect(sien).toContain('DUOM-entretien');
    expect(sien).not.toContain('DUOT-entretien');
    // Compte étranger (jamais rejoint) : refusé.
    expect((await GET(req(await jeton(second.user, B.acc.id), '/api/events'))).status).toBe(401);
    // Retrait par le titulaire : ancien jeton refusé tout de suite.
    const { DELETE } = await import('@/app/api/duo/member/route');
    expect((await DELETE(req(tokT, '/api/duo/member', { method: 'DELETE' }))).status).toBeLessThan(300);
    expect((await GET(req(surDuo, '/api/events'))).status).toBe(401);
    // Nouvelle adhésion puis départ volontaire.
    const surDuo2 = await cycle();
    expect((await GET(req(surDuo2, '/api/events'))).status).toBe(200);
    const { POST: partir } = await import('@/app/api/duo/leave/route');
    expect((await partir(req(surDuo2, '/api/duo/leave', { method: 'POST', body: {} }))).status).toBeLessThan(300);
    expect((await GET(req(surDuo2, '/api/events'))).status).toBe(401);
    // Données du compte partagé intactes.
    expect(await (await GET(req(tokT, '/api/events'))).text()).toContain('DUOT-entretien');
  });

  // ── SEC-04 ──────────────────────────────────────────────────────────────
  let claimA = 0;
  let damageA = 0;
  it('SEC-04-01 — sinistre A citant contrat, événement, facture, échange, pièce et photo de B : aucune exposition', async () => {
    // Lot 83D (V-Q1) : plus de route de saisie — sinistre de A tel qu'existant en préproduction (source CLAIM_FORM).
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    claimA = await withBusinessOperationWrite(A.acc.id, async (r) => {
      const c = await r.create({
        type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: '2026-03-12',
        source: { kind: 'CLAIM_FORM', entityKey: A.bien.id, authority: 'USER', confidence: 'certain' },
        assets: [{ assetId: A.bien.id, role: 'PRIMARY', authority: 'USER' }], reasonCode: 'E2E',
      } as never);
      await r.upsertClaimDetails(c.id, { claimType: 'DEGAT_DES_EAUX' } as never);
      return c.id;
    });
    const contratB = (await withBusinessOperationWrite(B.acc.id, (r) => r.create({
      type: { code: 'CONTRACT' }, status: 'REALIZED', provider: 'BRAVO-ASSUREUR',
      source: { kind: 'DOCUMENT', entityKey: B.fichier, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' }, reasonCode: 'E2E',
    } as never))).id;
    await sql`UPDATE business_operations SET provider = 'BRAVO-ASSUREUR' WHERE id = ${contratB}`;
    // L'écriture ordinaire est refusée (garde en base).
    await expect(sql`INSERT INTO business_operation_claim_details (operation_id, insurance_contract_operation_id) VALUES (${claimA}, ${contratB})
                     ON CONFLICT (operation_id) DO UPDATE SET insurance_contract_operation_id = EXCLUDED.insurance_contract_operation_id`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    const [dmg] = await sql<{ id: number }[]>`INSERT INTO business_operation_claim_damages (operation_id, zone) VALUES (${claimA}, 'ALPHA-cuisine') RETURNING id`;
    damageA = dmg.id;
    await expect(sql`INSERT INTO business_operation_claim_damage_photos (damage_id, photo_id) VALUES (${damageA}, ${B.photo})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    // Relations incorrectes injectées « historiquement ».
    await historique(sql, async (tx) => {
      await tx`INSERT INTO business_operation_claim_details (operation_id, insurance_contract_operation_id, history_event_id) VALUES (${claimA}, ${contratB}, ${B.evt})
               ON CONFLICT (operation_id) DO UPDATE SET insurance_contract_operation_id = EXCLUDED.insurance_contract_operation_id, history_event_id = EXCLUDED.history_event_id`;
      await tx`INSERT INTO business_operation_claim_damage_documents (damage_id, file_id) VALUES (${damageA}, ${B.fichier})`;
      await tx`INSERT INTO business_operation_claim_damage_photos (damage_id, photo_id) VALUES (${damageA}, ${B.photo})`;
      // Lot 84A (O-10) : actions et échanges de l'ancien modèle Sinistres (tables supprimées par la finalisation BO) — plus contrôlés.
      await tx`INSERT INTO asset_photos (asset_id, user_id, file_id, caption) VALUES (${A.bien.id}, ${A.user.id}, ${B.photoFile}, 'ALPHA-photo-etrangere')`;
    });
    const { loadClaimRecords } = await import('@/services/business-operations/claims/read');
    const exec = { execute: async (q: import('drizzle-orm').SQL) => (await import('@/db')).db.execute(q) };
    const [rec] = await loadClaimRecords(exec as never, A.acc.id, { ids: [claimA] });
    expect(rec.contractLabel).toBeNull();
    expect(rec.details?.insuranceContractOperationId ?? null).toBeNull();
    expect(rec.details?.historyEventId ?? null).toBeNull();
    const ids = JSON.stringify({ damages: rec.damages, documentIds: rec.documentIds });
    for (const x of [B.fichier, B.photo]) expect(ids).not.toMatch(new RegExp(`\\b${x}\\b`));
    // Dossier d'assurance (lot 83D, V-Q8) : rien de B (libellé, identifiants).
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const dossier = await loadExportSource({ assetId: A.bien.id, accountId: A.acc.id, userId: A.user.id, exportType: 'ASSURANCE_SINISTRE', claimOperationId: claimA });
    expect(JSON.stringify(dossier.claimFile)).not.toContain('BRAVO');
    for (const x of [B.fichier, B.photo]) expect(JSON.stringify(dossier.claimFile?.damages ?? [])).not.toMatch(new RegExp(`\\b${x}\\b`));
    // Export : la photo de B rattachée au bien de A n'est jamais incluse.
    const { buildAssetSnapshot } = await import('@/services/export-snapshot.service');
    const snap = await buildAssetSnapshot(A.bien.id, A.user.id, { accountId: A.acc.id });
    expect(JSON.stringify(snap)).not.toContain(`"fileId":${B.photoFile}`);
  });

  // ── SEC-05 ──────────────────────────────────────────────────────────────
  it('SEC-05-01 — mise en file : référence étrangère imbriquée refusée sans écriture ; même demande sur ses données acceptée', async () => {
    const { enqueue } = await import('@/services/ai/queue/job-queue.repository');
    const n = async (marque: string) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE payload ->> 'marque' = ${marque}`)[0].n;
    const refus = await enqueue({
      treatment: 'T3', scope: { accountId: A.acc.id, targetType: 'business_operations', targetId: String(A.acc.id) }, triggerCode: 'manual', origin: 'manual',
      payload: { kind: 'business_operations', marque: 'l54b-refus', events: [{ trigger: 'document_analyzed', fileId: B.fichier }] },
    });
    expect(refus.jobId).toBeNull();
    expect(await n('l54b-refus')).toBe(0);
    const cible = await enqueue({
      treatment: 'T3', scope: { accountId: A.acc.id, targetType: 'business_operations', targetId: String(B.acc.id) }, triggerCode: 'manual', origin: 'manual',
      payload: { kind: 'business_operations', marque: 'l54b-cible', events: [] },
    });
    expect(cible.jobId).toBeNull();
    const ok = await enqueue({
      treatment: 'T3', scope: { accountId: A.acc.id, targetType: 'business_operations', targetId: String(A.acc.id) }, triggerCode: 'manual', origin: 'manual',
      payload: { kind: 'business_operations', marque: 'l54b-ok', events: [{ trigger: 'document_analyzed', fileId: A.fichier }] },
    });
    expect(ok.jobId).not.toBeNull();
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${ok.jobId}`;
  });

  it('SEC-05-02 — exécution : job historique / différé / rejoué à référence étrangère imbriquée → échec définitif, à chaque passage', async () => {
    const [j] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload, available_at)
      VALUES ('T3', ${A.acc.id}, 'business_operations_agenda', ${String(A.acc.id)}, ${`l54b-histo-${A.acc.id}`}, 'automatic', 'x',
              ${JSON.stringify({ kind: 'business_operations_agenda', events: [{ operationIds: [claimA] }, { nested: { assetId: B.bien.id } }] })}::jsonb, now() + interval '30 days')
      RETURNING id`;
    const { assertJobScope } = await import('@/services/ai/queue/job-scope');
    const { isPermanentJobError } = await import('@/services/ai/queue/queue-policy');
    const row = async () => (await sql<Array<{ id: number; account_id: number; target_type: string; target_id: string; payload: Record<string, unknown> }>>`
      SELECT id, account_id, target_type, target_id, payload FROM ai_job_queue WHERE id = ${j.id}`)[0];
    for (const passe of [1, 2]) {
      const r = await row();
      const e = await assertJobScope({ id: r.id, treatment: 'T3', accountId: r.account_id, targetType: r.target_type, targetId: r.target_id, payload: r.payload }).catch((x) => x);
      expect(isPermanentJobError(e), `passe ${passe}`).toBe(true);
      expect(String(e.message)).toContain(`asset ${B.bien.id}`);
      await sql`UPDATE ai_job_queue SET status = 'PENDING', attempts = 0 WHERE id = ${j.id}`;
    }
    // Détecté par le contrôle d'isolation (références imbriquées).
    const { detectCrossAccountRelations, CROSS_ACCOUNT_CHECKS } = await import('@/services/security/cross-account/detection');
    const d = await detectCrossAccountRelations(undefined, CROSS_ACCOUNT_CHECKS.filter((c) => c.code === 'AI_JOB_PENDING'));
    expect(d.checks[0].samples.map((s) => s.ref).join(' ')).toContain(`ai_job_queue#${j.id}`);
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${j.id}`;
  });

  // ── SEC-06 / SEC-07 ─────────────────────────────────────────────────────
  it('SEC-06-01 / SEC-07-01 — anomalies injectées détectées ; état « Anomalies détectées » ; historisé avec la date', async () => {
    const { runCrossAccountCheck, readIsolationHistory } = await import('@/services/security/cross-account/alerts');
    const r = await runCrossAccountCheck(undefined, 'manual');
    expect(r.status).toBe('ANOMALIES');
    for (const c of ['CLAIM_CONTRACT', 'CLAIM_HISTORY_EVENT', 'CLAIM_DAMAGE_DOCUMENT', 'CLAIM_DAMAGE_PHOTO', 'PHOTO_FILE']) {
      expect(r.counts[c], c).toBeGreaterThan(0);
    }
    for (const c of ['CLAIM_ACTION_REF', 'CLAIM_EXCHANGE_DOCUMENT']) expect(r.counts[c], c).toBeUndefined();
    const h = await readIsolationHistory();
    expect(h?.runs[0]).toMatchObject({ trigger: 'manual', status: 'ANOMALIES', checksFailed: 0 });
    expect(h?.lastComplete).not.toBeNull();
  });

  it('SEC-07-02 — contrôle partiellement échoué : jamais conforme, alerte « incomplet », aucune résolution', async () => {
    const { detectCrossAccountRelations, CROSS_ACCOUNT_CHECKS } = await import('@/services/security/cross-account/detection');
    const { runCrossAccountCheck, recordIsolationCheck, CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT } = await import('@/services/security/cross-account/alerts');
    const anomalies = await import('@/services/admin/anomaly.service');
    const casse = [...CROSS_ACCOUNT_CHECKS.filter((c) => c.code === 'DOC_ASSET'), { code: 'BROKEN', family: 'documents' as const, label: 'cassé', sql: 'SELECT * FROM table_inexistante_l54' }];
    const resolus: string[] = [];
    const r = await runCrossAccountCheck({
      detect: () => detectCrossAccountRelations(undefined, casse),
      openFingerprints: async () => ['other:cross-account:doc_asset', 'other:cross-account:broken'],
      report: anomalies.reportAnomaly, resolve: async (f) => { resolus.push(f); return true; }, record: recordIsolationCheck,
    }, 'manual');
    expect(r.status).toBe('INCOMPLET');
    expect(resolus).not.toContain('other:cross-account:broken');
    expect(await sql`SELECT 1 FROM admin_anomalies WHERE fingerprint = ${CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT} AND status = 'open'`).toHaveLength(1);
    const [last] = await sql<{ status: string }[]>`SELECT status FROM account_isolation_checks ORDER BY id DESC LIMIT 1`;
    expect(last.status).toBe('INCOMPLET');
  });

  // ── SEC-09 ──────────────────────────────────────────────────────────────
  it('SEC-09-01 — Opérations : simulation sans écriture, application journalisée, recontrôle, restauration', async () => {
    const { runCrossAccountRemediation, restoreCrossAccountRemediation } = await import('@/services/security/cross-account/remediation');
    const { pgClient } = await import('@/db');
    const etat = async () => (await sql<{ k: number | null; d: number; p: number }[]>`
      SELECT (SELECT insurance_contract_operation_id FROM business_operation_claim_details WHERE operation_id = ${claimA})::int AS k,
             (SELECT count(*)::int FROM business_operation_claim_damage_documents WHERE damage_id = ${damageA}) AS d,
             (SELECT count(*)::int FROM business_operation_claim_damage_photos WHERE damage_id = ${damageA}) AS p`)[0];
    const avant = await etat();
    expect(avant.d).toBe(1);
    const sim = await runCrossAccountRemediation(pgClient, { family: 'operations', apply: false, accountId: A.acc.id });
    expect(sim.corrected).toBeGreaterThanOrEqual(4);   // lot 84A : sans les actions / échanges de l'ancien modèle
    expect(await etat()).toEqual(avant);
    expect(sim.categories.find((c) => c.code === 'OP_CORE_LINK')).toBeDefined();
    const app = await runCrossAccountRemediation(pgClient, { family: 'operations', apply: true, accountId: A.acc.id, reason: 'E2E SEC-09' });
    expect(app.corrected).toBe(sim.corrected);
    expect(await etat()).toEqual({ k: null, d: 0, p: 0 });
    expect(app.postCheck?.incomplete).toEqual([]);
    for (const c of ['CLAIM_CONTRACT', 'CLAIM_DAMAGE_DOCUMENT', 'CLAIM_DAMAGE_PHOTO']) {
      expect(app.postCheck?.remaining[c], c).toBe(0);
    }
    // Objets conservés dans leur compte.
    expect((await sql<{ account_id: number }[]>`SELECT account_id FROM asset_files WHERE id = ${B.fichier}`)[0].account_id).toBe(B.acc.id);
    const resto = await restoreCrossAccountRemediation(pgClient, app.runId);
    expect(resto.conflicts).toEqual([]);
    expect(await etat()).toEqual(avant);
    // Laisser propre.
    await runCrossAccountRemediation(pgClient, { family: 'operations', apply: true, accountId: A.acc.id, reason: 'E2E SEC-09 fin' });
  });

  it('SEC-09-02 — « Biens déplacés » : un écart SANS preuve de déplacement n’est jamais transféré automatiquement', async () => {
    const f = await make.assetFile(B.acc, { assetId: null, name: 'BRAVO-egare.pdf' });
    await historique(sql, (tx) => tx`UPDATE asset_files SET asset_id = ${A.bien.id} WHERE id = ${f.id}`);
    const { findMisplacedAssetData, runAssetAccountBackfill } = await import('@/services/assets/asset-account-backfill');
    const mien = (l: Array<{ assetId: number; fromAccountId: number }>) => l.filter((c) => c.assetId === A.bien.id && c.fromAccountId === B.acc.id);
    expect(mien(await findMisplacedAssetData(500))).toEqual([]);
    expect(mien(await findMisplacedAssetData(500, { proven: false }))).toHaveLength(1);
    const r = await runAssetAccountBackfill({ apply: true, batchSize: 500 });
    expect(r.unproven).toBeGreaterThan(0);
    expect((await sql<{ account_id: number }[]>`SELECT account_id FROM asset_files WHERE id = ${f.id}`)[0].account_id).toBe(B.acc.id);
  });

  it('SEC-04-02 — T2 / mascotte / agenda / exports : le balayage du lot 53B reste vert (l53b-d23) ; documents B introuvables depuis A', async () => {
    const { decideFileAccess } = await import('@/services/documents/file-access');
    const row = { id: B.fichier, accountId: B.acc.id, s3Bucket: 'e2e-bucket', s3Key: 'k', mimeType: null, size: null, originalFilename: null, isWebLink: false, uploadStatus: 'COMPLETED' };
    expect(decideFileAccess(row as never, A.acc.id)).toMatchObject({ ok: false, status: 404 });
  });
});

