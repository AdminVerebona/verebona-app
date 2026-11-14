/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 », LOT B « identité et
 * graphe canonique ») — sur PostgreSQL 16 réel, par les chemins de PRODUCTION :
 * migrations 1715 à 1717 rejouées, façade métier `operation-write.facade.ts`,
 * service unique de regroupement, fusion existante du dépôt, lecteur
 * `graph/read.ts`, vraie route de l'Agenda (seule la session est simulée).
 * Aucune IA.
 *
 *   L114O-E01  migrations rejouables ; reprise 1716 exacte, sans toucher un élément d'Agenda, un rôle, une date, un rappel
 *   L114O-E02  SC-05 à SC-07, AC15, AC49 à AC51 : financement ↔ acquisitions (N↔N), lecture dans les deux sens, aucun doublon,
 *              aucune relation réflexive, aucun coût, aucune date, aucun événement, aucun rappel créé
 *   L114O-E03  AC13, AC14, AC18 : refus durable de l'utilisateur ; même preuve → jamais recréée ; preuve nouvelle → arbitrage
 *              requis sans écriture ; version périmée → conflit ; clé d'idempotence rejouée
 *   L114O-E04  SC-12, SC-13, AC23 à AC25 : élément d'Agenda partagé par deux événements de référence = UN objet Agenda,
 *              à SA date, aucun rappel doublé, aucun « principal » posé ; refus de rattachement respecté par T4
 *   L114O-E05  compatibilité : la colonne historique et le graphe restent identiques quel que soit le chemin d'écriture
 *   L114O-E06  AC11 (liens), AC67 : fusion — relations et liens reportés sur la canonique, sans doublon, refus conservé,
 *              ancien identifiant redirigé
 *   L114O-E07  AC15, AC59 : isolation des comptes (façade, base, lecture, transfert d'un bien), droits (lecture seule, non-membre)
 *   L114O-E08  AC71 : deux commandes simultanées → une seule relation ; panne SQL en cours de commande → rien d'écrit
 *   L114O-E09  AC44 (lien), AC45 (fichier) : document rattaché, retiré, déplacé — fichier et liens d'Agenda conservés
 *   L114O-E10  AC01, AC03, AC06 : événement de référence créé sur DÉCLARATION (sans document, élément d'Agenda, bien ni date),
 *              source durable, même déclaration rejouée sans doublon, type nul conservé, jamais OTHER par défaut, aucune date inventée
 *   L114O-E11  correction par l'utilisateur protégée de T3 ; version périmée ; invalidation logique (rien supprimé, T3 ne
 *              réactive pas) ; restauration ; reconstruction du compte : l'événement déclaré est conservé
 *   L114O-E12  fournisseur relié / retiré (refus mémorisé), isolation des comptes ; commandes réservées à l'utilisateur
 *   L114O-E13  SC-16, AC59, AC60 : transfert RÉEL d'un bien (`transferAssetDataInTx`) — aucune relation ni lien entre comptes,
 *              la déclaration suit son événement de référence
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const facade = () => import('@/services/business-operations/operation-write.facade');
const lecture = () => import('@/services/business-operations/graph/read');
const magasin = () => import('@/services/business-operations/graph/store');
const grouping = () => import('@/services/business-operations/grouping/service');
const MIGRATIONS = ['1715_l114o_relations_evenements_reference.sql', '1716_l114o_liens_evenement_reference_agenda.sql', '1717_l114o_journal_graphe_evenements_reference.sql', '1718_l114o_declarations_evenements_reference.sql'];

scenario('L114O', 'Opérations / Agenda CDC V2.0 — lot B : graphe canonique (relations entre événements de référence, liens N↔N d’Agenda, façade d’écriture)', ({ sql, make }) => {
  const user = (c: AccountRow, over: Partial<OperationWriteContext> = {}): OperationWriteContext =>
    ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' }, ...over });
  const t3 = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'AI', treatment: 'T3' } });
  const t4 = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'AI', treatment: 'T4' } });
  const doc = (ref: number | string) => ({ kind: 'DOCUMENT' as const, ref: String(ref) });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };

  /** Événement de référence créé par le dépôt (avec sa source : jamais d'Opération sans fondement). */
  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; label?: string } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: 'REALIZED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114o-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }, reasonCode: 'L114O_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, title: string, date: string | null, assetIds: number[] = []): Promise<number> =>
    (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds })).id;
  const relations = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int, from_operation_id::int AS f, to_operation_id::int AS t, nature, state, origin, version, account_id FROM business_operation_relations
     WHERE account_id = ${compte.id} ORDER BY id`;
  const liens = (compte: AccountRow) => sql<Json[]>`
    SELECT operation_id::int AS op, agenda_item_id AS item, state, origin, legacy_column AS legacy FROM business_operation_agenda_links
     WHERE account_id = ${compte.id} ORDER BY operation_id, agenda_item_id`;
  const journal = (compte: AccountRow) => sql<Json[]>`
    SELECT relation_kind AS kind, action, origin, channel, actor_user_id, command, idempotency_key FROM business_operation_graph_history
     WHERE account_id = ${compte.id} ORDER BY id`;
  /** Empreinte de tout ce qu'une relation du graphe ne doit JAMAIS toucher (coûts, sources, Opérations, Agenda, rappels). */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_financial_components t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_sources t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_history t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM to_process_actions t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }
  const audit = async (compte: AccountRow) => {
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    return (await magasin()).auditOperationGraph(postgresRunner(sql as never), compte.id);
  };
  async function agenda(qs: string): Promise<Json[]> {
    const route = await import('@/app/api/agenda/route');
    const r = await route.GET(new NextRequest(`http://x/api/agenda${qs}`));
    expect(r.status).toBe(200);
    return (await r.json()).items as Json[];
  }

  it('L114O-E01 — migrations 1715 à 1718 rejouables ; reprise 1716 exacte et sans effet sur les éléments d’Agenda', async () => {
    const compte = await make.account({ plan: 'premium' });
    const op = await operation(compte, 'INTERVENTION', { realized: '2024-03-01' });
    const ref = await element(compte, 'Remplacement chaudière', '2024-03-01');
    const etape = await element(compte, 'Visite de contrôle', '2024-09-15');
    const seul = await element(compte, 'Ramonage', '2024-11-02');
    const g = await grouping();
    await g.withGroupingWrite(compte.id, async (ctx) => {
      await g.designatePrincipal(ctx, { operationId: op, itemId: ref, origin: 'T4', reasonCode: 'L114O_E2E' });
      await g.attachAgendaItem(ctx, { operationId: op, itemId: etape, role: 'RELATED', origin: 'T4', reasonCode: 'L114O_E2E' });
    });
    // État d'AVANT la migration : aucun lien du graphe (la table n'existait pas).
    await sql`DELETE FROM business_operation_agenda_links WHERE account_id = ${compte.id}`;
    const avant = await sql<Json[]>`SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS h FROM agenda_items t WHERE account_id = ${compte.id}`;
    const rappels = await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox`;
    for (let passage = 0; passage < 2; passage++) {
      for (const f of MIGRATIONS) {
        const texte = readFileSync(join(process.cwd(), 'src/db/migrations', f), 'utf8');
        await sql.begin((tx) => tx.unsafe(texte));
      }
      expect(await liens(compte)).toEqual([
        { op, item: ref, state: 'ACTIVE', origin: 'MIGRATION', legacy: true },
        { op, item: etape, state: 'ACTIVE', origin: 'MIGRATION', legacy: true },
      ]);
    }
    // Aucun élément créé, modifié, daté ou supprimé ; rôles historiques intacts (lus par les écrans existants) ; aucun rappel.
    expect(await sql<Json[]>`SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS h FROM agenda_items t WHERE account_id = ${compte.id}`).toEqual(avant);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox`).toEqual(rappels);
    expect(await sql<Json[]>`SELECT id, operation_role AS role FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`)
      .toEqual([{ id: ref, role: 'PRINCIPAL' }, { id: etape, role: 'RELATED' }, { id: seul, role: null }]);
    expect(await relations(compte)).toEqual([]);
    expect(await audit(compte)).toEqual([]);

    // 1718 sur une base d'AVANT (contrainte de 0316, sans USER_DECLARATION) : la contrainte est élargie, aucune source existante
    // n'est modifiée ni rejetée ; rejouée, elle ne change plus rien.
    const sources = () => sql<Json[]>`SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS h FROM business_operation_sources t`;
    const contrainte = async () => (await sql<Json[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'business_operation_sources'::regclass AND conname = 'business_operation_sources_kind_chk'`)[0].def as string;
    const avantSources = await sources();
    await sql.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE business_operation_sources DROP CONSTRAINT business_operation_sources_kind_chk`);
      await tx.unsafe(`ALTER TABLE business_operation_sources ADD CONSTRAINT business_operation_sources_kind_chk
        CHECK (source_kind IN ('DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION'))`);
    });
    expect(await contrainte()).not.toContain('USER_DECLARATION');
    const m1718 = readFileSync(join(process.cwd(), 'src/db/migrations', MIGRATIONS[3]), 'utf8');
    for (let passage = 0; passage < 2; passage++) {
      await sql.begin((tx) => tx.unsafe(m1718));
      expect(await contrainte()).toContain('USER_DECLARATION');
      for (const ancien of ['DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION']) expect(await contrainte()).toContain(`'${ancien}'`);
    }
    expect(await sources()).toEqual(avantSources);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_declarations`).toEqual([{ n: 0 }]);
  });

  it('L114O-E02 — financement ↔ acquisitions : N↔N, deux sens, ni doublon, ni réflexivité, ni coût, ni date, ni événement, ni rappel', async () => {
    const compte = await make.account({ plan: 'premium' });
    const pret = await operation(compte, 'FINANCING', { label: 'Prêt immobilier' });
    const pret2 = await operation(compte, 'FINANCING', { label: 'Prêt travaux' });
    const achatA = await operation(compte, 'ACQUISITION', { realized: '2021-05-04', label: 'Maison' });
    const achatB = await operation(compte, 'ACQUISITION', { realized: '2021-05-04', label: 'Garage' });
    const f = await facade();
    const avant = await empreinte(compte);

    // SC-06 : un prêt pour plusieurs acquisitions ; SC-07 : deux prêts pour un achat.
    const r1 = await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: achatA, nature: 'FINANCING' });
    expect(r1).toMatchObject({ status: 'APPLIED', code: 'OK', changed: true, data: { fromOperationId: pret, toOperationId: achatA, nature: 'FINANCING', state: 'ACTIVE', version: 1 } });
    expect((await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: achatB, nature: 'FINANCING' })).status).toBe('APPLIED');
    expect((await f.associateOperations(t3(compte), { fromOperationId: pret2, toOperationId: achatA, nature: 'FINANCING', evidence: [doc(101)] })).status).toBe('APPLIED');
    expect((await relations(compte)).map((r) => [r.f, r.t, r.nature, r.state, r.origin])).toEqual([
      [pret, achatA, 'FINANCING', 'ACTIVE', 'USER'], [pret, achatB, 'FINANCING', 'ACTIVE', 'USER'], [pret2, achatA, 'FINANCING', 'ACTIVE', 'AI'],
    ]);

    // Rejeu : aucun doublon, aucune écriture (ni version, ni journal).
    const n = (await journal(compte)).length;
    expect(await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: achatA, nature: 'FINANCING' })).toMatchObject({ status: 'APPLIED', code: 'NO_CHANGE', changed: false, data: { version: 1 } });
    expect(await relations(compte)).toHaveLength(3);
    expect(await journal(compte)).toHaveLength(n);

    // Intégrité : réflexive, sens faux (l'achat ne « finance » pas), inférence sans preuve — refusées, rien d'écrit.
    expect(await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: pret, nature: 'ASSOCIATED' })).toMatchObject({ status: 'FORBIDDEN', code: 'REFLEXIVE' });
    expect(await f.associateOperations(user(compte), { fromOperationId: achatA, toOperationId: achatB, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'NATURE_TYPE_MISMATCH' });
    expect(await f.associateOperations(t3(compte), { fromOperationId: pret2, toOperationId: achatB, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'EVIDENCE_REQUIRED' });
    // Filet de la base, hors façade : doublon de paire (même inversée) et relation réflexive impossibles.
    await expect(sql`INSERT INTO business_operation_relations (account_id, from_operation_id, to_operation_id, nature, origin, reason_code)
                     VALUES (${compte.id}, ${achatA}, ${pret}, 'ASSOCIATED', 'SYSTEM', 'E2E')`).rejects.toThrow(/business_operation_relations_pair_uidx/);
    await expect(sql`INSERT INTO business_operation_relations (account_id, from_operation_id, to_operation_id, nature, origin, reason_code)
                     VALUES (${compte.id}, ${achatB}, ${achatB}, 'ASSOCIATED', 'SYSTEM', 'E2E')`).rejects.toThrow(/business_operation_relations_not_self_chk/);
    expect(await relations(compte)).toHaveLength(3);

    // Lecture SYMÉTRIQUE : la même ligne lue des deux côtés (AC50).
    const { readOperationGraph } = await lecture();
    const duPret = await readOperationGraph(compte.id, pret);
    expect(duPret?.relations.map((r) => [r.direction, r.nature, r.other.operationId])).toEqual([['OUTGOING', 'FINANCING', achatA], ['OUTGOING', 'FINANCING', achatB]]);
    const deLAchat = await readOperationGraph(compte.id, achatA);
    expect(deLAchat?.relations.map((r) => [r.direction, r.nature, r.other.operationId, r.other.typeCode])).toEqual([
      ['INCOMING', 'FINANCING', pret, 'FINANCING'], ['INCOMING', 'FINANCING', pret2, 'FINANCING'],
    ]);
    expect(deLAchat?.relations[0].other.label).toBe('Financement — Prêt immobilier');
    expect(JSON.stringify([duPret, deLAchat])).not.toMatch(/Opération|opération/);

    // AC51 : aucune composante financière, aucune date, aucun événement, aucun rappel, aucune carte, aucune Opération modifiée.
    expect(await empreinte(compte)).toBe(avant);
    expect(await audit(compte)).toEqual([]);
  });

  it('L114O-E03 — refus durable ; même preuve jamais recréée ; preuve nouvelle → arbitrage sans écriture ; version périmée ; clé d’idempotence', async () => {
    const compte = await make.account({ plan: 'premium' });
    const sinistre = await operation(compte, 'CLAIM');
    const reparation = await operation(compte, 'INTERVENTION');
    const autre = await operation(compte, 'INTERVENTION');
    const f = await facade();

    // T3 associe sur preuve (SC-09), l'utilisateur REFUSE.
    const cree = await f.associateOperations(t3(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [doc(7)] });
    expect(cree).toMatchObject({ status: 'APPLIED', data: { version: 1 } });
    const refus = await f.dissociateOperations(user(compte, { idempotencyKey: 'l114o-e03-refus-0001' }), { operationAId: reparation, operationBId: sinistre, evidence: [doc(7)] });
    expect(refus).toMatchObject({ status: 'APPLIED', changed: true, replayed: false, data: { state: 'REJECTED', version: 2 } });
    // Les deux événements existent toujours, distincts (une dissociation n'est ni une fusion ni une suppression).
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL`).toEqual([{ n: 3 }]);

    // Relectures : même preuve → refus muet ; reprise déterministe → refus ; RIEN n'est écrit.
    const etat = JSON.stringify([await relations(compte), await journal(compte)]);
    for (let i = 0; i < 3; i++) {
      expect(await f.associateOperations(t3(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [doc(7)] })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_REJECTED', changed: false });
    }
    expect(await f.associateOperations({ accountId: compte.id, actor: { kind: 'SYSTEM', reason: 'COHERENCE' } }, { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [doc(7)] })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_REJECTED' });
    // Preuve NOUVELLE : arbitrage requis (c'est « À traiter » qui demandera), toujours sans écriture.
    expect(await f.associateOperations(t3(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [doc(7), doc(8)] })).toMatchObject({ status: 'ARBITRATION_REQUIRED', code: 'NEW_EVIDENCE_AFTER_REFUSAL', changed: false });
    expect(JSON.stringify([await relations(compte), await journal(compte)])).toBe(etat);
    const { readOperationGraph } = await lecture();
    expect(await readOperationGraph(compte.id, sinistre)).toMatchObject({ relations: [], refusedOperationIds: [reparation] });

    // Clé d'idempotence rejouée : résultat enregistré, aucune écriture ; clé réutilisée pour une autre commande : conflit.
    expect(await f.dissociateOperations(user(compte, { idempotencyKey: 'l114o-e03-refus-0001' }), { operationAId: reparation, operationBId: sinistre, evidence: [doc(7)] })).toMatchObject({ status: 'APPLIED', changed: false, replayed: true, data: { state: 'REJECTED', version: 2 } });
    // Même clé, même commande, AUTRE entrée : conflit (une clé ne vaut que pour l'entrée qu'elle a servie).
    expect(await f.dissociateOperations(user(compte, { idempotencyKey: 'l114o-e03-refus-0001' }), { operationAId: reparation, operationBId: autre })).toMatchObject({ status: 'CONFLICT', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await f.associateOperations(user(compte, { idempotencyKey: 'l114o-e03-refus-0001' }), { fromOperationId: sinistre, toOperationId: autre, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'CONFLICT', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(JSON.stringify([await relations(compte), await journal(compte)])).toBe(etat);

    // Version périmée (carte obsolète, AC18) : conflit, rien d'écrit ; bonne version : l'utilisateur lève SON refus.
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', expectedVersion: 1 })).toMatchObject({ status: 'CONFLICT', code: 'VERSION_MISMATCH', data: { currentVersion: 2 } });
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', expectedVersion: 2 })).toMatchObject({ status: 'APPLIED', changed: true, data: { state: 'ACTIVE', version: 3 } });
    // Une inférence ne retire pas la relation posée par l'utilisateur.
    expect(await f.dissociateOperations(t3(compte), { operationAId: sinistre, operationBId: reparation })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_RELATION_PROTECTED' });

    // « Ne pas associer » posé d'avance sur une paire jamais associée (AC17) : mémorisé, jamais proposé ensuite sur ces preuves.
    expect(await f.dissociateOperations(user(compte), { operationAId: sinistre, operationBId: autre, evidence: [doc(9)] })).toMatchObject({ status: 'APPLIED', changed: true, data: { state: 'REJECTED' } });
    expect(await f.associateOperations(t3(compte), { fromOperationId: sinistre, toOperationId: autre, nature: 'CLAIM_REPAIR', evidence: [doc(9)] })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_REJECTED' });
    expect((await journal(compte)).map((j) => [j.action, j.origin, j.channel])).toEqual([
      ['CREATED', 'AI', 'T3'], ['REJECTED', 'USER', 'UI'], ['REACTIVATED', 'USER', 'UI'], ['REJECTED', 'USER', 'UI'],
    ]);
    expect((await journal(compte))[1]).toMatchObject({ actor_user_id: compte.ownerUserId, command: 'dissociateOperations', idempotency_key: 'l114o-e03-refus-0001' });
  });

  it('L114O-E04 — élément d’Agenda partagé par deux événements de référence : un seul objet Agenda, à sa date, sans rappel doublé ni « principal »', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const diagnostic = await operation(compte, 'INTERVENTION', { realized: '2020-06-10', label: 'DPE' });
    const vente = await operation(compte, 'DISPOSAL', { label: 'Vente de la maison' });
    const dpe = await element(compte, 'Diagnostic de performance énergétique', '2020-06-10', [bien.id]);
    const expiration = await element(compte, 'Fin de validité du DPE', '2030-06-09', [bien.id]);
    const seul = await element(compte, 'Contrôle technique', '2025-02-01', [bien.id]);
    const f = await facade();
    const nbElements = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`)[0].n;
    const rappels = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`)[0].n;
    const rappelsAvant = await rappels();

    // Premier lien : colonne historique (vue des écrans existants) ; second événement de référence : lien supplémentaire.
    expect(await f.linkAgendaItem(user(compte), { operationId: diagnostic, agendaItemId: dpe })).toMatchObject({ status: 'APPLIED', changed: true, data: { support: 'LEGACY_COLUMN' } });
    expect(await f.linkAgendaItem(user(compte), { operationId: diagnostic, agendaItemId: expiration })).toMatchObject({ status: 'APPLIED', data: { support: 'LEGACY_COLUMN' } });
    expect(await f.linkAgendaItem(user(compte), { operationId: vente, agendaItemId: expiration })).toMatchObject({ status: 'APPLIED', changed: true, data: { support: 'EXTRA' } });
    expect(await f.linkAgendaItem(user(compte), { operationId: vente, agendaItemId: expiration })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await liens(compte)).toEqual([
      { op: diagnostic, item: dpe, state: 'ACTIVE', origin: 'USER', legacy: true },
      { op: diagnostic, item: expiration, state: 'ACTIVE', origin: 'USER', legacy: true },
      { op: vente, item: expiration, state: 'ACTIVE', origin: 'USER', legacy: false },
    ]);

    // SC-12 / AC24 : UN objet Agenda (aucune copie), aucun rappel créé ; aucun « principal » posé par la façade.
    expect(await nbElements()).toBe(3);
    expect(await rappels()).toBe(rappelsAvant);
    expect(await sql<Json[]>`SELECT DISTINCT operation_role AS role FROM agenda_items WHERE account_id = ${compte.id} AND business_operation_id IS NOT NULL`).toEqual([{ role: 'RELATED' }]);
    asUser(compte);
    const tous = await agenda('?period=all');
    expect(tous.map((i) => Number(i.id)).sort((a, b) => a - b)).toEqual([dpe, expiration, seul].sort((a, b) => a - b));
    // SC-13 / AC25 : l'échéance 2030 reste en 2030 (jamais repliée à la date 2020 de son événement de référence).
    expect((await agenda('?year=2030')).map((i) => Number(i.id))).toEqual([expiration]);
    expect((await agenda('?period=upcoming')).map((i) => Number(i.id))).toContain(expiration);
    expect(await sql<Json[]>`SELECT id, start_date::text AS d FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`)
      .toEqual([{ id: dpe, d: '2020-06-10' }, { id: expiration, d: '2030-06-09' }, { id: seul, d: '2025-02-01' }]);

    // Lecture N↔N dans les deux sens : chaque événement de référence voit l'élément À SA DATE ; l'élément voit ses deux événements.
    const { readOperationGraph, readAgendaItemOperations } = await lecture();
    expect((await readOperationGraph(compte.id, diagnostic))?.agendaItems.map((a) => [a.agendaItemId, a.startDate, a.sharedWith])).toEqual([[dpe, '2020-06-10', 1], [expiration, '2030-06-09', 2]]);
    expect((await readOperationGraph(compte.id, vente))?.agendaItems.map((a) => [a.agendaItemId, a.startDate, a.sharedWith, a.legacyColumn])).toEqual([[expiration, '2030-06-09', 2, false]]);
    expect((await readAgendaItemOperations(compte.id, expiration))?.map((o) => [o.operationId, o.legacyColumn])).toEqual([[diagnostic, true], [vente, false]]);
    // AC07 : un élément autonome n'a aucun événement de référence — ce n'est pas une anomalie, aucune carte.
    expect(await readAgendaItemOperations(compte.id, seul)).toEqual([]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);

    // Refus de l'utilisateur sur le lien supplémentaire : l'élément, sa date et son autre lien restent ; T4 ne le recrée pas.
    expect(await f.unlinkAgendaItem(user(compte), { operationId: vente, agendaItemId: expiration })).toMatchObject({ status: 'APPLIED', changed: true, data: { support: 'EXTRA' } });
    expect(await f.linkAgendaItem(t4(compte), { operationId: vente, agendaItemId: expiration, evidence: [doc(1)] })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_REJECTED' });
    const g = await grouping();
    // Même refus par le chemin historique (projection T4 existante) : la mémoire des décisions est unique.
    await sql`UPDATE agenda_items SET business_operation_id = NULL WHERE id = ${seul}`;
    expect(await f.linkAgendaItem(user(compte), { operationId: vente, agendaItemId: seul })).toMatchObject({ status: 'APPLIED', data: { support: 'LEGACY_COLUMN' } });
    expect(await f.unlinkAgendaItem(user(compte), { operationId: vente, agendaItemId: seul })).toMatchObject({ status: 'APPLIED', changed: true, data: { support: 'LEGACY_COLUMN' } });
    // `vente` n'a plus d'autre source que sa source de création : elle reste active ; T4 ne rattache pas l'élément refusé.
    const [venteActive] = await sql<Json[]>`SELECT invalidated_at IS NULL AS ok FROM business_operations WHERE id = ${vente}`;
    if (venteActive.ok) {
      const res = await g.withGroupingWrite(compte.id, (ctx) => g.attachAgendaItem(ctx, { operationId: vente, itemId: seul, role: 'RELATED', origin: 'T4', reasonCode: 'L114O_E2E' }));
      expect(res).toMatchObject({ changed: false, skipped: 'USER_REJECTED' });
    }
    expect((await readOperationGraph(compte.id, vente))?.refusedAgendaItemIds).toEqual([expiration, seul].sort((a, b) => a - b));
    expect(await nbElements()).toBe(3);
    expect(await rappels()).toBe(rappelsAvant);
    expect((await sql<Json[]>`SELECT start_date::text AS d FROM agenda_items WHERE id = ${expiration}`)[0].d).toBe('2030-06-09');
    expect((await readAgendaItemOperations(compte.id, expiration))?.map((o) => o.operationId)).toEqual([diagnostic]);
    // Une inférence ne détache pas un lien posé par l'utilisateur.
    expect(await f.unlinkAgendaItem(t4(compte), { operationId: diagnostic, agendaItemId: dpe })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_RELATION_PROTECTED' });
    expect(await audit(compte)).toEqual([]);
  });

  it('L114O-E05 — compatibilité : colonne historique et graphe identiques quel que soit le chemin d’écriture (regroupement, SQL direct, suppression)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const a = await operation(compte, 'INTERVENTION');
    const b = await operation(compte, 'CONTRACT');
    const i1 = await element(compte, 'Devis', '2023-01-10');
    const i2 = await element(compte, 'Travaux', '2023-05-02');
    const g = await grouping();
    const colonne = () => sql<Json[]>`SELECT business_operation_id::int AS op, id AS item FROM agenda_items WHERE account_id = ${compte.id} AND business_operation_id IS NOT NULL ORDER BY 1, 2`;
    const actifs = async () => (await liens(compte)).filter((l) => l.state === 'ACTIVE').map((l) => ({ op: l.op, item: l.item }));

    // Service unique de regroupement (écrans existants, T4) : rattachement, désignation historique, déplacement, détachement.
    await g.withGroupingWrite(compte.id, async (ctx) => {
      await g.attachAgendaItem(ctx, { operationId: a, itemId: i1, role: 'RELATED', origin: 'T4', reasonCode: 'L114O_E2E' });
      await g.designatePrincipal(ctx, { operationId: a, itemId: i2, origin: 'T4', reasonCode: 'L114O_E2E' });
    });
    expect(await actifs()).toEqual(await colonne());
    await g.withGroupingWrite(compte.id, (ctx) => g.attachAgendaItem(ctx, { operationId: b, itemId: i1, role: 'RELATED', origin: 'USER', reasonCode: 'L114O_E2E', move: true }));
    expect(await actifs()).toEqual(await colonne());
    expect(await liens(compte)).toEqual([
      { op: a, item: i1, state: 'REMOVED', origin: 'AI', legacy: false },
      { op: a, item: i2, state: 'ACTIVE', origin: 'AI', legacy: true },
      { op: b, item: i1, state: 'ACTIVE', origin: 'USER', legacy: true },
    ]);
    // Écriture directe de la colonne (purge, restauration, ancien code) : le filet de la base suit.
    await sql`UPDATE agenda_items SET business_operation_id = ${a} WHERE id = ${i1}`;
    expect(await actifs()).toEqual(await colonne());
    await sql`UPDATE agenda_items SET business_operation_id = NULL WHERE id = ${i2}`;
    expect(await actifs()).toEqual(await colonne());
    // Rôles historiques jamais écrits par le graphe : le déclencheur 0652 reste seul maître du rôle.
    expect(await sql<Json[]>`SELECT id, operation_role AS role FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`).toEqual([{ id: i1, role: 'RELATED' }, { id: i2, role: null }]);
    // Élément supprimé par l'utilisateur : ses liens partent avec lui, l'événement de référence reste.
    await sql`DELETE FROM agenda_items WHERE id = ${i1}`;
    expect(await actifs()).toEqual([]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL`).toEqual([{ n: 2 }]);
    expect(await audit(compte)).toEqual([]);

    // Écart fabriqué (lien du graphe effacé à la main) : détecté, réparé par la resynchronisation, idempotente.
    await sql`UPDATE agenda_items SET business_operation_id = ${b} WHERE id = ${i2}`;
    await sql`DELETE FROM business_operation_agenda_links WHERE account_id = ${compte.id} AND agenda_item_id = ${i2} AND operation_id = ${b}`;
    expect(await audit(compte)).toEqual([{ code: 'LEGACY_LINK_MISSING', count: 1, sample: [i2] }]);
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    const { resyncLegacyAgendaLinks } = await magasin();
    expect(await resyncLegacyAgendaLinks(postgresRunner(sql as never), compte.id)).toEqual({ created: 1, reactivated: 0, released: 0 });
    expect(await resyncLegacyAgendaLinks(postgresRunner(sql as never), compte.id)).toEqual({ created: 0, reactivated: 0, released: 0 });
    expect(await audit(compte)).toEqual([]);
  });

  it('L114O-E06 — fusion : relations et liens reportés sur la canonique, sans doublon ni réflexivité, refus conservé, ancien identifiant redirigé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const doublon = await operation(compte, 'ACQUISITION', { label: 'Achat (doublon)' });
    const canonique = await operation(compte, 'ACQUISITION', { label: 'Achat' });
    const pret = await operation(compte, 'FINANCING');
    const pret2 = await operation(compte, 'FINANCING');
    const pret3 = await operation(compte, 'FINANCING');
    const travaux = await operation(compte, 'INTERVENTION');
    const item = await element(compte, 'Signature chez le notaire', '2021-05-04');
    const item2 = await element(compte, 'Remise des clés', '2021-05-20');
    const f = await facade();
    // pret → doublon (à déplacer) ; pret2 → doublon ET pret2 → canonique (à dédoublonner) ; pret3 refusé pour le doublon mais
    // actif sur la canonique (le refus l'emporte) ; doublon ↔ canonique associés (devient réflexif) ; travaux refusé (à déplacer).
    for (const [from, to] of [[pret, doublon], [pret2, doublon], [pret2, canonique], [pret3, doublon], [pret3, canonique]]) {
      expect((await f.associateOperations(user(compte), { fromOperationId: from, toOperationId: to, nature: 'FINANCING' })).status).toBe('APPLIED');
    }
    expect((await f.dissociateOperations(user(compte), { operationAId: pret3, operationBId: doublon })).status).toBe('APPLIED');
    expect((await f.associateOperations(user(compte), { fromOperationId: doublon, toOperationId: canonique, nature: 'ASSOCIATED' })).status).toBe('APPLIED');
    expect((await f.dissociateOperations(user(compte), { operationAId: travaux, operationBId: doublon })).status).toBe('APPLIED');
    // Agenda : `item` sur la colonne du doublon ; `item2` sur la colonne de `travaux` + lien supplémentaire vers le doublon.
    expect((await f.linkAgendaItem(user(compte), { operationId: doublon, agendaItemId: item })).status).toBe('APPLIED');
    expect((await f.linkAgendaItem(user(compte), { operationId: travaux, agendaItemId: item2 })).status).toBe('APPLIED');
    expect(await f.linkAgendaItem(user(compte), { operationId: doublon, agendaItemId: item2 })).toMatchObject({ status: 'APPLIED', data: { support: 'EXTRA' } });

    // Fusion EXISTANTE du dépôt (aucune seconde fusion) — une transaction.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, (repo) => repo.mergeOperations(doublon, canonique, 'L114O_E2E_MERGE'));

    const etat = new Map((await relations(compte)).map((r) => [`${r.f}>${r.t}`, r.state]));
    expect(etat.get(`${pret}>${canonique}`)).toBe('ACTIVE');          // déplacée
    expect(etat.get(`${pret2}>${canonique}`)).toBe('ACTIVE');         // déjà là : pas de doublon
    expect(etat.get(`${pret2}>${doublon}`)).toBe('REMOVED');          // trace sur l'absorbée
    expect(etat.get(`${pret3}>${canonique}`)).toBe('REJECTED');       // le refus de l'utilisateur l'emporte
    expect([...etat.entries()].filter(([k, v]) => v === 'ACTIVE' && k.split('>').map(Number).includes(doublon))).toEqual([]); // plus rien d'actif sur l'absorbée
    const paires = (await relations(compte)).map((r) => [Math.min(r.f, r.t), Math.max(r.f, r.t)].join(':'));
    expect(new Set(paires).size).toBe(paires.length);
    // Lecture : identité canonique ; l'ancien identifiant est redirigé (AC67) ; aucune relation réflexive ni vers l'absorbée.
    const { readOperationGraph, readAgendaItemOperations } = await lecture();
    const parAncien = await readOperationGraph(compte.id, doublon);
    expect(parAncien).toMatchObject({ operationId: canonique, redirectedFrom: doublon });
    expect(parAncien?.relations.map((r) => r.other.operationId).sort((x, y) => x - y)).toEqual([pret, pret2]);
    expect(parAncien?.refusedOperationIds).toEqual([pret3, travaux].sort((x, y) => x - y));
    expect((await readOperationGraph(compte.id, pret))?.relations.map((r) => r.other.operationId)).toEqual([canonique]);
    // Liens d'Agenda : aucun élément perdu, aucun dupliqué ; l'élément partagé reste partagé (travaux + canonique).
    expect(parAncien?.agendaItems.map((a) => a.agendaItemId)).toEqual([item, item2]);
    expect((await readAgendaItemOperations(compte.id, item2))?.map((o) => o.operationId).sort((x, y) => x - y)).toEqual([travaux, canonique].sort((x, y) => x - y));
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`).toEqual([{ n: 2 }]);
    expect(await audit(compte)).toEqual([]);
    // Une écriture sur l'identifiant absorbé est refusée (on écrit sur la canonique).
    expect(await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: doublon, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'OPERATION_INACTIVE' });
  });

  it('L114O-E07 — isolation des comptes et droits : façade, filet de la base, lecture, transfert d’un bien', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const restreint = await make.account({ plan: null });
    const pretA = await operation(a, 'FINANCING');
    const achatA = await operation(a, 'ACQUISITION');
    const achatA2 = await operation(a, 'ACQUISITION');
    const achatB = await operation(b, 'ACQUISITION');
    const itemB = await element(b, 'Événement du compte B', '2024-01-01');
    const itemA = await element(a, 'Événement du compte A', '2024-01-01');
    const f = await facade();

    // Façade : un identifiant d'un autre compte est « introuvable » (aucune distinction), rien n'est écrit.
    expect(await f.associateOperations(user(a), { fromOperationId: pretA, toOperationId: achatB, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await f.associateOperations(user(a), { fromOperationId: pretA, toOperationId: 999_999_999, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await f.linkAgendaItem(user(a), { operationId: pretA, agendaItemId: itemB })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await f.linkAgendaItem(user(b), { operationId: pretA, agendaItemId: itemB })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    // Droits : utilisateur non membre du compte ; compte en lecture seule ; contexte invalide.
    expect(await f.associateOperations({ accountId: a.id, actor: { kind: 'USER', userId: b.ownerUserId, channel: 'ASSISTANT' } }, { fromOperationId: pretA, toOperationId: achatA, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_A_MEMBER' });
    const o1 = await operation(restreint, 'FINANCING');
    const o2 = await operation(restreint, 'ACQUISITION');
    expect(await f.associateOperations(user(restreint), { fromOperationId: o1, toOperationId: o2, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'READ_ONLY_ACCOUNT' });
    expect(await f.associateOperations({ accountId: a.id, actor: { kind: 'USER', userId: a.ownerUserId, channel: 'UI' }, idempotencyKey: 'x' }, { fromOperationId: pretA, toOperationId: achatA, nature: 'FINANCING' })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    for (const c of [a, b, restreint]) expect([await relations(c), await liens(c), await journal(c)]).toEqual([[], [], []]);

    // Filet de la base, hors façade : relation ou lien ACTIF entre deux comptes refusé.
    await expect(sql`INSERT INTO business_operation_relations (account_id, from_operation_id, to_operation_id, nature, origin, reason_code)
                     VALUES (${a.id}, ${pretA}, ${achatB}, 'FINANCING', 'SYSTEM', 'E2E')`).rejects.toThrow(/relation entre comptes refusée/);
    await expect(sql`INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, origin, reason_code)
                     VALUES (${a.id}, ${pretA}, ${itemB}, 'SYSTEM', 'E2E')`).rejects.toThrow(/lien entre comptes refusé/);

    // Lecture : le graphe d'un événement de référence n'est lisible que de son compte.
    expect((await f.associateOperations(user(a), { fromOperationId: pretA, toOperationId: achatA, nature: 'FINANCING' })).status).toBe('APPLIED');
    expect((await f.associateOperations(user(a), { fromOperationId: pretA, toOperationId: achatA2, nature: 'FINANCING' })).status).toBe('APPLIED');
    expect((await f.linkAgendaItem(user(a), { operationId: achatA, agendaItemId: itemA })).status).toBe('APPLIED');
    const { readOperationGraph, readAgendaItemOperations } = await lecture();
    expect(await readOperationGraph(b.id, pretA)).toBeNull();
    expect(await readAgendaItemOperations(b.id, itemA)).toBeNull();
    expect((await readOperationGraph(a.id, pretA))?.relations).toHaveLength(2);

    // SC-16 : le bien d'`achatA` part dans le compte B (Opération et son élément déplacés ; le prêt multi-acquisition reste).
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    const { detachCrossAccountGraphInTx } = await magasin();
    const bilan = await sql.begin(async (tx) => {
      await tx`UPDATE business_operations SET account_id = ${b.id} WHERE id = ${achatA}`;
      await tx`UPDATE agenda_items SET account_id = ${b.id} WHERE id = ${itemA}`;
      return detachCrossAccountGraphInTx(postgresRunner(tx as never), [a.id, b.id]);
    });
    expect(bilan).toEqual({ relationsFollowed: 0, relationsRemoved: 1, agendaLinksFollowed: 1, agendaLinksRemoved: 0 });
    // Le lien financement ↔ achat parti est retiré (tracé dans le compte quitté) : aucune lecture d'un compte vers l'autre.
    expect((await readOperationGraph(a.id, pretA))?.relations.map((r) => r.other.operationId)).toEqual([achatA2]);
    expect((await readOperationGraph(b.id, achatA))?.relations).toEqual([]);
    expect((await readOperationGraph(b.id, achatA))?.agendaItems.map((x) => x.agendaItemId)).toEqual([itemA]);
    expect(await readOperationGraph(a.id, achatA)).toBeNull();
    expect((await journal(a)).at(-1)).toMatchObject({ kind: 'OPERATION_RELATION', action: 'ACCOUNT_TRANSFER', origin: 'SYSTEM' });
    expect(await audit(a)).toEqual([]);
    expect(await audit(b)).toEqual([]);
    // Deux Opérations qui changent ENSEMBLE de compte gardent leur relation (elle les suit).
    const suivi = await sql.begin(async (tx) => {
      await tx`UPDATE business_operations SET account_id = ${b.id} WHERE id IN (${pretA}, ${achatA2})`;
      return detachCrossAccountGraphInTx(postgresRunner(tx as never), [a.id, b.id]);
    });
    // Deux lignes suivent : la relation active prêt ↔ achat n° 2, et la relation RETIRÉE prêt ↔ achat n° 1 dont les deux
    // extrémités sont désormais dans le compte B (aucune ligne du compte A ne désigne plus un objet du compte B).
    expect(suivi).toMatchObject({ relationsFollowed: 2, relationsRemoved: 0 });
    expect((await readOperationGraph(b.id, pretA))?.relations.map((r) => r.other.operationId)).toEqual([achatA2]);
    expect(await relations(a)).toEqual([]);
    expect((await relations(b)).map((r) => [r.f, r.t, r.state])).toEqual([[pretA, achatA, 'REMOVED'], [pretA, achatA2, 'ACTIVE']]);
    // La relation retirée par le transfert n'est PAS rétablie d'office (décision à valider par le PO) ; le journal du compte quitté garde la trace.
    expect((await journal(a)).filter((j) => j.action === 'ACCOUNT_TRANSFER')).toHaveLength(1);
    expect(await audit(a)).toEqual([]);
    expect(await audit(b)).toEqual([]);
  });

  it('L114O-E08 — commandes simultanées : une seule relation ; panne SQL en cours de commande : rien d’écrit, reprise intègre', async () => {
    const compte = await make.account({ plan: 'premium' });
    const pret = await operation(compte, 'FINANCING');
    const achat = await operation(compte, 'ACQUISITION');
    const autre = await operation(compte, 'ACQUISITION');
    const f = await facade();
    // Six commandes identiques en parallèle, dans les deux sens de saisie : sérialisées par le verrou du compte.
    const resultats = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2
      ? f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: achat, nature: 'FINANCING' })
      : f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: achat, nature: 'FINANCING', evidence: [doc(1)] }))));
    expect(resultats.every((r) => r.status === 'APPLIED')).toBe(true);
    expect(resultats.filter((r) => r.changed)).toHaveLength(1);
    expect(await relations(compte)).toHaveLength(1);
    expect(await journal(compte)).toHaveLength(1);

    // Panne SQL au moment d'écrire le journal (après l'écriture de la relation) : la commande rend FAILED, la relation n'existe pas.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION l114o_e2e_panne() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'panne e2e'; END $$;
      CREATE TRIGGER l114o_e2e_panne BEFORE INSERT ON business_operation_graph_history FOR EACH ROW EXECUTE FUNCTION l114o_e2e_panne();`);
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: autre, nature: 'FINANCING' })).toEqual({ status: 'FAILED', code: 'TECHNICAL_FAILURE', changed: false, replayed: false });
      expect(await f.dissociateOperations(user(compte), { operationAId: pret, operationBId: achat })).toMatchObject({ status: 'FAILED' });
    } finally {
      erreurs.mockRestore();
      await sql.unsafe(`DROP TRIGGER l114o_e2e_panne ON business_operation_graph_history; DROP FUNCTION l114o_e2e_panne();`);
    }
    expect((await relations(compte)).map((r) => [r.f, r.t, r.state, r.version])).toEqual([[pret, achat, 'ACTIVE', 1]]);
    // Reprise : la même commande, rejouée après la panne, s'applique une fois.
    expect(await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: autre, nature: 'FINANCING' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await relations(compte)).toHaveLength(2);
    expect(await audit(compte)).toEqual([]);
  });

  it('L114O-E09 — document rattaché, retiré, déplacé : le fichier et son lien à l’élément d’Agenda restent ; refus mémorisé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autreCompte = await make.account({ plan: 'premium' });
    const a = await operation(compte, 'INTERVENTION');
    const b = await operation(compte, 'INTERVENTION');
    const fichier = await make.assetFile(compte);
    const etranger = await make.assetFile(autreCompte);
    const item = await element(compte, 'Passage du chauffagiste', '2024-04-02');
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${item}, ${fichier.id}, ARRAY['MANUAL_DIRECT']::text[])`;
    const f = await facade();
    const membres = () => sql<Json[]>`SELECT operation_id::int AS op, origins FROM business_operation_documents WHERE account_id = ${compte.id} AND file_id = ${fichier.id} AND active ORDER BY 1`;

    expect(await f.linkDocument(user(compte), { operationId: a, fileId: fichier.id })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await f.linkDocument(user(compte), { operationId: a, fileId: fichier.id })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await membres()).toEqual([{ op: a, origins: ['USER'] }]);
    // Geste réservé à l'utilisateur ; document d'un autre compte introuvable.
    expect(await f.linkDocument(t3(compte), { operationId: a, fileId: fichier.id })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_ONLY' });
    expect(await f.linkDocument(user(compte), { operationId: a, fileId: etranger.id })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await f.moveDocument(user(compte), { fileId: fichier.id, fromOperationId: b, toOperationId: a })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_LINKED' });

    // Déplacement atomique : une seule appartenance après, aucun fichier copié, lien Document ↔ Agenda intact.
    expect(await f.moveDocument(user(compte), { fileId: fichier.id, fromOperationId: a, toOperationId: b })).toMatchObject({ status: 'APPLIED', changed: true, data: { operationId: b, fromOperationId: a } });
    expect(await membres()).toEqual([{ op: b, origins: ['USER'] }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id} AND deleted_at IS NULL`).toEqual([{ n: 1 }]);
    expect(await sql<Json[]>`SELECT provenances FROM agenda_file_links WHERE agenda_item_id = ${item} AND asset_file_id = ${fichier.id}`).toEqual([{ provenances: ['MANUAL_DIRECT'] }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_financial_components WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);
    // Le retrait de l'origine est une décision mémorisée (jamais rattaché de nouveau par T3 sur les mêmes preuves).
    expect(await sql<Json[]>`SELECT decision FROM business_operation_match_decisions WHERE account_id = ${compte.id} AND candidate_operation_id = ${a}
                               AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(fichier.id)} AND active`).toEqual([{ decision: 'REJECTED' }]);

    // Retrait : le fichier reste, son lien à l'élément d'Agenda reste (AC44).
    expect(await f.unlinkDocument(user(compte), { operationId: b, fileId: fichier.id })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await membres()).toEqual([]);
    expect(await sql<Json[]>`SELECT deleted_at IS NULL AS vivant FROM asset_files WHERE id = ${fichier.id}`).toEqual([{ vivant: true }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_file_links WHERE agenda_item_id = ${item} AND asset_file_id = ${fichier.id}`).toEqual([{ n: 1 }]);
    expect((await journal(compte)).map((j) => [j.kind, j.action])).toEqual([['DOCUMENT_LINK', 'CREATED'], ['DOCUMENT_LINK', 'MOVED'], ['DOCUMENT_LINK', 'REJECTED']]);
  });
  it('L114O-E10 — événement de référence créé sur déclaration : sans document, élément d’Agenda, bien ni date ; source durable ; rejeu sans doublon', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const bienAutre = await make.asset(autre, { category: 'IMMOBILIER', name: 'Bien d’un autre compte' });
    const f = await facade();
    const avantAgenda = await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`;
    const texte = 'Je vais faire remplacer la chaudière de la maison';

    const r = await f.createOperation(user(compte, { actor: { kind: 'USER', userId: compte.ownerUserId, channel: 'ASSISTANT' } }), { declaration: `  ${texte}  `, type: { code: 'INTERVENTION' }, status: 'ENVISAGED' });
    expect(r).toMatchObject({ status: 'APPLIED', code: 'OK', changed: true, data: { version: 1, typeCode: 'INTERVENTION', status: 'ENVISAGED' } });
    const id = r.data!.operationId;
    // Aucune date, aucun prestataire, aucun bien, aucun document, aucun élément d'Agenda : rien n'est inventé.
    expect(await sql<Json[]>`SELECT type_code, status, planned_date, start_date, realized_date, end_date, provider, technical_label, invalidated_at
                               FROM business_operations WHERE id = ${id} AND account_id = ${compte.id}`)
      .toEqual([{ type_code: 'INTERVENTION', status: 'ENVISAGED', planned_date: null, start_date: null, realized_date: null, end_date: null, provider: null, technical_label: null, invalidated_at: null }]);
    expect(await sql<Json[]>`SELECT (SELECT count(*)::int FROM business_operation_asset_links WHERE operation_id = ${id}) AS biens,
                                    (SELECT count(*)::int FROM business_operation_documents WHERE operation_id = ${id}) AS documents,
                                    (SELECT count(*)::int FROM business_operation_financial_components WHERE operation_id = ${id}) AS couts,
                                    (SELECT count(*)::int FROM agenda_items WHERE business_operation_id = ${id}) AS elements`)
      .toEqual([{ biens: 0, documents: 0, couts: 0, elements: 0 }]);
    // Source durable : la déclaration (texte utile normalisé, auteur, canal, horodatage) et la source USER_DECLARATION de l'Opération.
    expect(await sql<Json[]>`SELECT id::int, operation_id::int AS op, purpose, channel, author_user_id AS auteur, declaration_text AS texte, declared_at IS NOT NULL AS date
                               FROM business_operation_declarations WHERE account_id = ${compte.id}`)
      .toEqual([{ id: r.data!.declarationId, op: id, purpose: 'CREATE', channel: 'ASSISTANT', auteur: compte.ownerUserId, texte, date: true }]);
    expect(await sql<Json[]>`SELECT source_kind, source_entity_key, authority, active FROM business_operation_sources WHERE operation_id = ${id}`)
      .toEqual([{ source_kind: 'USER_DECLARATION', source_entity_key: String(r.data!.declarationId), authority: 'USER', active: true }]);
    expect(await sql<Json[]>`SELECT event_type, actor_user_id FROM business_operation_history WHERE operation_id = ${id}`).toEqual([{ event_type: 'CREATED', actor_user_id: compte.ownerUserId }]);
    // Lisible par le lecteur canonique sans document, élément ni bien.
    const { readOperationGraph } = await lecture();
    expect(await readOperationGraph(compte.id, id)).toMatchObject({ operationId: id, relations: [], agendaItems: [] });
    expect(await readOperationGraph(autre.id, id)).toBeNull();

    // AC03 : la même déclaration rejouée (casse, accents, espaces différents) ne crée pas de doublon.
    const rejeu = await f.createOperation(user(compte), { declaration: 'je vais faire REMPLACER la chaudiere de la maison', type: { code: 'INTERVENTION' }, status: 'ENVISAGED' });
    expect(rejeu).toMatchObject({ status: 'APPLIED', code: 'NO_CHANGE', changed: false, data: { operationId: id, alreadyExisted: true } });
    // Clé d'idempotence : même entrée → résultat enregistré ; autre entrée → conflit ; rien n'est écrit.
    const cle = { idempotencyKey: 'l114o-e10-creation-1' };
    const entree = { declaration: 'J’ai souscrit un prêt travaux auprès de ma banque', type: { code: 'FINANCING' as const }, status: 'REALIZED' as const, attributes: { startDate: '2024-02-01', provider: 'Banque du Centre' } };
    const pret = await f.createOperation(user(compte, cle), entree);
    expect(pret).toMatchObject({ status: 'APPLIED', changed: true, replayed: false });
    expect(await f.createOperation(user(compte, cle), entree)).toMatchObject({ status: 'APPLIED', changed: false, replayed: true, data: { operationId: pret.data!.operationId } });
    expect(await f.createOperation(user(compte, cle), { ...entree, status: 'ENVISAGED' })).toMatchObject({ status: 'CONFLICT', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await sql<Json[]>`SELECT start_date::text AS debut, provider, realized_date FROM business_operations WHERE id = ${pret.data!.operationId}`)
      .toEqual([{ debut: '2024-02-01', provider: 'Banque du Centre', realized_date: null }]);
    // AC06 : type nul conservé (qualification incertaine) ; OTHER jamais par défaut (exige sa qualification certaine).
    const flou = await f.createOperation(user(compte), { declaration: 'Quelque chose a été fait sur la toiture', type: null, status: 'REALIZED' });
    expect(flou).toMatchObject({ status: 'APPLIED', changed: true, data: { typeCode: null } });
    expect(await f.createOperation(user(compte), { declaration: 'Autre chose encore', type: { code: 'OTHER' } as never, status: 'REALIZED' })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    // Entrées refusées sans écriture : inférence, date impossible, effacement, bien d'un autre compte, déclaration vide.
    expect(await f.createOperation(t3(compte), { declaration: texte, type: null, status: 'REALIZED' })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_ONLY' });
    expect(await f.createOperation(user(compte), { declaration: 'Travaux de février', type: null, status: 'REALIZED', attributes: { realizedDate: '2024-02-30' } })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    expect(await f.createOperation(user(compte), { declaration: 'Travaux sans date', type: null, status: 'REALIZED', attributes: { realizedDate: null } as never })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    expect(await f.createOperation(user(compte), { declaration: 'Travaux chez le voisin', type: null, status: 'REALIZED', assetIds: [bienAutre.id] })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await f.createOperation(user(compte), { declaration: '   ', type: null, status: 'REALIZED' })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id}`).toEqual([{ n: 3 }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_declarations WHERE account_id = ${compte.id}`).toEqual([{ n: 3 }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${autre.id}`).toEqual([{ n: 0 }]);
    // Aucun élément d'Agenda n'est né de la création d'un événement de référence non daté.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`).toEqual(avantAgenda);
    expect((await journal(compte)).map((j) => [j.kind, j.action, j.command])).toEqual([
      ['OPERATION', 'CREATED', 'createOperation'], ['OPERATION', 'CREATED', 'createOperation'], ['OPERATION', 'CREATED', 'createOperation']]);
    // Avec un bien du compte : lien posé par le dépôt (autorité USER), un seul événement de référence.
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const avecBien = await f.createOperation(user(compte), { declaration: 'J’ai fait repeindre la façade de la maison', type: { code: 'INTERVENTION' }, status: 'REALIZED', attributes: { realizedDate: '2023-06-12' }, assetIds: [bien.id, bien.id] });
    expect(await sql<Json[]>`SELECT asset_id, authority, active FROM business_operation_asset_links WHERE operation_id = ${avecBien.data!.operationId}`).toEqual([{ asset_id: bien.id, authority: 'USER', active: true }]);
  });

  it('L114O-E11 — correction protégée de T3, version périmée, invalidation logique sans perte, T3 ne réactive pas, restauration, reconstruction', async () => {
    const compte = await make.account({ plan: 'premium' });
    const f = await facade();
    const cree = await f.createOperation(user(compte), { declaration: 'Contrat d’entretien de la pompe à chaleur', type: { code: 'CONTRACT' }, status: 'REALIZED', attributes: { startDate: '2022-01-01' } });
    const id = cree.data!.operationId;
    const item = await element(compte, 'Visite annuelle d’entretien', '2030-05-20');
    expect((await f.linkAgendaItem(user(compte), { operationId: id, agendaItemId: item })).status).toBe('APPLIED');
    const fichier = await make.assetFile(compte);
    expect((await f.linkDocument(user(compte), { operationId: id, fileId: fichier.id })).status).toBe('APPLIED');
    const etat = async () => (await sql<Json[]>`SELECT type_code, status, start_date::text AS debut, end_date::text AS fin, provider, version, invalidated_at IS NOT NULL AS invalide, invalidation_reason AS motif
                                                  FROM business_operations WHERE id = ${id}`)[0];
    const v1 = (await etat()).version as number;

    // Correction : seuls les champs fournis changent ; déclaration enregistrée ; version avancée ; version périmée refusée.
    const corr = await f.updateOperation(user(compte), { operationId: id, declaration: 'Le contrat est chez Thermo Services et se termine fin 2026', expectedVersion: v1, attributes: { provider: 'Thermo Services', endDate: '2026-12-31' } });
    expect(corr).toMatchObject({ status: 'APPLIED', changed: true, data: { operationId: id, typeCode: 'CONTRACT' } });
    expect(await etat()).toMatchObject({ debut: '2022-01-01', fin: '2026-12-31', provider: 'Thermo Services', invalide: false });
    expect(corr.data!.version).toBeGreaterThan(v1);
    expect(await f.updateOperation(user(compte), { operationId: id, declaration: 'Autre correction', expectedVersion: v1, attributes: { provider: 'Autre' } })).toMatchObject({ status: 'CONFLICT', code: 'VERSION_MISMATCH', data: { currentVersion: corr.data!.version } });
    // Rejouée à l'identique : rien à changer, aucune déclaration de plus.
    expect(await f.updateOperation(user(compte), { operationId: id, declaration: 'Le contrat est chez Thermo Services et se termine fin 2026', attributes: { provider: 'Thermo Services', endDate: '2026-12-31' } })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await sql<Json[]>`SELECT purpose FROM business_operation_declarations WHERE account_id = ${compte.id} ORDER BY id`).toEqual([{ purpose: 'CREATE' }, { purpose: 'UPDATE' }]);
    // Refus : effacement d'un champ, champ inconnu, transition d'état interdite (réalisé → annulé) — tout ou rien.
    expect(await f.updateOperation(user(compte), { operationId: id, declaration: 'x', attributes: { endDate: null } as never })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    expect(await f.updateOperation(user(compte), { operationId: id, declaration: 'x', attributes: { amount: 12 } as never })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    expect(await f.updateOperation(user(compte), { operationId: id, declaration: 'Finalement annulé', status: 'CANCELLED', attributes: { provider: 'Ne doit pas être écrit' } })).toMatchObject({ status: 'FORBIDDEN', code: 'STATUS_TRANSITION_REFUSED' });
    expect(await etat()).toMatchObject({ status: 'REALIZED', provider: 'Thermo Services', version: corr.data!.version });
    expect(await f.updateOperation(t4(compte), { operationId: id, declaration: 'x', attributes: { provider: 'IA' } })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_ONLY' });

    // T3 (reconsolidation de l'Opération) ne réécrit pas la correction de l'utilisateur et n'invalide pas un événement fondé sur une déclaration.
    const reconsolider = async () => {
      const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
      const { reconsolidateOperation } = await import('@/services/business-operations/consolidation/consolidator');
      await withBusinessOperationWrite(compte.id, (repo, s) => reconsolidateOperation(repo, s.tx, id, '2026-11-14'));
    };
    await reconsolider();
    expect(await etat()).toMatchObject({ type_code: 'CONTRACT', status: 'REALIZED', debut: '2022-01-01', fin: '2026-12-31', provider: 'Thermo Services', invalide: false });

    // Invalidation par l'utilisateur : logique, rien n'est supprimé ; l'élément d'Agenda reste à SA date, détaché ; le document reste.
    const rappelsAvant = await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`;
    const inval = await f.invalidateOperation(user(compte), { operationId: id });
    expect(inval).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await etat()).toMatchObject({ invalide: true, motif: 'USER_INVALIDATED' });
    expect(await sql<Json[]>`SELECT start_date::text AS date, business_operation_id AS op, title FROM agenda_items WHERE id = ${item}`).toEqual([{ date: '2030-05-20', op: null, title: 'Visite annuelle d’entretien' }]);
    expect(await sql<Json[]>`SELECT deleted_at IS NULL AS vivant FROM asset_files WHERE id = ${fichier.id}`).toEqual([{ vivant: true }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_declarations WHERE operation_id = ${id}`).toEqual([{ n: 2 }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`).toEqual(rappelsAvant);
    expect(await f.invalidateOperation(user(compte), { operationId: id })).toMatchObject({ status: 'APPLIED', changed: false });
    const { readOperationGraph } = await lecture();
    expect(await readOperationGraph(compte.id, id)).toBeNull();
    // Écritures refusées sur un événement invalidé ; T3 ne le réactive pas.
    expect(await f.updateOperation(user(compte), { operationId: id, declaration: 'x', attributes: { provider: 'Y' } })).toMatchObject({ status: 'FORBIDDEN', code: 'OPERATION_INACTIVE' });
    expect(await f.linkAgendaItem(user(compte), { operationId: id, agendaItemId: item })).toMatchObject({ status: 'FORBIDDEN', code: 'OPERATION_INACTIVE' });
    await reconsolider();
    expect(await etat()).toMatchObject({ invalide: true, motif: 'USER_INVALIDATED' });
    // La même déclaration, redite par l'utilisateur après l'invalidation, fonde un NOUVEL événement (décision explicite, jamais silencieuse).
    const redit = await f.createOperation(user(compte), { declaration: 'Contrat d’entretien de la pompe à chaleur', type: { code: 'CONTRACT' }, status: 'REALIZED' });
    expect(redit).toMatchObject({ status: 'APPLIED', changed: true });
    expect(redit.data!.operationId).not.toBe(id);

    // Restauration par l'utilisateur ; un événement invalidé pour une autre raison n'est pas restaurable par cette commande.
    expect(await f.restoreOperation(t3(compte), { operationId: id })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_ONLY' });
    expect(await f.restoreOperation(user(compte), { operationId: id })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await etat()).toMatchObject({ invalide: false, motif: null, provider: 'Thermo Services', fin: '2026-12-31' });
    expect(await f.restoreOperation(user(compte), { operationId: id })).toMatchObject({ status: 'APPLIED', changed: false });
    const systeme = await operation(compte, 'INTERVENTION');
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, (repo) => repo.invalidate(systeme, 'T3_NO_ACTIVE_SOURCE'));
    expect(await f.restoreOperation(user(compte), { operationId: systeme })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_RESTORABLE' });
    expect(await f.invalidateOperation(user(compte), { operationId: systeme })).toMatchObject({ status: 'FORBIDDEN', code: 'OPERATION_INACTIVE' });
    expect((await journal(compte)).filter((j) => j.kind === 'OPERATION').map((j) => j.action)).toEqual(['CREATED', 'UPDATED', 'INVALIDATED', 'CREATED', 'RESTORED']);

    // Reconstruction du compte (purge) : un événement fondé sur une déclaration est une saisie de l'utilisateur — conservé.
    const { inventoryAccount } = await import('@/services/business-operations/rebuild/purge');
    const plan = await inventoryAccount(sql as never, compte.id);
    expect(plan.purged).not.toContain(id);
    expect(plan.purged).not.toContain(redit.data!.operationId);
    expect(plan.kept.map((k) => k.id)).toEqual(expect.arrayContaining([id, redit.data!.operationId]));
  });

  it('L114O-E12 — fournisseur relié puis retiré (refus mémorisé), isolation des comptes, commandes réservées à l’utilisateur', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const fournisseur = async (c: AccountRow, name: string): Promise<number> =>
      (await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status) VALUES (${c.id}, ${c.ownerUserId}, ${name}, ${name.toLowerCase()}, 'active') RETURNING id`)[0].id;
    const plombier = await fournisseur(compte, 'Plomberie Martin');
    const etranger = await fournisseur(autre, 'Fournisseur d’un autre compte');
    const op = await operation(compte, 'INTERVENTION');
    const f = await facade();
    const lien = () => sql<Json[]>`SELECT supplier_id, role, origin, status FROM business_operation_suppliers WHERE account_id = ${compte.id} AND operation_id = ${op} ORDER BY supplier_id`;
    const avant = await empreinte(compte);

    expect(await f.linkSupplier(user(compte), { operationId: op, supplierId: plombier })).toMatchObject({ status: 'APPLIED', changed: true, data: { role: 'PROVIDER', status: 'ACTIVE' } });
    expect(await f.linkSupplier(user(compte), { operationId: op, supplierId: plombier })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await f.linkSupplier(user(compte), { operationId: op, supplierId: plombier, role: 'INTERVENER' })).toMatchObject({ status: 'APPLIED', changed: true, data: { role: 'INTERVENER' } });
    expect(await lien()).toEqual([{ supplier_id: plombier, role: 'INTERVENER', origin: 'USER', status: 'ACTIVE' }]);
    // Refus sans écriture : autre compte, rôle hors référentiel, inférence.
    expect(await f.linkSupplier(user(compte), { operationId: op, supplierId: etranger })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await f.linkSupplier(user(autre), { operationId: op, supplierId: etranger })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await f.linkSupplier(user(compte), { operationId: op, supplierId: plombier, role: 'OWNER' as never })).toMatchObject({ status: 'FORBIDDEN', code: 'INVALID_INPUT' });
    expect(await f.linkSupplier(t3(compte), { operationId: op, supplierId: plombier })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_ONLY' });
    // Retrait : refus mémorisé ; la fiche du fournisseur reste ; retirer un fournisseur jamais relié n'écrit rien.
    expect(await f.unlinkSupplier(user(compte), { operationId: op, supplierId: plombier })).toMatchObject({ status: 'APPLIED', changed: true, data: { status: 'REJECTED' } });
    expect(await f.unlinkSupplier(user(compte), { operationId: op, supplierId: plombier })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await lien()).toEqual([{ supplier_id: plombier, role: 'INTERVENER', origin: 'USER', status: 'REJECTED' }]);
    expect(await sql<Json[]>`SELECT status FROM suppliers WHERE id = ${plombier}`).toEqual([{ status: 'active' }]);
    const jamais = await fournisseur(compte, 'Jamais relié');
    expect(await f.unlinkSupplier(user(compte), { operationId: op, supplierId: jamais })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_suppliers WHERE account_id = ${autre.id}`).toEqual([{ n: 0 }]);
    expect((await journal(compte)).map((j) => [j.kind, j.action])).toEqual([['SUPPLIER_LINK', 'CREATED'], ['SUPPLIER_LINK', 'UPDATED'], ['SUPPLIER_LINK', 'REJECTED']]);
    // Un lien fournisseur ne crée ni coût, ni source, ni date, ni élément d'Agenda, ni rappel, ni carte.
    expect(await empreinte(compte)).toBe(avant);
  });

  it('L114O-E13 — transfert RÉEL d’un bien entre comptes : aucune relation ni lien entre comptes ; la déclaration suit son événement de référence', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'IMMOBILIER', name: 'Maison transférée' });
    const f = await facade();
    // Un prêt (sans bien : il reste), l'achat de la maison (son bien part), un élément d'Agenda de la maison rattaché à l'achat.
    const pret = (await f.createOperation(user(a), { declaration: 'Prêt immobilier pour deux achats', type: { code: 'FINANCING' }, status: 'REALIZED' })).data!.operationId;
    const achat = (await f.createOperation(user(a), { declaration: 'Achat de la maison', type: { code: 'ACQUISITION' }, status: 'REALIZED', attributes: { realizedDate: '2020-03-15' }, assetIds: [maison.id] })).data!.operationId;
    expect((await f.associateOperations(user(a), { fromOperationId: pret, toOperationId: achat, nature: 'FINANCING' })).status).toBe('APPLIED');
    const dpe = await element(a, 'Fin de validité du DPE', '2030-03-15', [maison.id]);
    expect((await f.linkAgendaItem(user(a), { operationId: achat, agendaItemId: dpe })).status).toBe('APPLIED');
    // Un lien SUPPLÉMENTAIRE du prêt vers le même élément (élément partagé) : il ne doit pas survivre entre deux comptes.
    expect(await f.linkAgendaItem(user(a), { operationId: pret, agendaItemId: dpe })).toMatchObject({ status: 'APPLIED', data: { support: 'EXTRA' } });

    const { db } = await import('@/db');
    const { sql: dsql } = await import('drizzle-orm');
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    const { transferAssetOperationsInTx } = await import('@/services/business-operations/asset-lifecycle');
    // Même enchaînement que le déplacement d'un bien (`asset-space-move.service.ts`) : Opérations, puis le bien, puis ses données.
    await db.transaction(async (tx) => {
      await transferAssetOperationsInTx(tx, { assetId: maison.id, fromAccountId: a.id, toAccountId: b.id });
      await tx.execute(dsql`UPDATE assets SET account_id = ${b.id} WHERE id = ${maison.id}`);
      return transferAssetDataInTx(tx, { assetId: maison.id, fromAccountId: a.id, toAccountId: b.id });
    });

    expect(await sql<Json[]>`SELECT id::int, account_id FROM business_operations WHERE id IN (${pret}, ${achat}) ORDER BY id`).toEqual([{ id: pret, account_id: a.id }, { id: achat, account_id: b.id }]);
    expect(await sql<Json[]>`SELECT account_id, start_date::text AS date FROM agenda_items WHERE id = ${dpe}`).toEqual([{ account_id: b.id, date: '2030-03-15' }]);
    // Aucune relation ACTIVE ni lien ACTIF entre les deux comptes ; aucune lecture d'un compte vers l'autre.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_relations rel
        JOIN business_operations x ON x.id = rel.from_operation_id JOIN business_operations y ON y.id = rel.to_operation_id
       WHERE rel.state = 'ACTIVE' AND (x.account_id <> y.account_id OR rel.account_id <> x.account_id)`).toEqual([{ n: 0 }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_agenda_links l
        JOIN business_operations o ON o.id = l.operation_id JOIN agenda_items i ON i.id = l.agenda_item_id
       WHERE l.state = 'ACTIVE' AND (o.account_id <> i.account_id OR l.account_id <> o.account_id)`).toEqual([{ n: 0 }]);
    const { readOperationGraph, readAgendaItemOperations } = await lecture();
    expect((await readOperationGraph(a.id, pret))).toMatchObject({ relations: [], agendaItems: [] });
    expect(await readOperationGraph(a.id, achat)).toBeNull();
    expect((await readOperationGraph(b.id, achat))).toMatchObject({ relations: [] });
    expect((await readOperationGraph(b.id, achat))?.agendaItems.map((x) => [x.agendaItemId, x.startDate, x.sharedWith])).toEqual([[dpe, '2030-03-15', 1]]);
    expect((await readAgendaItemOperations(b.id, dpe))?.map((x) => x.operationId)).toEqual([achat]);
    expect(await readAgendaItemOperations(a.id, dpe)).toBeNull();
    expect(await audit(a)).toEqual([]);
    expect(await audit(b)).toEqual([]);
    // La déclaration (source durable) suit son événement de référence ; celle du prêt reste au compte A.
    expect(await sql<Json[]>`SELECT operation_id::int AS op, account_id FROM business_operation_declarations WHERE operation_id IN (${pret}, ${achat}) ORDER BY operation_id`)
      .toEqual([{ op: pret, account_id: a.id }, { op: achat, account_id: b.id }]);
    // L'élément d'Agenda (échéance 2030) est intact : un seul objet, à sa date.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id IN (${a.id}, ${b.id})`).toEqual([{ n: 1 }]);
  });
});
