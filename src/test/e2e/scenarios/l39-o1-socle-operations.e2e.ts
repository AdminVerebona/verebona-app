/**
 * Lot 39 — O1, socle des Opérations métier (CDC Opérations V1 C20, C20.1,
 * C21, C21.1, C24, C25, C27, C8, C8.1, C13.1) — base PostgreSQL réelle.
 *
 * Identifiants du CDC quand ils existent (F-xxx, PARENT-xxx, INV-xxx,
 * NFR-OP-xxx), O1-Exx sinon. Aucune Opération n'est créée par l'application
 * dans ce lot : les scénarios écrivent par l'API d'écriture (T3 au lot O3).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow, Factories } from '../factories';

const MIG = join(process.cwd(), 'src/db/migrations');
// Lot 40 : 0320 (candidats T1 versionnés, marqueur T3) complète la 0317.
// Lot 41 : 0321 (issue T3 des candidats).
// Lot 44 : 0323 (colonnes et repère du Sinistre) complète les tables du socle ; 0322 (table `assets`) n'en fait pas partie.
// Lot 47A : 0325 (index de lecture du BO diagnostic sur ces tables).
// Lot 54D : 0379 (reprise T3 et cartes à resynchroniser sur les candidats).
// Lot 78A : 0609 complète ces tables (provenance, lien d'indice, origine ADMIN_REVIEW, index du rattrapage).
// Lot 82D : 0656 élargit les objets de la mémoire des décisions (business_operation_match_decisions).
const FICHIERS_O1 = readdirSync(MIG).filter((f) => /^(03(1[6-9]|2[0135]|79)|0609|0656)_.*\.sql$/.test(f)).sort();

const svc = () => import('@/services/business-operations/write');
const lifecycle = () => import('@/services/business-operations/asset-lifecycle');
const bus = () => import('@/services/business-operations/events');

async function codeErreur(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
  return 'AUCUNE_ERREUR';
}

/** Compte, bien, document du bien. */
async function base(make: Factories, opts: { assets?: number } = {}) {
  const compte = await make.account({ plan: 'premium' });
  const biens: AssetRow[] = [];
  for (let i = 0; i < (opts.assets ?? 1); i++) biens.push(await make.asset(compte, { category: 'IMMOBILIER' }));
  const doc = await make.assetFile(compte, { assetId: biens[0].id });
  return { compte, biens, bien: biens[0], doc };
}

