/**
 * Lot 82E — export complet de recette et point de restauration (décisions PO
 * du 23/10 : C-Q5, C-Q8, §4.1–4.2 ; D13 du Pilotage IA), sur PostgreSQL 16
 * réel, par les VRAIES routes BO (garde `requireAdmin` réelle : seule la
 * lecture du cookie de session est simulée) ; stockage OVH S3 SIMULÉ en
 * mémoire (envois en plusieurs parties, lectures en flux).
 *
 *   · L82E-E01 périmètre : chaque table de la base est classée (exportée ou
 *     exclue avec motif) — une nouvelle table non classée fait échouer ce
 *     test (C-Q11) ;
 *   · L82E-E02 export complet (route, tâche de fond, stockage) : COMPLETE,
 *     chaque fichier relu = attendu = exporté, SHA-256, totaux, dictionnaire,
 *     LISEZMOI, identifiants et relations de MES comptes conservés, masquage
 *     (e-mail pseudonymisé, clé de stockage, extract → longueur + SHA-256),
 *     TCO calculé, téléchargement (URL signée) et archive ZIP complète ;
 *   · L82E-E03 deux exports successifs comparables sans perte : mêmes
 *     lignes pour mes comptes, découpage en parties (totaux contrôlables,
 *     aucun doublon, ordre par clé primaire), instantané cohérent malgré une
 *     écriture concurrente ;
 *   · L82E-E04 sécurité : non-admin refusé (lancement, liste, détail,
 *     téléchargement, points de restauration) ; contenus sensibles sans
 *     habilitation refusés et journalisés ; chemin hors manifeste refusé ;
 *   · L82E-E05 point de restauration → campagne → export après →
 *     restauration (moteur des rattrapages BO) : état de mes comptes
 *     IDENTIQUE au point (lignes, horodatages, relations), objets créés
 *     pendant la campagne retirés, séquences jamais reculées, envoi en
 *     attente neutralisé, journaux d'administration, de rattrapages et
 *     traces IA de la campagne conservés, contraintes revalidées, déclencheurs rétablis, point de
 *     l'état d'avant restauration créé ; export après restauration = export
 *     avant campagne (mes comptes) ;
 *   · L82E-E06 refus sans écriture : schéma modifié depuis le point, point
 *     au format 1 ; liste des points (restaurable / motif).
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

type Json = Record<string, unknown>;

const s3 = vi.hoisted(() => {
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  const uploads = new Map<string, { key: string; parts: Buffer[] }>();
  let n = 0;
  const client = {
    async send(c: { constructor: { name: string }; input: Record<string, any> }) {
      const i = c.input;
      switch (c.constructor.name) {
        case 'CreateMultipartUploadCommand': { const id = `u${++n}`; uploads.set(id, { key: i.Key, parts: [] }); return { UploadId: id }; }
        case 'UploadPartCommand': { uploads.get(i.UploadId)!.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` }; }
        case 'CompleteMultipartUploadCommand': {
          const u = uploads.get(i.UploadId)!;
          objects.set(i.Key, { body: Buffer.concat(u.parts), modified: new Date() });
          uploads.delete(i.UploadId);
          return {};
        }
        case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
        case 'PutObjectCommand': objects.set(i.Key, { body: Buffer.from(i.Body), modified: new Date() }); return {};
        case 'ListObjectsV2Command':
          return { Contents: [...objects.entries()].filter(([k]) => k.startsWith(i.Prefix ?? '')).sort(([a], [b]) => a.localeCompare(b)).map(([Key, o]) => ({ Key, LastModified: o.modified, Size: o.body.length })), IsTruncated: false };
        case 'GetObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
          const { Readable } = await import('node:stream');
          // Lecture en flux, par morceaux de 64 Kio.
          const chunks: Buffer[] = [];
          for (let k = 0; k < o.body.length; k += 65_536) chunks.push(o.body.subarray(k, k + 65_536));
          const r = Readable.from(chunks, { objectMode: false }) as unknown as Record<string, unknown>;
          r.transformToString = async () => o.body.toString('utf8');
          return { Body: r };
        }
        case 'DeleteObjectsCommand': for (const x of i.Delete.Objects) objects.delete(x.Key); return {};
        default: throw new Error(`commande S3 non simulée : ${c.constructor.name}`);
      }
    },
  };
  return { objects, client };
});

vi.mock('@/lib/s3-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/s3-config')>()),
  isS3Configured: () => true,
  getS3Bucket: () => 'bucket-e2e',
  getS3Client: () => s3.client,
}));
vi.mock('@/services/exports/v12/storage', async (orig) => ({
  ...(await orig<typeof import('@/services/exports/v12/storage')>()),
  shortLivedDownloadUrl: async (key: string, fileName: string) => `https://s3.e2e.invalid/${key}?nom=${encodeURIComponent(fileName)}`,
}));

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

scenario('L82E', 'Export complet de recette, point de restauration et restauration', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); });
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  const routes = {} as Record<'recetteGET' | 'recettePOST' | 'detail' | 'download' | 'pointsGET' | 'backfillPOST', Route>;
  const req = (url: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://app.test${url}`, {
    method: init?.method ?? 'GET', headers: { 'content-type': 'application/json', origin: 'http://app.test', host: 'app.test' },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  let admin: { id: number; email: string };
  let A: AccountRow & { owner: { email: string } };
  let B: AccountRow;
  const ids: Record<string, number> = {};
  const TEXTE_EXTRACT = 'FACTURE n° F-2026-12 — Chaudière — total 1 499,00 € — contact facturation@chauffage.example';

  const asAdmin = () => { session.userId = admin.id; session.role = 'ADMIN'; session.email = admin.email; };

  /** Fichier stocké, décompressé si besoin. */
  const stored = (key: string) => {
    const o = s3.objects.get(key);
    if (!o) throw new Error(`objet absent : ${key}`);
    return key.endsWith('.gz') ? gunzipSync(o.body) : o.body;
  };
  const lines = (buf: Buffer) => buf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json);
  /** Lignes d'une table dans un export (toutes ses parties, dans l'ordre). */
  const tableRows = (m: Json, prefix: string, table: string) => (m.files as Json[]).filter((f) => f.table === table).sort((a, b) => String(a.path).localeCompare(String(b.path)))
    .flatMap((f) => lines(stored(`${prefix}${f.path}`)));

  async function lancerExport(): Promise<{ id: string; manifest: Json; prefix: string }> {
    asAdmin();
    const res = await routes.recettePOST(req('/api/admin/diagnostics/recette', { method: 'POST', body: {} }));
    expect(res.status, await res.clone().text()).toBe(202);
    const { generationId, storagePrefix } = await res.json() as { generationId: string; storagePrefix: string };
    const { waitForRecetteExport } = await import('@/services/admin/diagnostics-export/recette');
    await waitForRecetteExport(generationId);
    const manifest = JSON.parse(stored(`${storagePrefix}manifeste.json`).toString('utf8')) as Json;
    return { id: generationId, manifest, prefix: storagePrefix };
  }

  /** Photographie des lignes de MES comptes (texte exact de PostgreSQL), table par table. */
  async function photo(accounts: number[]): Promise<Record<string, string[]>> {
    const q: Record<string, string> = {
      accounts: `SELECT row_to_json(t)::text AS j FROM accounts t WHERE id = ANY($1) ORDER BY id`,
      assets: `SELECT row_to_json(t)::text AS j FROM assets t WHERE account_id = ANY($1) ORDER BY id`,
      equipments: `SELECT row_to_json(t)::text AS j FROM equipments t WHERE asset_id IN (SELECT id FROM assets WHERE account_id = ANY($1)) ORDER BY id`,
      substructures: `SELECT row_to_json(t)::text AS j FROM substructures t WHERE asset_id IN (SELECT id FROM assets WHERE account_id = ANY($1)) ORDER BY id`,
      asset_files: `SELECT row_to_json(t)::text AS j FROM asset_files t WHERE account_id = ANY($1) ORDER BY id`,
      document_asset_links: `SELECT row_to_json(t)::text AS j FROM document_asset_links t WHERE account_id = ANY($1) ORDER BY id`,
      document_raw_extracts: `SELECT row_to_json(t)::text AS j FROM document_raw_extracts t WHERE account_id = ANY($1) ORDER BY id`,
      agenda_items: `SELECT row_to_json(t)::text AS j FROM agenda_items t WHERE account_id = ANY($1) ORDER BY id`,
      agenda_asset_links: `SELECT row_to_json(t)::text AS j FROM agenda_asset_links t WHERE agenda_item_id IN (SELECT id FROM agenda_items WHERE account_id = ANY($1)) ORDER BY agenda_item_id, asset_id`,
      business_operations: `SELECT row_to_json(t)::text AS j FROM business_operations t WHERE account_id = ANY($1) ORDER BY id`,
      business_operation_asset_links: `SELECT row_to_json(t)::text AS j FROM business_operation_asset_links t WHERE account_id = ANY($1) ORDER BY id`,
      business_operation_financial_components: `SELECT row_to_json(t)::text AS j FROM business_operation_financial_components t WHERE account_id = ANY($1) ORDER BY id`,
      to_process_actions: `SELECT row_to_json(t)::text AS j FROM to_process_actions t WHERE account_id = ANY($1) ORDER BY id`,
    };
    const out: Record<string, string[]> = {};
    for (const [t, text] of Object.entries(q)) out[t] = (await sql.unsafe(text, [accounts] as never[])).map((r) => String((r as Json).j));
    return out;
  }

  /** Lignes d'un export appartenant à MES comptes (comparaison d'exports limitée à mes données). */
  const mesLignes = (m: Json, prefix: string, accounts: number[]) => {
    const out: Record<string, string[]> = {};
    for (const t of ['accounts', 'assets', 'asset_files', 'document_asset_links', 'document_raw_extracts', 'agenda_items', 'business_operations', 'business_operation_financial_components', 'to_process_actions']) {
      out[t] = tableRows(m, prefix, t).filter((r) => accounts.includes(Number(t === 'accounts' ? r.id : r.account_id))).map((r) => JSON.stringify(r));
    }
    return out;
  };

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const r = await import('@/app/api/admin/diagnostics/recette/route');
    routes.recetteGET = r.GET as Route;
    routes.recettePOST = r.POST as Route;
    routes.detail = (await import('@/app/api/admin/diagnostics/recette/[id]/route')).GET as Route;
    routes.download = (await import('@/app/api/admin/diagnostics/recette/[id]/download/route')).GET as Route;
    routes.pointsGET = (await import('@/app/api/admin/ops/restore-points/route')).GET as Route;
    routes.backfillPOST = (await import('@/app/api/admin/ops/backfills/route')).POST as Route;

    const u = await make.user({ role: 'ADMIN' });
    admin = { id: u.id, email: u.email };
    A = await make.account({ plan: 'premium', name: 'Compte recette A L82E' });
    B = await make.account({ plan: 'premium', name: 'Compte recette B L82E' });
    // Données représentatives : biens, Pièce, équipement, documents rattachés, extract, Opération et TCO, agenda / Timeline, carte « À traiter ».
    ids.maison = (await make.asset(A, { category: 'IMMOBILIER', name: 'Maison L82E', purchasePriceCents: 30_000_000, purchaseDate: '2019-06-14' })).id;
    ids.voiture = (await make.asset(B, { category: 'VEHICULE', name: 'Voiture L82E' })).id;
    ids.piece = (await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${ids.maison}, 'Cuisine') RETURNING id::int AS id`)[0].id;
    ids.chaudiere = (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${ids.maison}, 'Chaudière') RETURNING id::int AS id`)[0].id;
    ids.facture = (await make.assetFile(A, { assetId: ids.maison })).id;
    ids.carteGrise = (await make.assetFile(B, { assetId: ids.voiture })).id;
    await sql`UPDATE asset_files SET original_filename = 'facture-chaudiere.pdf' WHERE id = ${ids.facture}`;
    ids.lien = (await sql<{ id: number }[]>`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, status)
      VALUES (${A.id}, ${ids.facture}, ${ids.maison}, ${ids.chaudiere}, 'SECONDARY', 'AI', 'ACTIVE') RETURNING id::int AS id`)[0].id;
    await sql`INSERT INTO document_raw_extracts (account_id, file_id, method, extraction_status, full_text, full_text_chars)
              VALUES (${A.id}, ${ids.facture}, 'PDF_TEXT_LAYER', 'COMPLETE', ${TEXTE_EXTRACT}, ${TEXTE_EXTRACT.length})`;
    ids.op = (await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date)
      VALUES (${A.id}, 'INTERVENTION', 'REALIZED', 'Entretien chaudière L82E', 'Chauffage SARL', '2026-03-10') RETURNING id::int AS id`)[0].id;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${A.id}, ${ids.op}, ${ids.maison}, 'PRIMARY', 'STRUCTURED')`;
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority) VALUES (${A.id}, ${ids.op}, 'DOCUMENT', ${String(ids.facture)}, 'STRUCTURED')`;
    await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, amount_eur_cents, economic_date, target_asset_id)
              VALUES (${A.id}, ${ids.op}, 'REALIZED_COST', 149900, 'EUR', 149900, '2026-03-10', ${ids.maison})`;
    ids.rdv = (await make.agendaItem(A, { title: 'Entretien annuel chaudière', startDate: '2027-03-10', assetIds: [ids.maison] })).id;
    ids.carte = (await sql<{ id: number }[]>`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
      VALUES (${A.id}, 'ASSET', ${ids.maison}, 'acquisitionDate', 'COMPLETE', 'L82E-TEST', 'Date d’achat ?') RETURNING id::int AS id`)[0].id;
  });

  // ══ L82E-E01 ═══════════════════════════════════════════════════════════
  it('L82E-E01 — chaque table de la base est classée : exportée (domaine) ou exclue (motif)', async () => {
    const { classifyTables } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const tables = (await sql<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map((r) => r.t);
    const c = classifyTables(tables);
    expect(c.unclassified, 'tables à classer dans recette-catalog.ts').toEqual([]);
    expect(c.missing, 'tables du catalogue absentes de la base').toEqual([]);
    expect(c.included.length + c.excluded.length).toBe(tables.length);
  });

  // ══ L82E-E02 ═══════════════════════════════════════════════════════════
  it('L82E-E02 — export complet : tâche de fond, stockage, complétude vérifiable, identifiants, masquage, TCO, téléchargement', async () => {
    const { id, manifest: m, prefix } = await lancerExport();
    expect(m.schema).toBe('verebona.bo.export-recette/1');
    expect(m.status, JSON.stringify(m.warnings)).toBe('COMPLETE');
    expect((m.snapshot as Json).isolation).toBe('REPEATABLE READ, READ ONLY');
    expect(String((m.snapshot as Json).at)).toMatch(/^\d{4}-\d\d-\d\dT/);

    // Suivi 81C : génération COMPLETE avec totaux.
    asAdmin();
    const liste = await (await routes.recetteGET(req('/api/admin/diagnostics/recette'))).json() as { items: Json[] };
    const g = liste.items.find((x) => x.id === id)!;
    expect(g).toMatchObject({ status: 'COMPLETE', interrupted: false, rowsExported: (m.totals as Json).rowsExported, rowsExpected: (m.totals as Json).rowsExpected });

    // Chaque fichier relu : lignes = exporté = attendu ; SHA-256 et octets du contenu décompressé.
    let total = 0;
    for (const f of m.files as Json[]) {
      const buf = stored(`${prefix}${f.path}`);
      expect(sha(buf), String(f.path)).toBe(f.sha256);
      expect(buf.length, String(f.path)).toBe(f.bytes);
      if (f.nature === 'donnees') {
        const n = lines(buf).length;
        expect(n, String(f.path)).toBe(f.exported);
        expect(f.exported, String(f.path)).toBe(f.expected);
        total += n;
      }
    }
    expect(total).toBe((m.totals as Json).rowsExported);
    expect((m.totals as Json).rowsExported).toBe((m.totals as Json).rowsExpected);
    for (const t of m.tables as Json[]) expect(t.exported, String(t.table)).toBe(t.expected);

    // Mes comptes : identifiants et relations conservés.
    const assets = tableRows(m, prefix, 'assets');
    expect(assets.find((r) => r.id === ids.maison)).toMatchObject({ account_id: A.id, name: 'Maison L82E', purchase_price_cents: 30_000_000 });
    expect(tableRows(m, prefix, 'document_asset_links').find((r) => r.id === ids.lien)).toMatchObject({ file_id: ids.facture, asset_id: ids.maison, equipment_id: ids.chaudiere, link_role: 'SECONDARY' });
    expect(tableRows(m, prefix, 'substructures').find((r) => r.id === ids.piece)).toMatchObject({ asset_id: ids.maison, name: 'Cuisine' });
    expect(tableRows(m, prefix, 'agenda_asset_links').some((r) => r.agenda_item_id === ids.rdv && r.asset_id === ids.maison)).toBe(true);
    expect(tableRows(m, prefix, 'to_process_actions').find((r) => r.id === ids.carte)).toMatchObject({ account_id: A.id, rule_code: 'L82E-TEST', resolved_at: null });
    expect(tableRows(m, prefix, 'business_operation_financial_components').find((r) => r.operation_id === ids.op)).toMatchObject({ amount_minor: 149900, target_asset_id: ids.maison });

    // Masquage : fichier, e-mail, extract (longueur + empreinte : comparable sans révéler).
    const facture = tableRows(m, prefix, 'asset_files').find((r) => r.id === ids.facture)!;
    expect(facture.s3_key).toMatchObject({ $etat: 'masque', motif: 'clé de stockage' });
    expect(facture.original_filename).toMatchObject({ $etat: 'masque' });
    const extract = tableRows(m, prefix, 'document_raw_extracts').find((r) => r.file_id === ids.facture)!;
    expect(extract.full_text).toEqual({ $etat: 'masque', motif: expect.any(String), longueur: TEXTE_EXTRACT.length, sha256: sha(TEXTE_EXTRACT) });
    const proprio = tableRows(m, prefix, 'users').find((r) => r.id === A.ownerUserId)!;
    expect(proprio.email).toMatchObject({ $etat: 'masque', motif: 'e-mail', pseudonyme: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(proprio.password_hash).toMatchObject({ $etat: 'masque' });
    const tout = [...s3.objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k]) => stored(k).toString('utf8')).join('\n');
    expect(tout).not.toContain('facturation@chauffage.example');
    // NB : le TCO calculé reprend le titre AFFICHÉ d'un document (qui retombe sur le nom d'origine quand
    // aucun titre n'est retenu) — même sortie que le moteur TCO et le diagnostic 77C ; la colonne
    // `original_filename` elle-même est masquée (ci-dessus).
    expect(tout).not.toContain(A.owner.email);

    // TCO calculé par le moteur existant, dans l'instantané.
    const tco = (m.files as Json[]).filter((f) => String(f.path).startsWith('calculs/tco-lignes')).flatMap((f) => lines(stored(`${prefix}${f.path}`)));
    expect(tco.some((l) => l.assetId === ids.maison && l.accountId === A.id)).toBe(true);
    const syntheses = lines(stored(`${prefix}calculs/tco-syntheses.ndjson.gz`));
    expect(syntheses.some((l) => l.assetId === ids.maison && l.disponible === true)).toBe(true);

    // Documentation : dictionnaire (colonnes, clé, relations, masquage) et LISEZMOI.
    const dict = JSON.parse(stored(`${prefix}dictionnaire.json`).toString('utf8')) as { tables: Json[]; excluded: Json[] };
    const dAssets = dict.tables.find((t) => t.table === 'assets')!;
    expect(dAssets).toMatchObject({ domain: 'biens', primaryKey: ['id'] });
    expect((dAssets.relations as Json[]).some((r) => r.references === 'accounts')).toBe(true);
    expect(dict.excluded.some((x) => x.table === 'job_locks')).toBe(true);
    const lisez = stored(`${prefix}LISEZMOI.txt`).toString('utf8');
    expect(lisez).toContain(`Instant de cohérence  : ${(m.snapshot as Json).at}`);
    expect(lisez).toContain('Statut                : COMPLETE');

    // Détail et téléchargement : URL signée de courte durée pour un fichier du manifeste ; archive ZIP complète.
    const det = await (await routes.detail(req(`/api/admin/diagnostics/recette/${id}`), ctx(id))).json() as { downloadables: string[] };
    expect(det.downloadables).toContain('manifeste.json');
    const part = (m.files as Json[]).find((f) => f.table === 'assets')!.path as string;
    const dl = await routes.download(req(`/api/admin/diagnostics/recette/${id}/download?path=${encodeURIComponent(part)}`), ctx(id));
    expect(dl.status).toBe(302);
    expect(dl.headers.get('location')).toContain(`${prefix}${part}`);
    const zr = await routes.download(req(`/api/admin/diagnostics/recette/${id}/download?archive=zip`), ctx(id));
    expect(zr.status).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await zr.arrayBuffer()));
    expect(Object.keys(z.files).filter((k) => !z.files[k].dir).sort()).toEqual([...det.downloadables].sort());
    expect(sha(await z.file(part)!.async('nodebuffer'))).toBe(sha(s3.objects.get(`${prefix}${part}`)!.body));
    // Journal d'administration : lancement, fin, téléchargements.
    const journal = await sql<{ action_type: string }[]>`SELECT action_type FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND action_type LIKE 'RECETTE_EXPORT%'`;
    expect(journal.map((x) => x.action_type)).toEqual(expect.arrayContaining(['RECETTE_EXPORT', 'RECETTE_EXPORT_DOWNLOAD']));
  });

  // ══ L82E-E03 ═══════════════════════════════════════════════════════════
  it('L82E-E03 — deux exports successifs comparables sans perte ; découpage en parties ; instantané cohérent malgré une écriture concurrente', async () => {
    const { runRecetteExport, recettePrefix } = await import('@/services/admin/diagnostics-export/recette');
    const { openReadSession } = await import('@/services/admin/account-data/session');
    // Assez de biens pour plusieurs parties de 2 lignes.
    for (const k of [1, 2, 3]) await make.asset(B, { name: `Bien supplémentaire ${k} L82E` });
    const opts = { adminUserId: admin.id, partRows: 2, batchRows: 1, today: '2026-10-23' };
    const id1 = '00000000-0000-4000-8000-0000000000e1';
    const id2 = '00000000-0000-4000-8000-0000000000e2';
    const m1 = await runRecetteExport({ ...opts, generationId: id1 }) as unknown as Json;
    const m2 = await runRecetteExport({ ...opts, generationId: id2 }) as unknown as Json;
    expect(m1.status).toBe('COMPLETE');
    expect(m2.status).toBe('COMPLETE');
    // Mes comptes : mêmes lignes, octet pour octet.
    expect(mesLignes(m2, recettePrefix(id2), [A.id, B.id])).toEqual(mesLignes(m1, recettePrefix(id1), [A.id, B.id]));
    // Découpage : parties de 2 lignes au plus, numérotées, totaux = attendu, aucun doublon, ordre par clé primaire.
    const parts = (m1.files as Json[]).filter((f) => f.table === 'assets');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const [k, f] of parts.entries()) {
      expect(f.part).toEqual({ index: k + 1, of: parts.length });
      expect(Number(f.exported)).toBeLessThanOrEqual(2);
    }
    const ids1 = tableRows(m1, recettePrefix(id1), 'assets').map((r) => Number(r.id));
    expect(new Set(ids1).size).toBe(ids1.length);
    expect([...ids1].sort((a, b) => a - b)).toEqual(ids1);
    expect(ids1.length).toBe((m1.tables as Json[]).find((t) => t.table === 'assets')!.expected);

    // Écriture concurrente APRÈS l'ouverture de l'instantané : absente de l'export, totaux cohérents.
    const s = await openReadSession();
    let nouveau = 0;
    try {
      nouveau = (await make.asset(A, { name: 'Bien écrit pendant l’export L82E' })).id;
      const id3 = '00000000-0000-4000-8000-0000000000e3';
      const m3 = await runRecetteExport({ ...opts, generationId: id3, session: s }) as unknown as Json;
      expect(m3.status).toBe('COMPLETE');
      const a3 = tableRows(m3, recettePrefix(id3), 'assets');
      expect(a3.some((r) => r.id === nouveau)).toBe(false);
      expect(a3.length).toBe((m3.tables as Json[]).find((t) => t.table === 'assets')!.expected);
    } finally {
      await s.close();
      if (nouveau) await sql`DELETE FROM assets WHERE id = ${nouveau}`;
    }
  });

  // ══ L82E-E04 ═══════════════════════════════════════════════════════════
  it('L82E-E04 — sécurité : administrateurs seulement ; contenus sensibles réservés et journalisés ; aucun fichier hors manifeste', async () => {
    const user = await make.user();
    session.userId = user.id; session.role = 'USER'; session.email = user.email;
    const anyId = '00000000-0000-4000-8000-0000000000e1';
    for (const r of [
      await routes.recetteGET(req('/api/admin/diagnostics/recette')),
      await routes.recettePOST(req('/api/admin/diagnostics/recette', { method: 'POST', body: {} })),
      await routes.detail(req(`/api/admin/diagnostics/recette/${anyId}`), ctx(anyId)),
      await routes.download(req(`/api/admin/diagnostics/recette/${anyId}/download?path=manifeste.json`), ctx(anyId)),
      await routes.pointsGET(req('/api/admin/ops/restore-points')),
      await routes.backfillPOST(req('/api/admin/ops/backfills', { method: 'POST', body: { script: 'database-restore-point', action: 'apply', reason: 'tentative non admin' } })),
    ]) expect([401, 403]).toContain(r.status);

    asAdmin();
    const avant = process.env.AI_MODEL_OUTPUT_ADMIN_IDS;
    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = String(admin.id + 100_000);
    try {
      const r = await routes.recettePOST(req('/api/admin/diagnostics/recette', { method: 'POST', body: { contenusSensibles: true } }));
      expect(r.status).toBe(403);
      const [j] = await sql<{ result: string }[]>`SELECT result FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND action_type = 'RECETTE_EXPORT' ORDER BY id DESC LIMIT 1`;
      expect(j.result).toBe('DENIED');
    } finally {
      if (avant === undefined) delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS; else process.env.AI_MODEL_OUTPUT_ADMIN_IDS = avant;
    }
    const gens = await (await routes.recetteGET(req('/api/admin/diagnostics/recette'))).json() as { items: Json[] };
    const id = String(gens.items.find((x) => x.status === 'COMPLETE')!.id);
    for (const p of ['../backups/x.json', 'donnees/biens/inconnue.part-0001.ndjson.gz', '%2Fetc%2Fpasswd']) {
      const r = await routes.download(req(`/api/admin/diagnostics/recette/${id}/download?path=${p}`), ctx(id));
      expect(r.status, p).toBe(400);
    }
  });

  // ══ L82E-E05 ═══════════════════════════════════════════════════════════
  it('L82E-E05 — point de restauration → campagne → export après → restauration : retour exact à l’état du point', async () => {
    const { waitForBackfill, getBackfillRun } = await import('@/services/admin/ops/backfill/runner');
    const lancer = async (body: Json) => {
      asAdmin();
      const r = await routes.backfillPOST(req('/api/admin/ops/backfills', { method: 'POST', body }));
      expect(r.status, await r.clone().text()).toBe(202);
      const { run } = await r.json() as { run: { id: string } };
      await waitForBackfill(run.id);
      return (await getBackfillRun(run.id))!;
    };
    // Envoi en attente AU MOMENT DU POINT (il sera envoyé pendant la campagne).
    const [o] = await sql<{ id: string }[]>`INSERT INTO notification_outbox (id, event_type, category, account_id, recipient_user_id, dedupe_key, status)
      VALUES (gen_random_uuid(), 'L82E_TEST', 'system', ${A.id}, ${A.ownerUserId}, ${`l82e-${A.id}`}, 'pending') RETURNING id::text`;
    // Volume représentatif : plusieurs lots de rechargement (1 000 lignes) et décisions T3 avec preuves.
    const run = (await sql<{ id: number }[]>`INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, status) VALUES (${A.id}, ${ids.maison}, 'scheduled', 'completed') RETURNING id`)[0].id;
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids, source_priority, created_at)
              SELECT ${run}, ${A.id}, ${ids.maison}, 'champ_' || (g % 40), 'keep', 'R' || g, 'certain', true, jsonb_build_array(g, g + 1), g % 5,
                     timestamptz '2024-01-01 00:00:00.123456+00' + (g || ' minutes')::interval
                FROM generate_series(1, 5000) g`;
    await sql`INSERT INTO equipments (asset_id, name) SELECT ${ids.voiture}, 'Pièce détachée ' || g FROM generate_series(1, 1500) g`;
    const empreinte = async () => (await sql<{ d: string; e: string }[]>`
      SELECT (SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY id)) FROM reconciliation_decisions t WHERE account_id = ${A.id}) AS d,
             (SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY id)) FROM equipments t WHERE asset_id = ${ids.voiture}) AS e`)[0];
    const triggersAvant = await sql<{ n: string }[]>`SELECT tgrelid::regclass::text || ':' || tgname::text || ':' || tgenabled::text AS n FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`;

    // 1. Point de restauration (moteur des rattrapages BO).
    const point = await lancer({ script: 'database-restore-point', action: 'apply', reason: 'Avant campagne L82E' });
    expect(point.status, point.error ?? '').toBe('succeeded');
    const backupId = point.summary!.scriptRunId!;
    expect(point.summary!.restorable).toBe(true);
    const etatPoint = await photo([A.id, B.id]);
    const empreintePoint = await empreinte();
    const exportAvant = await lancerExport();

    // 2. Campagne : modifications, suppressions, créations sur mes comptes.
    await sql`UPDATE assets SET name = 'Maison renommée par la campagne' WHERE id = ${ids.maison}`;
    await sql`UPDATE reconciliation_decisions SET action = 'apply' WHERE account_id = ${A.id} AND id % 3 = 0`;
    await sql`DELETE FROM equipments WHERE asset_id = ${ids.voiture} AND id % 2 = 0`;
    await sql`UPDATE document_asset_links SET status = 'REMOVED' WHERE id = ${ids.lien}`;
    await sql`DELETE FROM agenda_items WHERE id = ${ids.rdv}`;
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'campagne' WHERE id = ${ids.carte}`;
    await sql`UPDATE notification_outbox SET status = 'sent', processed_at = now() WHERE id = ${o.id}::uuid`;
    // Trace IA de la campagne (journal) : CONSERVÉE après restauration (D13 : diagnostics consultables).
    const trace = (await sql<{ id: number }[]>`INSERT INTO ai_usage_event (account_id, operation_type, operation_code, asset_file_id, status)
      VALUES (${A.id}, 'l82e_campagne', 'l82e_campagne', ${ids.facture}, 'success') RETURNING id::int AS id`)[0].id;
    const cree = (await make.asset(A, { name: 'Bien créé par la campagne L82E' })).id;
    const creeRdv = (await make.agendaItem(A, { title: 'Événement créé par la campagne', assetIds: [ids.maison] })).id;
    expect(await photo([A.id, B.id])).not.toEqual(etatPoint);
    const exportApres = await lancerExport();
    expect(exportApres.manifest.status).toBe('COMPLETE');
    expect(mesLignes(exportApres.manifest, exportApres.prefix, [A.id])).not.toEqual(mesLignes(exportAvant.manifest, exportAvant.prefix, [A.id]));

    // 3. Restauration du point.
    const restau = await lancer({ script: 'database-restore-point', action: 'restore', runId: backupId, reason: 'Retour arrière L82E' });
    expect(restau.status, restau.error ?? '').toBe('succeeded');
    expect(restau.summary!.headline).toMatch(/Restauration au point/);
    const safety = restau.summary!.scriptRunId;
    expect(safety).toMatch(/^[0-9a-f-]{36}$/);

    // État de mes comptes IDENTIQUE au point : lignes, horodatages (microsecondes), relations.
    expect(await photo([A.id, B.id])).toEqual(etatPoint);
    expect(await empreinte()).toEqual(empreintePoint);
    expect((await sql`SELECT id FROM assets WHERE id = ${cree}`)).toHaveLength(0);
    expect((await sql`SELECT id FROM agenda_items WHERE id = ${creeRdv}`)).toHaveLength(0);
    // Séquences jamais reculées : un nouvel objet ne reprend pas l'identifiant d'un objet de la campagne.
    const apres = (await make.asset(A, { name: 'Bien après restauration L82E' })).id;
    expect(apres).toBeGreaterThan(cree);
    await sql`DELETE FROM assets WHERE id = ${apres}`;
    // Envoi en attente au point, envoyé pendant la campagne : restauré puis NEUTRALISÉ (jamais renvoyé).
    const [ob] = await sql<{ status: string; outcome_reason: string }[]>`SELECT status, outcome_reason FROM notification_outbox WHERE id = ${o.id}::uuid`;
    expect(ob.status).toBe('cancelled');
    expect(ob.outcome_reason).toContain(backupId);
    // Journaux conservés : lancement de la restauration (audit) et historique des rattrapages.
    expect((await sql`SELECT 1 FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND action_type = 'OPS_BACKFILL_RESTORE'`).length).toBeGreaterThan(0);
    expect((await sql`SELECT 1 FROM ops_backfill_runs WHERE id = ${point.id}::uuid AND status = 'succeeded'`)).toHaveLength(1);
    expect((await sql`SELECT 1 FROM admin_export_generations WHERE id = ${exportApres.id}::uuid`)).toHaveLength(1);
    expect((await sql`SELECT 1 FROM ai_usage_event WHERE id = ${trace} AND asset_file_id = ${ids.facture}`)).toHaveLength(1);
    // Contraintes : toutes présentes et validées (sauf celles déjà « NOT VALID » auparavant) ; déclencheurs dans leur état d'origine.
    expect((await sql`SELECT 1 FROM pg_constraint WHERE conname = 'admin_audit_log_admin_user_id_users_id_fk'`)).toHaveLength(1);
    expect(await sql<{ n: string }[]>`SELECT tgrelid::regclass::text || ':' || tgname::text || ':' || tgenabled::text AS n FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`).toEqual(triggersAvant);
    // Le point de l'état d'avant restauration existe (retour arrière possible).
    asAdmin();
    const pts = await (await routes.pointsGET(req('/api/admin/ops/restore-points'))).json() as { items: Json[] };
    expect(pts.items.find((p) => p.backupId === safety)).toMatchObject({ restorable: true, label: expect.stringContaining('Avant restauration du point') });
    // Export après restauration = export avant campagne (mes comptes).
    const exportRestaure = await lancerExport();
    expect(mesLignes(exportRestaure.manifest, exportRestaure.prefix, [A.id, B.id])).toEqual(mesLignes(exportAvant.manifest, exportAvant.prefix, [A.id, B.id]));
  });

  // ══ L82E-E06 ═══════════════════════════════════════════════════════════
  it('L82E-E06 — refus sans écriture : schéma modifié depuis le point, point au format 1 ; liste des points', async () => {
    const { waitForBackfill, getBackfillRun } = await import('@/services/admin/ops/backfill/runner');
    asAdmin();
    let pts = await (await routes.pointsGET(req('/api/admin/ops/restore-points'))).json() as { items: Json[]; environment: Json };
    expect(pts.environment).toMatchObject({ allowed: true });
    const cible = pts.items.find((p) => p.restorable && String(p.label).startsWith('Avant campagne L82E'))!;
    expect(cible).toBeDefined();
    // Point au format 1 : listé, jamais restaurable.
    s3.objects.set('backups/2026-01-01T00-00-00Z.json', { body: Buffer.from(JSON.stringify({ version: 1, finishedAt: '2026-01-01T00:00:00Z', tables: [{ name: 'assets', rows: 1 }], totalRows: 1, trigger: 'scheduler', dataKey: 'x', sizeBytes: 1, durationMs: 1 })), modified: new Date() });

    // Migration passée depuis le point : refus motivé, AUCUNE écriture.
    await sql.unsafe(`ALTER TABLE assets ADD COLUMN l82e_colonne_test TEXT`);
    try {
      pts = await (await routes.pointsGET(req('/api/admin/ops/restore-points'))).json() as { items: Json[]; environment: Json };
      expect(pts.items.find((p) => p.backupId === cible.backupId)).toMatchObject({ restorable: false, reason: expect.stringMatching(/schéma a changé/) });
      expect(pts.items.find((p) => p.version === 1)).toMatchObject({ restorable: false, reason: expect.stringMatching(/format antérieur/) });
      await sql`UPDATE assets SET name = 'Après le point L82E' WHERE id = ${ids.maison}`;
      const r = await routes.backfillPOST(req('/api/admin/ops/backfills', { method: 'POST', body: { script: 'database-restore-point', action: 'restore', runId: cible.backupId, reason: 'Refus attendu L82E' } }));
      const { run } = await r.json() as { run: { id: string } };
      await waitForBackfill(run.id);
      const fini = (await getBackfillRun(run.id))!;
      expect(fini.status).toBe('failed');
      expect(fini.error).toMatch(/schéma a changé/);
      expect((await sql<{ name: string }[]>`SELECT name FROM assets WHERE id = ${ids.maison}`)[0].name).toBe('Après le point L82E');
    } finally {
      await sql.unsafe(`ALTER TABLE assets DROP COLUMN IF EXISTS l82e_colonne_test`);
      s3.objects.delete('backups/2026-01-01T00-00-00Z.json');
    }
  });
});
