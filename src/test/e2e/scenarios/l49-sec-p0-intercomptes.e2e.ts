/**
 * Lot 49 — SEC-P0 : isolation intercomptes, matrice A/B du ticket (§6) sur
 * PostgreSQL réel (migrations du lot appliquées par le harnais, dont 0332).
 *
 * Deux comptes A et B, chacun avec biens, pièces, équipements, documents,
 * fournisseurs et événements. Chaque ligne de la matrice du ticket est un
 * test nommé avec ses critères d'acceptation (AC01 à AC09) :
 *
 *   A consulte un événement B / ses documents        → refusé (404)
 *   A associe un document A à un événement B         → refusé, rien d'écrit
 *   A supprime une relation de B                     → refusé, relation intacte
 *   A lit les fournisseurs d'un équipement B         → aucune donnée B
 *   A rattache un fournisseur A à un équipement B    → refusé
 *   A modifie un document A avec un bien B           → refus intégral
 *   A crée une échéance sur un équipement B          → refusée (même validate: false)
 *   relation A/B incorrecte volontaire en base       → aucune donnée B affichée
 *                                                      (routes, Agenda, T2, T6),
 *                                                      détectée par le contrôle
 *                                                      d'exploitation (lecture seule)
 *   T1 sur un document A lié à tort à un bien B      → aucune projection vers B
 *   T3 rapproche A et B                              → aucune liaison
 *   T4 exécute un ancien job à cible étrangère       → aucune écriture
 *   même utilisateur sur A et B                      → isolation par compte actif
 *   Premium Duo, fonctions autorisées                → inchangées
 *   opérations concurrentes / jobs rejoués           → aucune relation intercomptes
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import type { AccountRow, Factories } from '../factories';

const session = { userId: 0, currentAccountId: 0 as number | null };
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Sql = Parameters<Parameters<typeof scenario>[2]>[0]['sql'];

const req = (url: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://localhost${url}`, {
  method: init?.method ?? 'GET',
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
});
const ctx = <K extends string>(k: K, v: number) => ({ params: Promise.resolve({ [k]: String(v) } as Record<K, string>) });
const as = (acc: AccountRow, userId = acc.ownerUserId) => { session.userId = userId; session.currentAccountId = acc.id; };

/** Un compte complet : biens, pièce, équipements, documents, fournisseur, événement. */
async function compte(sql: Sql, make: Factories, nom: string, owner?: Awaited<ReturnType<Factories['user']>>) {
  const acc = await make.account({ plan: 'premium', ...(owner ? { owner } : {}) });
  await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
  const bien = await make.asset(acc, { category: 'IMMOBILIER', name: `${nom}-maison-${acc.id}` });
  const bien2 = await make.asset(acc, { category: 'IMMOBILIER', name: `${nom}-garage-${acc.id}` });
  const [piece] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${bien.id}, ${`${nom}-salon`}) RETURNING id`;
  const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${bien.id}, ${`${nom}-chaudiere`}) RETURNING id`;
  const [equip2] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${bien2.id}, ${`${nom}-portail`}) RETURNING id`;
  const fichier = await make.assetFile(acc, { assetId: bien.id, name: `${nom}-${acc.id}-facture.pdf` });
  await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', document_type = 'FACTURE', original_filename = ${`${nom}-facture.pdf`} WHERE id = ${fichier.id}`;
  const [fourn] = await sql<{ id: number }[]>`
    INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, phone)
    VALUES (${acc.id}, ${acc.ownerUserId}, ${`${nom}-FOURNISSEUR`}, ${`${nom.toLowerCase()} fournisseur ${acc.id}`}, '0102030405') RETURNING id`;
  const [evt] = await sql<{ id: number }[]>`
    INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
    VALUES (${acc.id}, ${acc.ownerUserId}, ${bien.id}, 'entretien', ${`${nom}-entretien`}, now()) RETURNING id`;
  return { acc, bien, bien2, piece: piece.id, equip: equip.id, equip2: equip2.id, fichier: fichier.id, fourn: fourn.id, evt: evt.id };
}

/** Écriture d'une relation incorrecte « historique » : déclencheurs 0332 contournés (rôle de réplication). */
async function relationHistorique(sql: Sql, ecrire: (tx: Sql) => Promise<unknown>) {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await ecrire(tx as unknown as Sql);
  });
}

