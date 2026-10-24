/**
 * Lot 84A — CDC « Opérations v5 », lot O-10 : suppression DÉFINITIVE de
 * l'ancien modèle Sinistres, étape finale « Finaliser » du rattrapage BO
 * « Sinistres : nettoyage de l'ancien modèle » (PostgreSQL 16 réel).
 *
 * La finalisation supprime des tables et des colonnes : ce scénario travaille
 * donc dans SA PROPRE BASE (construite comme celle du harnais — schéma
 * Drizzle, état déployé d'avant finalisation, toutes les migrations), pour ne
 * jamais toucher la base partagée des autres scénarios. L'application
 * (`@/db`) y est branchée avant tout import.
 *
 *   L84A-E01  avant : export de recette — chaque table classée (L82E-E01),
 *             export complet ; l'application tourne (smoke : transfert d'un
 *             bien avec l'ancien lien parent — garde transitoire —, dossier BO
 *             « Données du compte », diagnostic des Opérations, isolation des
 *             comptes, informations complémentaires, campagne de cohérence) ;
 *   L84A-E02  simulation de la finalisation : rapport exact (objets, lignes,
 *             motifs de refus), AUCUNE écriture (schéma et données intacts) ;
 *   L84A-E03  finalisation REFUSÉE sans nettoyage complet (point de
 *             restauration présent) — rien supprimé ; puis nettoyage appliqué ;
 *   L84A-E04  finalisation REFUSÉE sans point de restauration de moins de
 *             24 h (nettoyage complet) — rien supprimé ;
 *   L84A-E05  point de restauration RÉEL (mécanisme 82E) puis « Finaliser »
 *             par le moteur des rattrapages BO : tables, colonnes, clé,
 *             contrainte, index supprimés ; contrainte JSON reposée sans
 *             `claim_json` ; trace FINALIZE ; rejouée : « déjà supprimé » ;
 *   L84A-E06  après : l'application tourne SANS ces tables (même smoke),
 *             export de recette vert (L82E-E01 + export complet) ;
 *   L84A-E07  après : restaurer le nettoyage 83D → REFUSÉ, message clair,
 *             rien d'écrit ; le nettoyage rend « ancien modèle supprimé » ;
 *   L84A-E08  après : restaurer le point ANTÉRIEUR à la finalisation →
 *             REFUSÉ (variante prudente), motif dédié, AUCUNE écriture.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminUrlFromEnv, bootstrapE2eDatabase, dropE2eDatabase } from '../db-bootstrap';
import { factories, type AccountRow, type Factories } from '../factories';

type Json = Record<string, unknown>;

// Stockage objet simulé (même simulation que L82E) : points de restauration et exports de recette.
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

const ADMIN = adminUrlFromEnv();
const BASE = `verebona_e2e_l84a_${Date.now()}_${process.pid}`;
const LEGACY_TABLES = ['business_operation_claim_actions', 'business_operation_claim_exchanges', 'business_operation_claim_migration_marks'];
const hooks = () => ({ log: () => undefined, progress: () => undefined });

describe('L84A — Sinistres v5 O-10 : finalisation (suppression définitive de l’ancien modèle) au BO', () => {
  let sql: postgres.Sql;
  let make: Factories;
  let compte: AccountRow;
  let cleanupRunId = '';
  let pointAvant = '';

  beforeAll(async () => {
    const boot = await bootstrapE2eDatabase({ adminUrl: ADMIN!, database: BASE });
    // `@/db` lit DATABASE_URL à son premier import : il vise désormais la base de CE scénario.
    process.env.DATABASE_URL = boot.url;
    // Lot 86 : en suite complète (un seul processus), un module `@/db` déjà chargé viserait la base
    // partagée — la finalisation y supprimerait les tables héritées pour tous les fichiers suivants.
    // Registre de modules remis à zéro : `@/db` et les services sont rechargés sur la base de CE scénario.
    vi.resetModules();
    const { pgClient } = await import('@/db');
    sql = pgClient;
    make = factories(pgClient);
    // Garde : la finalisation SUPPRIME des tables — elle ne doit jamais viser la base partagée de l'exécution.
    const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    if (db !== BASE) throw new Error(`[l84a] base inattendue : ${db} (attendue ${BASE}) — @/db importé avant le changement de DATABASE_URL`);
  }, 300_000);

  afterAll(async () => {
    const { pgClient } = await import('@/db');
    await pgClient.end({ timeout: 5 }).catch(() => undefined);
    await dropE2eDatabase(ADMIN!, BASE, { force: true }).catch(() => undefined);
  });

  // ── Outils ───────────────────────────────────────────────────────────────
  const legacy = async () => (await import('@/services/business-operations/claims/legacy-schema')).readLegacyClaimSchema(sql);
  const tables = async () => (await sql<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map((r) => r.t);
  const contrainte = async (nom: string) => (await sql<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${nom}`)[0]?.def ?? null;
  const index = async (nom: string) => (await sql`SELECT 1 FROM pg_class WHERE relname = ${nom} AND relkind = 'i'`).length > 0;
  const runs = async (mode: string) => sql<Json[]>`SELECT id::text AS id, status, error, counters, restore_point_id FROM claim_legacy_cleanup_runs WHERE mode = ${mode} ORDER BY started_at`;
  const pointRecent = (backupId = 'pt-l84a') => async () => [{ backupId, version: 2, finishedAt: new Date(Date.now() - 3_600_000).toISOString(), restorable: true }];
  const aucunPoint = async () => [{ backupId: 'vieux', version: 2, finishedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(), restorable: true }];

  /** L82E-E01 : chaque table classée (exportée ou exclue), aucune manquante. */
  async function recetteClassee(): Promise<void> {
    const { classifyTables } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const t = await tables();
    const c = classifyTables(t);
    expect(c.unclassified, 'tables à classer').toEqual([]);
    expect(c.missing, 'tables du catalogue absentes').toEqual([]);
    expect(c.included.length + c.excluded.length).toBe(t.length);
  }

  /** Export complet de recette (moteur 82E) : COMPLET, tables de l'ancien modèle présentes ou non selon l'état. */
  async function exportComplet(attenduAncien: boolean): Promise<void> {
    const { runRecetteExport } = await import('@/services/admin/diagnostics-export/recette');
    const m = await runRecetteExport({ generationId: randomUUID(), adminUserId: null }) as unknown as Json;
    expect(m.status, JSON.stringify(m.warnings)).toBe('COMPLETE');
    const exportees = JSON.stringify(m.files ?? m.tables ?? []);
    for (const t of LEGACY_TABLES) expect(exportees.includes(t), t).toBe(attenduAncien);
  }

  /**
   * L'application tourne : transfert d'un bien entre comptes (Opérations
   * comprises), dossier BO « Données du compte », diagnostic des Opérations,
   * isolation des comptes, informations complémentaires, cohérence.
   */
  async function smoke(avecParent: boolean): Promise<void> {
    const A = await make.account();
    const B = await make.account();
    const voiture = await make.asset(A, { category: 'VEHICULE', name: 'Voiture' });
    const maison = await make.asset(A, { category: 'IMMOBILIER', name: 'Maison' });
    const op = async (type: string, assets: number[]) => {
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO business_operations (account_id, type_code, status, realized_date, technical_label)
        VALUES (${A.id}, ${type}, 'REALIZED', '2026-03-10', ${`${type} e2e`}) RETURNING id::int AS id`;
      await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority) VALUES (${A.id}, ${id}, 'MIGRATION', ${`e2e:${id}`}, 'STRUCTURED')`;
      for (const [k, a] of assets.entries()) {
        await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${A.id}, ${id}, ${a}, ${k === 0 ? 'PRIMARY' : 'CONCERNED'}, 'STRUCTURED')`;
      }
      return id;
    };
    const intervention = await op('INTERVENTION', [voiture.id]);
    const sinistre = await op('CLAIM', [voiture.id, maison.id]);
    // Avant la finalisation : ancien lien « enfant » (clé étrangère COMPOSÉE avec le compte) — la garde transitoire le détache.
    if (avecParent) await sql.unsafe(`UPDATE business_operations SET parent_operation_id = $1 WHERE id = $2`, [sinistre, intervention] as never[]);

    const { db } = await import('@/db');
    const { sql: d } = await import('drizzle-orm');
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    const { transferAssetOperationsInTx } = await import('@/services/business-operations/asset-lifecycle');
    // Même enchaînement que le déplacement d'un bien (Duo) : Opérations, puis le bien, puis ses données.
    await db.transaction(async (tx) => {
      await transferAssetOperationsInTx(tx, { assetId: voiture.id, fromAccountId: A.id, toAccountId: B.id });
      await tx.execute(d`UPDATE assets SET account_id = ${B.id} WHERE id = ${voiture.id}`);
      await transferAssetDataInTx(tx, { assetId: voiture.id, fromAccountId: A.id, toAccountId: B.id });
    });
    const compteDe = async (id: number) => (await sql<{ a: number }[]>`SELECT account_id AS a FROM business_operations WHERE id = ${id}`)[0].a;
    expect(await compteDe(intervention)).toBe(B.id);
    expect(await compteDe(sinistre)).toBe(A.id);
    if (avecParent) expect((await sql.unsafe<Array<{ p: number | null }>>(`SELECT parent_operation_id AS p FROM business_operations WHERE id = $1`, [intervention] as never[]))[0].p).toBeNull();

    // Dossier BO « Données du compte » (Opération et bien), diagnostic, isolation des comptes.
    const { buildEntityDossier } = await import('@/services/admin/account-data/dossier');
    const dos = await buildEntityDossier(A.id, 'operation', sinistre);
    expect(JSON.stringify(dos)).not.toMatch(/claim_actions|claim_exchanges|Opération parente|Opération enfant/);
    expect(JSON.stringify(await buildEntityDossier(B.id, 'asset', voiture.id))).toContain('Voiture');
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const diag = new OperationDiagnosticsService();
    expect((await diag.detail(sinistre))?.operation.id).toBe(sinistre);
    const durs = await diag.hardAnomalies(A.id);
    expect(Array.isArray(durs)).toBe(true);
    const { detectCrossAccountRelations } = await import('@/services/security/cross-account/detection');
    const iso = await detectCrossAccountRelations();
    expect(iso.checks.filter((c) => c.error), JSON.stringify(iso.checks.filter((c) => c.error))).toEqual([]);

    // Informations complémentaires (Drizzle : lecture / écriture de la ligne complète).
    const { updateAssetAdditionalInfos, getAssetAdditionalInfos } = await import('@/services/exports/additional-infos.service');
    const ecrit = await updateAssetAdditionalInfos(maison.id, A.id, A.ownerUserId, { set: { commercial: { e2eNote: 'L84A' } }, unset: {} } as never);
    expect(ecrit.commercial).toBeDefined();
    expect((await getAssetAdditionalInfos(maison.id, A.id)).version).toBeGreaterThanOrEqual(1);
    expect(Object.keys(ecrit)).not.toContain('claim');

    // Campagne de cohérence (tous les contrôles du registre) sur ces comptes : aucune erreur.
    const { runCoherenceFor } = await import('../coherence-run');
    const run = await runCoherenceFor(sql, [A.id, B.id], { mode: 'DRY_RUN' });
    expect(run.status).toBe('COMPLETE');
    expect(Object.entries(run.results).filter(([, r]) => (r.ERROR ?? 0) > 0)).toEqual([]);
  }

  // ══ L84A-E01 ════════════════════════════════════════════════════════════
  it('L84A-E01 — avant : recette classée et export complet ; l’application tourne avec l’ancien modèle encore présent', async () => {
    const m = await import('@/services/business-operations/claims/legacy-schema');
    expect(m.legacyClaimModelComplete(await legacy())).toBe(true);
    await recetteClassee();
    await exportComplet(true);
    await smoke(true);
  }, 120_000);

  // ══ L84A-E02 ════════════════════════════════════════════════════════════
  it('L84A-E02 — simulation : rapport exact (objets, lignes, motifs de refus), aucune écriture', async () => {
    // Données héritées d'un compte de préproduction (état d'avant nettoyage).
    compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison sinistrée' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    const [{ id: claim }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label) VALUES (${compte.id}, 'CLAIM', 'REALIZED', 'Dégât des eaux') RETURNING id::int AS id`;
    const [{ id: interv }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label) VALUES (${compte.id}, 'INTERVENTION', 'REALIZED', 'Plombier') RETURNING id::int AS id`;
    await sql.unsafe(`UPDATE business_operations SET parent_operation_id = $1 WHERE id = $2`, [claim, interv] as never[]);
    await sql.unsafe(`INSERT INTO business_operation_claim_actions (operation_id, title, invoice_file_id) VALUES ($1, 'Recherche de fuite', $2)`, [claim, f.id] as never[]);
    await sql.unsafe(`INSERT INTO business_operation_claim_exchanges (operation_id, summary, document_file_id) VALUES ($1, 'Courrier assureur', $2)`, [claim, f.id] as never[]);
    await sql.unsafe(`INSERT INTO asset_additional_infos (asset_id, account_id, claim_json) VALUES ($1, $2, '{"claimType":"DEGAT_DES_EAUX"}'::jsonb)`, [bien.id, compte.id] as never[]);
    await sql.unsafe(`INSERT INTO business_operation_claim_migration_marks (asset_id, account_id, migration_version, data_fingerprint, outcome) VALUES ($1, $2, 'v1', 'x', 'CREATED')`, [bien.id, compte.id] as never[]);

    const photo = async () => ({
      schema: await legacy(),
      lignes: await sql.unsafe(`SELECT (SELECT count(*) FROM business_operation_claim_actions)::int AS a, (SELECT count(*) FROM business_operation_claim_exchanges)::int AS x,
        (SELECT count(*) FROM business_operation_claim_migration_marks)::int AS m, (SELECT count(*) FROM business_operations WHERE parent_operation_id IS NOT NULL)::int AS p,
        (SELECT count(*) FROM asset_additional_infos WHERE claim_json <> '{}'::jsonb)::int AS j`),
      fk: await contrainte('business_operations_parent_fk'),
      json: await contrainte('asset_additional_infos_json_objects_check'),
    });
    const avant = await photo();
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const out = await executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'simulate', step: 'finalize', runId: null, accountId: null, reason: null }, hooks());
    const r = out.result as Json & { blockers: Array<{ code: string }>; objects: Array<{ name: string; present: boolean; rows: number | null }>; remaining: Record<string, number> };
    expect(r).toMatchObject({ kind: 'FINALIZE', mode: 'SIMULATE', status: 'succeeded', possible: false, alreadyFinalized: false });
    expect(r.blockers.map((b) => b.code).sort()).toEqual(['CLEANUP_INCOMPLETE', 'RESTORE_POINT_REQUIRED']);
    expect(r.remaining).toMatchObject({ ACTIONS: 1, EXCHANGES: 1, CHILDREN: 1, LEGACY_FORM: 1, MIGRATION_MARKS: 1 });
    expect(r.remainingAccounts).toEqual([compte.id]);
    expect(r.objects.map((o) => [o.name, o.present])).toEqual([
      ['business_operation_claim_actions', true], ['business_operation_claim_exchanges', true], ['business_operation_claim_migration_marks', true],
      ['business_operations.parent_operation_id', true], ['asset_additional_infos.claim_json', true],
    ]);
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    expect(summarizeBackfill('claims-legacy-cleanup', 'simulate', 'finalize', out).headline).toMatch(/finalisation REFUSÉE pour l’instant — Nettoyage incomplet/);
    // AUCUNE écriture : schéma, données, contraintes identiques ; seule la trace d'exécution.
    expect(await photo()).toEqual(avant);
    expect(await runs('FINALIZE_SIMULATE')).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  }, 60_000);

  // ══ L84A-E03 ════════════════════════════════════════════════════════════
  it('L84A-E03 — « Finaliser » refusé sans nettoyage complet (point présent) ; rien supprimé ; puis nettoyage appliqué', async () => {
    const f = await import('@/services/business-operations/claims/legacy-finalize');
    const r = await f.runClaimLegacyFinalization({ sql, mode: 'APPLY', reason: 'Finalisation e2e', restorePoints: pointRecent() });
    expect(r).toMatchObject({ status: 'refused', refusal: { code: 'CLEANUP_INCOMPLETE' }, dropped: [] });
    expect(r.refusal!.message).toMatch(/Nettoyage incomplet : 5 élément\(s\).*1 compte\(s\)/);
    const m = await import('@/services/business-operations/claims/legacy-schema');
    expect(m.legacyClaimModelComplete(await legacy())).toBe(true);
    // Par le moteur des rattrapages : échec motivé (le rapport du BO affiche le motif).
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    await expect(executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'apply', step: 'finalize', runId: null, accountId: null, reason: 'Finalisation e2e' }, hooks()))
      .rejects.toMatchObject({ code: expect.stringMatching(/CLEANUP_INCOMPLETE|RESTORE_POINT_REQUIRED/) });
    expect(m.legacyClaimModelComplete(await legacy())).toBe(true);

    // Nettoyage (étape 1) appliqué sur tous les comptes.
    const c = await import('@/services/business-operations/claims/legacy-cleanup');
    const n = await c.runClaimLegacyCleanup({ sql, mode: 'APPLY', reason: 'Nettoyage e2e', restorePoints: pointRecent(), requestCoherence: async () => null });
    expect(n.status).toBe('succeeded');
    expect(n.counters).toMatchObject({ ACTIONS: 1, EXCHANGES: 1, CHILDREN: 1, LEGACY_FORM: 1, MIGRATION_MARKS: 1 });
    cleanupRunId = n.runId;
    expect((await c.countLegacyRemaining(sql, await legacy())).accounts).toEqual([]);
  }, 60_000);

  // ══ L84A-E04 ════════════════════════════════════════════════════════════
  it('L84A-E04 — « Finaliser » refusé sans point de restauration de moins de 24 h ; rien supprimé', async () => {
    const f = await import('@/services/business-operations/claims/legacy-finalize');
    const r = await f.runClaimLegacyFinalization({ sql, mode: 'APPLY', reason: 'Finalisation e2e', restorePoints: aucunPoint });
    expect(r).toMatchObject({ status: 'refused', refusal: { code: 'RESTORE_POINT_REQUIRED' }, dropped: [] });
    expect(r.refusal!.message).toMatch(/Aucun point de restauration de moins de 24 h/);
    const m = await import('@/services/business-operations/claims/legacy-schema');
    expect(m.legacyClaimModelComplete(await legacy())).toBe(true);
    expect((await runs('FINALIZE')).map((x) => x.status)).toEqual(['refused', 'refused', 'refused']);
  }, 60_000);

  // ══ L84A-E05 ════════════════════════════════════════════════════════════
  it('L84A-E05 — point de restauration réel puis « Finaliser » (moteur BO) : ancien modèle supprimé, contrainte JSON reposée ; rejoué : rien', async () => {
    const { runDatabaseBackup } = await import('@/services/backup/database-backup.service');
    const point = await runDatabaseBackup('admin', { label: 'Avant finalisation L84A' });
    pointAvant = point.backupId;
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    // Simulation d'abord : possible.
    const sim = (await executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'simulate', step: 'finalize', runId: null, accountId: null, reason: null }, hooks())).result as Json;
    expect(sim).toMatchObject({ possible: true, blockers: [], restorePoint: { backupId: pointAvant } });
    const out = await executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'apply', step: 'finalize', runId: null, accountId: null, reason: 'Finalisation O-10 e2e' }, hooks());
    const r = out.result as Json & { dropped: string[] };
    expect(r).toMatchObject({ status: 'succeeded', alreadyFinalized: false, restorePoint: { backupId: pointAvant } });
    expect(r.dropped).toEqual(expect.arrayContaining([...LEGACY_TABLES, 'business_operations.parent_operation_id', 'asset_additional_infos.claim_json',
      'business_operations_parent_fk', 'business_operations_parent_not_self_chk', 'business_operations_parent_idx']));
    const m = await import('@/services/business-operations/claims/legacy-schema');
    expect(m.legacyClaimModelPresent(await legacy())).toBe(false);
    const t = await tables();
    for (const x of LEGACY_TABLES) expect(t, x).not.toContain(x);
    expect(await contrainte('business_operations_parent_fk')).toBeNull();
    expect(await contrainte('business_operations_parent_not_self_chk')).toBeNull();
    expect(await index('business_operations_parent_idx')).toBe(false);
    const json = await contrainte('asset_additional_infos_json_objects_check');
    expect(json).toMatch(/commercial_json.*rental_json.*insurance_json.*finance_json/);
    expect(json).not.toMatch(/claim_json/);
    // Les autres contraintes des Opérations sont intactes.
    expect(await contrainte('business_operations_merged_into_fk')).toMatch(/FOREIGN KEY/);
    expect(await runs('FINALIZE')).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'succeeded', restore_point_id: pointAvant })]));
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    expect(summarizeBackfill('claims-legacy-cleanup', 'apply', 'finalize', out)).toMatchObject({ restorable: false, headline: expect.stringMatching(/supprimé\(s\) définitivement/) });
    // Rejouée : déjà supprimé, rien à faire (même sans point de restauration).
    const f = await import('@/services/business-operations/claims/legacy-finalize');
    const again = await f.runClaimLegacyFinalization({ sql, mode: 'APPLY', reason: 'Rejeu', restorePoints: aucunPoint });
    expect(again).toMatchObject({ status: 'succeeded', alreadyFinalized: true, dropped: [] });
    expect(again.finalizedAt).not.toBeNull();
  }, 120_000);

  // ══ L84A-E06 ════════════════════════════════════════════════════════════
  it('L84A-E06 — après : l’application tourne sans ces tables ; export de recette vert (L82E-E01 + export complet)', async () => {
    await recetteClassee();
    await exportComplet(false);
    await smoke(false);
    // Dossier BO de l'Opération du compte nettoyé (sinistre d'avant) : lisible.
    const [{ id }] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'CLAIM'`;
    const { buildEntityDossier } = await import('@/services/admin/account-data/dossier');
    expect(JSON.stringify(await buildEntityDossier(compte.id, 'operation', id))).toContain('Dégât des eaux');
  }, 120_000);

  // ══ L84A-E07 ════════════════════════════════════════════════════════════
  it('L84A-E07 — après : restaurer le nettoyage 83D est refusé (message clair, rien d’écrit) ; le nettoyage rend « supprimé »', async () => {
    const c = await import('@/services/business-operations/claims/legacy-cleanup');
    await expect(c.restoreClaimLegacyCleanup(sql, cleanupRunId, { reason: 'Retour arrière' }))
      .rejects.toMatchObject({ code: 'LEGACY_MODEL_FINALIZED', message: expect.stringMatching(/Restauration refusée : l’ancien modèle Sinistres a été supprimé définitivement le .*Rien n’a été modifié/) });
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    await expect(executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'restore', step: null, runId: cleanupRunId, accountId: null, reason: 'Retour arrière' }, hooks()))
      .rejects.toThrow(/ne peut plus être restauré/);
    expect(await sql`SELECT count(*)::int AS n FROM claim_legacy_cleanup_journal WHERE run_id = ${cleanupRunId} AND restored_at IS NOT NULL`).toEqual([{ n: 0 }]);
    expect((await runs('REFUSED')).filter((x) => String(x.error).includes('supprimé définitivement'))).toHaveLength(2);
    // Simuler / Appliquer le nettoyage : ancien modèle supprimé, rien à faire (aucun point requis).
    for (const mode of ['SIMULATE', 'APPLY'] as const) {
      const r = await c.runClaimLegacyCleanup({ sql, mode, reason: 'Après finalisation', restorePoints: aucunPoint });
      expect(r).toMatchObject({ status: 'succeeded', accounts: [], finalized: { at: expect.any(String) } });
    }
  }, 60_000);

  // ══ L84A-E08 ════════════════════════════════════════════════════════════
  it('L84A-E08 — après : un point de restauration ANTÉRIEUR à la finalisation est refusé (variante prudente), aucune écriture', async () => {
    const { restoreDatabaseBackup, RestoreRefusedError } = await import('@/services/backup/database-restore.service');
    const avant = await sql`SELECT count(*)::int AS n FROM business_operations`;
    const err = await restoreDatabaseBackup(sql, pointAvant, { reason: 'Retour au point L84A', skipSafetyBackup: true }).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreRefusedError);
    expect(String(err.message)).toMatch(/ANTÉRIEUR à la suppression définitive de l’ancien modèle Sinistres/);
    expect(err.compatibility).toMatchObject({ restorable: false, predatesClaimFinalization: true });
    expect(await sql`SELECT count(*)::int AS n FROM business_operations`).toEqual(avant);
    const m = await import('@/services/business-operations/claims/legacy-schema');
    expect(m.legacyClaimModelPresent(await legacy())).toBe(false);
    // La liste des points le montre non restaurable (le BO l'affiche avec ce motif).
    const { listRestorePoints } = await import('@/services/business-operations/claims/legacy-cleanup');
    expect((await listRestorePoints(sql)).find((p) => p.backupId === pointAvant)).toMatchObject({ restorable: false });
  }, 60_000);
});
