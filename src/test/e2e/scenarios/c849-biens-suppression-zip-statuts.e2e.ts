/**
 * Carte #849 (P1, pré-MEP) — Biens : suppression définitive sécurisée, ZIP
 * complet, statut Transmis et quotas — sur PostgreSQL réel, parcours HTTP
 * (routes) et services.
 *
 *   C849-A1  migration 2013 : VENDU / ARCHIVED / ancien DETRUIT → TRANSMIS,
 *            trace idempotente (ancien statut, motif, date), date de statut,
 *            données de vente et `updated_at` conservés, aucun événement,
 *            aucune Opération de cession inventée pour un ancien archivé ;
 *            rejouable ; contrainte à deux valeurs.
 *   C849-A2  quota des biens ACTIFS (création, remise en service, saturé,
 *            concurrence), TRANSMIS consultable (GET) et verrouillé en
 *            écriture (routes du bien, Agenda, document), Agenda courant et
 *            rappels sans les biens transmis, retour sans doublon.
 *   C849-B   suppression : inventaire supprimé / conservé, empreinte exigée
 *            (428) et revérifiée (409), documents / échéances / Agenda /
 *            Opérations PARTAGÉS conservés et détachés, exclusifs supprimés,
 *            purge des seuls objets exclusifs, autre compte et autre bien
 *            identiques (comptages PG avant / après, TCO), aucune référence
 *            restante au bien, double suppression / suppressions simultanées,
 *            échec DB → rien de détruit.
 *   C849-C   ZIP complet (Standard, Premium, Duo) : fichiers, versions,
 *            photos, Opérations, dépenses, relations, Unicode / doublons,
 *            liens web, manifeste et SHA-256 relus ; objet manquant ou
 *            corrompu → échec visible (jamais « prêt ») ; sélection du tiroir
 *            stricte ; confidentialité entre comptes.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import type { AccountRow } from '../factories';

const h = vi.hoisted(() => {
  process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
  process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
  process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
  process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';
  return {
    session: { userId: 0, currentAccountId: 0 as number | null },
    objets: new Map<string, Buffer>(),
    depots: new Map<string, Buffer>(),
  };
});

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    tryGetSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
    assertOwnership: () => undefined,
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// Stockage objet simulé : lecture des pièces (absente → erreur), dépôt du ZIP conservé pour relecture.
vi.mock('@/lib/s3-client', async (o) => ({
  ...(await o<object>()),
  s3Client: {
    send: async (cmd: { input?: { Key?: string } }) => {
      const key = String(cmd?.input?.Key ?? '');
      const b = h.objets.get(key);
      if (!b) throw Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });
      return { Body: (async function* corps() { yield new Uint8Array(b); })() };
    },
  },
}));
vi.mock('@/services/export-upload.service', async (o) => ({
  ...(await o<object>()),
  uploadExportFile: async (buffer: Buffer, key: string) => { h.depots.set(key, Buffer.from(buffer)); return key; },
}));
vi.mock('@/services/exports/export-support-notifier', () => ({ notifySupportOfExportFailure: async () => true }));
vi.mock('@/services/exports/v12/generation/rate-limit', async (o) => ({ ...(await o<object>()), exportRateLimitResponse: () => null }));

type Sql = Parameters<Parameters<typeof scenario>[2]>[0]['sql'];
type Json = Record<string, any>;

const req = (url: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://localhost${url}`, {
  method: init?.method ?? 'GET',
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
});
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const as = (acc: AccountRow) => { h.session.userId = acc.ownerUserId; h.session.currentAccountId = acc.id; };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const plusJours = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Document stocké (objet simulé présent, empreinte enregistrée). */
async function fichier(sql: Sql, acc: AccountRow, assetId: number | null, nom: string, over: { type?: string; contenu?: string; sansObjet?: boolean } = {}) {
  const contenu = Buffer.from(over.contenu ?? `contenu ${nom} ${Math.random()}`);
  const key = `e2e/${acc.id}/${Math.random().toString(36).slice(2)}/${nom}`;
  if (!over.sansObjet) h.objets.set(key, contenu);
  const [f] = await sql<{ id: number }[]>`
    INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, original_filename, retained_title, document_type, size, sha256_hash, upload_status)
    VALUES (${acc.ownerUserId}, ${acc.id}, ${assetId}, ${key}, ${nom.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf'}, ${nom}, ${nom.replace(/\.pdf$/, '')}, ${over.type ?? 'FACTURE'},
            ${contenu.length}, ${sha(contenu)}, 'COMPLETED') RETURNING id`;
  return { id: f.id, key, contenu };
}

/** Comptage par table des lignes d'un compte (tables à `account_id`) — preuve « rien d'autre n'est touché ». */
async function empreinteCompte(sql: Sql, accountId: number): Promise<Record<string, number>> {
  const tables = await sql<{ t: string }[]>`
    SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x
        ON x.table_name = c.table_name AND x.table_schema = c.table_schema AND x.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'account_id' ORDER BY 1`;
  const out: Record<string, number> = {};
  for (const { t } of tables) {
    const [r] = await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}" WHERE account_id = $1`, [accountId]);
    if (Number(r.n) > 0) out[t] = Number(r.n);
  }
  return out;
}