scenario('L49-SEC', 'SEC-P0 — isolation intercomptes (matrice A/B)', ({ sql, make }) => {
  let A: Awaited<ReturnType<typeof compte>>;
  let B: Awaited<ReturnType<typeof compte>>;
  const ecartes: number[] = [];

  beforeAll(async () => {
    A = await compte(sql, make, 'A');
    B = await compte(sql, make, 'SECRETB');
    // Relation légitime de B (équipement ↔ fournisseur, événement ↔ document).
    await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id, source_type) VALUES (${B.equip}, ${B.fourn}, 'manual')`;
    await sql`INSERT INTO event_documents (event_id, file_id) VALUES (${B.evt}, ${B.fichier})`;
  });
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes}) AND status = 'PENDING'`;
  });

  // ── Lectures (AC01) ────────────────────────────────────────────────────────

  it('AC01 — A tente de consulter un événement B : accès refusé (toutes les routes events)', async () => {
    // Lot 84A (CDC v5 O-10, E25) : routes sans appelant RETIRÉES (plus de surface à protéger).
    for (const f of ['[eventId]/route.ts', '[eventId]/suggestions/route.ts', 'prochaines-echeances/route.ts', 'agenda/route.ts']) {
      expect(existsSync(join(process.cwd(), 'src/app/api/events', f)), f).toBe(false);
    }
    as(A.acc);
    const list = await import('@/app/api/events/route');
    expect((await list.GET(req(`/api/events?id=${B.evt}`))).status).toBe(404);
    const liste = await (await list.GET(req(`/api/events?assetId=${B.bien.id}`))).json();
    expect(JSON.stringify(liste)).not.toContain('SECRETB');
    // B voit son événement.
    as(B.acc);
    expect((await list.GET(req(`/api/events?id=${B.evt}`))).status).toBe(200);
  });

  it('AC01 — A tente de consulter les documents d’un événement B : accès refusé', async () => {
    as(A.acc);
    const r = await import('@/app/api/events/[eventId]/documents/route');
    // Lot 84A (O-10, E25) : lecture retirée (aucun appelant) — seul le rattachement (POST) reste.
    expect((r as Record<string, unknown>).GET).toBeUndefined();
    const d = await import('@/app/api/documents/[id]/events/route');
    expect((await d.GET(req(`/api/documents/${B.fichier}/events`), ctx('id', B.fichier))).status).toBe(404);
  });

  it('AC01 — A tente de consulter les fournisseurs d’un équipement B : aucune donnée B', async () => {
    as(A.acc);
    const r = await import('@/app/api/equipments/[id]/suppliers/route');
    const res = await r.GET(req(`/api/equipments/${B.equip}/suppliers`), ctx('id', B.equip));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SECRETB');
    const docs = await import('@/app/api/equipments/[id]/documents/route');
    expect((await docs.GET(req(`/api/equipments/${B.equip}/documents`), ctx('id', B.equip))).status).toBe(404);
    const ag = await import('@/app/api/equipments/[id]/agenda/route');
    expect((await ag.GET(req(`/api/equipments/${B.equip}/agenda`), ctx('id', B.equip))).status).toBe(404);
    const sup = await import('@/app/api/suppliers/[id]/route');
    expect((await sup.GET(req(`/api/suppliers/${B.fourn}`), ctx('id', B.fourn))).status).toBe(404);
  });

  // ── Écritures et relations (AC02, AC03) ───────────────────────────────────

  it('AC02/AC03 — A tente d’associer un document A à un événement B (et l’inverse) : association refusée, rien d’écrit', async () => {
    as(A.acc);
    const r = await import('@/app/api/events/[eventId]/documents/route');
    expect((await r.POST(req(`/api/events/${B.evt}/documents`, { method: 'POST', body: { fileIds: [A.fichier] } }), ctx('eventId', B.evt))).status).toBe(404);
    // Liste mêlant un document A et un document B : refus ENTIER.
    expect((await r.POST(req(`/api/events/${A.evt}/documents`, { method: 'POST', body: { fileIds: [A.fichier, B.fichier] } }), ctx('eventId', A.evt))).status).toBe(404);
    const d = await import('@/app/api/documents/[id]/events/route');
    expect((await d.POST(req(`/api/documents/${A.fichier}/events`, { method: 'POST', body: { eventIds: [B.evt] } }), ctx('id', A.fichier))).status).toBe(404);
    const lignes = await sql`SELECT 1 FROM event_documents WHERE (event_id = ${B.evt} AND file_id = ${A.fichier}) OR event_id = ${A.evt}`;
    expect(lignes).toHaveLength(0);
  });

  it('AC02 — A tente de supprimer une relation appartenant à B : suppression refusée, relation intacte', async () => {
    as(A.acc);
    const r = await import('@/app/api/events/[eventId]/documents/route');
    // Lot 84A (O-10, E25) : suppressions par les routes events retirées (aucun appelant).
    expect((r as Record<string, unknown>).DELETE).toBeUndefined();
    expect(((await import('@/app/api/events/route')) as Record<string, unknown>).DELETE).toBeUndefined();
    const d = await import('@/app/api/documents/[id]/events/route');
    expect((await d.DELETE(req(`/api/documents/${B.fichier}/events?eventId=${B.evt}`, { method: 'DELETE' }), ctx('id', B.fichier))).status).toBe(404);
    expect(await sql`SELECT 1 FROM event_documents WHERE event_id = ${B.evt} AND file_id = ${B.fichier}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM events WHERE id = ${B.evt}`).toHaveLength(1);
  });

  it('AC02/AC03 — A tente de rattacher un fournisseur A à un équipement B (ou B à A) : rattachement refusé', async () => {
    as(A.acc);
    const r = await import('@/app/api/equipments/[id]/suppliers/route');
    expect((await r.POST(req(`/api/equipments/${B.equip}/suppliers`, { method: 'POST', body: { supplierId: A.fourn } }), ctx('id', B.equip))).status).toBe(404);
    expect((await r.POST(req(`/api/equipments/${A.equip}/suppliers`, { method: 'POST', body: { supplierId: B.fourn } }), ctx('id', A.equip))).status).toBe(404);
    expect(await sql`SELECT 1 FROM equipment_suppliers WHERE (equipment_id = ${B.equip} AND supplier_id = ${A.fourn}) OR (equipment_id = ${A.equip} AND supplier_id = ${B.fourn})`).toHaveLength(0);
  });

  it('AC02 — A modifie un document A en indiquant un bien, une pièce ou un équipement B : modification refusée intégralement', async () => {
    as(A.acc);
    const r = await import('@/app/api/documents/[id]/route');
    const avant = (await sql`SELECT asset_id, substructure_id, equipment_id, original_filename, document_type, updated_at FROM asset_files WHERE id = ${A.fichier}`)[0];
    for (const cible of [{ assetId: B.bien.id }, { substructureId: B.piece }, { equipmentId: B.equip }]) {
      const res = await r.PUT(req(`/api/documents/${A.fichier}`, { method: 'PUT', body: { fileName: 'renomme.pdf', documentType: 'DEVIS', ...cible } }), ctx('id', A.fichier));
      expect(res.status).toBe(404);
    }
    // Cohérence : équipement d'un autre bien du compte que le bien indiqué.
    const inco = await r.PUT(req(`/api/documents/${A.fichier}`, { method: 'PUT', body: { fileName: 'renomme.pdf', documentType: 'DEVIS', assetId: A.bien.id, equipmentId: A.equip2 } }), ctx('id', A.fichier));
    expect(inco.status).toBe(400);
    const apres = (await sql`SELECT asset_id, substructure_id, equipment_id, original_filename, document_type, updated_at FROM asset_files WHERE id = ${A.fichier}`)[0];
    expect(apres).toEqual(avant); // aucune écriture partielle
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${A.acc.id} AND target_id = ${String(A.fichier)}`).toHaveLength(0);
  });

  it('AC02/AC04 — A crée une échéance associée à un équipement B : création refusée (primitive, même validate: false)', async () => {
    as(A.acc);
    const titre = `echeance-${A.acc.id}-interdite`;
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const { writeAgendaItem, AgendaOwnershipError } = await import('@/services/agenda/write-agenda-item');
    await expect(createAgendaItem({ title: titre, startDate: '2030-01-01', equipmentIds: [B.equip] }, A.acc.id, A.acc.ownerUserId))
      .rejects.toBeInstanceOf(AgendaOwnershipError);
    for (const links of [{ equipmentIds: [B.equip] }, { assetIds: [A.bien.id, B.bien.id] }, { fileIds: [B.fichier] }, { substructureIds: [B.piece] }]) {
      await expect(writeAgendaItem(
        { values: { title: titre, startDate: '2030-01-01', isAutomatic: true } as never, links },
        { accountId: A.acc.id, channel: 'T4', validate: false, linkMode: 'add' },
      )).rejects.toBeInstanceOf(AgendaOwnershipError);
    }
    // Document source étranger (T4) : refusé de même.
    await expect(writeAgendaItem(
      { values: { title: titre, startDate: '2030-01-01' } as never, links: { assetIds: [A.bien.id] }, sources: [{ fileId: B.fichier }] as never },
      { accountId: A.acc.id, channel: 'T4', validate: false },
    )).rejects.toBeInstanceOf(AgendaOwnershipError);
    expect(await sql`SELECT 1 FROM agenda_items WHERE title = ${titre}`).toHaveLength(0);
    // Routes historiques : même exigence.
    const list = await import('@/app/api/events/route');
    expect((await list.POST(req('/api/events', { method: 'POST', body: { titre, categorie: 'entretien', equipmentId: B.equip } }))).status).toBe(404);
    expect((await list.POST(req('/api/events', { method: 'POST', body: { titre, categorie: 'entretien', assetId: A.bien.id, equipmentId: A.equip2 } }))).status).toBe(400);
    expect(await sql`SELECT 1 FROM events WHERE titre = ${titre}`).toHaveLength(0);
  });

  it('AC03 — migration 0332 : rejouable sans effet (idempotente)', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0332_cross_account_link_guard.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const triggers = await sql`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%_cross_account_guard'`;
    expect(triggers).toHaveLength(8);
  });

  it('AC03 — garde en base (0332) : une nouvelle relation ordinaire entre comptes est refusée quel que soit le chemin', async () => {
    await expect(sql`INSERT INTO event_documents (event_id, file_id) VALUES (${A.evt}, ${B.fichier})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    await expect(sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id) VALUES (${A.equip}, ${B.fourn})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    await expect(sql`INSERT INTO document_suppliers (document_id, supplier_id) VALUES (${A.fichier}, ${B.fourn})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    const g = await make.agendaItem(A.acc, { assetIds: [A.bien.id] });
    await expect(sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${g.id}, ${B.bien.id})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    await expect(sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${g.id}, ${B.equip})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    await expect(sql`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${g.id}, ${B.piece})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    await expect(sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${g.id}, ${B.fichier})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    // Relation du même compte : acceptée.
    await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${g.id}, ${A.equip})`;
    await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id) VALUES (${A.equip2}, ${A.fourn})`;
  });

  // ── Relations historiques incorrectes (AC06, AC08) ────────────────────────

  it('AC06/AC08 — une relation incorrecte A/B existe volontairement en base : aucune donnée B affichée dans A ; contrôle d’exploitation en lecture seule', async () => {
    const titre = `agenda-${A.acc.id}-lien-incorrect`;
    const g = await make.agendaItem(A.acc, { title: titre, startDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) });
    const [evtA2] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
      VALUES (${A.acc.id}, ${A.acc.ownerUserId}, ${A.bien.id}, 'entretien', 'A-evt2', now()) RETURNING id`;
    await relationHistorique(sql, async (tx) => {
      await tx`INSERT INTO event_documents (event_id, file_id) VALUES (${evtA2.id}, ${B.fichier})`;
      await tx`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${g.id}, ${B.bien.id})`;
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${g.id}, ${B.fichier})`;
      await tx`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${g.id}, ${B.piece})`;
      await tx`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${g.id}, ${B.equip})`;
      await tx`INSERT INTO equipment_suppliers (equipment_id, supplier_id, source_type) VALUES (${A.equip}, ${B.fourn}, 'manual')`;
      await tx`INSERT INTO document_suppliers (document_id, supplier_id) VALUES (${A.fichier}, ${B.fourn})`;
      await tx`UPDATE events SET equipment_id = ${B.equip} WHERE id = ${evtA2.id}`;
    });
    as(A.acc);

    // Routes.
    const es = await import('@/app/api/equipments/[id]/suppliers/route');
    const r2 = await es.GET(req(`/api/equipments/${A.equip}/suppliers`), ctx('id', A.equip));
    expect(r2.status).toBe(200);
    expect(await r2.text()).not.toContain('SECRETB');
    as(B.acc);
    const de = await import('@/app/api/documents/[id]/events/route');
    const r3 = await (await de.GET(req(`/api/documents/${B.fichier}/events`), ctx('id', B.fichier))).json();
    expect(r3.events.map((e: { id: number }) => e.id)).not.toContain(evtA2.id);
    as(A.acc);

    // Agenda (lecture), T2 (assistant), T6 (mascotte).
    const { getAgendaItemById } = await import('@/services/agenda/AgendaQueryService');
    const item = await getAgendaItemById(g.id, A.acc.id);
    expect(item).not.toBeNull();
    expect(JSON.stringify(item)).not.toContain('SECRETB');
    expect(JSON.stringify(item)).not.toContain(`"id":${B.bien.id},`);
    const { listUpcomingAgenda } = await import('@/services/verebona-assistant/canonical/agenda');
    const t2 = await listUpcomingAgenda(A.acc.id, {});
    expect(t2.find((x) => x.id === g.id)).toBeDefined();
    expect(JSON.stringify(t2)).not.toContain('SECRETB');
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    expect(JSON.stringify(await collectMascotData(A.acc.id))).not.toContain('SECRETB');

    // Mise à jour de l'élément par A : aucune donnée B réécrite, rien de B supprimé automatiquement.
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(g.id, { title: titre, assetIds: [A.bien.id] } as never, A.acc.id).catch(() => undefined);
    expect(await sql`SELECT 1 FROM agenda_asset_links WHERE agenda_item_id = ${g.id} AND asset_id = ${B.bien.id}`).toHaveLength(1);

    // Contrôle d'exploitation : rapport par type, comptes, identifiants ; rien modifié.
    const { detectCrossAccountRelations } = await import('@/services/security/cross-account/detection');
    const avant = await sql`SELECT count(*)::int AS n FROM event_documents`;
    const rapport = await detectCrossAccountRelations();
    expect(rapport.readOnly).toBe(true);
    expect(rapport.checks.filter((c) => c.error)).toEqual([]); // tout le SQL est valide sur le schéma réel
    const par = Object.fromEntries(rapport.checks.map((c) => [c.code, c]));
    for (const code of ['EVENT_DOCUMENT', 'EVENT_TARGET', 'AGENDA_ASSET', 'AGENDA_FILE', 'AGENDA_ROOM', 'AGENDA_EQUIPMENT', 'EQUIPMENT_SUPPLIER', 'DOC_SUPPLIER']) {
      expect(par[code].count, code).toBeGreaterThanOrEqual(1);
      expect(par[code].accountIds, code).toEqual(expect.arrayContaining([A.acc.id, B.acc.id]));
    }
    expect(par.EVENT_DOCUMENT.samples.map((s) => s.ref).join(' ')).toContain(`events#${evtA2.id}`);
    expect(await sql`SELECT count(*)::int AS n FROM event_documents`).toEqual(avant);

    // Tâche quotidienne : anomalie de Supervision ouverte, aucune correction.
    const { runCrossAccountCheck } = await import('@/services/security/cross-account/alerts');
    const res = await runCrossAccountCheck();
    expect(res.total).toBeGreaterThanOrEqual(8);
    const anomalies = await sql<{ fingerprint: string; status: string }[]>`
      SELECT fingerprint, status FROM admin_anomalies WHERE fingerprint = 'other:cross-account:event_document'`;
    expect(anomalies).toEqual([expect.objectContaining({ status: 'open' })]);
    expect(await sql`SELECT 1 FROM event_documents WHERE event_id = ${evtA2.id} AND file_id = ${B.fichier}`).toHaveLength(1);

    // BO : route administrateur en lecture seule.
    const admin = await make.user({ role: 'ADMIN' });
    session.userId = admin.id;
    const bo = await import('@/app/api/admin/ops/cross-account/route');
    const rbo = await bo.GET(req('/api/admin/ops/cross-account'));
    expect(rbo.status).toBe(200);
    expect((await rbo.json()).total).toBeGreaterThanOrEqual(8);
  });

  // ── Traitements IA (AC05) ─────────────────────────────────────────────────

  it('AC05 — T1 analyse un document A déjà lié à tort à un bien B : aucune projection vers B', async () => {
    const f = await make.assetFile(A.acc, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket' WHERE id = ${f.id}`;
    await relationHistorique(sql, (tx) => tx`UPDATE asset_files SET asset_id = ${B.bien.id} WHERE id = ${f.id}`);
    const { knownAssetOfAccount } = await import('@/services/security/account-ownership');
    expect(await knownAssetOfAccount(A.acc.id, B.bien.id, 'e2e')).toBeNull();
    expect(await knownAssetOfAccount(A.acc.id, A.bien.id, 'e2e')).toBe(A.bien.id);

    Object.assign(process.env, {
      OVH_S3_ACCESS_KEY_ID: process.env.OVH_S3_ACCESS_KEY_ID ?? 'x', OVH_S3_SECRET_ACCESS_KEY: process.env.OVH_S3_SECRET_ACCESS_KEY ?? 'x',
      OVH_S3_BUCKET: process.env.OVH_S3_BUCKET ?? 'e2e-bucket', OVH_S3_ENDPOINT: process.env.OVH_S3_ENDPOINT ?? 'https://s3.example.com',
      OVH_S3_REGION: process.env.OVH_S3_REGION ?? 'gra',
    });
    const { FileSourceAdapter } = await import('@/services/ai/source-analysis/adapters/file-source.adapter');
    const prepared = await new FileSourceAdapter().prepare({ sourceIds: [f.id], accountId: A.acc.id, userId: A.acc.ownerUserId });
    expect(prepared.linkedAssetId).toBeNull(); // KNOWN_TARGET étranger ignoré
    const legit = await new FileSourceAdapter().prepare({ sourceIds: [A.fichier], accountId: A.acc.id, userId: A.acc.ownerUserId });
    expect(legit.linkedAssetId).toBe(A.bien.id);
    // Un bien B transmis par l'appelant est ignoré de même.
    const force = await new FileSourceAdapter().prepare({ sourceIds: [A.fichier], accountId: A.acc.id, userId: A.acc.ownerUserId, linkedAssetId: B.bien.id });
    expect(force.linkedAssetId).toBeNull();

    // Projection : un fait ciblant le bien B n'est jamais persisté.
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const trace = { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'] };
    const r = await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [f.id], accountId: A.acc.id, userId: A.acc.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: f.id, trace, analysisRunId: 1, documentType: 'FACTURE',
      facts: [{
        canonicalKey: 'mileage', rawKey: 'Kilométrage', label: null, subject: null, attribute: null, rawValue: null, value: 1, valueType: 'number',
        canonicalUnit: 'km', target: { targetType: 'ASSET', targetEntityId: B.bien.id, targetEntityLabel: null, targetConfidence: 'certain' },
        provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'x', page: 1 }, semanticEvent: null, recurrence: null,
        periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
      }],
    } as never);
    expect(r.skipped.map((s: { reason: string }) => s.reason)).toEqual(['TARGET_NOT_FOUND']);
    expect(await sql`SELECT 1 FROM field_evidence WHERE asset_id = ${B.bien.id}`).toHaveLength(0);
  });

  it('AC05 — T3 tente de rapprocher des données de A et B : aucune liaison intercomptes (écriture et mise en file)', async () => {
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await expect(linkDocumentToAsset({ accountId: A.acc.id, fileId: A.fichier, target: { assetId: B.bien.id }, role: 'SECONDARY', origin: 'AI' } as never)).rejects.toThrow();
    await expect(linkDocumentToAsset({ accountId: A.acc.id, fileId: B.fichier, target: { assetId: A.bien.id }, role: 'SECONDARY', origin: 'AI' } as never)).rejects.toThrow();
    await expect(linkDocumentToAsset({ accountId: A.acc.id, fileId: A.fichier, target: { equipmentId: B.equip }, role: 'SECONDARY', origin: 'AI' } as never)).rejects.toThrow();
    expect(await sql`SELECT 1 FROM document_asset_links WHERE (file_id = ${A.fichier} AND asset_id = ${B.bien.id}) OR (file_id = ${B.fichier} AND (account_id = ${A.acc.id} OR asset_id = ${A.bien.id}))`).toHaveLength(0);

    const repo = await import('@/services/ai/queue/job-queue.repository');
    const { buildT3Payload } = await import('@/services/ai/reconciliation/t3-job-contract');
    const refus = await repo.enqueue({
      treatment: 'T3', scope: { accountId: A.acc.id, targetType: 'asset', targetId: B.bien.id }, triggerCode: 'document_linked',
      payload: buildT3Payload('asset', { sourceFileId: A.fichier }),
    });
    expect(refus.jobId).toBeNull();
    const refus2 = await repo.enqueue({
      treatment: 'T3', scope: { accountId: A.acc.id, targetType: 'asset', targetId: A.bien.id }, triggerCode: 'document_linked',
      payload: buildT3Payload('asset', { sourceFileId: B.fichier }),
    });
    expect(refus2.jobId).toBeNull();
    const jobs = await sql`SELECT id, target_type, target_id, payload, origin, trigger_code, created_at FROM ai_job_queue WHERE account_id = ${A.acc.id} AND treatment = 'T3' AND target_type = 'asset' AND (target_id = ${String(B.bien.id)} OR payload->>'sourceFileId' = ${String(B.fichier)})`;
    expect(jobs, JSON.stringify(jobs)).toHaveLength(0);
  });

  it('AC05 — T4 exécute un ancien job (inséré avant le correctif, relancé) référençant une cible étrangère : aucune écriture ni suppression sur B', async () => {
    const repo = await import('@/services/ai/queue/job-queue.repository');
    const { runOne, registerJobHandler } = await import('@/services/ai/queue/queue-worker');
    const admin = await make.user();
    await repo.setEmergencyStop(false, admin.id);
    await repo.setTreatmentState('T4', 'ENABLED', admin.id);
    const appels: number[] = [];
    registerJobHandler('T4', async (job) => { appels.push(job.id); });

    const ecarter = async (id: number) => {
      const rows = await sql<{ id: number }[]>`
        UPDATE ai_job_queue SET available_at = now() + interval '1 day'
         WHERE treatment = 'T4' AND status = 'PENDING' AND available_at <= now() AND id <> ${id} RETURNING id`;
      ecartes.push(...rows.map((x) => Number(x.id)));
    };
    const ancien = async (payload: Record<string, unknown>, targetId = A.fichier) => (await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload, available_at)
      VALUES ('T4', ${A.acc.id}, 'asset_file', ${String(targetId)}, ${`l49-${Date.now()}-${Math.random()}`}, 'automatic', 'source_analyzed',
              ${JSON.stringify(payload)}::jsonb, now()) RETURNING id`)[0].id;
    const agendaB = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${B.acc.id}`)[0].n;
    const avantB = await agendaB();

    // Bien cible d'un autre compte (contexte), puis document source d'un autre compte (cible).
    for (const [payload, cible] of [[{ assetId: B.bien.id, leadSourceId: A.fichier, candidates: [] }, A.fichier], [{ assetId: A.bien.id, leadSourceId: B.fichier, candidates: [] }, B.fichier]] as const) {
      const id = await ancien(payload, cible);
      for (let passe = 0; passe < 2; passe++) { // job rejoué
        await ecarter(id);
        expect(await runOne('T4')).toBe(true);
        const [j] = await sql<{ status: string; last_error: string }[]>`SELECT status, last_error FROM ai_job_queue WHERE id = ${id}`;
        expect(j.status).toBe('FAILED');
        expect(j.last_error).toContain('périmètre hors compte');
        await sql`UPDATE ai_job_queue SET status = 'PENDING', available_at = now(), attempts = 0 WHERE id = ${id}`;
      }
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${id}`.catch(() => sql`DELETE FROM ai_job_queue WHERE id = ${id}`);
    }
    expect(appels).toEqual([]); // l'exécutant n'a jamais tourné
    expect(await agendaB()).toBe(avantB);

    // Job légitime : exécuté normalement (non-régression).
    const ok = await ancien({ assetId: A.bien.id, leadSourceId: A.fichier, candidates: [] });
    await ecarter(ok);
    expect(await runOne('T4')).toBe(true);
    expect(appels).toEqual([ok]);
  });

  // ── Comptes multiples, Duo, concurrence (AC07, AC09) ──────────────────────

  it('AC01/AC07 — un même utilisateur possède des droits sur A et B : isolation selon le compte actif', async () => {
    const u = await make.user();
    const X = await compte(sql, make, 'X', u);
    const Y = await compte(sql, make, 'SECRETY', u);
    const one = await import('@/app/api/events/route');
    const es = await import('@/app/api/equipments/[id]/suppliers/route');
    await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id) VALUES (${Y.equip}, ${Y.fourn})`;
    as(X.acc, u.id);
    expect((await one.GET(req(`/api/events?id=${Y.evt}`))).status).toBe(404);
    expect((await es.GET(req(`/api/equipments/${Y.equip}/suppliers`), ctx('id', Y.equip))).status).toBe(404);
    const r = await import('@/app/api/events/[eventId]/documents/route');
    expect((await r.POST(req(`/api/events/${X.evt}/documents`, { method: 'POST', body: { fileIds: [Y.fichier] } }), ctx('eventId', X.evt))).status).toBe(404);
    as(Y.acc, u.id);
    expect((await one.GET(req(`/api/events?id=${Y.evt}`))).status).toBe(200);
    const sup = await (await es.GET(req(`/api/equipments/${Y.equip}/suppliers`), ctx('id', Y.equip))).json();
    expect(sup.suppliers.map((s: { supplierId: number }) => s.supplierId)).toEqual([Y.fourn]);
  });

  it('AC07 — un utilisateur Premium Duo utilise les fonctions autorisées : fonctionnement légitime inchangé', async () => {
    const titulaire = await make.user();
    const membre = await make.user();
    const D = await compte(sql, make, 'DUO', titulaire);
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${D.acc.id}, ${membre.id}, 'member', 'active')`;
    as(D.acc, membre.id);
    const evd = await import('@/app/api/events/[eventId]/documents/route');
    expect((await evd.POST(req(`/api/events/${D.evt}/documents`, { method: 'POST', body: { fileIds: [D.fichier] } }), ctx('eventId', D.evt))).status).toBe(201);
    const de = await import('@/app/api/documents/[id]/events/route');
    expect((await (await de.GET(req(`/api/documents/${D.fichier}/events`), ctx('id', D.fichier))).json()).total).toBe(1);
    expect((await de.DELETE(req(`/api/documents/${D.fichier}/events?eventId=${D.evt}`, { method: 'DELETE' }), ctx('id', D.fichier))).status).toBe(200);
    expect((await de.POST(req(`/api/documents/${D.fichier}/events`, { method: 'POST', body: { eventIds: [D.evt] } }), ctx('id', D.fichier))).status).toBe(201);
    const es = await import('@/app/api/equipments/[id]/suppliers/route');
    expect((await es.POST(req(`/api/equipments/${D.equip}/suppliers`, { method: 'POST', body: { supplierId: D.fourn } }), ctx('id', D.equip))).status).toBe(201);
    expect((await (await es.GET(req(`/api/equipments/${D.equip}/suppliers`), ctx('id', D.equip))).json()).suppliers).toHaveLength(1);
    // Le tiroir document reste réservé au déposant (règle antérieure, inchangée).
    as(D.acc, titulaire.id);
    const doc = await import('@/app/api/documents/[id]/route');
    const put = await doc.PUT(req(`/api/documents/${D.fichier}`, { method: 'PUT', body: { fileName: 'DUO-facture.pdf', documentType: 'FACTURE', assetId: D.bien.id, substructureId: D.piece, equipmentId: D.equip } }), ctx('id', D.fichier));
    expect(put.status).toBe(200);
    expect((await sql`SELECT substructure_id, equipment_id FROM asset_files WHERE id = ${D.fichier}`)[0]).toEqual({ substructure_id: D.piece, equipment_id: D.equip });
    const list = await import('@/app/api/events/route');
    expect((await list.POST(req('/api/events', { method: 'POST', body: { titre: 'DUO-controle', categorie: 'controle', assetId: D.bien.id, equipmentId: D.equip } }))).status).toBe(201);
    const { writeAgendaItem } = await import('@/services/agenda/write-agenda-item');
    const w = await writeAgendaItem(
      { values: { title: 'DUO-echeance', startDate: '2030-02-01' } as never, links: { assetIds: [D.bien.id], equipmentIds: [D.equip], substructureIds: [D.piece], fileIds: [D.fichier] } },
      { accountId: D.acc.id, channel: 'MANUAL', validate: true, actorUserId: membre.id },
    );
    expect(w.created).toBe(true);
    expect(await sql`SELECT 1 FROM agenda_equipment_links WHERE agenda_item_id = ${w.id} AND equipment_id = ${D.equip}`).toHaveLength(1);
  });

  it('AC03/AC09 — opérations concurrentes et jobs rejoués : aucune relation intercomptes créée', async () => {
    as(A.acc);
    const [evt] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
      VALUES (${A.acc.id}, ${A.acc.ownerUserId}, ${A.bien.id}, 'entretien', 'A-concurrent', now()) RETURNING id`;
    const evd = await import('@/app/api/events/[eventId]/documents/route');
    const es = await import('@/app/api/equipments/[id]/suppliers/route');
    const res = await Promise.all([
      ...Array.from({ length: 6 }, () => evd.POST(req(`/api/events/${evt.id}/documents`, { method: 'POST', body: { fileIds: [B.fichier] } }), ctx('eventId', evt.id))),
      ...Array.from({ length: 3 }, () => evd.POST(req(`/api/events/${evt.id}/documents`, { method: 'POST', body: { fileIds: [A.fichier] } }), ctx('eventId', evt.id))),
      ...Array.from({ length: 4 }, () => es.POST(req(`/api/equipments/${A.equip}/suppliers`, { method: 'POST', body: { supplierId: B.fourn } }), ctx('id', A.equip))),
    ]);
    expect(res.slice(0, 6).every((r) => r.status === 404)).toBe(true);
    expect(res.slice(6, 9).every((r) => r.status === 201)).toBe(true);
    expect(res.slice(9).every((r) => r.status === 404)).toBe(true);
    const croisees = await sql`
      SELECT 1 FROM event_documents ed JOIN events e ON e.id = ed.event_id JOIN asset_files f ON f.id = ed.file_id
       WHERE ed.event_id = ${evt.id} AND f.account_id <> e.account_id`;
    expect(croisees).toHaveLength(0);
    expect(await sql`SELECT 1 FROM event_documents WHERE event_id = ${evt.id}`).toHaveLength(1);
  });
});
