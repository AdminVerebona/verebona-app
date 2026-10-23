/**
 * Lot 83D — O-8 « Sinistres / Assurance » (CDC Opérations, Agenda, Timeline,
 * Sinistres v5 §15–§18, AC35–AC39 ; arbitrages V-Q1, V-Q2, V-Q8, C-Q5, C-Q8)
 * sur PostgreSQL 16 réel.
 *
 *   L83D-E01  dossier d'assurance COMPLET depuis l'Opération CLAIM, comparé à
 *             la RÉFÉRENCE capturée avant refonte (L83D-E00) : rien d'utile
 *             perdu ; photo de dommage et justificatif EXPLOITABLES ; Pièces
 *             et équipements ; les anciennes « actions » deviennent des étapes
 *             de la chronologie, les échanges des documents.
 *   L83D-E02  bloc « Sinistres » ABSENT (desktop et mobile partagent les mêmes
 *             routes) : plus de routes /claims, plus de sous-rubrique `claim`
 *             (lecture et écriture), plus de « Voir le sinistre » à l'Agenda.
 *   L83D-E03  export : choix du sinistre, snapshot figé, Standard refusé ;
 *             sans sinistre : ancienne saisie `claim_json` JAMAIS lue.
 *   L83D-E04  rattrapage BO : application REFUSÉE sans point de restauration
 *             (aucune écriture, exécution REFUSED journalisée) — par le
 *             moteur des rattrapages (`executeBackfill`).
 *   L83D-E05  simulation : rapport exact, AUCUNE écriture.
 *   L83D-E06  application (point de restauration < 24 h) : purge, documents /
 *             Opérations / événements / Pièces / équipements / dommages
 *             PRÉSERVÉS, aucune FK vers les tables purgées, cartes fermées,
 *             campagne de cohérence demandée ; dossier inchangé ; idempotence ;
 *             restauration exacte.
 *   L83D-E07  compte inéligible : purgé, mais jamais de campagne de cohérence.
 *
 * Assertions limitées aux comptes créés ici (filtre `accountId` du
 * rattrapage). Aucune dépendance à la date du jour (dates figées).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { buildSinistreDossier, dossierUtile, type DossierUtile, type SinistreDossier } from '../datasets/sinistre-dossier';
import type { AccountRow } from '../factories';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const AUJOURDHUI = '2026-10-23';
const MAINTENANT = new Date('2026-10-23T10:00:00Z');
const REFERENCE = JSON.parse(readFileSync(join(process.cwd(), 'src/test/e2e/fixtures/l83d-dossier-assurance-reference.json'), 'utf8')) as { utile: DossierUtile };
/** Point de restauration simulé (S3 absent en e2e) : manifeste v2 compatible, terminé il y a 2 h. */
const POINT_RECENT = async () => [{ backupId: 'e2e-l83d', version: 2, finishedAt: '2026-10-23T08:00:00Z', restorable: true }];
const POINT_ANCIEN = async () => [{ backupId: 'e2e-l83d-old', version: 2, finishedAt: '2026-10-21T08:00:00Z', restorable: true }];

type Json = Record<string, unknown>;

