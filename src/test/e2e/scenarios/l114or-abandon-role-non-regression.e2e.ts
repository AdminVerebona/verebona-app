/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 » §4, §16, §22 ; AC21
 * à AC27, AC40, AC52, AC61, AC64) — travaux F de la carte : ABANDON DU RÔLE
 * « principal » par le traitement T4 et ses projections.
 *
 * NON-RÉGRESSION PROUVÉE, sur PostgreSQL 16 réel, par les chemins de
 * PRODUCTION : migration 1721 rejouée, projection T4
 * (`agenda-projection/service.ts`), service unique de regroupement, vraie route
 * `GET /api/agenda` et vraie route `GET /api/assets/:id/overview` (Timeline
 * regroupée ET détaillée). Seule la session est simulée. Aucune IA.
 * Dates FIXES : aucun test ne dépend du jour.
 *
 * Le raisonnement de la preuve, en trois temps — « à données égales, rien ne
 * change » ne pouvant pas se mesurer en exécutant l'ancien code, il se mesure
 * en partant de l'ÉTAT DE PRÉPRODUCTION (le rôle écrit sur l'élément, aucun
 * fait porté sur le lien) :
 *
 *   L114OR-E01  la REPRISE (migration 1721) ne change RIEN de visible : même
 *               empreinte de dates, de rappels, de cartes « À traiter », de
 *               regroupements d'écran ; `agenda_items` n'est pas touchée d'une
 *               ligne (md5 identique) ; rejouée, toujours rien ;
 *   L114OR-E02  la reprise est FIDÈLE : l'élément que le rôle désignait est
 *               exactement celui qui porte le fait, y compris les désignations
 *               de l'utilisateur ; aucun membre ne devient porteur ;
 *   L114OR-E03  sur ces données reprises, la projection T4 et le service de
 *               regroupement ne changent RIEN de visible et ne créent AUCUN
 *               élément (le fait déjà porté suffit à l'idempotence) ;
 *   L114OR-E04  la colonne historique reste tenue À L'IDENTIQUE par son SEUL
 *               déclencheur (`agenda_items_operation_role_sync`, 0652) :
 *               RELATED dès qu'un élément est rattaché, NULL quand il ne l'est
 *               plus — et plus AUCUN écrivain ne pose PRINCIPAL.
 *
 * Limite assumée et documentée : l'élément porteur SANS DATE est couvert par
 * `l83a-o7-projection-agenda` et `l85e-acquisition-sans-date`, qui prouvent la
 * dernière lecture du rôle restante (`src/services/to-process/producers.service.ts`,
 * `principalDateContexts`). Ce scénario-ci travaille sur des porteurs DATÉS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

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
/** Jour de référence de la projection : FIXE (aucune dépendance au jour réel). */
const AUJ = '2026-06-15';
const MIGRATION_1721 = '1721_l114o_fait_porte_lien_agenda.sql';

scenario('L114OR', 'Opérations / Agenda CDC V2.0 — travaux F : abandon du rôle « principal » par T4, non-régression prouvée', ({ sql, make }) => {
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };

  // ── Chemins de production ─────────────────────────────────────────────────

  /** Événement de référence créé par le dépôt (avec sa source : jamais d'Opération sans fondement). */
  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; label?: string } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: 'REALIZED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114of-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }, reasonCode: 'L114OR_E2E',
    })).id);
  }
  const projeter = async (compte: AccountRow, operationIds: number[]) => {
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    return projectAccountOperations(compte.id, { operationIds, correlationId: 'l114of', today: AUJ });
  };
  const recomputer = async (compte: AccountRow, operationIds: number[]) => {
    const g = await import('@/services/business-operations/grouping/service');
    await g.withGroupingWrite(compte.id, async (ctx) => {
      for (const id of operationIds) await g.recomputePrincipal(ctx, id);
    });
  };

  // ── Lectures d'écran (vraies routes) ──────────────────────────────────────

  async function agenda(qs = '?period=all'): Promise<Json[]> {
    const route = await import('@/app/api/agenda/route');
    const r = await route.GET(new NextRequest(`http://x/api/agenda${qs}`));
    expect(r.status).toBe(200);
    return (await r.json()).items as Json[];
  }
  async function timeline(assetId: number, mode: 'grouped' | 'detailed'): Promise<Json[]> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const r = await route.GET(
      new NextRequest(`http://x/api/assets/${assetId}/overview?section=timeline&mode=${mode}&limit=100`),
      { params: Promise.resolve({ id: String(assetId) }) },
    );
    expect(r.status).toBe(200);
    return ((await r.json()).timeline ?? []) as Json[];
  }

  // ── Empreintes ────────────────────────────────────────────────────────────

  /**
   * TOUT ce que la carte interdit de changer : la date et le titre de chaque
   * élément d'Agenda, les rappels, les cartes « À traiter », et le
   * regroupement RENDU PAR LES ÉCRANS (Agenda général, Timeline regroupée et
   * détaillée de chaque bien). Volontairement SANS `updated_at` ni
   * `functional_key` : la carte autorise une écriture technique invisible, elle
   * interdit un changement VISIBLE.
   */
  async function empreinteVisible(compte: AccountRow, biens: AssetRow[]): Promise<Json> {
    asUser(compte);
    return {
      elements: await sql<Json[]>`
        SELECT id, title, start_date::text AS date, no_deadline, event_nature, business_type, manual_status, projection_origin
          FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`,
      rappels: await sql<Json[]>`
        SELECT entity_type, entity_id, event_type, status, scheduled_for::text AS quand, dedupe_key FROM notification_outbox
         WHERE account_id = ${compte.id} ORDER BY dedupe_key`,
      cartes: await sql<Json[]>`
        SELECT rule_code, target_type, target_id, field_key, action_kind, resolved_at IS NOT NULL AS resolu
          FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY rule_code, target_type, target_id, field_key`,
      liensDocuments: await sql<Json[]>`
        SELECT l.agenda_item_id AS item, l.asset_file_id AS fichier, l.provenances AS prov FROM agenda_file_links l
          JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id} ORDER BY 1, 2`,
      agenda: (await agenda()).map((i) => [i.id, i.title, i.startDate, i.businessOperationId ?? null]),
      timelines: await Promise.all(biens.map(async (b) => ({
        bien: b.id,
        regroupee: (await timeline(b.id, 'grouped')).map((e) => [e.kind, e.id, e.effectiveDate, ((e.members ?? []) as Json[]).map((m) => m.id)]),
        detaillee: (await timeline(b.id, 'detailed')).map((e) => [e.kind, e.id, e.effectiveDate]),
      }))),
    };
  }
  /** Empreinte EXACTE de la table `agenda_items` : la migration n'a le droit de toucher AUCUNE ligne. */
  const empreinteExacte = (compte: AccountRow) => sql<Json[]>`
    SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) AS h FROM agenda_items t WHERE account_id = ${compte.id}`;
  /** Liens N↔N : qui porte quel fait. */
  const liens = (compte: AccountRow) => sql<Json[]>`
    SELECT operation_id::int AS op, agenda_item_id AS item, state, origin, fact_key AS fait FROM business_operation_agenda_links
     WHERE account_id = ${compte.id} ORDER BY operation_id, agenda_item_id`;
  /** Colonne historique du rôle, telle quelle. */
  const roles = (compte: AccountRow) => sql<Json[]>`
    SELECT id, operation_role AS role, operation_role_origin AS origine FROM agenda_items
     WHERE account_id = ${compte.id} AND business_operation_id IS NOT NULL ORDER BY id`;

  /** Rejeu de la migration 1721, dans une transaction, comme en préproduction. */
  const rejouer1721 = () => sql.begin((tx) => tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations', MIGRATION_1721), 'utf8')));

  // ── Jeu de données « état de préproduction » ──────────────────────────────

  /**
   * Un compte réaliste AVANT les travaux F : quatre événements de référence de
   * types différents, chacun avec l'élément qui le REPRÉSENTE et au moins un
   * membre, un élément parfaitement indépendant, un document propagé — et
   * l'ancien modèle écrit TEL QUEL : le rôle sur l'élément (PRINCIPAL d'origine
   * T4 ou USER, RELATED pour les membres), AUCUN fait porté sur les liens.
   */
  async function etatDePreproduction() {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const facture = await make.assetFile(compte, { assetId: maison.id });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');

    const inter = await operation(compte, 'INTERVENTION', { realized: '2026-03-12', label: 'Remplacement chaudière' });
    const sinistre = await operation(compte, 'CLAIM', { realized: '2026-04-02', label: 'Dégât des eaux' });
    const achat = await operation(compte, 'ACQUISITION', { realized: '2021-04-01', label: 'Achat du garage' });
    const contrat = await operation(compte, 'CONTRACT', { label: 'Assurance habitation' });
    await withBusinessOperationWrite(compte.id, async (r) => {
      await r.upsertContractDetails(contrat, { effectiveTo: '2027-01-31' });
      for (const [op, bien] of [[inter, maison], [sinistre, maison], [contrat, maison], [achat, garage]] as Array<[number, AssetRow]>) {
        await r.linkAsset(op, { assetId: bien.id, authority: 'USER' });
      }
    });

    // Les éléments d'Agenda tels que l'utilisateur les voit, à LEUR date.
    const el = async (title: string, date: string, assetIds: number[]) => (await make.agendaItem(compte, { title, startDate: date, assetIds })).id;
    const porteurs = {
      [inter]: await el('Remplacement chaudière', '2026-03-12', [maison.id]),
      [sinistre]: await el('Dégât des eaux', '2026-04-02', [maison.id]),
      [achat]: await el('Achat du garage', '2021-04-01', [garage.id]),
      [contrat]: await el('Fin du contrat d’assurance', '2027-01-31', [maison.id]),
    };
    const membres = {
      [inter]: await el('Visite de contrôle', '2026-09-15', [maison.id]),
      [sinistre]: await el('Constat amiable', '2026-04-03', [maison.id]),
    };
    const seul = await el('Ramonage', '2026-11-02', [maison.id]);

    // ÉTAT HISTORIQUE, injecté hors déclencheurs (ancien modèle) : la colonne d'appartenance,
    // le rôle et son origine ; le document propagé au « principal » (provenance OPERATION_PRINCIPAL, §7.4).
    const ops = [inter, sinistre, achat, contrat];
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      for (const op of ops) {
        await tx`UPDATE agenda_items SET business_operation_id = ${op}, operation_role = 'PRINCIPAL',
                        operation_role_origin = ${op === sinistre ? 'USER' : 'T4'} WHERE id = ${porteurs[op]}`;
      }
      for (const op of [inter, sinistre]) {
        await tx`UPDATE agenda_items SET business_operation_id = ${op}, operation_role = 'RELATED', operation_role_origin = 'T4' WHERE id = ${membres[op]}`;
      }
      // Le document est MEMBRE de l'événement de référence (§6.2) et propagé au « principal » (§7.4) :
      // sans l'appartenance, la propagation serait un lien ORPHELIN que l'invariant O1-PRINCIPAL-DOCUMENTS
      // retirerait — règle antérieure à cette carte, sans rapport avec le rôle.
      await tx`INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins)
               VALUES (${compte.id}, ${inter}, ${facture.id}, ARRAY['SOURCE']::text[])
               ON CONFLICT (operation_id, file_id) DO NOTHING`;
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${porteurs[inter]}, ${facture.id}, ARRAY['OPERATION_PRINCIPAL']::text[])
               ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE SET provenances = EXCLUDED.provenances`;
      // Les liens N↔N du graphe existent (reprise 1716) mais ne portent AUCUN fait : c'est l'état d'avant 1721.
      await tx`INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, legacy_column, reason_code)
               SELECT i.account_id, i.business_operation_id, i.id, 'ACTIVE', 'MIGRATION', true, 'L114OR_ETAT_PREPROD'
                 FROM agenda_items i WHERE i.account_id = ${compte.id} AND i.business_operation_id IS NOT NULL
               ON CONFLICT (operation_id, agenda_item_id) DO UPDATE SET state = 'ACTIVE', fact_key = NULL`;
      await tx`UPDATE business_operation_agenda_links SET fact_key = NULL WHERE account_id = ${compte.id}`;
    });
    return { compte, biens: [maison, garage], facture, ops, inter, sinistre, achat, contrat, porteurs, membres, seul };
  }

  // ══ E01 — la reprise ne change RIEN de visible ════════════════════════════

  it('L114OR-E01 — AC61 / AC64 : la reprise 1721 ne change aucune date, aucun rappel, aucune carte, aucun regroupement d’écran ; `agenda_items` intacte ; rejouable', async () => {
    const d = await etatDePreproduction();
    const avantVisible = await empreinteVisible(d.compte, d.biens);
    const avantExact = await empreinteExacte(d.compte);
    const avantRoles = await roles(d.compte);
    // Aucun fait porté : c'est bien l'état d'AVANT la migration.
    expect((await liens(d.compte)).every((l) => l.fait === null)).toBe(true);

    for (let passage = 0; passage < 2; passage++) {
      await rejouer1721();
      // La table des éléments d'Agenda n'a pas bougé d'une ligne (ni date, ni titre, ni `updated_at`).
      expect(await empreinteExacte(d.compte), `passage ${passage}`).toEqual(avantExact);
      // Le rôle historique est laissé EN PLACE, inchangé (retrait seulement après recette, §22).
      expect(await roles(d.compte), `passage ${passage}`).toEqual(avantRoles);
      // Rien de visible n'a changé : dates, rappels, cartes, Agenda, Timeline regroupée et détaillée.
      expect(await empreinteVisible(d.compte, d.biens), `passage ${passage}`).toEqual(avantVisible);
    }
  });

  // ══ E02 — la reprise est FIDÈLE ═══════════════════════════════════════════

  it('L114OR-E02 — AC22 / AC26 / AC27 : l’élément que le rôle désignait est exactement celui qui porte le fait (désignations de l’utilisateur comprises) ; aucun membre n’en devient porteur', async () => {
    const d = await etatDePreproduction();
    await rejouer1721();
    const porteurs = (await liens(d.compte)).filter((l) => l.fait !== null);

    // Un porteur par événement de référence, et c'est bien l'élément qui portait le rôle PRINCIPAL.
    expect(porteurs.map((p) => [p.op, p.item]).sort()).toEqual(d.ops.map((op) => [op, d.porteurs[op]]).sort());
    // Le fait porté est celui du TYPE de l'événement de référence (reprise b, aucune décision nouvelle).
    const faitDe = new Map(porteurs.map((p) => [p.op, p.fait]));
    expect(faitDe.get(d.inter)).toBe('INTERVENTION');
    expect(faitDe.get(d.sinistre)).toBe('CLAIM');
    expect(faitDe.get(d.achat)).toBe('ACQUISITION');
    expect(faitDe.get(d.contrat)).toBe('CONTRACT:END');
    // La désignation de l'UTILISATEUR (rôle d'origine USER sur le sinistre) n'est pas perdue : son élément porte le fait (AC22).
    expect(porteurs.find((p) => p.op === d.sinistre)).toMatchObject({ item: d.porteurs[d.sinistre], fait: 'CLAIM' });
    // Aucun membre de plein droit ne devient porteur, et l'élément indépendant n'est relié à rien.
    for (const op of [d.inter, d.sinistre]) {
      expect((await liens(d.compte)).find((l) => l.op === op && l.item === d.membres[op])?.fait).toBeNull();
    }
    expect((await liens(d.compte)).some((l) => l.item === d.seul)).toBe(false);
    // Aucun rôle n'a été écrit par la migration : tous les porteurs portent ENCORE le rôle historique, intact.
    expect((await roles(d.compte)).filter((r) => r.role === 'PRINCIPAL').map((r) => r.id).sort())
      .toEqual(d.ops.map((op) => d.porteurs[op]).sort());
  });

  // ══ E03 — T4 et le regroupement ne changent rien ══════════════════════════

  it('L114OR-E03 — AC21 à AC25 / AC40 : sur les données reprises, la projection T4 et le service de regroupement ne créent aucun élément et ne changent rien de visible ; rejoués non plus', async () => {
    const d = await etatDePreproduction();
    await rejouer1721();
    const avant = await empreinteVisible(d.compte, d.biens);
    const nbElements = (await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${d.compte.id}`)[0].n as number;

    // La projection T4 reconnaît le fait DÉJÀ PORTÉ : elle ne crée aucun second élément (pas de doublon).
    const r1 = await projeter(d.compte, d.ops);
    expect(r1.created, JSON.stringify(r1)).toBe(0);
    await recomputer(d.compte, d.ops);
    // Rejoué : toujours rien.
    const r2 = await projeter(d.compte, d.ops);
    expect(r2.created).toBe(0);
    await recomputer(d.compte, d.ops);

    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${d.compte.id}`)[0].n).toBe(nbElements);
    // Aucune date, aucun rappel, aucune carte « À traiter », aucun regroupement d'écran ne change.
    expect(await empreinteVisible(d.compte, d.biens)).toEqual(avant);
    // Le document propagé est resté sur le porteur (§7.4), sans doublon de provenance.
    expect(await sql<Json[]>`SELECT provenances AS p FROM agenda_file_links WHERE agenda_item_id = ${d.porteurs[d.inter]} AND asset_file_id = ${d.facture.id}`)
      .toEqual([{ p: ['OPERATION_PRINCIPAL'] }]);
    // Et T4 n'a toujours posé AUCUN rôle. Les porteurs sont inchangés, SAUF le contrat : AC52 / §11.10 (invariant
    // O7-NO-INFERRED-PRINCIPAL, règle du lot 83A antérieure à cette carte) — un fait DÉDUIT porté dans une RELATION
    // DURABLE est retiré ; l'élément et son lien restent, membre de plein droit. C'est exactement ce que la projection
    // faisait de l'ancien rôle déduit : elle le rétrogradait. Aucune date, aucun rappel, aucune carte, aucun
    // regroupement d'écran n'en dépend (empreinte identique, vérifiée ci-dessus).
    const porteurs = (await liens(d.compte)).filter((l) => l.fait !== null);
    expect(porteurs.map((p) => [p.op, p.item]).sort())
      .toEqual([d.inter, d.sinistre, d.achat].map((op) => [op, d.porteurs[op]]).sort());
    expect((await liens(d.compte)).find((l) => l.op === d.contrat && l.item === d.porteurs[d.contrat]))
      .toMatchObject({ state: 'ACTIVE', fait: null });
  });

  // ══ E04 — la colonne historique, tenue à l'identique par son déclencheur ══

  it('L114OR-E04 — §22 : la colonne historique reste tenue à l’identique par son SEUL déclencheur (RELATED rattaché, NULL détaché) ; plus aucun écrivain ne pose PRINCIPAL', async () => {
    const d = await etatDePreproduction();
    await rejouer1721();
    const g = await import('@/services/business-operations/grouping/service');
    const roleDe = async (id: number) => (await sql<Json[]>`
      SELECT operation_role AS role, operation_role_origin AS origine FROM agenda_items WHERE id = ${id}`)[0];

    // Un élément NOUVEAU, rattaché par le service : RELATED, sans origine — jamais PRINCIPAL.
    const nouveau = (await make.agendaItem(d.compte, { title: 'Ramonage annuel', startDate: '2027-11-02' })).id;
    await g.withGroupingWrite(d.compte.id, (ctx) => g.attachAgendaItem(ctx, { operationId: d.inter, itemId: nouveau, origin: 'T4', reasonCode: 'L114OR_E2E' }));
    expect(await roleDe(nouveau)).toEqual({ role: 'RELATED', origine: null });

    // DÉSIGNÉ porteur par le service (T4 puis l'utilisateur) : la colonne ne bouge pas, le FAIT se déplace.
    await g.withGroupingWrite(d.compte.id, (ctx) => g.designatePrincipal(ctx, { operationId: d.inter, itemId: nouveau, origin: 'USER', reasonCode: 'L114OR_E2E' }), { actorUserId: d.compte.ownerUserId });
    expect(await roleDe(nouveau)).toEqual({ role: 'RELATED', origine: null });
    expect((await liens(d.compte)).find((l) => l.item === nouveau)).toMatchObject({ fait: 'INTERVENTION', origin: 'USER' });

    // DÉTACHÉ : la colonne repasse à NULL (déclencheur), le lien passe à REMOVED et ne porte plus de fait.
    await g.withGroupingWrite(d.compte.id, (ctx) => g.detachAgendaItem(ctx, { operationId: d.inter, itemId: nouveau, origin: 'USER', reasonCode: 'L114OR_E2E' }), { actorUserId: d.compte.ownerUserId });
    expect(await roleDe(nouveau)).toEqual({ role: null, origine: null });
    expect((await liens(d.compte)).find((l) => l.item === nouveau)).toMatchObject({ state: 'REMOVED', fait: null });

    // Rattaché par un chemin HORS service (colonne historique écrite directement) : RELATED, jamais PRINCIPAL,
    // et le lien du graphe suit (déclencheur 1716 reposé par 1721) sans porter de fait.
    await sql`UPDATE agenda_items SET business_operation_id = ${d.achat} WHERE id = ${d.seul}`;
    expect(await roleDe(d.seul)).toEqual({ role: 'RELATED', origine: null });
    expect((await liens(d.compte)).find((l) => l.item === d.seul)).toMatchObject({ op: d.achat, state: 'ACTIVE', fait: null });

    // Aucun élément du compte ne porte PRINCIPAL en dehors de ce que la préproduction y avait mis.
    expect((await roles(d.compte)).filter((r) => r.role === 'PRINCIPAL').map((r) => r.id).sort())
      .toEqual(d.ops.map((op) => d.porteurs[op]).sort());
  });
});