/** Opération créée par l'API d'écriture (source documentaire). */
async function creer(compte: AccountRow, fileId: number, over: Record<string, unknown> = {}) {
  const { withBusinessOperationWrite } = await svc();
  return withBusinessOperationWrite(compte.id, (repo) => repo.create({
    type: { code: 'INTERVENTION' },
    status: 'REALIZED',
    source: { kind: 'DOCUMENT', entityKey: fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
    reasonCode: 'E2E',
    ...over,
  } as never));
}

scenario('L39-O1', 'Socle des Opérations : schéma, intégrité, concurrence, événements, cycle de vie des biens', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  // ── Schéma ────────────────────────────────────────────────────────────────

  it('O1-E01 / C27 migrations 0316-0319 rejouables ; 7 types seedés, aucun 8e type', async () => {
    // Lot 41 : rejeu dans un schéma ISOLÉ — la base E2E est partagée entre fichiers ; rejouer
    // 0317 (index complet que 0320 remplace) sur des candidats réanalysés par un autre scénario
    // échouerait sans rien dire de l'idempotence des migrations elles-mêmes.
    const cnx = await sql.reserve();
    try {
      await cnx.unsafe('SET client_min_messages = warning');
      await cnx.unsafe('DROP SCHEMA IF EXISTS o1_rejeu CASCADE; CREATE SCHEMA o1_rejeu');
      await cnx.unsafe('SET search_path TO o1_rejeu, public');
      for (let passe = 0; passe < 2; passe++) {
        for (const f of FICHIERS_O1) await cnx.unsafe(readFileSync(join(MIG, f), 'utf8'));
      }
      const rejoues = await cnx.unsafe<{ code: string }[]>('SELECT code FROM o1_rejeu.business_operation_types ORDER BY code');
      expect(rejoues.map((t) => t.code)).toEqual(['ACQUISITION', 'CLAIM', 'CONTRACT', 'DISPOSAL', 'FINANCING', 'INTERVENTION', 'OTHER']);
    } finally {
      await cnx.unsafe('SET search_path TO public');
      await cnx.unsafe('DROP SCHEMA IF EXISTS o1_rejeu CASCADE');
      await cnx.unsafe('RESET client_min_messages');
      cnx.release();
    }
    const types = await sql<{ code: string; label: string; active: boolean }[]>`SELECT code, label, active FROM business_operation_types ORDER BY code`;
    expect(types.map((t) => t.code)).toEqual(['ACQUISITION', 'CLAIM', 'CONTRACT', 'DISPOSAL', 'FINANCING', 'INTERVENTION', 'OTHER']);
    expect(types.every((t) => t.active)).toBe(true);
    expect(types.find((t) => t.code === 'CLAIM')?.label).toBe('Sinistre');
    expect(await codeErreur(sql`INSERT INTO business_operation_types (code, label, description) VALUES ('TCO', 'TCO', 'x')`)).toBe('23514');
  });

  it('O1-E02 migration sur schéma vierge = déclarations Drizzle (colonnes, contraintes, index)', async () => {
    const tables = ['business_operation_types', 'business_operations', 'business_operation_sources', 'business_operation_asset_links',
      'business_operation_equipment_links', 'business_operation_financial_components', 'business_operation_financial_component_sources',
      'business_operation_history', 'business_operation_projection_suppressions', 'business_operation_references',
      'document_operation_candidates', 'business_operation_match_decisions', 'business_operation_contract_details',
      'business_operation_financing_details', 'business_operation_claim_details', 'business_operation_claim_damages',
      'business_operation_claim_damage_documents', 'business_operation_claim_damage_photos', 'business_operation_claim_actions',
      'business_operation_claim_exchanges'];
    const cnx = await sql.reserve();
    try {
      await cnx.unsafe('SET client_min_messages = warning');
      await cnx.unsafe('DROP SCHEMA IF EXISTS o1_mig CASCADE; CREATE SCHEMA o1_mig');
      await cnx.unsafe('SET search_path TO o1_mig, public');
      for (const f of FICHIERS_O1) await cnx.unsafe(readFileSync(join(MIG, f), 'utf8'));
      const norm = (s: string | null) => (s ?? '').replace(/\b(o1_mig|public)\./g, '');
      const decrire = async (schema: string, table: string) => {
        const cols = await cnx.unsafe<{ c: string }[]>(`
          SELECT column_name || ' ' || udt_name || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS c
            FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`, [schema, table]);
        const cons = await cnx.unsafe<{ c: string }[]>(`
          SELECT contype::text || ' ' || CASE WHEN contype = 'f' THEN '' ELSE conname END || ' ' || pg_get_constraintdef(oid) AS c
            FROM pg_constraint WHERE conrelid = format('%I.%I', $1::text, $2::text)::regclass ORDER BY 1`, [schema, table]);
        const idx = await cnx.unsafe<{ c: string }[]>(`SELECT indexdef AS c FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`, [schema, table]);
        return {
          cols: cols.map((r) => norm(r.c).replace(/nextval\('[^']*_seq'::regclass\)/, 'nextval(seq)')),
          cons: cons.map((r) => norm(r.c)).sort(),
          idx: idx.map((r) => norm(r.c).replace(/ ON (o1_mig|public)\./, ' ON ')).sort(),
        };
      };
      for (const t of tables) {
        const migre = await decrire('o1_mig', t);
        const drizzle = await decrire('public', t);
        expect(migre.cols.length * migre.cons.length * migre.idx.length).toBeGreaterThan(0);
        expect({ t, ...migre }).toEqual({ t, ...drizzle });
      }
      const agenda = await cnx.unsafe<{ n: number }[]>(`
        SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'agenda_items'
           AND column_name IN ('business_operation_id', 'projection_origin', 'projection_correlation_id')`);
      expect(agenda[0].n).toBe(3);
    } finally {
      await cnx.unsafe('SET search_path TO public');
      await cnx.unsafe('DROP SCHEMA IF EXISTS o1_mig CASCADE');
      await cnx.unsafe('RESET client_min_messages');
      cnx.release();
    }
  });

  it('O1-E03 / C20.1 contraintes SQL : montants ≥ 0, devise, statut, parent ≠ soi, fusion ⇒ invalidée, unicités, FK', async () => {
    const { compte, doc } = await base(make);
    const autre = await make.account();
    const [{ id }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'ENVISAGED') RETURNING id`;
    const src = async () => (await sql<{ id: number }[]>`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority)
      VALUES (${compte.id}, ${id}, 'DOCUMENT', ${String(doc.id)}, 'DOCUMENT') RETURNING id`)[0].id;
    await src();
    expect(await codeErreur(src())).toBe('23505'); // même source active, même locator, même rôle
    const comp = (amount: number, currency = 'EUR', fp: string | null = null) => sql`
      INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, fingerprint)
      VALUES (${compte.id}, ${id}, 'REALIZED_COST', ${amount}, ${currency}, ${fp})`;
    expect(await codeErreur(comp(-1))).toBe('23514');
    expect(await codeErreur(comp(100, 'eur'))).toBe('23514');
    await comp(100, 'EUR', 'fp1');
    expect(await codeErreur(comp(200, 'EUR', 'fp1'))).toBe('23505');
    expect(await codeErreur(sql`UPDATE business_operations SET status = 'CLOSED' WHERE id = ${id}`)).toBe('23514');
    expect(await codeErreur(sql`UPDATE business_operations SET parent_operation_id = ${id} WHERE id = ${id}`)).toBe('23514');
    expect(await codeErreur(sql`UPDATE business_operations SET type_code = 'AUTRE' WHERE id = ${id}`)).toBe('23503');
    const [{ id: id2 }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'REALIZED') RETURNING id`;
    expect(await codeErreur(sql`UPDATE business_operations SET merged_into_operation_id = ${id} WHERE id = ${id2}`)).toBe('23514');
    // F-169 en SQL : parent d'un autre compte impossible (clé composée).
    const [{ id: idAutre }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${autre.id}, 'REALIZED') RETURNING id`;
    expect(await codeErreur(sql`UPDATE business_operations SET parent_operation_id = ${idAutre} WHERE id = ${id}`)).toBe('23503');
    // F-170 en SQL : ligne fille portant un autre compte que son Opération.
    expect(await codeErreur(sql`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority)
      VALUES (${autre.id}, ${id}, 'MIGRATION', 'x', 'STRUCTURED')`)).toBe('23503');
    // F-077 : suppression physique d'un parent refusée.
    await sql`UPDATE business_operations SET parent_operation_id = ${id} WHERE id = ${id2}`;
    expect(await codeErreur(sql`DELETE FROM business_operations WHERE id = ${id}`)).toBe('23503');
    expect(await codeErreur(sql`UPDATE agenda_items SET projection_origin = 'T4' WHERE account_id = ${compte.id}`)).toBe('AUCUNE_ERREUR');
    const evt = await make.agendaItem(compte, { title: 'Contrôle' });
    expect(await codeErreur(sql`UPDATE agenda_items SET projection_origin = 'T4' WHERE id = ${evt.id}`)).toBe('23514');
    await sql`UPDATE agenda_items SET projection_origin = 'OPERATION', business_operation_id = ${id}, projection_correlation_id = 'c1' WHERE id = ${evt.id}`;
  });

  // ── Création, type, statut ───────────────────────────────────────────────

  it('F-030 / INV-FINAL-008 type nul admis ; OTHER refusé en repli, accepté qualifié ; F-054 requalification même id', async () => {
    const { compte, doc } = await base(make);
    const { id } = await creer(compte, doc.id, { type: null });
    const [op] = await sql<{ type_code: string | null }[]>`SELECT type_code FROM business_operations WHERE id = ${id}`;
    expect(op.type_code).toBeNull();
    const { withBusinessOperationWrite } = await svc();
    expect(await codeErreur(withBusinessOperationWrite(compte.id, (r) => r.setType(id, { code: 'OTHER' } as never, 'E2E')))).toBe('OTHER_AS_FALLBACK');
    expect(await codeErreur(withBusinessOperationWrite(compte.id, (r) => r.setType(id, { code: 'OTHER', qualification: { confidence: 'probable', reason: 'x' } } as never, 'E2E')))).toBe('OTHER_AS_FALLBACK');
    expect(await codeErreur(creer(compte, doc.id, { type: { code: 'OTHER' } }))).toBe('OTHER_AS_FALLBACK');
    expect(await withBusinessOperationWrite(compte.id, (r) => r.setType(id, { code: 'INTERVENTION' }, 'T3_QUALIFIED'))).toBe(true);
    expect(await withBusinessOperationWrite(compte.id, (r) => r.setType(id, { code: 'OTHER', qualification: { confidence: 'certain', reason: 'Bornage de terrain' } }, 'T3_QUALIFIED'))).toBe(true);
    const h = await sql<{ event_type: string }[]>`SELECT event_type FROM business_operation_history WHERE operation_id = ${id} ORDER BY id`;
    expect(h.map((x) => x.event_type)).toEqual(['CREATED', 'TYPE_CHANGED', 'TYPE_CHANGED']);
  });

  it('C8 / B7 transitions : ENVISAGED→REALIZED, REALIZED→CANCELLED refusé, F-070 retour ENVISAGED sur retrait de preuve, F-072 closed_at et invalidation orthogonaux', async () => {
    const { compte, doc } = await base(make);
    const { withBusinessOperationWrite } = await svc();
    const { id } = await creer(compte, doc.id, { status: 'ENVISAGED' });
    expect(await withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'REALIZED', { reasonCode: 'INVOICE' }))).toBe(true);
    expect(await withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'REALIZED', { reasonCode: 'INVOICE' }))).toBe(false);
    expect(await codeErreur(withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'CANCELLED', { reasonCode: 'X' })))).toBe('STATUS_TRANSITION_FORBIDDEN');
    expect(await codeErreur(withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'ENVISAGED', { reasonCode: 'X' })))).toBe('STATUS_TRANSITION_FORBIDDEN');
    expect(await withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'ENVISAGED', { reasonCode: 'PROOF_WITHDRAWN', transition: 'REALIZATION_PROOF_WITHDRAWN' }))).toBe(true);
    expect(await withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'CANCELLED', { reasonCode: 'CANCEL_PROOF' }))).toBe(true);
    expect(await withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'REALIZED', { reasonCode: 'F-071' }))).toBe(true);
    // F-072 : sinistre clos → REALIZED + closed_at ; l'invalidation reste distincte.
    expect(await withBusinessOperationWrite(compte.id, (r) => r.close(id, 'CLAIM_CLOSED'))).toBe(true);
    const [o] = await sql<{ status: string; closed: boolean; inval: boolean; version: number }[]>`
      SELECT status, closed_at IS NOT NULL AS closed, invalidated_at IS NOT NULL AS inval, version FROM business_operations WHERE id = ${id}`;
    expect(o).toMatchObject({ status: 'REALIZED', closed: true, inval: false });
    expect(o.version).toBeGreaterThan(1);
    expect(await withBusinessOperationWrite(compte.id, (r) => r.invalidate(id, 'WRONG'))).toBe(true);
    expect(await codeErreur(withBusinessOperationWrite(compte.id, (r) => r.setStatus(id, 'ENVISAGED', { reasonCode: 'X', transition: 'REALIZATION_PROOF_WITHDRAWN' })))).toBe('OPERATION_INACTIVE');
    expect(await withBusinessOperationWrite(compte.id, (r) => r.reactivate(id, 'NEW_PROOF'))).toBe(true);
    const [o2] = await sql<{ status: string; closed: boolean }[]>`SELECT status, closed_at IS NOT NULL AS closed FROM business_operations WHERE id = ${id}`;
    expect(o2).toEqual({ status: 'REALIZED', closed: true });
  });

  it('NFR-OP-005 / INV-040 : un appel sans changement n’écrit aucun historique', async () => {
    const { compte, bien, doc } = await base(make);
    const { withBusinessOperationWrite } = await svc();
    const { id, sourceId } = await creer(compte, doc.id, { assets: [{ assetId: bien.id, role: 'PRIMARY', authority: 'DOCUMENT' }], realizedDate: '2026-03-02' });
    const avant = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE operation_id = ${id}`;
    await withBusinessOperationWrite(compte.id, async (r) => {
      expect(await r.setStatus(id, 'REALIZED', { reasonCode: 'SWEEP' })).toBe(false);
      expect(await r.setType(id, { code: 'INTERVENTION' }, 'SWEEP')).toBe(false);
      expect(await r.updateAttributes(id, { realizedDate: '2026-03-02' }, 'SWEEP')).toBe(false);
      expect(await r.linkAsset(id, { assetId: bien.id, role: 'PRIMARY', authority: 'DOCUMENT' })).toBe(false);
      expect(await r.addSource(id, { kind: 'DOCUMENT', entityKey: doc.id, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' })).toBe(sourceId);
      expect(await r.addReference(id, { kind: 'INVOICE', value: 'FA-2026/001' })).toBe(true);
      expect(await r.addReference(id, { kind: 'INVOICE', value: 'fa 2026 001' })).toBe(false);
      await r.markReconciled(id);
    });
    const apres = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE operation_id = ${id}`;
    expect(apres[0].n).toBe(avant[0].n + 1); // la seule référence ajoutée
    const [{ ref }] = await sql<{ ref: string }[]>`SELECT normalized_value AS ref FROM business_operation_references WHERE operation_id = ${id}`;
    expect(ref).toBe('FA2026001');
  });

  // ── Parent / enfant (C8.1, C13.1) ────────────────────────────────────────

  it('PARENT-001..009 / INV-017 / INV-018 / INV-020 / INV-022 / INV-024 / INV-046 / INV-047 : un parent, même compte, profondeur ≤ 3, pas de cycle, relations C13.1, aucune propagation', async () => {
    const { compte, biens, doc } = await base(make, { assets: 2 });
    const { withBusinessOperationWrite } = await svc();
    const w = <T,>(fn: Parameters<typeof withBusinessOperationWrite<T>>[1]) => withBusinessOperationWrite(compte.id, fn);
    const claim = (await creer(compte, doc.id, { type: { code: 'CLAIM' }, assets: [{ assetId: biens[0].id, authority: 'USER' }, { assetId: biens[1].id, authority: 'USER' }] })).id;
    const repar = (await creer(compte, doc.id, { type: { code: 'INTERVENTION' }, status: 'REALIZED', realizedDate: '2026-02-01' })).id;
    const sousRepar = (await creer(compte, doc.id, { type: { code: 'INTERVENTION' } })).id;
    const acquisition = (await creer(compte, doc.id, { type: { code: 'ACQUISITION' } })).id;
    const financement = (await creer(compte, doc.id, { type: { code: 'FINANCING' } })).id;
    const contrat = (await creer(compte, doc.id, { type: { code: 'CONTRACT' } })).id;
    const inconnu = (await creer(compte, doc.id, { type: null })).id;

    // PARENT-004 / PARENT-005 : relations admises.
    expect(await w((r) => r.setParent(financement, acquisition, 'E2E'))).toBe(true);
    expect(await w((r) => r.setParent(repar, claim, 'E2E'))).toBe(true);
    expect(await w((r) => r.setParent(sousRepar, repar, 'E2E'))).toBe(true);
    // PARENT-006 : CONTRACT jamais parent d'un CLAIM ni d'une INTERVENTION.
    expect(await codeErreur(w((r) => r.setParent(claim, contrat, 'E2E')))).toBe('PARENT_RELATION_NOT_ALLOWED');
    expect(await codeErreur(w((r) => r.setParent(sousRepar, contrat, 'E2E')))).toBe('PARENT_RELATION_NOT_ALLOWED');
    expect(await codeErreur(w((r) => r.setParent(inconnu, claim, 'E2E')))).toBe('PARENT_TYPE_UNKNOWN');
    // PARENT-002 / F-172 : profondeur 4 refusée.
    const niveau4 = (await creer(compte, doc.id, { type: { code: 'INTERVENTION' } })).id;
    expect(await codeErreur(w((r) => r.setParent(niveau4, sousRepar, 'E2E')))).toBe('PARENT_DEPTH_EXCEEDED');
    expect(await codeErreur(creer(compte, doc.id, { type: { code: 'INTERVENTION' }, parentOperationId: sousRepar }))).toBe('PARENT_DEPTH_EXCEEDED');
    // F-171 : cycle refusé ; parent ≠ soi.
    expect(await codeErreur(w((r) => r.setParent(repar, sousRepar, 'E2E')))).toBe('PARENT_CYCLE');
    expect(await codeErreur(w((r) => r.setParent(repar, repar, 'E2E')))).toBe('PARENT_SELF');
    // PARENT-001 / F-169 : parent d'un autre compte refusé (erreur technique).
    const autre = await base(make);
    const etranger = (await creer(autre.compte, autre.doc.id, { type: { code: 'CLAIM' } })).id;
    expect(await codeErreur(w((r) => r.setParent(niveau4, etranger, 'E2E')))).toBe('CROSS_ACCOUNT');
    // Requalification incompatible avec la relation existante : refusée.
    expect(await codeErreur(w((r) => r.setType(repar, { code: 'CONTRACT' }, 'E2E')))).toBe('PARENT_RELATION_NOT_ALLOWED');
    // PARENT-007 : aucune propagation des biens, dates, montants, statut.
    const [enfant] = await sql<{ n: number; realized: string | null; status: string }[]>`
      SELECT (SELECT count(*)::int FROM business_operation_asset_links WHERE operation_id = ${repar}) AS n,
             realized_date::text AS realized, status FROM business_operations WHERE id = ${repar}`;
    expect(enfant).toEqual({ n: 0, realized: '2026-02-01', status: 'REALIZED' });
    // PARENT-008 / PARENT-009 : le parent change de statut sans toucher l'enfant réalisé.
    const projet = (await creer(compte, doc.id, { type: { code: 'CLAIM' }, status: 'ENVISAGED' })).id;
    const travaux = (await creer(compte, doc.id, { type: { code: 'INTERVENTION' }, status: 'REALIZED' })).id;
    await w((r) => r.setParent(travaux, projet, 'E2E'));
    await w((r) => r.setStatus(projet, 'CANCELLED', { reasonCode: 'CANCEL_PROOF' }));
    const [t] = await sql<{ status: string }[]>`SELECT status FROM business_operations WHERE id = ${travaux}`;
    expect(t.status).toBe('REALIZED');
    // Parent invalidé : rattachement refusé.
    await w((r) => r.invalidate(contrat, 'E2E'));
    const fin2 = (await creer(compte, doc.id, { type: { code: 'FINANCING' } })).id;
    const acq2 = (await creer(compte, doc.id, { type: { code: 'ACQUISITION' } })).id;
    await w((r) => r.invalidate(acq2, 'E2E'));
    expect(await codeErreur(w((r) => r.setParent(fin2, acq2, 'E2E')))).toBe('PARENT_INACTIVE');
  });

  // ── Inter-comptes (F-169, F-170, C25) ────────────────────────────────────

  it('F-170 / C25 : bien, équipement, source, contrat d’assurance d’un autre compte refusés ; cible de composante non rattachée refusée', async () => {
    const a = await base(make);
    const b = await base(make);
    const { withBusinessOperationWrite } = await svc();
    const [equipB] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${b.bien.id}, 'Chaudière') RETURNING id`;
    const [equipA] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${a.bien.id}, 'Chaudière') RETURNING id`;
    expect(await codeErreur(creer(a.compte, b.doc.id))).toBe('CROSS_ACCOUNT');
    expect(await codeErreur(creer(a.compte, a.doc.id, { assets: [{ assetId: b.bien.id, authority: 'DOCUMENT' }] }))).toBe('CROSS_ACCOUNT');
    const { id } = await creer(a.compte, a.doc.id, { type: { code: 'CLAIM' } });
    expect(await codeErreur(withBusinessOperationWrite(a.compte.id, (r) => r.linkEquipment(id, { equipmentId: equipB.id, authority: 'USER' })))).toBe('CROSS_ACCOUNT');
    expect(await codeErreur(withBusinessOperationWrite(a.compte.id, (r) => r.addSource(id, { kind: 'ASSET_DATA', entityKey: b.bien.id, authority: 'STRUCTURED' })))).toBe('CROSS_ACCOUNT');
    expect(await codeErreur(withBusinessOperationWrite(b.compte.id, (r) => r.setStatus(id, 'ENVISAGED', { reasonCode: 'X', transition: 'REALIZATION_PROOF_WITHDRAWN' })))).toBe('CROSS_ACCOUNT');
    const contratB = (await creer(b.compte, b.doc.id, { type: { code: 'CONTRACT' } })).id;
    expect(await codeErreur(withBusinessOperationWrite(a.compte.id, (r) => r.upsertClaimDetails(id, { insuranceContractOperationId: contratB })))).toBe('CROSS_ACCOUNT');
    expect(await codeErreur(withBusinessOperationWrite(a.compte.id, (r) => r.upsertContractDetails(id, {})))).toBe('DETAILS_TYPE_MISMATCH');
    const srcId = (await sql<{ id: number }[]>`SELECT id FROM business_operation_sources WHERE operation_id = ${id}`)[0].id;
    expect(await codeErreur(withBusinessOperationWrite(a.compte.id, (r) => r.addFinancialComponent(id, {
      kind: 'REALIZED_COST', amountMinor: 1000, currency: 'EUR', targetAssetId: a.bien.id, sources: [{ sourceId: srcId }],
    })))).toBe('TARGET_NOT_LINKED');
    await withBusinessOperationWrite(a.compte.id, async (r) => {
      await r.linkAsset(id, { assetId: a.bien.id, authority: 'USER' });
      await r.linkEquipment(id, { equipmentId: equipA.id, authority: 'USER' });
      await r.addFinancialComponent(id, { kind: 'INDEMNITY', amountMinor: 80000, currency: 'EUR', targetAssetId: a.bien.id, sources: [{ sourceId: srcId }] });
      await r.upsertClaimDetails(id, { status: 'A_DECLARER', insurerClaimRef: 'SIN-1', estimatedDamageMinor: 120000 });
    });
    expect(await codeErreur(withBusinessOperationWrite(a.compte.id, (r) => r.addFinancialComponent(id, {
      kind: 'REALIZED_COST', amountMinor: -5, currency: 'EUR', sources: [{ sourceId: srcId }],
    })))).toBe('INVALID_AMOUNT');
    // Aucune trace des tentatives refusées (transaction annulée).
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${a.compte.id}`;
    expect(n).toBe(1);
  });

  // ── Concurrence (C24) ────────────────────────────────────────────────────

  it('F-166 / NFR-OP-001 : deux écritures concurrentes du même compte sont sérialisées — une seule Opération pour la même source', async () => {
    const { compte, doc } = await base(make);
    const { withBusinessOperationWrite } = await svc();
    const { sql: dsql } = await import('drizzle-orm');
    const traces: string[] = [];
    const trouverOuCreer = (nom: string) => withBusinessOperationWrite(compte.id, async (repo, session) => {
      traces.push(`${nom}:début`);
      const existantes = await repo.findActiveBySource('DOCUMENT', doc.id);
      if (existantes.length) { traces.push(`${nom}:trouvée`); return existantes[0]; }
      await session.tx.execute(dsql`SELECT pg_sleep(0.3)`);
      const { id } = await repo.create({
        type: { code: 'INTERVENTION' }, status: 'REALIZED', reasonCode: 'E2E',
        source: { kind: 'DOCUMENT', entityKey: doc.id, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
      });
      traces.push(`${nom}:créée`);
      return id;
    });
    const [a, b] = await Promise.all([trouverOuCreer('A'), trouverOuCreer('B')]);
    expect(a).toBe(b);
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(DISTINCT operation_id)::int AS n FROM business_operation_sources
       WHERE account_id = ${compte.id} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(doc.id)} AND active`;
    expect(n).toBe(1);
    // La seconde n'a commencé qu'après la fin de la première (verrou détenu).
    expect(traces.filter((t) => t.endsWith('créée')).length).toBe(1);
    expect(traces[1]).toMatch(/créée$/);
    // Un autre compte n'attend pas : son écriture se termine pendant que le verrou du premier est tenu.
    const autre = await base(make);
    const fin: string[] = [];
    await Promise.all([
      withBusinessOperationWrite(compte.id, async (_r, s) => { await s.tx.execute(dsql`SELECT pg_sleep(1)`); }).then(() => fin.push('compte')),
      (async () => { await new Promise((r) => setTimeout(r, 100)); await creer(autre.compte, autre.doc.id); fin.push('autre'); })(),
    ]);
    expect(fin).toEqual(['autre', 'compte']);
  });

  // ── Événements (C21.1) ───────────────────────────────────────────────────

  it('C21.1 : événements émis APRÈS commit seulement ; annulation = aucun événement ; dédoublonnés', async () => {
    const { compte, bien, doc } = await base(make);
    const { subscribeBusinessOperationEvents } = await bus();
    const { withBusinessOperationWrite } = await svc();
    const recus: Array<{ type: string; visible: boolean; op: number }> = [];
    subscribeBusinessOperationEvents('e2e', async (e) => {
      const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE id = ${e.operationId}`;
      recus.push({ type: e.type, visible: r.n === 1, op: e.operationId });
    });
    // Annulée : rien en base, aucun événement.
    expect(await codeErreur(withBusinessOperationWrite(compte.id, async (r) => {
      await r.create({ type: { code: 'INTERVENTION' }, status: 'REALIZED', reasonCode: 'E2E', source: { kind: 'DOCUMENT', entityKey: doc.id, authority: 'DOCUMENT' } });
      throw new Error('ÉCHEC_APRÈS_ÉCRITURE');
    }))).toBe('ÉCHEC_APRÈS_ÉCRITURE');
    expect(recus).toEqual([]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id}`;
    expect(n).toBe(0);
    // Validée : CREATED seul (les signaux fins de la même Opération sont englobés), visible par une autre connexion.
    const { id } = await creer(compte, doc.id, { assets: [{ assetId: bien.id, authority: 'DOCUMENT' }] });
    expect(recus).toEqual([{ type: 'BUSINESS_OPERATION_CREATED', visible: true, op: id }]);
    recus.length = 0;
    const srcId = (await sql<{ id: number }[]>`SELECT id FROM business_operation_sources WHERE operation_id = ${id}`)[0].id;
    await withBusinessOperationWrite(compte.id, async (r) => {
      await r.addFinancialComponent(id, { kind: 'REALIZED_COST', amountMinor: 135000, currency: 'EUR', sources: [{ sourceId: srcId }], fingerprint: 'facture-1' });
      await r.addFinancialComponent(id, { kind: 'REALIZED_COST', amountMinor: 120000, currency: 'EUR', sources: [{ sourceId: srcId }], fingerprint: 'facture-1' });
      await r.invalidate(id, 'E2E');
    });
    expect(recus.map((e) => e.type).sort()).toEqual(['BUSINESS_OPERATION_FINANCIAL_CHANGED', 'BUSINESS_OPERATION_INVALIDATED']);
    // F-062 : même empreinte, montant corrigé → supersédée, pas additionnée.
    const comps = await sql<{ amount: string; active: boolean }[]>`
      SELECT amount_minor::text AS amount, active FROM business_operation_financial_components WHERE operation_id = ${id} ORDER BY id`;
    expect(comps).toEqual([{ amount: '135000', active: false }, { amount: '120000', active: true }]);
  });

  // ── Lecture (C20.1, F-185) ───────────────────────────────────────────────

  it('F-185 / INV-043 : lecture par ancien id redirigée vers la canonique ; absorbée et invalidée jamais actives ; autre compte invisible', async () => {
    const { compte, bien, doc } = await base(make);
    const autre = await base(make);
    const { BusinessOperationReadService } = await import('@/services/business-operations/read-service');
    const lecture = new BusinessOperationReadService();
    const canon = (await creer(compte, doc.id, { assets: [{ assetId: bien.id, authority: 'DOCUMENT' }] })).id;
    const absorbee = (await creer(compte, doc.id, { assets: [{ assetId: bien.id, authority: 'DOCUMENT' }], source: { kind: 'DOCUMENT', entityKey: doc.id, role: 'QUOTE', authority: 'DOCUMENT' } })).id;
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'MERGED', merged_into_operation_id = ${canon} WHERE id = ${absorbee}`;
    const r = await lecture.getOperation(compte.id, absorbee);
    expect(r).toMatchObject({ redirectedFrom: absorbee, operation: { id: canon, active: true } });
    expect(await lecture.resolveCanonicalId(compte.id, absorbee)).toBe(canon);
    expect((await lecture.getOperation(compte.id, absorbee, { followMerge: false }))?.operation.mergedIntoOperationId).toBe(canon);
    expect(await lecture.getOperation(autre.compte.id, canon)).toBeNull();
    const actives = await lecture.listActiveOperations(compte.id, { assetId: bien.id });
    expect(actives.map((o) => o.id)).toEqual([canon]);
    const detail = await lecture.getOperationDetail(compte.id, absorbee);
    expect(detail).toMatchObject({ id: canon, redirectedFrom: absorbee });
    expect(detail!.sources.length).toBe(1);
    // Écrire sur l'absorbée est refusé.
    const { withBusinessOperationWrite } = await svc();
    expect(await codeErreur(withBusinessOperationWrite(compte.id, (w) => w.setStatus(absorbee, 'CANCELLED', { reasonCode: 'X' })))).toBe('OPERATION_MERGED');
  });

  // ── Transfert de bien entre comptes (Q14) ────────────────────────────────

  it('Q14 Duo : l’Opération mono-bien suit le bien avec ses lignes ; la multi-biens reste et perd son lien (historisé)', async () => {
    const titulaire = await make.user();
    const membre = await make.user();
    const duoCompte = await make.account({ owner: titulaire, plan: 'premium_duo' });
    const cible = await make.account({ owner: membre });
    const [duo] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id) VALUES (${titulaire.id}) RETURNING id`;
    const voiture = await make.asset(duoCompte, { category: 'VEHICULE', name: 'Voiture' });
    const maison = await make.asset(duoCompte, { category: 'IMMOBILIER', name: 'Maison' });
    const facture = await make.assetFile(duoCompte, { assetId: voiture.id });
    const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${voiture.id}, 'Autoradio') RETURNING id`;
    const { withBusinessOperationWrite } = await svc();

    const mono = (await creer(duoCompte, facture.id, { assets: [{ assetId: voiture.id, role: 'PRIMARY', authority: 'DOCUMENT' }], equipments: [{ equipmentId: equip.id, authority: 'DOCUMENT' }] })).id;
    const sinistre = (await creer(duoCompte, facture.id, { type: { code: 'CLAIM' }, assets: [{ assetId: voiture.id, authority: 'USER' }, { assetId: maison.id, authority: 'USER' }] })).id;
    const contratMaison = (await creer(duoCompte, facture.id, { type: { code: 'CONTRACT' }, assets: [{ assetId: maison.id, authority: 'DOCUMENT' }] })).id;
    const sinistreVoiture = (await creer(duoCompte, facture.id, { type: { code: 'CLAIM' }, assets: [{ assetId: voiture.id, authority: 'USER' }] })).id;
    await withBusinessOperationWrite(duoCompte.id, async (r) => {
      const [{ id: src }] = await sql<{ id: number }[]>`SELECT id FROM business_operation_sources WHERE operation_id = ${mono}`;
      await r.addFinancialComponent(mono, { kind: 'REALIZED_COST', amountMinor: 45000, currency: 'EUR', targetAssetId: voiture.id, sources: [{ sourceId: src }] });
      await r.addReference(mono, { kind: 'INVOICE', value: 'F-77' });
      const [{ id: srcS }] = await sql<{ id: number }[]>`SELECT id FROM business_operation_sources WHERE operation_id = ${sinistre}`;
      await r.addFinancialComponent(sinistre, { kind: 'INDEMNITY', amountMinor: 30000, currency: 'EUR', targetAssetId: voiture.id, sources: [{ sourceId: srcS }] });
      await r.upsertClaimDetails(sinistreVoiture, { insuranceContractOperationId: contratMaison, policyReferenceText: 'POL-1', status: 'DECLARE' });
      await r.setParent(mono, sinistre, 'E2E');
    });
    const [req] = await sql<{ id: number }[]>`
      INSERT INTO asset_move_requests (asset_id, duo_id, target_account_id, initiator_user_id, validator_user_id, asset_label_snapshot, target_user_snapshot, initiator_user_snapshot)
      VALUES (${voiture.id}, ${duo.id}, ${cible.id}, ${membre.id}, ${titulaire.id}, 'Voiture', 'Membre', 'Membre') RETURNING id`;

    const { subscribeBusinessOperationEvents } = await bus();
    const recus: Array<{ type: string; accountId: number; op: number; prev?: number }> = [];
    subscribeBusinessOperationEvents('e2e', (e) => { recus.push({ type: e.type, accountId: e.accountId, op: e.operationId, prev: e.previousAccountId }); });
    const { DuoService } = await import('@/services/duo.service');
    await DuoService.respondToMoveRequest({ requestId: req.id, action: 'ACCEPT', resolvedByUserId: titulaire.id, resolvedByType: 'USER' });

    const compteDe = async (id: number) => (await sql<{ a: number }[]>`SELECT account_id AS a FROM business_operations WHERE id = ${id}`)[0].a;
    expect(await compteDe(mono)).toBe(cible.id);
    expect(await compteDe(sinistreVoiture)).toBe(cible.id);
    expect(await compteDe(sinistre)).toBe(duoCompte.id);
    expect(await compteDe(contratMaison)).toBe(duoCompte.id);
    // Toutes les lignes filles ont suivi (clé composée en cascade).
    for (const table of ['business_operation_sources', 'business_operation_asset_links', 'business_operation_equipment_links',
      'business_operation_financial_components', 'business_operation_references', 'business_operation_history']) {
      const r = await sql.unsafe<{ a: number }[]>(`SELECT DISTINCT account_id AS a FROM ${table} WHERE operation_id = $1`, [mono]);
      expect({ table, comptes: r.map((x) => x.a) }).toEqual({ table, comptes: [cible.id] });
    }
    // Relations qui franchiraient les comptes : détachées.
    const [m] = await sql<{ parent: number | null }[]>`SELECT parent_operation_id AS parent FROM business_operations WHERE id = ${mono}`;
    expect(m.parent).toBeNull();
    const [d] = await sql<{ c: number | null; t: string }[]>`SELECT insurance_contract_operation_id AS c, policy_reference_text AS t FROM business_operation_claim_details WHERE operation_id = ${sinistreVoiture}`;
    expect(d).toEqual({ c: null, t: 'POL-1' });
    // Multi-biens : lien retiré, attribution de l'indemnité redevenue globale, historisé.
    const liens = await sql<{ asset_id: number; active: boolean }[]>`SELECT asset_id, active FROM business_operation_asset_links WHERE operation_id = ${sinistre} ORDER BY asset_id`;
    expect(liens).toEqual([{ asset_id: voiture.id, active: false }, { asset_id: maison.id, active: true }].sort((x, y) => x.asset_id - y.asset_id));
    const [c] = await sql<{ t: number | null }[]>`SELECT target_asset_id AS t FROM business_operation_financial_components WHERE operation_id = ${sinistre}`;
    expect(c.t).toBeNull();
    const h = await sql<{ e: string; r: string }[]>`SELECT event_type AS e, reason_code AS r FROM business_operation_history WHERE operation_id = ${sinistre} ORDER BY id`;
    expect(h.map((x) => x.e)).toEqual(expect.arrayContaining(['TARGET_CHANGED', 'FINANCIAL_CHANGED']));
    const hm = await sql<{ e: string; b: { account_id: number } | null }[]>`SELECT event_type AS e, before_json AS b FROM business_operation_history WHERE operation_id = ${mono} AND reason_code = 'ASSET_TRANSFERRED_DUO'`;
    expect(hm).toEqual([{ e: 'UPDATED', b: { account_id: duoCompte.id } }]);
    // Événements publiés après commit, aux bons comptes.
    expect(recus).toEqual(expect.arrayContaining([
      { type: 'BUSINESS_OPERATION_UPDATED', accountId: cible.id, op: mono, prev: duoCompte.id },
      expect.objectContaining({ type: 'BUSINESS_OPERATION_TARGET_CHANGED', accountId: duoCompte.id, op: sinistre }),
    ]));
    const [asset] = await sql<{ a: number }[]>`SELECT account_id AS a FROM assets WHERE id = ${voiture.id}`;
    expect(asset.a).toBe(cible.id);
  });

  it('Q14 : les absorbées suivent leur canonique ; transfert annulé = rien de déplacé ; aucun bien = aucun effet', async () => {
    const { compte, bien, doc } = await base(make);
    const cible = await make.account();
    const canon = (await creer(compte, doc.id, { assets: [{ assetId: bien.id, authority: 'DOCUMENT' }] })).id;
    const absorbee = (await creer(compte, doc.id, { source: { kind: 'MIGRATION', entityKey: `mig:${bien.id}`, authority: 'STRUCTURED' } })).id;
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'MERGED', merged_into_operation_id = ${canon} WHERE id = ${absorbee}`;
    const { transferAssetOperationsInTx } = await lifecycle();
    const { db } = await import('@/db');
    // Annulé : aucune ligne déplacée.
    expect(await codeErreur(db.transaction(async (tx) => {
      await transferAssetOperationsInTx(tx, { assetId: bien.id, fromAccountId: compte.id, toAccountId: cible.id });
      throw new Error('ROLLBACK');
    }))).toBe('ROLLBACK');
    expect((await sql<{ a: number }[]>`SELECT account_id AS a FROM business_operations WHERE id = ${canon}`)[0].a).toBe(compte.id);
    const r = await db.transaction((tx) => transferAssetOperationsInTx(tx, { assetId: bien.id, fromAccountId: compte.id, toAccountId: cible.id }));
    expect(r.moved).toEqual([canon, absorbee]);
    const comptes = await sql<{ a: number }[]>`SELECT DISTINCT account_id AS a FROM business_operations WHERE id IN (${canon}, ${absorbee})`;
    expect(comptes.map((x) => x.a)).toEqual([cible.id]);
    const vide = await db.transaction((tx) => transferAssetOperationsInTx(tx, { assetId: bien.id, fromAccountId: compte.id, toAccountId: compte.id }));
    expect(vide).toEqual({ moved: [], detached: [], events: [] });
  });

  // ── Suppression d'un bien / d'un compte ──────────────────────────────────

  it('F-187 / F-064 / B27 suppression d’un bien : liens retirés et historisés, mono-bien sans source invalidée, multi-biens et Opération encore prouvée survivent', async () => {
    const { compte, biens, doc } = await base(make, { assets: 2 });
    const [garage, maison] = biens;
    const docMaison = await make.assetFile(compte, { assetId: maison.id });
    const { withBusinessOperationWrite } = await svc();
    const monoDoc = (await creer(compte, doc.id, { assets: [{ assetId: garage.id, authority: 'DOCUMENT' }] })).id;
    const multi = (await creer(compte, docMaison.id, { type: { code: 'CLAIM' }, assets: [{ assetId: garage.id, authority: 'USER' }, { assetId: maison.id, authority: 'USER' }] })).id;
    const monoProuvee = (await creer(compte, doc.id, { assets: [{ assetId: garage.id, authority: 'DOCUMENT' }] })).id;
    // Une autre preuve, indépendante du bien (clé MIGRATION sans bien dans le locator).
    await withBusinessOperationWrite(compte.id, (r) => r.addSource(monoProuvee, { kind: 'MIGRATION', entityKey: `mig-compte-${compte.id}`, authority: 'STRUCTURED' }));
    const { deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    await deleteAssetCompletely({ id: garage.id });

    const etat = async (id: number) => (await sql<{ inval: string | null; reason: string | null }[]>`
      SELECT invalidated_at::text AS inval, invalidation_reason AS reason FROM business_operations WHERE id = ${id}`)[0];
    expect((await etat(monoDoc)).reason).toBe('ASSET_DELETED_NO_SOURCE');
    expect((await etat(multi)).inval).toBeNull();
    expect((await etat(monoProuvee)).inval).toBeNull();
    const liens = await sql<{ asset_id: number; active: boolean }[]>`SELECT asset_id, active FROM business_operation_asset_links WHERE operation_id = ${multi}`;
    expect(liens).toEqual([{ asset_id: maison.id, active: true }]);
    const h = await sql<{ e: string }[]>`SELECT event_type AS e FROM business_operation_history WHERE operation_id = ${monoDoc} ORDER BY id`;
    expect(h.map((x) => x.e)).toEqual(['CREATED', 'TARGET_CHANGED', 'SOURCE_REMOVED', 'INVALIDATED']);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_sources WHERE operation_id = ${monoDoc} AND active`;
    expect(n).toBe(0);
  });

  it('F-186 / INV-060 suppression du compte : Opérations et lignes filles supprimées par la cascade, sans orphelin', async () => {
    const { compte, bien, doc } = await base(make);
    const { withBusinessOperationWrite } = await svc();
    const parent = (await creer(compte, doc.id, { type: { code: 'CLAIM' }, assets: [{ assetId: bien.id, authority: 'USER' }] })).id;
    const enfant = (await creer(compte, doc.id, { type: { code: 'INTERVENTION' }, parentOperationId: parent })).id;
    await withBusinessOperationWrite(compte.id, (r) => r.upsertClaimDetails(parent, { status: 'CLOS' }));
    await sql`INSERT INTO business_operation_claim_damages (operation_id, zone) VALUES (${parent}, 'Cuisine')`;
    const evt = await make.agendaItem(compte, { title: 'Sinistre' });
    await sql`UPDATE agenda_items SET business_operation_id = ${parent} WHERE id = ${evt.id}`;
    await sql`INSERT INTO business_operation_projection_suppressions (account_id, operation_id, projection_kind, projection_key, user_id)
              VALUES (${compte.id}, ${enfant}, 'AGENDA', 'k', ${compte.ownerUserId})`;
    const { scheduleDeletion, executeScheduledDeletion } = await import('@/services/account/scheduled-deletion.service');
    const s = await scheduleDeletion({ accountId: compte.id, userId: compte.ownerUserId, reason: 'ADMIN', delayDays: 0 });
    const r = await executeScheduledDeletion(s.id);
    expect(r.status).toBe('executed');
    for (const t of ['business_operations', 'business_operation_sources', 'business_operation_asset_links', 'business_operation_history', 'business_operation_projection_suppressions']) {
      const [{ n }] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t} WHERE account_id = $1`, [compte.id]);
      expect({ t, n }).toEqual({ t, n: 0 });
    }
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_claim_damages WHERE operation_id = ${parent}`;
    expect(n).toBe(0);
  });

  // ── RGPD, BO ─────────────────────────────────────────────────────────────

  it('B27 export RGPD : Opérations, sources, liens, composantes, Sinistre structuré exportés ; aucune table exclue', async () => {
    const { compte, bien, doc } = await base(make);
    const { withBusinessOperationWrite } = await svc();
    const id = (await creer(compte, doc.id, { type: { code: 'CLAIM' }, assets: [{ assetId: bien.id, authority: 'USER' }] })).id;
    await withBusinessOperationWrite(compte.id, async (r) => {
      const [{ id: src }] = await sql<{ id: number }[]>`SELECT id FROM business_operation_sources WHERE operation_id = ${id}`;
      await r.addFinancialComponent(id, { kind: 'INDEMNITY', amountMinor: 80000, currency: 'EUR', sources: [{ sourceId: src }] });
      await r.upsertClaimDetails(id, { status: 'INDEMNISE', circumstances: 'Fuite' });
    });
    const [{ id: dmg }] = await sql<{ id: number }[]>`INSERT INTO business_operation_claim_damages (operation_id, zone) VALUES (${id}, 'Salle de bain') RETURNING id`;
    await sql`INSERT INTO business_operation_claim_damage_documents (damage_id, file_id) VALUES (${dmg}, ${doc.id})`;
    const { collectUserData } = await import('@/services/gdpr/export-collector');
    const { buildGdprExportContent, EXCLUDED_TABLES } = await import('@/services/gdpr/export-content');
    const data = await collectUserData(compte.ownerUserId);
    const contenu = buildGdprExportContent({ generatedAt: new Date(), userId: compte.ownerUserId, accountIds: data.accountIds, tables: data.tables, documents: { include: [], skipped: [], includedBytes: 0 } });
    const attendues = ['business_operations', 'business_operation_sources', 'business_operation_asset_links', 'business_operation_financial_components',
      'business_operation_financial_component_sources', 'business_operation_history', 'business_operation_claim_details',
      'business_operation_claim_damages', 'business_operation_claim_damage_documents'];
    for (const t of attendues) {
      expect({ t, present: `donnees/${t}.json` in contenu.textFiles }).toEqual({ t, present: true });
      expect(EXCLUDED_TABLES.has(t)).toBe(false);
    }
    const ops = JSON.parse(contenu.textFiles['donnees/business_operations.json']) as Array<{ id: number }>;
    expect(ops.map((o) => Number(o.id))).toEqual([id]);
  });

  it('F-183 / C27 BO Référentiels : onglet Types d’Opération — 7 types, tri alphabétique, utilisations comptées', async () => {
    const { compte, doc } = await base(make);
    await creer(compte, doc.id, { type: { code: 'CONTRACT' } });
    const { loadReferentials } = await import('@/app/api/admin/referentials/referentials-data');
    const snap = await loadReferentials();
    expect(snap.operationTypes.map((r) => r.code).sort()).toEqual(['ACQUISITION', 'CLAIM', 'CONTRACT', 'DISPOSAL', 'FINANCING', 'INTERVENTION', 'OTHER']);
    const labels = snap.operationTypes.map((r) => r.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'fr')));
    expect(snap.operationTypes.find((r) => r.code === 'CONTRACT')?.usage ?? 0).toBeGreaterThanOrEqual(1);
    expect(snap.operationTypes.every((r) => r.active === true && /Toutes les familles/.test(r.details ?? ''))).toBe(true);
  });
});