scenario('L83D', 'Sinistres v5 — bloc retiré, dossier d’assurance depuis l’Opération, nettoyage de l’ancien modèle', ({ sql, make }) => {
  afterEach(async () => {
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
  });

  const cleanup = () => import('@/services/business-operations/claims/legacy-cleanup');
  function connecter(c: AccountRow) {
    session.currentAccountId = c.id;
    session.userId = c.ownerUserId;
  }

  /** Photographie de tout ce que le nettoyage doit PRÉSERVER (compte du jeu). */
  async function preserve(d: SinistreDossier) {
    const a = d.compte.id;
    const n = async (q: ReturnType<typeof sql>) => Number(((await q) as unknown as Array<{ n: number }>)[0].n);
    return {
      fichiers: await n(sql`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${a} AND deleted_at IS NULL`),
      photos: await n(sql`SELECT count(*)::int AS n FROM asset_photos WHERE asset_id = ${d.maison.id}`),
      operations: await sql`SELECT id::int AS id, type_code, status, invalidated_at FROM business_operations WHERE account_id = ${a} ORDER BY id`,
      sources: await n(sql`SELECT count(*)::int AS n FROM business_operation_sources WHERE account_id = ${a} AND active`),
      composantes: await n(sql`SELECT count(*)::int AS n FROM business_operation_financial_components WHERE account_id = ${a} AND active`),
      membres: await sql`SELECT operation_id::int AS operation_id, file_id::int AS file_id, origins FROM business_operation_documents WHERE account_id = ${a} ORDER BY operation_id, file_id`,
      agenda: await sql`SELECT id::int AS id, business_operation_id::int AS op, operation_role FROM agenda_items WHERE account_id = ${a} ORDER BY id`,
      pieces: await n(sql`SELECT count(*)::int AS n FROM business_operation_room_links WHERE account_id = ${a} AND active`),
      equipements: await n(sql`SELECT count(*)::int AS n FROM business_operation_equipment_links WHERE account_id = ${a} AND active`),
      details: await sql`SELECT * FROM business_operation_claim_details WHERE operation_id = ${d.claimId}`,
      dommages: await sql`SELECT dm.id::int AS id, dm.zone, dm.element, array(SELECT photo_id::int FROM business_operation_claim_damage_photos WHERE damage_id = dm.id) AS photos,
                                array(SELECT file_id::int FROM business_operation_claim_damage_documents WHERE damage_id = dm.id) AS docs
                            FROM business_operation_claim_damages dm WHERE dm.operation_id = ${d.claimId} ORDER BY dm.id`,
      historique: await n(sql`SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${a}`),
    };
  }
  const ancienModele = async (d: SinistreDossier) => ({
    actions: (await sql`SELECT id FROM business_operation_claim_actions WHERE operation_id = ${d.claimId}`).length,
    echanges: (await sql`SELECT id FROM business_operation_claim_exchanges WHERE operation_id = ${d.claimId}`).length,
    parent: (await sql<{ p: number | null }[]>`SELECT parent_operation_id::int AS p FROM business_operations WHERE id = ${d.childInterventionId}`)[0].p,
    formulaire: (await sql<{ c: Json }[]>`SELECT claim_json AS c FROM asset_additional_infos WHERE asset_id = ${d.maison.id}`)[0]?.c ?? null,
    marques: (await sql`SELECT asset_id FROM business_operation_claim_migration_marks WHERE account_id = ${d.compte.id}`).length,
    cartes: await sql<{ id: number; resolution_reason: string | null }[]>`SELECT id::int AS id, resolution_reason FROM to_process_actions WHERE account_id = ${d.compte.id} AND rule_code IN ('OPERATION-CLAIM-PARENT', 'OPERATION-CLAIM-DETACH') ORDER BY id`,
  });
  /** Jeu complet + ce qui reste de l'ancien modèle en préproduction (formulaire, repère de migration, carte ouverte). */
  async function jeuPreprod(): Promise<SinistreDossier> {
    const d = await buildSinistreDossier(sql, make);
    await sql`INSERT INTO asset_additional_infos (asset_id, account_id, claim_json) VALUES (${d.maison.id}, ${d.compte.id}, ${JSON.stringify({ claimType: 'VOL', occurredOn: '2020-01-01', circumstances: 'Ancienne saisie' })}::jsonb)
              ON CONFLICT (asset_id) DO UPDATE SET claim_json = EXCLUDED.claim_json`;
    await sql`INSERT INTO business_operation_claim_migration_marks (account_id, asset_id, migration_version, data_fingerprint, operation_id, outcome)
              VALUES (${d.compte.id}, ${d.maison.id}, '1', 'e2e', ${d.claimId}, 'CREATED')`;
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
              VALUES (${d.compte.id}, 'BUSINESS_OPERATION', ${d.childInterventionId}, ${`claim-parent:${d.claimId}`}, 'ARBITRATE', 'OPERATION-CLAIM-PARENT', 'Cette intervention fait-elle partie du sinistre ?')`;
    return d;
  }

  // ══ V-Q8 : dossier d'assurance depuis l'Opération CLAIM ═══════════════════

  it('L83D-E01 / F-153 / F-154 — dossier complet depuis l’Opération : référence d’avant refonte conservée ; photo de dommage ET justificatif exploitables ; Pièces / équipements ; étapes et courriers ; dommage et échange jamais des Opérations', async () => {
    const d = await buildSinistreDossier(sql, make);
    const { utile, data } = await dossierUtile(d, AUJOURDHUI);
    const ref = REFERENCE.utile;
    // Synthèse : identique à la référence (aucune donnée d'assurance perdue).
    expect(utile.claim).toEqual(ref.claim);
    // Chronologie : toutes les entrées de la référence, dont l'ancienne « action » devenue étape d'Agenda (§18.1).
    expect(utile.timeline).toEqual(expect.arrayContaining(ref.timeline));
    expect(utile.timeline).toContain('2026-04-18 Réparation du plafond');
    expect(ref.actions).toEqual(['2026-04-18 Réparation du plafond']);
    expect(utile.actions).toEqual([]);
    // Documents : TOUS ceux de l'Opération (la référence + le devis, désormais présélectionné), sans doublon.
    expect(utile.documents).toEqual(expect.arrayContaining(ref.documents));
    expect(utile.documents).toContain('Devis plombier Martin');
    expect(new Set(utile.documents).size).toBe(utile.documents.length);
    // Dommage : photo ET justificatif reliés, exploitables (référencés dans le dossier), jamais dupliqués.
    expect(utile.damages).toHaveLength(1);
    expect(utile.damages[0]).toMatchObject({ zone: ref.damages[0].zone, element: ref.damages[0].element, finding: ref.damages[0].finding, photos: ref.damages[0].photos });
    expect(utile.damages[0].justificatifs).toEqual(['Devis plombier Martin']);
    expect(utile.photos).toEqual(ref.photos);
    const docDevis = (data.documents ?? []).filter((x) => x.title === 'Devis plombier Martin');
    expect(docDevis).toHaveLength(1);
    expect(data.damages![0].docIds).toEqual([docDevis[0].id]);
    // Échanges (§18.2) : le courrier de l'expert est un document de l'Opération.
    expect(utile.exchanges.some((x) => x.includes('Courrier expert convocation'))).toBe(true);
    // Pièces et équipements du socle 82D.
    expect(utile.scope).toEqual({ rooms: ['Salle de bain'], equipments: ['Chauffe-eau'] });
    expect(data.claim).toMatchObject({ rooms: 'Salle de bain', equipments: 'Chauffe-eau' });
    // F-153 / F-154 : le dommage (donnée du sinistre) et le courrier de l'expert (document) ne sont jamais des Opérations.
    expect((await sql<{ t: string }[]>`SELECT type_code AS t FROM business_operations WHERE account_id = ${d.compte.id} ORDER BY id`).map((x) => x.t)).toEqual(['CLAIM', 'INTERVENTION']);
    // Le dossier ne lit plus l'ancien modèle : vider actions / échanges / enfant n'y change rien.
    await sql`DELETE FROM business_operation_claim_actions WHERE operation_id = ${d.claimId}`;
    await sql`DELETE FROM business_operation_claim_exchanges WHERE operation_id = ${d.claimId}`;
    await sql`UPDATE business_operations SET parent_operation_id = NULL WHERE id = ${d.childInterventionId}`;
    expect((await dossierUtile(d, AUJOURDHUI)).utile).toEqual(utile);
  });

  // ══ V-Q1 : bloc « Sinistres » absent ═════════════════════════════════════

  it('L83D-E02 — bloc « Sinistres » absent : aucune route /claims, sous-rubrique `claim` ni lue ni écrite (422), Agenda sans « Voir le sinistre »', async () => {
    const d = await jeuPreprod();
    connecter(d.compte);
    // Routes de la fiche (desktop et mobile utilisent les mêmes) : supprimées.
    await expect(import('@/app/api/assets/[id]/claims/route' as string)).rejects.toThrow();
    await expect(import('@/app/api/assets/[id]/claims/[claimId]/route' as string)).rejects.toThrow();
    const route = await import('@/app/api/assets/[id]/additional-infos/route');
    const params = { params: Promise.resolve({ id: String(d.maison.id) }) };
    const get = await route.GET(new NextRequest(`http://x/api/assets/${d.maison.id}/additional-infos?include=references`), params);
    expect(get.status).toBe(200);
    const body = await get.json() as Json;
    expect(body).not.toHaveProperty('claim');
    expect(JSON.stringify(body.sections)).not.toMatch(/"claim"/);
    expect(JSON.stringify(body.references ?? {})).not.toMatch(/claimEvents/);
    expect(JSON.stringify(body)).not.toMatch(/Ancienne saisie/);
    const patch = await route.PATCH(new NextRequest(`http://x/api/assets/${d.maison.id}/additional-infos`, {
      method: 'PATCH', body: JSON.stringify({ claim: { claimType: 'VOL' } }), headers: { 'content-type': 'application/json' },
    }), params);
    expect(patch.status).toBe(422);
    expect(JSON.stringify(await patch.json())).toMatch(/Sous-rubrique inconnue/);
    // Agenda : l'élément principal du sinistre n'expose plus de lien vers un bloc de la fiche.
    const { getAgendaItemById } = await import('@/services/agenda/AgendaQueryService');
    const item = await getAgendaItemById(d.agenda.principal, d.compte.id);
    expect(item).not.toBeNull();
    expect(JSON.stringify(item)).not.toMatch(/claimSource|highlight=claims/);
  });

  it('L83D-E03 / F-157 — export : choix du sinistre, snapshot figé, Standard refusé ; sans sinistre, l’ancienne saisie n’est jamais lue', async () => {
    const d = await buildSinistreDossier(sql, make);
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const vol = await withBusinessOperationWrite(d.compte.id, async (repo) => {
      const c = await repo.create({
        type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: '2025-05-01',
        source: { kind: 'DOCUMENT', entityKey: d.files.constat, authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: d.maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L83D',
      });
      await repo.upsertClaimDetails(c.id, { claimType: 'VOL' } as never, 'E2E_L83D');
      return c.id;
    });
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const defaut = await loadExportSource({ assetId: d.maison.id, accountId: d.compte.id, userId: d.compte.ownerUserId, exportType: 'ASSURANCE_SINISTRE' });
    expect(defaut.claim).toMatchObject({ selectedOperationId: d.claimId, origin: 'operation' });
    expect(defaut.claim!.options.map((o) => o.id)).toEqual([d.claimId, vol]);
    expect(defaut.claimFile).toMatchObject({ operationId: d.claimId, claimType: 'DEGAT_DES_EAUX', rooms: ['Salle de bain'], equipments: ['Chauffe-eau'] });
    const choisi = await loadExportSource({ assetId: d.maison.id, accountId: d.compte.id, userId: d.compte.ownerUserId, exportType: 'ASSURANCE_SINISTRE', claimOperationId: vol });
    expect(choisi.claimFile).toMatchObject({ operationId: vol, claimType: 'VOL', occurredOn: '2025-05-01' });
    // Préparation et génération : sinistre figé dans la demande.
    const { prepareDossier } = await import('@/services/exports/v12/preparation/load');
    const { findAccessibleAssetForExport } = await import('@/services/exports/export-access');
    const acces = (await findAccessibleAssetForExport({ userId: d.compte.ownerUserId, currentAccountId: d.compte.id } as never, d.maison.id))!;
    const p = await prepareDossier({ asset: acces, userId: d.compte.ownerUserId, body: { exportType: 'ASSURANCE_SINISTRE', claimOperationId: vol } });
    expect(p.ok && p.body.claim).toMatchObject({ selectedOperationId: vol, origin: 'operation' });
    const { enqueueGeneration } = await import('@/services/exports/v12/generation/enqueue');
    const g = await enqueueGeneration({ asset: acces, userId: d.compte.ownerUserId, code: 'ASSURANCE_SINISTRE', body: { choices: { outputFormat: 'PDF', claimOperationId: vol } } });
    expect(g.ok).toBe(true);
    const [snap] = await sql<{ s: Json }[]>`SELECT snapshot_json AS s FROM export_generation WHERE asset_id = ${d.maison.id} ORDER BY id DESC LIMIT 1`;
    expect((snap.s.request as Json).claimOperationId ?? ((snap.s.request as Json).choices as Json).claimOperationId).toBe(vol);
    // Sans sinistre : l'ancienne saisie (claim_json) n'est JAMAIS lue (V-Q2, aucune passerelle).
    const autre = await make.asset(d.compte, { category: 'IMMOBILIER', name: 'Studio' });
    await sql`INSERT INTO asset_additional_infos (asset_id, account_id, claim_json) VALUES (${autre.id}, ${d.compte.id}, ${JSON.stringify({ circumstances: 'Choc en stationnement' })}::jsonb)`;
    const sans = await loadExportSource({ assetId: autre.id, accountId: d.compte.id, userId: d.compte.ownerUserId, exportType: 'ASSURANCE_SINISTRE' });
    expect(sans.claim).toMatchObject({ selectedOperationId: null, origin: 'none' });
    expect(sans.claimFile ?? null).toBeNull();
    expect(JSON.stringify(sans)).not.toMatch(/Choc en stationnement/);
    // Standard : export refusé (Premium).
    const std = await make.account({ plan: 'standard' });
    const velo = await make.asset(std, { name: 'Vélo' });
    const accesStd = (await findAccessibleAssetForExport({ userId: std.ownerUserId, currentAccountId: std.id } as never, velo.id))!;
    expect(await prepareDossier({ asset: accesStd, userId: std.ownerUserId, body: { exportType: 'ASSURANCE_SINISTRE' } })).toMatchObject({ ok: false, status: 403 });
  });

  // ══ V-Q2 : nettoyage de l'ancien modèle (rattrapage BO) ══════════════════

  it('L83D-E04 — application REFUSÉE sans point de restauration (< 24 h) : moteur des rattrapages, aucune écriture, exécution REFUSED journalisée', async () => {
    const d = await jeuPreprod();
    const avant = await ancienModele(d);
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const hooks = { log: () => undefined, progress: () => undefined };
    // S3 absent en e2e : aucun point de restauration lisible → refus par le moteur.
    await expect(executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'apply', accountId: d.compte.id, reason: 'Nettoyage lot 83D' } as never, hooks))
      .rejects.toMatchObject({ code: 'RESTORE_POINT_REQUIRED' });
    // Point trop ancien (> 24 h) : refus, motif lisible.
    const m = await cleanup();
    const r = await m.runClaimLegacyCleanup({ sql, mode: 'APPLY', accountId: d.compte.id, reason: 'Nettoyage lot 83D', now: MAINTENANT, restorePoints: POINT_ANCIEN });
    expect(r).toMatchObject({ status: 'refused', accounts: [], journalRows: 0 });
    expect(r.refusal).toMatch(/point de restauration/i);
    expect(await ancienModele(d)).toEqual(avant);
    const [run] = await sql`SELECT mode, status, error FROM claim_legacy_cleanup_runs WHERE id = ${r.runId}`;
    expect(run).toMatchObject({ mode: 'REFUSED', status: 'refused' });
    expect(await sql`SELECT id FROM claim_legacy_cleanup_journal WHERE run_id = ${r.runId}`).toHaveLength(0);
  });

  it('L83D-E05 — simulation : rapport exact par catégorie, AUCUNE écriture (moteur des rattrapages)', async () => {
    const d = await jeuPreprod();
    const avantModele = await ancienModele(d);
    const avant = await preserve(d);
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const out = await executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'simulate', accountId: d.compte.id } as never, { log: () => undefined, progress: () => undefined });
    const r = (out as { result: Awaited<ReturnType<Awaited<ReturnType<typeof cleanup>>['runClaimLegacyCleanup']>> }).result;
    expect(r).toMatchObject({ mode: 'SIMULATE', status: 'succeeded', accounts: [d.compte.id], journalRows: 0 });
    expect(r.counters).toEqual({ ACTIONS: 1, EXCHANGES: 1, CHILDREN: 1, LEGACY_FORM: 1, MIGRATION_MARKS: 1, CARDS: 1 });
    expect(r.samples.map((s) => s.label).join(' | ')).toMatch(/Réparation du plafond/);
    expect(r.coherence.requested).toBe(false);
    expect(await ancienModele(d)).toEqual(avantModele);
    expect(await preserve(d)).toEqual(avant);
    // Rapport lisible au BO.
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    expect(summarizeBackfill('claims-legacy-cleanup', 'simulate', null, out).headline).toMatch(/Simulation : 6 élément\(s\) de l’ancien modèle|Simulation : 6 élément\(s\)/);
  });

  it('L83D-E06 — application : purge journalisée, tout le reste PRÉSERVÉ, aucune FK collatérale, cartes fermées, cohérence demandée ; dossier inchangé ; idempotente ; restauration exacte', async () => {
    const d = await jeuPreprod();
    const dossierAvant = (await dossierUtile(d, AUJOURDHUI)).utile;
    const avant = await preserve(d);
    const modeleAvant = await ancienModele(d);
    // Aucune clé étrangère d'une AUTRE table vers les tables purgées (aucune suppression en cascade possible).
    expect(await sql`
      SELECT conrelid::regclass::text AS de, confrelid::regclass::text AS vers FROM pg_constraint
       WHERE contype = 'f' AND confrelid IN ('business_operation_claim_actions'::regclass, 'business_operation_claim_exchanges'::regclass, 'business_operation_claim_migration_marks'::regclass)
         AND conrelid NOT IN ('business_operation_claim_actions'::regclass, 'business_operation_claim_exchanges'::regclass, 'business_operation_claim_migration_marks'::regclass)`).toEqual([]);

    const m = await cleanup();
    const campagnes: number[][] = [];
    const requestCoherence = async (ids: number[]) => { campagnes.push(ids); return 4242; };
    const r = await m.runClaimLegacyCleanup({ sql, mode: 'APPLY', accountId: d.compte.id, reason: 'Nettoyage lot 83D', now: MAINTENANT, restorePoints: POINT_RECENT, requestCoherence });
    expect(r).toMatchObject({ status: 'succeeded', accounts: [d.compte.id], restorePoint: { backupId: 'e2e-l83d' } });
    expect(r.counters).toEqual({ ACTIONS: 1, EXCHANGES: 1, CHILDREN: 1, LEGACY_FORM: 1, MIGRATION_MARKS: 1, CARDS: 1 });
    expect(r.coherence).toMatchObject({ requested: true, campaignId: 4242, eligibleAccounts: [d.compte.id], skippedAccounts: [] });
    expect(campagnes).toEqual([[d.compte.id]]);
    const [run] = await sql`SELECT mode, status, restore_point_id, coherence_campaign_id::int AS c, accounts FROM claim_legacy_cleanup_runs WHERE id = ${r.runId}`;
    expect(run).toMatchObject({ mode: 'APPLY', status: 'succeeded', restore_point_id: 'e2e-l83d', c: 4242, accounts: [d.compte.id] });

    // Ancien modèle purgé.
    const apres = await ancienModele(d);
    expect(apres).toMatchObject({ actions: 0, echanges: 0, parent: null, formulaire: {}, marques: 0 });
    expect(apres.cartes).toEqual([{ id: modeleAvant.cartes[0].id, resolution_reason: 'OBSOLETE' }]);
    expect(await sql`SELECT event FROM to_process_action_events WHERE action_id = ${modeleAvant.cartes[0].id} AND event = 'OBSOLETE'`).toHaveLength(1);
    // Préservé : documents, photos, Opérations (l'intervention reste, sans parent), sources, composantes, membres, Agenda, Pièces, équipements, détails, dommages, historique.
    expect(await preserve(d)).toEqual(avant);
    // Dossier d'assurance : identique (photo de dommage et justificatif toujours exploitables).
    expect((await dossierUtile(d, AUJOURDHUI)).utile).toEqual(dossierAvant);

    // Idempotence : un second passage ne trouve plus rien et n'écrit rien.
    const r2 = await m.runClaimLegacyCleanup({ sql, mode: 'APPLY', accountId: d.compte.id, reason: 'Second passage', now: MAINTENANT, restorePoints: POINT_RECENT, requestCoherence });
    expect(r2).toMatchObject({ status: 'succeeded', accounts: [], journalRows: 0 });
    expect(Object.values(r2.counters).every((v) => v === 0)).toBe(true);
    expect(campagnes).toHaveLength(1);

    // Restauration exacte de l'exécution (moteur des rattrapages).
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const out = await executeBackfill(sql, { script: 'claims-legacy-cleanup', action: 'restore', runId: r.runId, reason: 'Retour arrière e2e' } as never, { log: () => undefined, progress: () => undefined });
    expect((out as { result: { conflicts: string[]; restored: number } }).result).toMatchObject({ conflicts: [] });
    expect((out as { result: { restored: number } }).result.restored).toBeGreaterThanOrEqual(6);
    const restaure = await ancienModele(d);
    expect({ ...restaure, cartes: restaure.cartes.map((c) => c.resolution_reason) }).toEqual({ ...modeleAvant, cartes: [null] });
    expect(await sql`SELECT id FROM to_process_action_events WHERE action_id = ${modeleAvant.cartes[0].id} AND event = 'OBSOLETE'`).toHaveLength(0);
    expect(await preserve(d)).toEqual(avant);
    // Restaurer deux fois : refusé ou sans effet, jamais de doublon.
    await m.restoreClaimLegacyCleanup(sql, r.runId, { reason: 'Deuxième retour' }).catch(() => null);
    expect(await ancienModele(d)).toEqual(restaure);
  });

  it('L83D-E07 — compte inéligible (suspendu) : ancien modèle purgé, mais AUCUNE campagne de cohérence', async () => {
    const d = await jeuPreprod();
    await sql`UPDATE accounts SET is_active = false WHERE id = ${d.compte.id}`;
    const m = await cleanup();
    const campagnes: number[][] = [];
    const r = await m.runClaimLegacyCleanup({
      sql, mode: 'APPLY', accountId: d.compte.id, reason: 'Nettoyage lot 83D', now: MAINTENANT, restorePoints: POINT_RECENT,
      requestCoherence: async (ids) => { campagnes.push(ids); return 1; },
    });
    expect(r).toMatchObject({ status: 'succeeded', accounts: [d.compte.id] });
    expect(r.coherence).toMatchObject({ requested: false, campaignId: null, eligibleAccounts: [], skippedAccounts: [d.compte.id] });
    expect(campagnes).toEqual([]);
    expect(await ancienModele(d)).toMatchObject({ actions: 0, echanges: 0, parent: null });
  });
});