/** Lignes qui citent encore un bien (toute colonne *asset_id* d'une table de base). */
async function referencesAuBien(sql: Sql, assetId: number): Promise<string[]> {
  const cols = await sql<{ t: string; c: string }[]>`
    SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c JOIN information_schema.tables x
        ON x.table_name = c.table_name AND x.table_schema = c.table_schema AND x.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name IN ('asset_id', 'linked_asset_id', 'target_asset_id', 'duplicated_asset_id', 'copied_asset_id')
       AND c.data_type IN ('integer', 'bigint') ORDER BY 1, 2`;
  const out: string[] = [];
  for (const { t, c } of cols) {
    const [r] = await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}" WHERE "${c}" = $1`, [assetId]);
    if (Number(r.n) > 0) out.push(`${t}.${c}=${r.n}`);
  }
  return out;
}

scenario('C849', 'Biens — suppression définitive sécurisée, ZIP complet, statut Transmis et quotas (#849)', ({ sql, make }) => {
  beforeEach(() => { h.depots.clear(); });

  const opRepo = async (accountId: number, fn: (repo: any) => Promise<number>) => {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(accountId, fn as never) as unknown as Promise<number>;
  };
  const creerOp = (acc: AccountRow, p: { fileId: number; assets: number[]; montants: Array<{ assetId: number | null; cents: number }>; label: string }) =>
    opRepo(acc.id, async (repo) => {
      const r = await repo.create({
        type: { code: 'INTERVENTION' }, status: 'REALIZED', realizedDate: '2026-01-05', technicalLabel: p.label,
        source: { kind: 'DOCUMENT', entityKey: p.fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: p.assets.map((assetId, i) => ({ assetId, role: i === 0 ? 'PRIMARY' : 'CONCERNED', authority: 'DOCUMENT' })),
        reasonCode: 'E2E_C849',
      });
      for (const [i, m] of p.montants.entries()) {
        await repo.addFinancialComponent(r.id, {
          kind: 'REALIZED_COST', amountMinor: m.cents, currency: 'EUR', amountEurCents: m.cents, economicDate: '2026-01-05',
          targetAssetId: m.assetId, sources: [{ sourceId: r.sourceId }], fingerprint: `c849-${r.id}-${i}`,
        }, 'E2E_C849');
      }
      return r.id;
    });

  // ── A1 : migration des statuts ───────────────────────────────────────────

  it('C849-A1 — migration 2013 : quatre statuts → deux, trace idempotente, ventes et dates conservées, aucun faux événement', async () => {
    const acc = await make.account({ plan: 'premium' });
    await sql`ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check`;
    const kcVente = JSON.stringify({ saleDate: '2025-03-01', salePrice: 12000, saleDate__origin: 'USER', salePrice__origin: 'USER' });
    const biens: Record<string, number> = {};
    for (const [st, reason, kc] of [['EN_SERVICE', null, null], ['VENDU', null, kcVente], ['ARCHIVED', 'user', null], ['DETRUIT', null, null], ['TRANSMIS', 'transmitted', null]] as const) {
      const b = await make.asset(acc, { name: `c849-${st}`, ...(kc ? { keyCharacteristics: JSON.parse(kc) } : {}) });
      await sql`UPDATE assets SET status = ${st}, archived_reason = ${reason} WHERE id = ${b.id}`;
      // Date du statut posée APRÈS (le déclencheur date chaque changement de statut).
      await sql`UPDATE assets SET status_changed_at = '2024-06-01T10:00:00Z', updated_at = '2024-06-02T10:00:00Z' WHERE id = ${b.id}`;
      biens[st] = b.id;
    }
    const avant = await sql<Json[]>`SELECT id, key_characteristics, updated_at::text AS u FROM assets WHERE account_id = ${acc.id} ORDER BY id`;
    const compter = async () => (await sql<{ a: number; o: number; n: number }[]>`
      SELECT (SELECT count(*)::int FROM agenda_items WHERE account_id = ${acc.id}) AS a,
             (SELECT count(*)::int FROM business_operations WHERE account_id = ${acc.id}) AS o,
             (SELECT count(*)::int FROM notification_outbox WHERE account_id = ${acc.id}) AS n`)[0];
    const evenementsAvant = await compter();

    const fichier2013 = await readFile(join(process.cwd(), 'src/db/migrations/2013_c849_statuts_bien_deux_valeurs.sql'), 'utf8');
    const runner = sql as unknown as SqlRunner;
    await runMigrationSql(runner, fichier2013);
    await runMigrationSql(runner, fichier2013); // rejouable

    const apres = await sql<Json[]>`SELECT id, status, archived_reason, (status_changed_at AT TIME ZONE 'UTC')::text AS sc, key_characteristics, updated_at::text AS u FROM assets WHERE account_id = ${acc.id} ORDER BY id`;
    const par = new Map(apres.map((r) => [Number(r.id), r]));
    expect(par.get(biens.EN_SERVICE)!.status).toBe('EN_SERVICE');
    for (const st of ['VENDU', 'ARCHIVED', 'DETRUIT', 'TRANSMIS']) {
      expect(par.get(biens[st])!.status, st).toBe('TRANSMIS');
      expect(par.get(biens[st])!.sc, `date du statut conservée (${st})`).toMatch(/^2024-06-01 10:00:00/);
    }
    expect(par.get(biens.ARCHIVED)!.archived_reason).toBe('user');
    for (const r of avant) {
      expect(par.get(Number(r.id))!.key_characteristics, 'données de vente conservées').toEqual(r.key_characteristics);
      expect(par.get(Number(r.id))!.u, 'aucune fausse date de modification').toBe(r.u);
    }
    const traces = await sql<Json[]>`
      SELECT asset_id, old_value, new_value, origin, outcome FROM canonical_field_writes
       WHERE account_id = ${acc.id} AND source_type = 'MIGRATION' AND source_id = '2013_c849_statuts_bien' ORDER BY asset_id`;
    expect(traces.map((t) => [Number(t.asset_id), t.old_value.status])).toEqual([
      [biens.VENDU, 'VENDU'], [biens.ARCHIVED, 'ARCHIVED'], [biens.DETRUIT, 'DETRUIT'],
    ]);
    expect(traces.find((t) => Number(t.asset_id) === biens.ARCHIVED)!.old_value).toMatchObject({ archivedReason: 'user' });
    expect(await compter(), 'aucun événement, aucune Opération, aucune notification créés').toEqual(evenementsAvant);
    const [{ def }] = await sql<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'assets_status_check'`;
    expect(def).toContain(`'EN_SERVICE'`);
    expect(def).toContain(`'TRANSMIS'`);
    expect(def).not.toMatch(/VENDU|ARCHIVED/);
    expect(await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${biens.EN_SERVICE}`.catch((e) => e.code)).toBe('23514');

    // Opération de cession : ancien VENDU chiffré → vente (prix conservé) ; ancien archivé → AUCUNE cession.
    const { loadAssetDataRow } = await import('@/services/business-operations/consolidation/consolidator');
    const { assetDataFacts } = await import('@/services/business-operations/consolidation/asset-data');
    const { db } = await import('@/db');
    const lire = (id: number) => db.transaction((tx) => loadAssetDataRow(tx, acc.id, id));
    expect(assetDataFacts((await lire(biens.VENDU))!).DISPOSAL).toMatchObject({ amountMinor: 1200000, disposalKind: 'SALE', date: '2025-03-01' });
    expect(assetDataFacts((await lire(biens.ARCHIVED))!).DISPOSAL).toBeNull();
    expect(assetDataFacts((await lire(biens.DETRUIT))!).DISPOSAL).toBeNull();
    expect(assetDataFacts((await lire(biens.TRANSMIS))!).DISPOSAL).toMatchObject({ disposalKind: 'TRANSMISSION', amountMinor: null });
  });

  // ── A2 : quota des biens actifs, lecture seule, Agenda ────────────────────

  it('C849-A2a — quota : seuls les biens EN_SERVICE comptent ; remise en service libre / saturée ; courses sérialisées', async () => {
    const acc = await make.account({ plan: 'standard' }); // Standard : 2 biens actifs
    const a = await make.asset(acc, { name: 'c849-q-a' });
    const b = await make.asset(acc, { name: 'c849-q-b' });
    const t = await make.asset(acc, { name: 'c849-q-t' });
    await sql`UPDATE assets SET status = 'TRANSMIS' WHERE id = ${t.id}`;
    const { countAccountAssets } = await import('@/lib/asset-quota-guard');
    expect(await countAccountAssets(acc.id)).toBe(2);
    as(acc);
    const { POST: reactiver } = await import('@/app/api/assets/[id]/reactivate/route');
    const sature = await reactiver(req(`/api/assets/${t.id}/reactivate`, { method: 'POST' }), ctx(t.id));
    expect(sature.status).toBe(403);
    expect((await sature.json()).code).toBe('ASSET_QUOTA_REACHED');
    expect((await sql`SELECT status FROM assets WHERE id = ${t.id}`)[0].status).toBe('TRANSMIS');

    // Transmettre a libère une place : le bien transmis compte hors quota.
    await sql`UPDATE assets SET status = 'TRANSMIS' WHERE id = ${a.id}`;
    const { checkAssetCreationAllowed } = await import('@/services/assets/asset-write.facade');
    expect(await checkAssetCreationAllowed(acc.id)).toEqual({ ok: true });

    // Une seule place : deux remises en service simultanées → une seule réussit, aucun dépassement.
    const [r1, r2] = await Promise.all([
      reactiver(req(`/api/assets/${t.id}/reactivate`, { method: 'POST' }), ctx(t.id)),
      reactiver(req(`/api/assets/${a.id}/reactivate`, { method: 'POST' }), ctx(a.id)),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 403]);
    expect(await countAccountAssets(acc.id)).toBe(2);

    // Création et remise en service simultanées sur la dernière place : une seule passe.
    const restant = (await sql<{ id: number }[]>`SELECT id FROM assets WHERE account_id = ${acc.id} AND status = 'TRANSMIS' ORDER BY id`)[0].id;
    await sql`UPDATE assets SET status = 'TRANSMIS' WHERE id = ${b.id}`;
    const { createAssetForAccount } = await import('@/services/assets/asset-write.facade');
    const [c1, c2] = await Promise.all([
      createAssetForAccount({ accountId: acc.id, userId: acc.ownerUserId }, { category: 'VEHICULE', name: 'c849-q-nouveau' }),
      reactiver(req(`/api/assets/${restant}/reactivate`, { method: 'POST' }), ctx(restant)),
    ]);
    const succes = [c1.ok === true, c2.status === 200].filter(Boolean).length;
    expect(succes).toBe(1);
    expect(await countAccountAssets(acc.id)).toBe(2);
    // Idempotence : déjà en service.
    const actif = (await sql<{ id: number }[]>`SELECT id FROM assets WHERE account_id = ${acc.id} AND status = 'EN_SERVICE' ORDER BY id LIMIT 1`)[0].id;
    const deja = await reactiver(req(`/api/assets/${actif}/reactivate`, { method: 'POST' }), ctx(actif));
    expect(await deja.json()).toMatchObject({ alreadyActive: true });
  });

  it('C849-A2b — bien TRANSMIS : GET autorisés, écritures refusées (fiche, statut, Agenda, document) ; suppression permise', async () => {
    const acc = await make.account({ plan: 'premium' });
    const t = await make.asset(acc, { name: 'c849-ro' });
    const doc = await fichier(sql, acc, t.id, 'ro.pdf');
    await sql`UPDATE assets SET status = 'TRANSMIS' WHERE id = ${t.id}`;
    as(acc);
    const { GET: details } = await import('@/app/api/assets/[id]/details/route');
    const { GET: overview } = await import('@/app/api/assets/[id]/overview/route');
    expect((await details(req(`/api/assets/${t.id}/details`), ctx(t.id))).status).toBe(200);
    expect((await overview(req(`/api/assets/${t.id}/overview`), ctx(t.id))).status).toBe(200);

    const route = await import('@/app/api/assets/route');
    const patch = await route.PATCH(req(`/api/assets?id=${t.id}`, { method: 'PATCH', body: { status: 'EN_SERVICE' } }));
    expect(patch.status).toBe(403);
    expect((await patch.json()).code).toBe('ASSET_READ_ONLY');
    const put = await route.PUT(req(`/api/assets?id=${t.id}`, { method: 'PUT', body: { name: 'renommé' } }));
    expect(put.status).toBe(403);
    expect((await sql`SELECT name, status FROM assets WHERE id = ${t.id}`)[0]).toMatchObject({ name: 'c849-ro', status: 'TRANSMIS' });

    const { updateAssetDetails } = await import('@/services/asset-details-write.service');
    await expect(updateAssetDetails({ assetId: t.id, accountId: acc.id, section: 'common', fields: { name: 'x' }, actorUserId: acc.ownerUserId } as never))
      .rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', details: { reason: 'TRANSMIS' } });

    const { POST: agendaPost } = await import('@/app/api/agenda/route');
    const ag = await agendaPost(req('/api/agenda', { method: 'POST', body: { title: 'Contrôle', startDate: plusJours(5), assetIds: [t.id] } }));
    expect(ag.status).toBe(403);
    const { PUT: docPut } = await import('@/app/api/documents/[id]/route');
    const dp = await docPut(req(`/api/documents/${doc.id}`, { method: 'PUT', body: { retainedTitle: 'autre' } }), { params: Promise.resolve({ id: String(doc.id) }) });
    expect(dp.status).toBe(403);
    // « Supprimer définitivement » reste disponible depuis un bien transmis.
    const { GET: resume } = await import('@/app/api/assets/[id]/deletion-summary/route');
    const inv = await (await resume(req(`/api/assets/${t.id}/deletion-summary`), ctx(t.id))).json();
    const del = await route.DELETE(req(`/api/assets?id=${t.id}&inventory=${inv.fingerprint}`, { method: 'DELETE' }));
    expect(del.status).toBe(200);
    expect(await sql`SELECT id FROM assets WHERE id = ${t.id}`).toEqual([]);
  });

  it('C849-A2c — Agenda et rappels : bien transmis absent de l’Agenda courant et des rappels, partagé conservé, retour sans doublon ni rétroactif', async () => {
    const acc = await make.account({ plan: 'premium' });
    const t = await make.asset(acc, { name: 'c849-ag-t' });
    const y = await make.asset(acc, { name: 'c849-ag-y' });
    const seul = await make.agendaItem(acc, { title: 'c849-seul', startDate: plusJours(3), assetIds: [t.id] });
    const partage = await make.agendaItem(acc, { title: 'c849-partage', startDate: plusJours(3), assetIds: [t.id, y.id] });
    const passe = await make.agendaItem(acc, { title: 'c849-passe', startDate: plusJours(-2), assetIds: [t.id] });
    await sql`UPDATE agenda_items SET home_category = 'action' WHERE id IN (${seul.id}, ${partage.id}, ${passe.id})`;
    await sql`UPDATE assets SET status = 'TRANSMIS' WHERE id = ${t.id}`;

    const { getAgendaItems, getHomepageAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    const courant = (await getAgendaItems({ accountId: acc.id })).map((i) => i.id);
    expect(courant).toContain(partage.id);
    expect(courant).not.toContain(seul.id);
    expect((await getHomepageAgendaItems(acc.id)).map((i) => i.id)).not.toContain(seul.id);
    // Historique du bien : consultable.
    expect((await getAgendaItems({ accountId: acc.id, assetIds: [t.id] })).map((i) => i.id)).toEqual(expect.arrayContaining([seul.id, partage.id, passe.id]));

    const { runDeadlineReminders } = await import('@/lib/notifications/scheduled/deadlines');
    const couverts = async () => (await sql<{ id: number; n: number }[]>`
      SELECT agenda_item_id AS id, count(*)::int AS n FROM agenda_deadline_reminders
       WHERE account_id = ${acc.id} AND state <> 'cancelled' GROUP BY 1 ORDER BY 1`).map((r) => [Number(r.id), Number(r.n)]);
    await runDeadlineReminders(new Date());
    const avant = new Map(await couverts() as Array<[number, number]>);
    expect(avant.has(seul.id), 'aucun rappel pour un bien transmis').toBe(false);
    expect(avant.has(passe.id)).toBe(false);

    as(acc);
    const { POST: reactiver } = await import('@/app/api/assets/[id]/reactivate/route');
    expect((await reactiver(req(`/api/assets/${t.id}/reactivate`, { method: 'POST' }), ctx(t.id))).status).toBe(200);
    expect((await getAgendaItems({ accountId: acc.id })).map((i) => i.id)).toContain(seul.id);
    await runDeadlineReminders(new Date());
    await runDeadlineReminders(new Date());
    const apres = new Map(await couverts() as Array<[number, number]>);
    expect(apres.has(passe.id), 'aucun rappel rétroactif').toBe(false);
    for (const [, n] of apres) expect(n, 'aucun rappel en double').toBe(1);
    expect(avant.get(partage.id), 'échéance partagée avec un bien actif : rappel maintenu').toBe(1);
    expect(apres.get(partage.id)).toBe(1);
    expect(apres.get(seul.id), 'échéance future remise au suivi').toBe(1);
  });

  // ── B : suppression définitive ────────────────────────────────────────────

  it('C849-B1 — inventaire, empreinte exigée (428) et revérifiée (409), partagé conservé, exclusif supprimé, autre compte / autre bien intacts', async () => {
    const acc = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const x = await make.asset(acc, { name: 'c849-x', category: 'IMMOBILIER' });
    const y = await make.asset(acc, { name: 'c849-y', category: 'IMMOBILIER' });
    const z = await make.asset(autre, { name: 'c849-z', category: 'IMMOBILIER' });
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${x.id}, 'c849-chaudiere') RETURNING id`;
    await sql`INSERT INTO substructures (asset_id, name) VALUES (${x.id}, 'c849-salon')`;
    const exclusif = await fichier(sql, acc, x.id, 'exclusif.pdf');
    await sql`INSERT INTO document_versions (file_id, account_id, user_id, version_number, s3_key, s3_bucket, s3_region, file_size, sha256_hash, is_current_version)
              VALUES (${exclusif.id}, ${acc.id}, ${acc.ownerUserId}, 1, ${`${exclusif.key}.v1`}, 'b', 'r', 3, 'x', false)`;
    const partage = await fichier(sql, acc, x.id, 'partage.pdf');
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${acc.id}, ${partage.id}, ${y.id}, 'SECONDARY', 'USER', 'ACTIVE')`;
    const deY = await fichier(sql, acc, y.id, 'de-y.pdf');
    await sql`UPDATE asset_files SET linked_asset_id = ${x.id} WHERE id = ${deY.id}`;
    const photo = await fichier(sql, acc, x.id, 'photo.jpg');
    await sql`INSERT INTO asset_photos (asset_id, user_id, file_id, is_primary) VALUES (${x.id}, ${acc.ownerUserId}, ${photo.id}, true)`;
    const [evtPartage] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, linked_asset_id, categorie, titre, date_evenement)
      VALUES (${acc.id}, ${acc.ownerUserId}, ${x.id}, ${y.id}, 'entretien', 'c849-evt-partage', now()) RETURNING id`;
    const [evtSeul] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement)
      VALUES (${acc.id}, ${acc.ownerUserId}, ${x.id}, 'entretien', 'c849-evt-seul', now()) RETURNING id`;
    const agSeul = await make.agendaItem(acc, { title: 'c849-ag-seul', startDate: '2026-02-01', assetIds: [x.id] });
    const agPartage = await make.agendaItem(acc, { title: 'c849-ag-partage', startDate: '2026-02-01', assetIds: [x.id, y.id] });
    const opX = await creerOp(acc, { fileId: exclusif.id, assets: [x.id], montants: [{ assetId: x.id, cents: 50000 }], label: 'c849-op-x' });
    const opXY = await creerOp(acc, { fileId: partage.id, assets: [x.id, y.id], montants: [{ assetId: x.id, cents: 10000 }, { assetId: y.id, cents: 20000 }], label: 'c849-op-xy' });
    const [exp] = await sql<{ id: number }[]>`
      INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status, output_payload)
      VALUES (${x.id}, ${acc.id}, ${acc.ownerUserId}, 'EXPORT_BRUT', 'ready', ${JSON.stringify({ zipS3Key: `exports/${x.id}/a.zip` })}) RETURNING id`;
    // Autre compte : document qui porte la même clé de stockage que le document partagé (jamais purgé).
    await fichier(sql, autre, z.id, 'z.pdf');

    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const tcoY = JSON.stringify((await readAssetTco(acc.id, y.id, { today: '2026-06-01' })).summary);
    const compteAutreAvant = await empreinteCompte(sql, autre.id);
    const yAvant = await sql`SELECT id, name, status, key_characteristics FROM assets WHERE id = ${y.id}`;

    as(acc);
    const { GET: resume } = await import('@/app/api/assets/[id]/deletion-summary/route');
    const inv = await (await resume(req(`/api/assets/${x.id}/deletion-summary`), ctx(x.id))).json();
    expect(inv).toMatchObject({
      documents: 1, documentVersions: 1, photos: 1, equipments: 1, rooms: 1, events: 1, agendaItems: 1, operations: 1, expenses: 2, exports: 1,
      shared: { documents: 2, agendaItems: 1, operations: 1, events: 1 },
    });
    expect(inv.fingerprint).toMatch(/^[0-9a-f]{32}$/);

    const route = await import('@/app/api/assets/route');
    // Suppression aveugle (sans inventaire confirmé) : refusée, rien n'est détruit.
    const aveugle = await route.DELETE(req(`/api/assets?id=${x.id}`, { method: 'DELETE' }));
    expect(aveugle.status).toBe(428);
    expect((await aveugle.json()).code).toBe('DELETION_INVENTORY_REQUIRED');
    // Nouveau rattachement entre l'affichage et la confirmation : 409, rien n'est détruit.
    const tardif = await fichier(sql, acc, x.id, 'tardif.pdf');
    const perime = await route.DELETE(req(`/api/assets?id=${x.id}&inventory=${inv.fingerprint}`, { method: 'DELETE' }));
    expect(perime.status).toBe(409);
    expect((await perime.json()).code).toBe('DELETION_INVENTORY_CHANGED');
    expect((await sql`SELECT count(*)::int AS n FROM asset_files WHERE asset_id = ${x.id}`)[0].n).toBe(4);
    expect(await sql`SELECT id FROM pending_blob_deletions WHERE storage_path = ${exclusif.key}`).toEqual([]);

    const inv2 = await (await resume(req(`/api/assets/${x.id}/deletion-summary`), ctx(x.id))).json();
    expect(inv2.documents).toBe(2);
    const ok = await route.DELETE(req(`/api/assets?id=${x.id}&inventory=${inv2.fingerprint}`, { method: 'DELETE' }));
    expect(ok.status).toBe(200);

    // Supprimés : bien, document exclusif et sa version, photo, équipement, pièce, événement seul, agenda seul, Opération seule, export.
    expect(await sql`SELECT id FROM assets WHERE id = ${x.id}`).toEqual([]);
    expect(await sql`SELECT id FROM asset_files WHERE id IN (${exclusif.id}, ${tardif.id}, ${photo.id})`).toEqual([]);
    expect(await sql`SELECT id FROM events WHERE id = ${evtSeul.id}`).toEqual([]);
    expect(await sql`SELECT id FROM agenda_items WHERE id = ${agSeul.id}`).toEqual([]);
    expect(await sql`SELECT id FROM business_operations WHERE id = ${opX}`).toEqual([]);
    expect(await sql`SELECT id FROM business_operation_financial_components WHERE operation_id = ${opX}`).toEqual([]);
    expect(await sql`SELECT id FROM export_generation WHERE id = ${exp.id}`).toEqual([]);
    expect(await sql`SELECT id FROM equipments WHERE id = ${eq.id}`).toEqual([]);
    // Conservés : documents partagés (confiés à Y), événement et agenda partagés, Opération multi-biens et ventilation de Y.
    expect((await sql`SELECT asset_id, linked_asset_id FROM asset_files WHERE id = ${partage.id}`)[0]).toEqual({ asset_id: y.id, linked_asset_id: null });
    expect((await sql`SELECT asset_id, linked_asset_id FROM asset_files WHERE id = ${deY.id}`)[0]).toEqual({ asset_id: y.id, linked_asset_id: null });
    expect((await sql`SELECT asset_id, linked_asset_id FROM events WHERE id = ${evtPartage.id}`)[0]).toEqual({ asset_id: y.id, linked_asset_id: null });
    expect((await sql`SELECT l.asset_id FROM agenda_asset_links l WHERE l.agenda_item_id = ${agPartage.id}`).map((r) => r.asset_id)).toEqual([y.id]);
    expect((await sql`SELECT id FROM business_operations WHERE id = ${opXY} AND invalidated_at IS NULL`).length).toBe(1);
    expect(Number((await sql`SELECT amount_minor FROM business_operation_financial_components WHERE operation_id = ${opXY} AND active AND target_asset_id = ${y.id}`)[0].amount_minor)).toBe(20000);
    // Purge : seulement les objets exclusifs (document, version, photo, export), jamais un objet conservé.
    const purge = (await sql<{ p: string }[]>`SELECT storage_path AS p FROM pending_blob_deletions WHERE processed_at IS NULL`).map((r) => r.p);
    expect(purge).toEqual(expect.arrayContaining([exclusif.key, `${exclusif.key}.v1`, photo.key, tardif.key, `exports/${x.id}/a.zip`]));
    expect(purge).not.toContain(partage.key);
    expect(purge).not.toContain(deY.key);
    // Aucune ligne ne cite plus le bien supprimé ; autre compte et autre bien identiques ; TCO de Y identique.
    expect(await referencesAuBien(sql, x.id)).toEqual([]);
    expect(await empreinteCompte(sql, autre.id)).toEqual(compteAutreAvant);
    expect(await sql`SELECT id, name, status, key_characteristics FROM assets WHERE id = ${y.id}`).toEqual(yAvant);
    expect(JSON.stringify((await readAssetTco(acc.id, y.id, { today: '2026-06-01' })).summary)).toBe(tcoY);

    // Double clic : la seconde demande constate la suppression, sans erreur.
    const encore = await route.DELETE(req(`/api/assets?id=${x.id}&inventory=${inv2.fingerprint}`, { method: 'DELETE' }));
    expect(encore.status).toBe(200);
  });

  it('C849-B2 — suppressions simultanées, échec en base → rien de détruit, autre compte jamais visé', async () => {
    const acc = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const x = await make.asset(acc, { name: 'c849-b2' });
    const f = await fichier(sql, acc, x.id, 'b2.pdf');
    const { deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    const { getAssetDeletionInventory } = await import('@/services/assets/asset-deletion.service');

    // Échec en base au moment de supprimer le bien : transaction annulée, rien de détruit, rien en purge.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION c849_refus() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.name = 'c849-b2' THEN RAISE EXCEPTION 'échec simulé'; END IF; RETURN OLD; END $$`);
    await sql.unsafe(`CREATE TRIGGER c849_refus BEFORE DELETE ON assets FOR EACH ROW EXECUTE FUNCTION c849_refus()`);
    const echec = await deleteAssetCompletely({ id: x.id }).then(() => null, (e: Error & { cause?: Error }) => `${e.message} ${e.cause?.message ?? ''}`);
    expect(echec).toMatch(/échec simulé/);
    await sql.unsafe(`DROP TRIGGER c849_refus ON assets; DROP FUNCTION c849_refus()`);
    expect((await sql`SELECT count(*)::int AS n FROM asset_files WHERE id = ${f.id}`)[0].n).toBe(1);
    expect(await sql`SELECT id FROM pending_blob_deletions WHERE storage_path = ${f.key}`).toEqual([]);

    // Deux suppressions simultanées : une supprime, l'autre constate — aucune erreur, une seule purge.
    const inv = await getAssetDeletionInventory(x.id);
    const [r1, r2] = await Promise.all([
      deleteAssetCompletely({ id: x.id }, { expectedFingerprint: inv!.fingerprint }),
      deleteAssetCompletely({ id: x.id }, { expectedFingerprint: inv!.fingerprint }),
    ]);
    expect([r1.alreadyDeleted === true, r2.alreadyDeleted === true].filter(Boolean).length).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM pending_blob_deletions WHERE storage_path = ${f.key}`)[0].n).toBe(1);

    // Bien d'un autre compte : 403, rien de supprimé.
    const z = await make.asset(autre, { name: 'c849-b2-z' });
    as(acc);
    const route = await import('@/app/api/assets/route');
    const r = await route.DELETE(req(`/api/assets?id=${z.id}&inventory=abc`, { method: 'DELETE' }));
    expect(r.status).toBe(403);
    expect((await sql`SELECT id FROM assets WHERE id = ${z.id}`).length).toBe(1);
  });

  // ── C : ZIP complet ───────────────────────────────────────────────────────

  async function bienComplet(plan: 'standard' | 'premium' | 'premium_duo') {
    const acc = await make.account({ plan });
    const x = await make.asset(acc, { name: `c849-zip-${plan}`, category: 'IMMOBILIER' });
    const y = await make.asset(acc, { name: `c849-zip-autre-${plan}`, category: 'IMMOBILIER' });
    const d1 = await fichier(sql, acc, x.id, 'Facture été.pdf');
    const d2 = await fichier(sql, acc, x.id, 'Facture été.pdf'); // même nom : jamais écrasé
    const v = Buffer.from('ancienne version');
    h.objets.set(`${d1.key}.v1`, v);
    await sql`INSERT INTO document_versions (file_id, account_id, user_id, version_number, s3_key, s3_bucket, s3_region, file_size, sha256_hash, is_current_version)
              VALUES (${d1.id}, ${acc.id}, ${acc.ownerUserId}, 1, ${`${d1.key}.v1`}, 'b', 'r', ${v.length}, ${sha(v)}, false)`;
    const ph = await fichier(sql, acc, x.id, 'photo.jpg');
    await sql`INSERT INTO asset_photos (asset_id, user_id, file_id, is_primary) VALUES (${x.id}, ${acc.ownerUserId}, ${ph.id}, true)`;
    await sql`INSERT INTO asset_files (user_id, account_id, asset_id, is_web_link, web_link_url, web_link_title, upload_status)
              VALUES (${acc.ownerUserId}, ${acc.id}, ${x.id}, true, 'https://exemple.fr/notice', 'Notice', 'COMPLETED')`;
    const op = await creerOp(acc, { fileId: d1.id, assets: [x.id, y.id], montants: [{ assetId: x.id, cents: 12345 }, { assetId: y.id, cents: 999 }], label: 'c849-zip-op' });
    await make.agendaItem(acc, { title: 'c849-zip-rdv', startDate: '2027-01-10', assetIds: [x.id] });
    return { acc, x, y, d1, d2, ph, op };
  }

  const exporter = async (acc: AccountRow, assetId: number, body: Json) => {
    as(acc);
    const { POST } = await import('@/app/api/assets/[id]/exports/route');
    const res = await POST(req(`/api/assets/${assetId}/exports`, { method: 'POST', body }), ctx(assetId));
    return { status: res.status, json: await res.json() as Json };
  };

  it('C849-C1 — ZIP complet identique pour Standard, Premium et Duo : fichiers, versions, photos, Opérations, dépenses, relations, manifeste vérifié', async () => {
    const comptes: Json[] = [];
    for (const plan of ['standard', 'premium', 'premium_duo'] as const) {
      const b = await bienComplet(plan);
      const r = await exporter(b.acc, b.x.id, { exportType: 'EXPORT_BRUT', options: { complete: true } });
      expect(r.status, plan).toBe(200);
      expect(r.json.archive).toMatchObject({ scope: 'complete', status: 'COMPLETE' });
      const [row] = await sql<Json[]>`SELECT status, output_payload FROM export_generation WHERE public_id = ${r.json.publicId}`;
      expect(row.status).toBe('ready');
      const key = JSON.parse(row.output_payload).zipS3Key;
      const buf = h.depots.get(key)!;
      expect(sha(buf)).toBe(r.json.archive.sha256);
      const zip = await JSZip.loadAsync(buf);
      const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
      expect(manifest.status).toBe('COMPLETE');
      expect(manifest.missing).toEqual([]);
      for (const f of manifest.files) {
        const data = await zip.file(f.path)!.async('nodebuffer');
        expect(sha(data), f.path).toBe(f.sha256);
      }
      const noms = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
      expect(noms).toEqual(expect.arrayContaining([
        'LISEZMOI.txt', 'manifest.json', 'recap_donnees.txt', 'donnees/bien.json', 'donnees/documents.csv', 'donnees/operations.csv',
        'donnees/depenses.csv', 'donnees/relations.csv', 'donnees/agenda.csv', 'donnees/liens_web.csv', 'donnees/versions.csv',
        'documents/FACTURE/Facture été.pdf', 'documents/FACTURE/Facture été (2).pdf', `documents/versions/${b.d1.id}/Facture été (v1).pdf`,
        'photos/photo_1_principale.jpg',
      ]));
      expect(await zip.file('documents/FACTURE/Facture été.pdf')!.async('nodebuffer')).toEqual(b.d1.contenu);
      const depenses = await zip.file('donnees/depenses.csv')!.async('string');
      expect(depenses).toContain('12345');
      expect(depenses, 'ventilation d’un autre bien jamais exportée').not.toContain(';999;');
      expect(manifest.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'depenses', motif: 'VENTILATION_D_UN_AUTRE_BIEN' })]));
      expect(await zip.file('donnees/operations.csv')!.async('string')).toContain(String(b.op));
      expect(await zip.file('donnees/liens_web.csv')!.async('string')).toContain('https://exemple.fr/notice');
      const relations = await zip.file('donnees/relations.csv')!.async('string');
      expect(relations).toContain(`operation;${b.op};asset;${b.x.id}`);
      expect(relations).not.toContain(`;asset;${b.y.id}`);
      expect(await zip.file('LISEZMOI.txt')!.async('string')).toContain('ne peut pas être réimportée');
      comptes.push(manifest.categories);
    }
    expect(comptes[1]).toEqual(comptes[0]);
    expect(comptes[2]).toEqual(comptes[0]);
  });

  it('C849-C2 — objet manquant ou corrompu : échec VISIBLE (jamais prêt), détail des manquants ; sélection stricte ; autre compte refusé', async () => {
    const b = await bienComplet('premium');
    h.objets.delete(b.d2.key);
    const r = await exporter(b.acc, b.x.id, { exportType: 'EXPORT_BRUT', options: { complete: true } });
    expect(r.status).toBe(500);
    expect(r.json.detailCode).toBe('EXPORT_INCOMPLETE');
    expect(r.json.details.missing).toEqual([expect.objectContaining({ category: 'documents', id: b.d2.id, motif: 'OBJET_ILLISIBLE' })]);
    const [row] = await sql<Json[]>`SELECT status, error_payload FROM export_generation WHERE public_id = ${r.json.publicId}`;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.error_payload).missing).toHaveLength(1);
    expect(h.depots.size, 'aucune archive incomplète déposée').toBe(0);

    // Corrompu : empreinte différente de celle enregistrée.
    h.objets.set(b.d2.key, Buffer.from('altéré'));
    const c = await exporter(b.acc, b.x.id, { exportType: 'EXPORT_BRUT', options: { complete: true } });
    expect(c.status).toBe(500);
    expect(c.json.details.missing[0]).toMatchObject({ id: b.d2.id, motif: 'EMPREINTE_DIFFERENTE' });

    // Export brut à la sélection du tiroir : pièce illisible → échec, plus de ZIP « prêt » amputé.
    h.objets.delete(b.d2.key);
    const s = await exporter(b.acc, b.x.id, { exportType: 'EXPORT_BRUT', options: { customDocIds: [b.d1.id, b.d2.id] } });
    expect(s.status).toBe(500);
    expect(s.json.detailCode).toBe('EXPORT_INCOMPLETE');

    // Confidentialité : un autre compte n'exporte jamais ce bien.
    const intrus = await make.account({ plan: 'premium' });
    const i = await exporter(intrus, b.x.id, { exportType: 'EXPORT_BRUT', options: { complete: true } });
    expect(i.status).toBe(404);
  });
});
