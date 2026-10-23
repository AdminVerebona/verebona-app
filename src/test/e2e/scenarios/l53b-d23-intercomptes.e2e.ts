/**
 * Lot 53 (53B) — retour PO D23 « Relations intercomptes : CORRIGER AVANT
 * PRODUCTION » (le simple signalement du lot 49 ne suffit pas), sur
 * PostgreSQL réel :
 *
 *   PO-D23-02  migrations 0345 / 0346 rejouables (journal, garde 0332
 *              redéfinie, déclencheur de détachement à la suppression d'un bien) ;
 *   PO-D23-03  NEUTRALISATION des lectures : une relation ancienne de CHAQUE
 *              catégorie existe en base entre A et B ; aucun écran, route,
 *              service, assistant (T2), export, agenda, « À traiter »,
 *              recherche ni mascotte de A ne restitue une donnée de B (et
 *              réciproquement) ;
 *   PO-D23-04  miniatures et fichiers : un fichier de l'autre compte reste
 *              introuvable même lié ;
 *   PO-D23-05  inventaire qualifié, SIMULATION (rien d'écrit, rapport exact),
 *              APPLICATION par famille depuis le BO (journalisée), contrôle
 *              revenu à 0, objets conservés dans leur compte, RESTAURATION ;
 *   PO-D23-06  Duo (D3 ouvert) : relation entre deux comptes reliés par un
 *              Duo ou sur un bien déplacé → signalée, JAMAIS corrigée ;
 *   PO-D23-07  NEUTRALISATION des écritures : supprimer son bien (ou son
 *              compte) n'emporte plus le document, l'événement ni le fichier
 *              stocké de l'autre compte ;
 *   PO-D23-08  partage légitime (compte partagé, `account_memberships`) :
 *              jamais candidat, jamais modifié, toujours visible du membre ;
 *   PO-D23-09  écritures par la relation ancienne refusées (document,
 *              agenda, déplacement en lot) ;
 *   PO-D23-10  preuves après correction : nouveau balayage complet sans
 *              fuite, BO à 0 pour les catégories corrigées, journal visible.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import type { AccountRow, Factories } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
    assertOwnership: () => undefined,
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

type Sql = Parameters<Parameters<typeof scenario>[2]>[0]['sql'];

const req = (url: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://localhost${url}`, {
  method: init?.method ?? 'GET',
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
});
const ctx = <K extends string>(k: K, v: number) => ({ params: Promise.resolve({ [k]: String(v) } as Record<K, string>) });
const as = (acc: AccountRow, userId = acc.ownerUserId) => { session.userId = userId; session.currentAccountId = acc.id; };

/** Un compte complet, chaque libellé porte le marqueur du compte. */
async function compte(sql: Sql, make: Factories, m: string) {
  const acc = await make.account({ plan: 'premium' });
  await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
  const bien = await make.asset(acc, { category: 'IMMOBILIER', name: `${m}-maison-${acc.id}` });
  const bien2 = await make.asset(acc, { category: 'IMMOBILIER', name: `${m}-garage-${acc.id}` });
  const [piece] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${bien.id}, ${`${m}-salon`}) RETURNING id`;
  const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${bien.id}, ${`${m}-chaudiere`}) RETURNING id`;
  const [equip2] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${bien2.id}, ${`${m}-portail`}) RETURNING id`;
  const [room] = await sql<{ id: number }[]>`INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${bien.id}, ${acc.id}, ${`${m}-chambre`}, 'BEDROOM') RETURNING id`;
  const fichier = await doc(sql, make, acc, m, 'facture', bien.id);
  const [fourn] = await sql<{ id: number }[]>`
    INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, phone)
    VALUES (${acc.id}, ${acc.ownerUserId}, ${`${m}-FOURNISSEUR`}, ${`${m.toLowerCase()} fournisseur ${acc.id}`}, '0102030405') RETURNING id`;
  const [evt] = await sql<{ id: number }[]>`
    INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
    VALUES (${acc.id}, ${acc.ownerUserId}, ${bien.id}, 'entretien', ${`${m}-entretien`}, now()) RETURNING id`;
  return { acc, bien, bien2, piece: piece.id, equip: equip.id, equip2: equip2.id, room: room.id, fichier, fourn: fourn.id, evt: evt.id };
}

async function doc(sql: Sql, make: Factories, acc: AccountRow, m: string, nom: string, assetId: number | null): Promise<number> {
  const f = await make.assetFile(acc, { assetId, name: `${m}-${nom}-${acc.id}.pdf` });
  await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', document_type = 'FACTURE', original_filename = ${`${m}-${nom}.pdf`},
              retained_title = ${`${m} ${nom}`}, upload_status = 'COMPLETED', document_date = '2026-01-15' WHERE id = ${f.id}`;
  return f.id;
}

/** Relation « historique » : gardes 0332 contournées (rôle de réplication), comme avant le lot 49. */
async function historique(sql: Sql, ecrire: (tx: Sql) => Promise<unknown>) {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await ecrire(tx as unknown as Sql);
  });
}

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

scenario('L53B-D23', 'Relations intercomptes : inventaire, neutralisation, correction contrôlée', ({ sql, make }) => {
  let A: Awaited<ReturnType<typeof compte>>;
  let B: Awaited<ReturnType<typeof compte>>;
  /** Documents de B rattachés aux objets de A (et un de A rattaché à B). */
  const lies: Record<string, number> = {};
  let agendaA = 0;
  let agendaOrigineA = 0;
  let evtA2 = 0;
  let echeanceA = 0;
  let adminId = 0;

  beforeAll(async () => {
    // Le scénario l49 rejoue 0332 (fonction d'origine) : on remet la version 0345.
    await rejouer(sql, '0345_cross_account_remediation.sql');
    A = await compte(sql, make, 'ALPHA');
    B = await compte(sql, make, 'BRAVO');
    adminId = (await make.user({ role: 'ADMIN' })).id;

    // Documents rattachés à tort, dans les DEUX sens.
    lies.bVersBienA = await doc(sql, make, B.acc, 'BRAVO', 'sur-bien-a', null);
    lies.bLieBienA = await doc(sql, make, B.acc, 'BRAVO', 'lie-bien-a', null);
    lies.bPieceA = await doc(sql, make, B.acc, 'BRAVO', 'piece-a', null);
    lies.bEquipA = await doc(sql, make, B.acc, 'BRAVO', 'equip-a', null);
    lies.bRoomA = await doc(sql, make, B.acc, 'BRAVO', 'room-a', null);
    lies.aVersBienB = await doc(sql, make, A.acc, 'ALPHA', 'sur-bien-b', null);
    const [e2] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
      VALUES (${A.acc.id}, ${A.acc.ownerUserId}, ${A.bien.id}, 'entretien', 'ALPHA-evt2', now()) RETURNING id`;
    evtA2 = e2.id;
    const [d] = await sql<{ id: number }[]>`
      INSERT INTO deadlines (account_id, user_id, label, deadline_date) VALUES (${A.acc.id}, ${A.acc.ownerUserId}, 'ALPHA-echeance', '2030-01-01') RETURNING id`;
    echeanceA = d.id;
    agendaA = (await make.agendaItem(A.acc, { title: 'ALPHA-rdv', startDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), assetIds: [A.bien.id] })).id;
    agendaOrigineA = (await make.agendaItem(A.acc, { title: 'ALPHA-origine', startDate: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10) })).id;
    const [ext] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, title) VALUES (${B.acc.id}, ${B.fichier}, 'BRAVO extraction') RETURNING id`;

    await historique(sql, async (tx) => {
      // DOC_* (colonnes) : documents de B sur les objets de A, document de A sur le bien de B.
      await tx`UPDATE asset_files SET asset_id = ${A.bien.id} WHERE id = ${lies.bVersBienA}`;
      await tx`UPDATE asset_files SET linked_asset_id = ${A.bien.id} WHERE id = ${lies.bLieBienA}`;
      await tx`UPDATE asset_files SET substructure_id = ${A.piece} WHERE id = ${lies.bPieceA}`;
      await tx`UPDATE asset_files SET equipment_id = ${A.equip} WHERE id = ${lies.bEquipA}`;
      await tx`UPDATE asset_files SET linked_room_id = ${A.room} WHERE id = ${lies.bRoomA}`;
      await tx`UPDATE asset_files SET asset_id = ${B.bien.id} WHERE id = ${lies.aVersBienB}`;
      // DOC_ASSET_LINK
      await tx`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${A.acc.id}, ${B.fichier}, ${A.bien.id}, 'PRIMARY', 'USER', 'ACTIVE')`;
      // Fournisseurs
      await tx`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${A.fichier}, ${B.fourn}, true)`;
      await tx`INSERT INTO equipment_suppliers (equipment_id, supplier_id, source_type) VALUES (${A.equip}, ${B.fourn}, 'manual')`;
      await tx`INSERT INTO equipment_suppliers (equipment_id, supplier_id, source_type, source_document_id) VALUES (${A.equip2}, ${A.fourn}, 'document', ${B.fichier})`;
      await tx`INSERT INTO asset_suppliers (asset_id, supplier_id) VALUES (${A.bien.id}, ${B.fourn})`;
      // Événements / échéances
      await tx`INSERT INTO event_documents (event_id, file_id) VALUES (${A.evt}, ${B.fichier})`;
      await tx`UPDATE events SET equipment_id = ${B.equip} WHERE id = ${evtA2}`;
      await tx`UPDATE deadlines SET asset_id = ${B.bien.id} WHERE id = ${echeanceA}`;
      // Agenda
      await tx`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${agendaA}, ${B.bien.id})`;
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${agendaA}, ${B.fichier})`;
      await tx`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${agendaA}, ${B.piece})`;
      await tx`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${agendaA}, ${B.equip})`;
      await tx`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type) VALUES (${agendaA}, ${B.fichier}, 'linked')`;
      await tx`UPDATE agenda_items SET origin_ref_type = 'asset_file', origin_ref_id = ${B.fichier} WHERE id = ${agendaOrigineA}`;
      // Preuves et données projetées
      await tx`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, evidence_excerpt, confidence, fingerprint)
               VALUES (${A.acc.id}, ${B.bien.id}, 'mileage', '1'::jsonb, 'document', ${A.fichier}, 'BRAVO extrait', 'certain', ${`fp-a-${A.acc.id}`})`;
      await tx`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, evidence_excerpt, confidence, fingerprint)
               VALUES (${A.acc.id}, ${A.bien.id}, 'surface', '120'::jsonb, 'document', ${B.fichier}, 'BRAVO extrait 2', 'certain', ${`fp-a2-${A.acc.id}`})`;
      await tx`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, confidence, excerpt, value_text)
               VALUES (${A.acc.id}, ${B.fichier}, ${ext.id}, 'BRAVO_FAIT', 'certain', 'BRAVO extrait fait', 'BRAVO valeur')`;
      await tx`INSERT INTO ai_field_updates (account_id, asset_id, field_key, new_value) VALUES (${A.acc.id}, ${B.bien.id}, 'mileage', 'BRAVO-km')`;
      // À traiter
      await tx`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
               VALUES (${A.acc.id}, 'DOCUMENT', ${B.fichier}, 'documentDate', 'COMPLETE', 'E2E_RULE', 'Question sur un document')`;
      // Job IA en attente (pas encore disponible : aucun boucleur ne le prend).
      await tx`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload, available_at)
               VALUES ('T3', ${A.acc.id}, 'asset', ${String(B.bien.id)}, ${`l53b-${A.acc.id}`}, 'automatic', 'document_linked', '{}'::jsonb, now() + interval '30 days')`;
    });
  });

  // ── Balayage des lectures : rien de l'autre compte ─────────────────────────

  async function balayer(moi: Awaited<ReturnType<typeof compte>>, autreMarque: string): Promise<Array<{ nom: string; status: number; fuite: boolean }>> {
    as(moi.acc);
    const out: Array<{ nom: string; status: number; fuite: boolean; extrait?: string }> = [];
    const noter = (nom: string, status: number, texte: string) => {
      const i = texte.indexOf(autreMarque);
      out.push({ nom, status, fuite: i >= 0, ...(i >= 0 ? { extrait: texte.slice(Math.max(0, i - 120), i + 60) } : {}) });
    };
    const route = async (nom: string, f: () => Promise<Response>) => {
      const r = await f();
      noter(nom, r.status, await r.text());
    };
    const service = async (nom: string, f: () => Promise<unknown>) => {
      try {
        noter(nom, 200, JSON.stringify(await f()));
      } catch (e) {
        noter(nom, 500, String((e as Error)?.stack ?? e));
      }
    };
    const docs = await import('@/app/api/documents/route');
    await route('GET /api/documents', () => docs.GET(req('/api/documents?pageSize=200')));
    await route('GET /api/documents?assetId', () => docs.GET(req(`/api/documents?assetId=${moi.bien.id}&pageSize=200`)));
    const browse = await import('@/app/api/documents/browse/route');
    await route('GET /api/documents/browse', () => browse.GET(req('/api/documents/browse?limit=100')));
    await route('GET /api/documents/browse?assetIds', () => browse.GET(req(`/api/documents/browse?limit=100&assetIds=${moi.bien.id}`)));
    const ov = await import('@/app/api/assets/[id]/overview/route');
    await route('GET /api/assets/[id]/overview', () => ov.GET(req(`/api/assets/${moi.bien.id}/overview`), ctx('id', moi.bien.id)));
    const ph = await import('@/app/api/assets/[id]/photos/route');
    await route('GET /api/assets/[id]/photos', () => ph.GET(req(`/api/assets/${moi.bien.id}/photos`), ctx('id', moi.bien.id)));
    const ds = await import('@/app/api/assets/[id]/deletion-summary/route');
    await route('GET /api/assets/[id]/deletion-summary', () => ds.GET(req(`/api/assets/${moi.bien.id}/deletion-summary`), ctx('id', moi.bien.id)));
    // Lot 83D (V-Q1) : routes /claims retirées — les références du bien passent par les informations complémentaires.
    const infos = await import('@/app/api/assets/[id]/additional-infos/route');
    await route('GET /api/assets/[id]/additional-infos?include=references', () => infos.GET(req(`/api/assets/${moi.bien.id}/additional-infos?include=references`), ctx('id', moi.bien.id)));
    const home = await import('@/services/home/HomeSummaryService');
    await service('buildHomeSummary (accueil)', () => home.buildHomeSummary(moi.acc.id));
    const tp = await import('@/app/api/v2/to-process/route');
    await route('GET /api/v2/to-process', () => tp.GET(req('/api/v2/to-process')));
    const ag = await import('@/app/api/agenda/route');
    await route('GET /api/agenda', () => ag.GET(req('/api/agenda?period=all&includeUndated=true')));
    const { getAgendaItemById } = await import('@/services/agenda/AgendaQueryService');
    await service('getAgendaItemById', () => getAgendaItemById(agendaA, moi.acc.id));
    const search = await import('@/app/api/search/route');
    await route('GET /api/search', () => search.GET(req(`/api/search?q=${encodeURIComponent(autreMarque)}`)));
    const eqDocs = await import('@/app/api/equipments/[id]/documents/route');
    await route('GET /api/equipments/[id]/documents', () => eqDocs.GET(req(`/api/equipments/${moi.equip}/documents`), ctx('id', moi.equip)));
    const eqSup = await import('@/app/api/equipments/[id]/suppliers/route');
    await route('GET /api/equipments/[id]/suppliers', () => eqSup.GET(req(`/api/equipments/${moi.equip}/suppliers`), ctx('id', moi.equip)));
    const eqAg = await import('@/app/api/equipments/[id]/agenda/route');
    await route('GET /api/equipments/[id]/agenda', () => eqAg.GET(req(`/api/equipments/${moi.equip}/agenda`), ctx('id', moi.equip)));
    const evs = await import('@/app/api/events/route');
    await route('GET /api/events?assetId', () => evs.GET(req(`/api/events?assetId=${moi.bien.id}`)));
    const evd = await import('@/app/api/events/[eventId]/documents/route');
    await route('GET /api/events/[id]/documents', () => evd.GET(req(`/api/events/${moi.evt}/documents`), ctx('eventId', moi.evt)));
    const sup = await import('@/app/api/suppliers/[id]/route');
    await route('GET /api/suppliers/[id]', () => sup.GET(req(`/api/suppliers/${moi.fourn}`), ctx('id', moi.fourn)));
    // Assistant (T2) : lectures canoniques.
    const t2agenda = await import('@/services/verebona-assistant/canonical/agenda');
    await service('T2 listUpcomingAgenda', () => t2agenda.listUpcomingAgenda(moi.acc.id, {}));
    const t2todo = await import('@/services/verebona-assistant/canonical/actionables');
    await service('T2 listOpenTodos', () => t2todo.listOpenTodos(moi.acc.id));
    const t2sup = await import('@/services/verebona-assistant/canonical/suppliers');
    await service('T2 listSuppliersDeduplicated', () => t2sup.listSuppliersDeduplicated(moi.acc.id));
    const { accountDataRepository } = await import('@/services/verebona-assistant/core/account-data.repository');
    await service('T2 searchDocuments', () => accountDataRepository.searchDocuments(moi.acc.id, [autreMarque.toLowerCase(), 'facture'], undefined as never));
    await service('T2 searchFacts', () => accountDataRepository.searchFacts(moi.acc.id, [autreMarque.toLowerCase(), 'bravo_fait'], undefined as never));
    await service('T2 listAssets', () => accountDataRepository.listAssets(moi.acc.id));
    const { listAssetDocuments } = await import('@/services/documents/document-asset-links');
    await service('T2/exports listAssetDocuments', () => listAssetDocuments(moi.acc.id, moi.bien.id));
    // Mascotte (T6).
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    await service('T6 collectMascotData', () => collectMascotData(moi.acc.id));
    // Exports (moteur de dossiers).
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    for (const exportType of ['ASSURANCE_SINISTRE', 'VENTE'] as const) {
      await service(`exports loadExportSource ${exportType}`, () => loadExportSource({ assetId: moi.bien.id, accountId: moi.acc.id, userId: moi.acc.ownerUserId, exportType } as never));
    }
    return out;
  }

  const sansFuite = (r: Awaited<ReturnType<typeof balayer>>) => r.filter((x) => x.fuite);

  it('PO-D23-02 — migrations 0345 / 0346 rejouables sans effet ; journal et déclencheurs présents', async () => {
    for (const f of ['0345_cross_account_remediation.sql', '0346_assets_detach_foreign_refs.sql']) {
      for (const passe of [1, 2]) await expect(rejouer(sql, f), `${f} passe ${passe}`).resolves.toBeUndefined();
    }
    expect(await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'cross_account_remediations'`).toHaveLength(1);
    expect(await sql`SELECT tgname FROM pg_trigger WHERE tgname = 'assets_detach_foreign_refs'`).toHaveLength(1);
    expect(await sql`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%_cross_account_guard'`).toHaveLength(8);
    // La garde 0332 reste active hors restauration.
    await expect(sql`INSERT INTO event_documents (event_id, file_id) VALUES (${B.evt}, ${A.fichier})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
  });

  it('PO-D23-03 — neutralisation des LECTURES : aucune route, service, T2, export, agenda, À traiter, recherche ni mascotte ne restitue l’autre compte', async () => {
    const vueA = await balayer(A, 'BRAVO');
    // Chaque lecture a réellement répondu (aucune n'est vide par refus).
    expect(vueA.filter((x) => x.status !== 200).map((x) => `${x.nom} ${x.status}`)).toEqual([]);
    expect(vueA.filter((x) => x.status >= 500), JSON.stringify(vueA.filter((x) => x.status >= 500))).toEqual([]);
    expect(sansFuite(vueA), JSON.stringify(sansFuite(vueA))).toEqual([]);
    const vueB = await balayer(B, 'ALPHA');
    expect(vueB.filter((x) => x.status >= 500), JSON.stringify(vueB.filter((x) => x.status >= 500))).toEqual([]);
    expect(sansFuite(vueB), JSON.stringify(sansFuite(vueB))).toEqual([]);
    // Le balayage voit bien les données légitimes (le test n'est pas vide).
    as(A.acc);
    const docs = await import('@/app/api/documents/route');
    const liste = await (await docs.GET(req(`/api/documents?assetId=${A.bien.id}&pageSize=200`))).json() as { data: Array<{ id: number }> };
    expect(liste.data.map((d) => d.id)).toContain(A.fichier);
    // Le document de A rattaché à tort au bien de B reste visible dans A… sans le nom du bien de B.
    const tous = await (await docs.GET(req('/api/documents?pageSize=200'))).json() as { data: Array<{ id: number; asset: { name: string } | null }> };
    expect(tous.data.find((d) => d.id === lies.aVersBienB)?.asset?.name).toBe('Bien supprimé');
  });

  it('PO-D23-04 — miniatures et fichiers : le fichier de l’autre compte reste introuvable même lié', async () => {
    as(A.acc);
    for (const id of [B.fichier, lies.bVersBienA, lies.bEquipA]) {
      const view = await import('@/app/api/files/[id]/view/route');
      expect((await view.GET(req(`/api/files/${id}/view`), ctx('id', id))).status, `view ${id}`).toBe(404);
      const thumb = await import('@/app/api/files/[id]/thumbnail/route');
      expect([403, 404], `thumbnail ${id}`).toContain((await thumb.GET(req(`/api/files/${id}/thumbnail`), ctx('id', id))).status);
      const dl = await import('@/app/api/files/[id]/download/route');
      expect([403, 404], `download ${id}`).toContain((await dl.GET(req(`/api/files/${id}/download`), ctx('id', id))).status);
    }
  });

  it('PO-D23-09 — écritures par la relation ancienne refusées : document, déplacement en lot, agenda', async () => {
    as(A.acc);
    const doc = await import('@/app/api/documents/[id]/route');
    const avant = (await sql`SELECT original_filename, asset_id FROM asset_files WHERE id = ${lies.bVersBienA}`)[0];
    const put = await doc.PUT(req(`/api/documents/${lies.bVersBienA}`, { method: 'PUT', body: { fileName: 'pirate.pdf', documentType: 'DEVIS', assetId: A.bien.id } }), ctx('id', lies.bVersBienA));
    expect(put.status).toBe(404);
    const move = await import('@/app/api/documents/bulk-move/route');
    const r = await move.POST(req('/api/documents/bulk-move', { method: 'POST', body: { fileIds: [lies.bVersBienA], targetAssetId: A.bien2.id } }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await sql`SELECT original_filename, asset_id FROM asset_files WHERE id = ${lies.bVersBienA}`)[0]).toEqual(avant);
    // Mise à jour de l'élément d'agenda de A : rien de B réécrit ni supprimé.
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(agendaA, { title: 'ALPHA-rdv', assetIds: [A.bien.id] } as never, A.acc.id).catch(() => undefined);
    expect(await sql`SELECT 1 FROM equipments WHERE id = ${B.equip}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${B.fichier} AND deleted_at IS NULL`).toHaveLength(1);
  });

  it('PO-D23-06 — Duo (D3 ouvert) : relation entre comptes reliés par un Duo ou sur un bien déplacé → signalée, jamais corrigée', async () => {
    const titulaire = await make.account({ plan: 'premium_duo' });
    const membre = await make.account({ plan: 'premium' });
    const [duo] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id) VALUES (${titulaire.ownerUserId}) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duo.id} WHERE id = ${titulaire.id}`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot) VALUES (${duo.id}, ${titulaire.ownerUserId}, 'ACTIVE', 0), (${duo.id}, ${membre.ownerUserId}, 'ACTIVE', 1)`;
    const bienT = await make.asset(titulaire, { category: 'IMMOBILIER', name: 'DUO-maison' });
    const docM = await doc(sql, make, membre, 'DUOM', 'doc', null);
    await historique(sql, (tx) => tx`UPDATE asset_files SET asset_id = ${bienT.id} WHERE id = ${docM}`);
    // Bien déplacé (demande de déplacement) entre deux comptes SANS Duo actuel.
    const X = await make.account({ plan: 'premium' });
    const Y = await make.account({ plan: 'premium' });
    const bienX = await make.asset(X, { category: 'IMMOBILIER', name: 'MOVE-maison' });
    const [duo2] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id, subscription_status) VALUES (${X.ownerUserId}, 'CANCELED') RETURNING id`;
    await sql`INSERT INTO asset_move_requests (asset_id, duo_id, target_account_id, initiator_user_id, validator_user_id, status, asset_label_snapshot, target_user_snapshot, initiator_user_snapshot)
              VALUES (${bienX.id}, ${duo2.id}, ${X.id}, ${X.ownerUserId}, ${X.ownerUserId}, 'ACCEPTED', 'MOVE', 'x', 'x')`;
    const docY = await doc(sql, make, Y, 'MOVEY', 'doc', null);
    await historique(sql, (tx) => tx`UPDATE asset_files SET asset_id = ${bienX.id} WHERE id = ${docY}`);

    const { readRemediationInventory } = await import('@/services/security/cross-account/remediation');
    const inv = Object.fromEntries((await readRemediationInventory()).map((e) => [e.code, e]));
    expect(inv.DOC_ASSET.duo).toBeGreaterThanOrEqual(2);

    const { runCrossAccountRemediation } = await import('@/services/security/cross-account/remediation');
    const { openOpsClient } = await import('@/services/admin/ops/backfill/runner');
    const client = openOpsClient();
    try {
      const r = await runCrossAccountRemediation(client, { family: 'documents', apply: true, accountId: membre.id, reason: 'e2e duo' });
      expect(r.categories.find((c) => c.code === 'DOC_ASSET')!.duo).toBe(1);
      expect(r.corrected).toBe(0);
      const r2 = await runCrossAccountRemediation(client, { family: 'documents', apply: true, accountId: Y.id, reason: 'e2e move' });
      expect(r2.categories.find((c) => c.code === 'DOC_ASSET')!.duo).toBe(1);
      expect(r2.corrected).toBe(0);
    } finally {
      await client.end({ timeout: 5 });
    }
    // Rien modifié : le flux Duo / transfert reste seul compétent.
    expect((await sql`SELECT asset_id FROM asset_files WHERE id = ${docM}`)[0].asset_id).toBe(bienT.id);
    expect((await sql`SELECT asset_id FROM asset_files WHERE id = ${docY}`)[0].asset_id).toBe(bienX.id);
  });

  it('PO-D23-08 — partage légitime (compte partagé) : jamais candidat, jamais modifié, toujours visible du membre', async () => {
    const P = await compte(sql, make, 'PARTAGE');
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${P.acc.id}, ${membre.id}, 'member', 'active')`;
    await sql`INSERT INTO event_documents (event_id, file_id) VALUES (${P.evt}, ${P.fichier})`;
    await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id) VALUES (${P.equip}, ${P.fourn})`;
    const { readRemediationInventory } = await import('@/services/security/cross-account/remediation');
    const { openOpsClient } = await import('@/services/admin/ops/backfill/runner');
    const { runCrossAccountRemediation } = await import('@/services/security/cross-account/remediation');
    const client = openOpsClient();
    try {
      for (const family of ['documents', 'fournisseurs', 'evenements', 'agenda'] as const) {
        const r = await runCrossAccountRemediation(client, { family, apply: true, accountId: P.acc.id, reason: 'e2e partage' });
        expect(r.corrected + r.duo + r.undecidable, family).toBe(0);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
    expect((await readRemediationInventory()).length).toBeGreaterThan(0);
    expect(await sql`SELECT 1 FROM event_documents WHERE event_id = ${P.evt} AND file_id = ${P.fichier}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM equipment_suppliers WHERE equipment_id = ${P.equip} AND supplier_id = ${P.fourn}`).toHaveLength(1);
    as(P.acc, membre.id);
    const evd = await import('@/app/api/events/[eventId]/documents/route');
    expect((await (await evd.GET(req(`/api/events/${P.evt}/documents`), ctx('eventId', P.evt))).json()).count).toBe(1);
    const docs = await import('@/app/api/documents/route');
    const liste = await (await docs.GET(req(`/api/documents?assetId=${P.bien.id}`))).json() as { data: Array<{ id: number; asset: { name: string } | null }> };
    expect(liste.data.find((d) => d.id === P.fichier)?.asset?.name).toContain('PARTAGE-maison');
  });

  it('PO-D23-05 — inventaire qualifié, simulation (rien d’écrit), application par famille depuis le BO, contrôle revenu à 0, restauration', async () => {
    const { readRemediationInventory, REMEDIATION_FAMILIES } = await import('@/services/security/cross-account/remediation');
    const inv = Object.fromEntries((await readRemediationInventory(undefined, A.acc.id)).map((e) => [e.code, e]));
    const codes = ['DOC_ASSET', 'DOC_LINKED_ASSET', 'DOC_SUBSTRUCTURE', 'DOC_EQUIPMENT', 'DOC_ROOM_LEGACY', 'DOC_ASSET_LINK', 'DOC_SUPPLIER',
      'EQUIPMENT_SUPPLIER', 'EQUIPMENT_SUPPLIER_SOURCE', 'ASSET_SUPPLIER', 'EVENT_DOCUMENT', 'EVENT_TARGET', 'DEADLINE_TARGET', 'AGENDA_ASSET',
      'AGENDA_FILE', 'AGENDA_ROOM', 'AGENDA_EQUIPMENT', 'AGENDA_SOURCE', 'EVIDENCE_ASSET', 'EVIDENCE_SOURCE', 'FACT_SOURCE', 'AI_FIELD_UPDATE',
      'TO_PROCESS_TARGET', 'AI_JOB_PENDING'];
    for (const c of codes) {
      expect(inv[c]?.error, c).toBeUndefined();
      expect(inv[c]?.correctable, c).toBeGreaterThanOrEqual(1);
    }

    // BO : routes administrateur (rattrapage « cross-account »), comme l'exploitant.
    session.userId = adminId;
    session.currentAccountId = null;
    const { startBackfill, waitForBackfill, getBackfillRun } = await import('@/services/admin/ops/backfill/runner');
    const lancer = async (action: 'simulate' | 'apply' | 'restore', step: string | null, runId: string | null = null) => {
      const run = await startBackfill({ script: 'cross-account', action, step, runId, accountId: A.acc.id, reason: action === 'simulate' ? null : 'Recette D23 e2e' } as never, { id: adminId });
      await waitForBackfill(run.id);
      const fin = await getBackfillRun(run.id);
      expect(fin?.status, `${action} ${step} : ${fin?.error}`).toBe('succeeded');
      return fin!;
    };

    // Simulation : rapport exact, AUCUNE écriture.
    const empreinte = async () => (await sql`
      SELECT (SELECT count(*) FROM agenda_asset_links WHERE agenda_item_id = ${agendaA})::int AS liens,
             (SELECT asset_id FROM asset_files WHERE id = ${lies.bVersBienA}) AS doc,
             (SELECT count(*) FROM cross_account_remediations)::int AS journal`)[0];
    const avant = await empreinte();
    const simu = await lancer('simulate', 'agenda');
    expect(simu.summary?.headline).toMatch(/Simulation \(agenda\) : [1-9]\d* relation\(s\) à corriger/);
    expect(await empreinte()).toEqual(avant);

    // Application, famille par famille, avec motif (journal admin + journal ligne à ligne).
    const runs: Record<string, string> = {};
    for (const f of REMEDIATION_FAMILIES) {
      const r = await lancer('apply', f);
      expect(r.summary?.headline, f).toMatch(/Application/);
      if (r.summary?.scriptRunId) runs[f] = r.summary.scriptRunId;
    }
    expect(Object.keys(runs).sort()).toEqual([...REMEDIATION_FAMILIES].sort());
    const audit = await sql`SELECT 1 FROM admin_audit_log WHERE action_type = 'OPS_BACKFILL_APPLY' AND admin_user_id = ${adminId}`;
    expect(audit.length).toBeGreaterThanOrEqual(REMEDIATION_FAMILIES.length);

    // Contrôle : toutes les catégories revenues à 0 pour A et B.
    for (const acc of [A.acc.id, B.acc.id]) {
      const apres = Object.fromEntries((await readRemediationInventory(undefined, acc)).map((e) => [e.code, e]));
      for (const c of codes) expect(apres[c].total, `${c} compte ${acc}`).toBe(0);
    }

    // Chaque objet est resté dans son compte, rien n'a été supprimé d'un compte.
    const f = await sql<{ id: number; account_id: number; asset_id: number | null; linked_asset_id: number | null; substructure_id: number | null; equipment_id: number | null; linked_room_id: number | null; deleted_at: Date | null }[]>`
      SELECT id, account_id, asset_id, linked_asset_id, substructure_id, equipment_id, linked_room_id, deleted_at FROM asset_files WHERE id = ANY(${Object.values(lies)})`;
    expect(f).toHaveLength(Object.keys(lies).length);
    for (const x of f) {
      expect(x.deleted_at).toBeNull();
      expect([A.acc.id, B.acc.id]).toContain(x.account_id);
      expect([x.asset_id, x.linked_asset_id, x.substructure_id, x.equipment_id, x.linked_room_id]).toEqual([null, null, null, null, null]);
    }
    expect((await sql`SELECT status FROM document_asset_links WHERE file_id = ${B.fichier} AND account_id = ${A.acc.id}`)[0].status).toBe('REMOVED');
    expect((await sql`SELECT lifecycle_status FROM field_evidence WHERE account_id = ${A.acc.id} AND fingerprint = ${`fp-a-${A.acc.id}`}`)[0].lifecycle_status).toBe('WITHDRAWN');
    expect((await sql`SELECT status FROM ai_job_queue WHERE dedupe_key = ${`l53b-${A.acc.id}`}`)[0].status).toBe('CANCELLED');
    expect(await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${A.acc.id} AND target_id = ${B.fichier} AND resolution_reason = 'OBSOLETE'`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM equipment_suppliers WHERE equipment_id = ${A.equip2} AND supplier_id = ${A.fourn} AND source_document_id IS NULL`).toHaveLength(1);
    expect((await sql`SELECT equipment_id FROM events WHERE id = ${evtA2}`)[0].equipment_id).toBeNull();
    for (const t of [B.fourn, A.fourn]) expect(await sql`SELECT 1 FROM suppliers WHERE id = ${t}`).toHaveLength(1);

    // Restauration (réversible) : la famille « agenda » revient à l'identique, puis se recorrige.
    const resto = await lancer('restore', null, runs.agenda);
    expect(resto.summary?.headline).toMatch(/Restauration de .* : [1-9]\d* ligne\(s\)/);
    expect((await sql`SELECT count(*)::int AS n FROM agenda_asset_links WHERE agenda_item_id = ${agendaA} AND asset_id = ${B.bien.id}`)[0].n).toBe(1);
    expect((await sql`SELECT origin_ref_id FROM agenda_items WHERE id = ${agendaOrigineA}`)[0].origin_ref_id).toBe(B.fichier);
    const reinv = Object.fromEntries((await readRemediationInventory(undefined, A.acc.id)).map((e) => [e.code, e]));
    expect(reinv.AGENDA_ASSET.correctable).toBeGreaterThanOrEqual(1);
    await lancer('apply', 'agenda');
    // Restauration d'un changement de STATUT et d'une suppression (famille « preuves »).
    const rp = await lancer('restore', null, runs.preuves);
    expect(rp.summary?.conflicts.count).toBe(0);
    expect((await sql`SELECT lifecycle_status FROM field_evidence WHERE fingerprint = ${`fp-a-${A.acc.id}`}`)[0].lifecycle_status).not.toBe('WITHDRAWN');
    expect(await sql`SELECT 1 FROM document_facts WHERE account_id = ${A.acc.id} AND fact_key = 'BRAVO_FAIT' AND status = 'active'`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM ai_field_updates WHERE account_id = ${A.acc.id} AND asset_id = ${B.bien.id}`).toHaveLength(1);
    // Une restauration déjà faite ne se rejoue pas (journal marqué).
    const rp2 = await lancer('restore', null, runs.preuves);
    expect(rp2.summary?.headline).toMatch(/: 0 ligne\(s\)/);
    await lancer('apply', 'preuves');
    const fin = Object.fromEntries((await readRemediationInventory(undefined, A.acc.id)).map((e) => [e.code, e]));
    expect(fin.AGENDA_ASSET.correctable).toBe(0);
    expect(fin.AGENDA_SOURCE.correctable).toBe(0);
    expect(fin.EVIDENCE_ASSET.correctable).toBe(0);
    expect(fin.AI_FIELD_UPDATE.correctable).toBe(0);
  });

  it('PO-D23-10 — preuves après correction : balayage sans fuite, BO à 0 pour les catégories corrigées, journal visible', async () => {
    expect(sansFuite(await balayer(A, 'BRAVO'))).toEqual([]);
    expect(sansFuite(await balayer(B, 'ALPHA'))).toEqual([]);
    session.userId = adminId;
    const bo = await import('@/app/api/admin/ops/cross-account/route');
    const r = await bo.GET(req('/api/admin/ops/cross-account'));
    expect(r.status).toBe(200);
    const body = await r.json() as { inventory: Array<{ code: string; correctable: number }>; journal: Array<{ runId: string; rows: number }> | null; checks: Array<{ code: string; count: number; error?: string }> };
    expect(body.checks.filter((c) => c.error)).toEqual([]);
    expect(body.journal?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(body.journal!.reduce((n, j) => n + j.rows, 0)).toBeGreaterThan(0);
    // Ce qui reste n'est QUE du Duo (signalé) ou d'autres scénarios de la base : rien de A ni B.
    const { runCrossAccountRemediation, REMEDIATION_FAMILIES } = await import('@/services/security/cross-account/remediation');
    const { openOpsClient } = await import('@/services/admin/ops/backfill/runner');
    const client = openOpsClient();
    try {
      for (const family of REMEDIATION_FAMILIES) {
        for (const acc of [A.acc.id, B.acc.id]) {
          const s = await runCrossAccountRemediation(client, { family, apply: false, accountId: acc });
          expect(s.corrected + s.duo + s.undecidable, `${family} ${acc}`).toBe(0);
        }
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('PO-D23-07 — neutralisation des ÉCRITURES : supprimer son bien ou son compte n’emporte plus les données de l’autre compte', async () => {
    const C = await compte(sql, make, 'CHARLIE');
    const D = await compte(sql, make, 'DELTA');
    const docD = await doc(sql, make, D.acc, 'DELTA', 'sur-bien-c', null);
    const docD2 = await doc(sql, make, D.acc, 'DELTA', 'lie-bien-c', null);
    const docD3 = await doc(sql, make, D.acc, 'DELTA', 'piece-c', null);
    await sql`UPDATE asset_files SET s3_key = ${`e2e/d/${docD}.pdf`} WHERE id = ${docD}`;
    const [evD] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
      VALUES (${D.acc.id}, ${D.acc.ownerUserId}, ${D.bien.id}, 'entretien', 'DELTA-evt', now()) RETURNING id`;
    await historique(sql, async (tx) => {
      await tx`UPDATE asset_files SET asset_id = ${C.bien.id} WHERE id = ${docD}`;
      await tx`UPDATE asset_files SET linked_asset_id = ${C.bien.id} WHERE id = ${docD2}`;
      await tx`UPDATE asset_files SET asset_id = NULL, substructure_id = ${C.piece} WHERE id = ${docD3}`;
      await tx`UPDATE events SET asset_id = ${C.bien.id} WHERE id = ${evD.id}`;
    });
    // Récapitulatif avant suppression : rien de D compté.
    as(C.acc);
    const { getAssetDeletionSummary, deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    const resume = await getAssetDeletionSummary(C.bien.id);
    expect(resume.documents).toBe(1); // le seul document de C
    const res = await deleteAssetCompletely({ id: C.bien.id });
    expect(res.fileIds).not.toContain(docD);
    expect(res.fileIds).toContain(C.fichier);
    expect(await sql`SELECT 1 FROM pending_blob_deletions WHERE storage_path = ${`e2e/d/${docD}.pdf`}`).toHaveLength(0);
    const survivants = await sql<{ id: number; account_id: number; asset_id: number | null; linked_asset_id: number | null; substructure_id: number | null }[]>`
      SELECT id, account_id, asset_id, linked_asset_id, substructure_id FROM asset_files WHERE id = ANY(${[docD, docD2, docD3]}) ORDER BY id`;
    expect(survivants.map((s) => [s.account_id, s.asset_id, s.linked_asset_id, s.substructure_id])).toEqual([
      [D.acc.id, null, null, null], [D.acc.id, null, null, null], [D.acc.id, null, null, null],
    ]);
    expect((await sql`SELECT asset_id FROM events WHERE id = ${evD.id}`)[0]).toEqual({ asset_id: null });
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${C.fichier}`).toHaveLength(0); // règle produit inchangée pour C

    // Suppression d'un COMPTE (cascade SQL) : le document de l'autre compte survit aussi.
    const E = await compte(sql, make, 'ECHO');
    const docD4 = await doc(sql, make, D.acc, 'DELTA', 'sur-bien-e', null);
    await historique(sql, (tx) => tx`UPDATE asset_files SET asset_id = ${E.bien.id} WHERE id = ${docD4}`);
    await sql`DELETE FROM assets WHERE account_id = ${E.acc.id}`;
    expect((await sql`SELECT account_id, asset_id FROM asset_files WHERE id = ${docD4}`)[0]).toEqual({ account_id: D.acc.id, asset_id: null });
  });
});
