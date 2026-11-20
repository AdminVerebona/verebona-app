/**
 * Carte Trello #806, volet B §8 — LISTE DES OPÉRATIONS et FAITS QUALIFIÉS DE LA FICHE (CDC « Opérations / Agenda
 * V2.0 » §14, §15, §18, §23 ; AC38, AC39, AC41 à AC43, AC56, AC59, AC74) — sur PostgreSQL 16 réel, par les chemins
 * de PRODUCTION : vraies routes `GET /api/evenements-reference` et `GET /api/evenements-reference/:id/fiche`,
 * persistance T1 et consolidation T3 réelles, façade d'écriture. Seule la session est simulée. Aucune IA.
 *
 *   L116CB-L01  LISTE : toutes les opérations actives du compte (avec ou sans bien, document, événement, date, type),
 *               jamais une opération supprimée ni celle d'un autre compte ; filtres par type (dont « non précisé »),
 *               par bien, par état visible ; recherche par intitulé, pièce, équipement, fournisseur, justificatif,
 *               référence ; tris ; le montant est celui de la fiche ; contrat associé nommé ; la lecture n'écrit rien
 *   L116CB-L02  VOLUME : 130 opérations — six pages de 25 sans perte ni répétition, deux pages de 100 ; total exact
 *   L116CB-L03  FICHE : montants par nature (devis jamais additionné au coût), source de chaque date (justificatif
 *               ouvrable), valeurs différentes relevées avec leurs justificatifs ; après une correction de
 *               l'utilisateur, plus aucun justificatif n'est donné pour source de la date ; type nommé
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
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

scenario('L116CB-L', 'Opérations / Agenda #806 volet B §8 — liste des opérations et faits qualifiés de la fiche', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };

  async function operation(compte: AccountRow, type: string | null, over: { label?: string; realized?: string; assetId?: number } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: over.realized ? 'REALIZED' : 'ENVISAGED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l116cb-l-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, authority: 'STRUCTURED' as const }] } : {}),
      reasonCode: 'L116CB_L_E2E',
    })).id);
  }
  async function liste(query = ''): Promise<{ status: number; body: Json }> {
    const route = await import('@/app/api/evenements-reference/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference${query}`));
    return { status: r.status, body: await r.json() as Json };
  }
  const ids = async (query: string): Promise<number[]> => (await liste(query)).body.items.map((i: Json) => i.id);
  async function fiche(operationId: number): Promise<Json | null> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${operationId}/fiche`), { params: Promise.resolve({ id: String(operationId) }) });
    return r.status === 200 ? (await r.json()).fiche as Json : null;
  }
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_documents t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_financial_components t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM to_process_actions t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  it('L116CB-L01 — liste : tout le compte et rien d’autre ; filtres, recherche, tris ; montant de la fiche ; contrat associé ; lecture sans écriture', async () => {
    const compte = await make.account({ plan: 'standard' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison des Lilas' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    // Opérations nées de justificatifs (consolidation T3 réelle), avec leurs montants.
    const toiture = await k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', summary: 'Réfection de la toiture', provider: 'Couverture Martin', targetHints: [cible(maison.id)],
      businessReferences: [ref('INVOICE', 'FA-TOIT-806L')], temporalHints: { realizedDate: '2025-04-02' }, financialHints: [fh('REALIZED_COST', 1_200_000, { economicDate: '2025-04-02' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Facture zinguerie 806L', amountCents: 1_200_000, date: '2025-04-02' });
    const vidange = await k.document(compte, clio.id, [cand({
      typeHint: 'INTERVENTION', summary: 'Vidange', provider: 'Garage du Centre', targetHints: [cible(clio.id)],
      businessReferences: [ref('INVOICE', 'FA-VID-806L')], temporalHints: { realizedDate: '2026-01-10' }, financialHints: [fh('REALIZED_COST', 18_000, { economicDate: '2026-01-10' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Facture vidange 806L', amountCents: 18_000, date: '2026-01-10' });
    await k.passer(compte);
    const opToiture = (await sql<{ id: number }[]>`SELECT operation_id::int AS id FROM business_operation_documents WHERE file_id = ${toiture} AND active`)[0].id;
    const opVidange = (await sql<{ id: number }[]>`SELECT operation_id::int AS id FROM business_operation_documents WHERE file_id = ${vidange} AND active`)[0].id;
    // Un sinistre et son contrat d'assurance associé ; pièce et équipement sur la toiture ; fournisseur relié.
    const sinistre = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', realized: '2025-06-01', assetId: maison.id });
    const assurance = await operation(compte, 'CONTRACT', { label: 'Assurance habitation', assetId: maison.id });
    const f = await facade();
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: assurance, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED' });
    const [piece] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${maison.id}, 'Grenier') RETURNING id`;
    const [equipement] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Velux nord') RETURNING id`;
    await sql`INSERT INTO business_operation_room_links (account_id, operation_id, substructure_id, authority, active) VALUES (${compte.id}, ${opToiture}, ${piece.id}, 'USER', true)`;
    await sql`INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority, active) VALUES (${compte.id}, ${opToiture}, ${equipement.id}, ${maison.id}, 'USER', true)`;
    const [fournisseur] = await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status) VALUES (${compte.id}, ${compte.ownerUserId}, 'Zinguerie Lambert', 'zinguerie lambert', 'active') RETURNING id`;
    expect(await f.linkSupplier(user(compte), { operationId: opToiture, supplierId: fournisseur.id })).toMatchObject({ status: 'APPLIED' });
    // Une opération DÉCLARÉE : ni bien, ni document, ni événement, ni date, ni type.
    const declaree = await f.createOperation({ accountId: compte.id, actor: { kind: 'USER', userId: compte.ownerUserId, channel: 'ASSISTANT' } },
      { declaration: 'Faire élaguer le cerisier du fond', type: null, status: 'ENVISAGED' });
    expect(declaree).toMatchObject({ status: 'APPLIED' });
    const opDeclaree = declaree.data!.operationId;
    // Une opération SUPPRIMÉE par l'utilisateur, et une opération d'un AUTRE compte portant le même intitulé.
    const supprimee = await operation(compte, 'INTERVENTION', { label: 'Créée à tort 806L', assetId: maison.id });
    expect(await f.invalidateOperation(user(compte), { operationId: supprimee })).toMatchObject({ status: 'APPLIED' });
    const bienAutre = await make.asset(autre, { category: 'IMMOBILIER', name: 'Maison des Lilas' });
    const etrangere = await operation(autre, 'INTERVENTION', { label: 'Réfection de la toiture', realized: '2025-04-02', assetId: bienAutre.id });
    asUser(compte);
    const avant = await empreinte(compte);

    // TOUT le compte, et rien d'autre.
    const tout = await liste();
    expect(tout.status).toBe(200);
    const attendus = [opToiture, opVidange, sinistre, assurance, opDeclaree].sort((a, b) => a - b);
    expect(tout.body.items.map((i: Json) => i.id).sort((a: number, b: number) => a - b)).toEqual(attendus);
    expect(tout.body).toMatchObject({ total: 5, totalAll: 5, page: 1, pages: 1 });
    expect(JSON.stringify(tout.body)).not.toContain('Créée à tort 806L');
    expect(tout.body.items.map((i: Json) => i.id)).not.toContain(etrangere);
    expect(tout.body.assets.map((a: Json) => a.name)).toEqual(['Clio', 'Maison des Lilas']);
    // Chaque ligne nomme ce qu'elle porte ; le MONTANT est celui de la fiche (même règle, aucun second calcul).
    const ligne = tout.body.items.find((i: Json) => i.id === opToiture);
    expect(ligne).toMatchObject({
      typeCode: 'INTERVENTION', typeLabel: 'Intervention', date: '2025-04-02', assets: [{ id: maison.id, name: 'Maison des Lilas' }],
      rooms: ['Grenier'], equipments: ['Velux nord'], suppliers: ['Zinguerie Lambert'], documentCount: 1, netCents: 1_200_000, unconvertedCount: 0,
    });
    expect(ligne.title).toBe((await fiche(opToiture))!.title);
    expect(ligne.netCents).toBe((await fiche(opToiture))!.summary.netCents);
    expect(tout.body.items.find((i: Json) => i.id === sinistre).contracts).toEqual([{ id: assurance, label: 'Contrat — Assurance habitation' }]);
    expect(tout.body.items.find((i: Json) => i.id === opDeclaree)).toMatchObject({ typeCode: null, typeLabel: null, date: null, assets: [], documentCount: 0, netCents: null });

    // FILTRES.
    expect((await ids('?type=CLAIM'))).toEqual([sinistre]);
    expect((await ids('?type=NONE'))).toEqual([opDeclaree]);
    expect((await ids(`?bien=${clio.id}`))).toEqual([opVidange]);
    expect((await ids('?etat=UNDATED')).sort((a, b) => a - b)).toEqual([assurance, opDeclaree].sort((a, b) => a - b));
    expect((await ids('?etat=NO_DOCUMENT')).sort((a, b) => a - b)).toEqual([sinistre, assurance, opDeclaree].sort((a, b) => a - b));
    expect((await liste(`?bien=${clio.id}`)).body).toMatchObject({ total: 1, totalAll: 5 });
    // Le bien d'un AUTRE compte nommé dans le filtre : rien (jamais ses opérations).
    expect(await ids(`?bien=${bienAutre.id}`)).toEqual([]);
    // RECHERCHE : intitulé, pièce, équipement, fournisseur relié, prestataire lu, justificatif, référence, déclaration.
    for (const [q, attendu] of [['toiture', opToiture], ['grenier', opToiture], ['velux', opToiture], ['lambert', opToiture], ['zinguerie 806L', opToiture],
      ['FA-VID-806L', opVidange], ['garage centre', opVidange], ['cerisier', opDeclaree], ['dégât eaux', sinistre]] as const) {
      expect(await ids(`?q=${encodeURIComponent(q)}`), q).toEqual([attendu]);
    }
    expect(await ids(`?q=${encodeURIComponent('introuvable 806L')}`)).toEqual([]);
    // TRIS : par date (sans date en fin), par intitulé, par montant (sans montant en fin).
    expect((await ids('?tri=DATE_DESC')).slice(0, 3)).toEqual([opVidange, sinistre, opToiture]);
    expect((await ids('?tri=DATE_ASC')).slice(0, 3)).toEqual([opToiture, sinistre, opVidange]);
    expect((await ids('?tri=AMOUNT_DESC')).slice(0, 2)).toEqual([opToiture, opVidange]);
    const parTitre = (await liste('?tri=TITLE')).body.items.map((i: Json) => i.title as string);
    expect(parTitre).toEqual([...parTitre].sort((a, b) => a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().localeCompare(b.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(), 'fr')));

    // La lecture n'écrit rien ; l'autre compte ne voit que la sienne.
    expect(await empreinte(compte)).toBe(avant);
    asUser(autre);
    expect(await ids('')).toEqual([etrangere]);
  }, 180000);

  it('L116CB-L02 — 130 opérations : six pages de 25 sans perte ni répétition, deux pages de 100, total exact', async () => {
    const compte = await make.account({ plan: 'premium' });
    const immeuble = await make.asset(compte, { category: 'IMMOBILIER', name: 'Immeuble' });
    const crees: number[] = [];
    for (let i = 0; i < 130; i++) {
      crees.push(await operation(compte, 'INTERVENTION', { label: `Lot ${String(i + 1).padStart(3, '0')}`, realized: '2025-06-01', assetId: immeuble.id }));
    }
    asUser(compte);
    const t0 = Date.now();
    const premiere = await liste('');
    const ms = Date.now() - t0;
    expect(premiere.body).toMatchObject({ total: 130, totalAll: 130, page: 1, pages: 6, pageSize: 25 });
    const vus: number[] = [];
    for (let p = 1; p <= 6; p++) {
      const page = await liste(`?page=${p}`);
      expect(page.body.page).toBe(p);
      vus.push(...page.body.items.map((i: Json) => i.id));
    }
    expect(vus).toHaveLength(130);
    expect(new Set(vus).size).toBe(130);
    expect([...vus].sort((a, b) => a - b)).toEqual([...crees].sort((a, b) => a - b));
    // Même date partout : l'ordre reste total (aucune ligne ne change de page d'une lecture à l'autre).
    expect((await liste('?page=3')).body.items.map((i: Json) => i.id)).toEqual(vus.slice(50, 75));
    // Pages de 100 ; une page au-delà de la dernière est ramenée à la dernière (jamais une page vide trompeuse).
    expect((await liste('?taille=100')).body).toMatchObject({ pages: 2, pageSize: 100 });
    expect((await liste('?taille=100&page=2')).body.items).toHaveLength(30);
    expect((await liste('?page=99')).body).toMatchObject({ page: 6 });
    expect((await liste('?page=99')).body.items).toHaveLength(5);
    // Recherche sur l'ENSEMBLE, pas sur une page : « Lot 013 » en trouve une ; « Lot 12 » les douze qui le contiennent
    // (012, 112, 120 à 129), dont la plupart sont au-delà de la première page.
    expect((await liste(`?q=${encodeURIComponent('Lot 013')}`)).body.total).toBe(1);
    expect((await liste(`?q=${encodeURIComponent('Lot 12')}`)).body.total).toBe(12);
    console.info(`[L116CB-L02] liste de 130 opérations, première page : ${ms} ms (mesure indicative)`);
    expect(ms).toBeLessThan(20000);
  }, 240000);

  it('L116CB-L03 — fiche : montants par nature, source de chaque date, valeurs différentes relevées, aucune source fausse après correction', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const devis = await k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', summary: 'Remplacement de la chaudière', provider: 'Chauffage Martin', targetHints: [cible(maison.id)],
      businessReferences: [ref('QUOTE', 'DV-806L')], financialHints: [fh('FORECAST_COST', 420_000)],
    })], { type: 'QUOTE', title: 'Devis chaudière 806L', amountCents: 420_000, date: '2025-03-01' });
    const facture = await k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'INVOICE', summary: 'Remplacement de la chaudière', provider: 'Chauffage Martin', targetHints: [cible(maison.id)],
      businessReferences: [ref('QUOTE', 'DV-806L'), ref('INVOICE', 'FA-806L')], temporalHints: { realizedDate: '2025-04-15' }, financialHints: [fh('REALIZED_COST', 410_000, { economicDate: '2025-04-15' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Facture chaudière 806L', amountCents: 410_000, date: '2025-04-15' });
    // Un procès-verbal de réception qui donne une AUTRE date de réalisation (un mois plus tard).
    const pv = await k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'OTHER_EVIDENCE', summary: 'Remplacement de la chaudière', provider: 'Chauffage Martin', targetHints: [cible(maison.id)],
      businessReferences: [ref('QUOTE', 'DV-806L')], temporalHints: { realizedDate: '2025-05-20' }, financialHints: [],
    })], { type: 'OTHER_INSURANCE_CLAIMS', title: 'Procès-verbal de réception 806L', amountCents: null, date: '2025-05-20' });
    await k.passer(compte);
    const [{ id: op }] = await sql<{ id: number }[]>`SELECT operation_id::int AS id FROM business_operation_documents WHERE file_id = ${facture} AND active`;
    asUser(compte);

    const vue = (await fiche(op))!;
    expect(vue).toMatchObject({ typeCode: 'INTERVENTION', typeLabel: 'Intervention' });
    // MONTANTS PAR NATURE : le coût réalisé (4 100 €) et la prévision du devis (4 200 €) — jamais additionnés ; la
    // synthèse garde la règle existante (net des coûts réalisés).
    expect(vue.amounts).toEqual([
      { kind: 'REALIZED_COST', count: 1, eurCents: 410_000, unconverted: 0 },
      { kind: 'FORECAST_COST', count: 1, eurCents: 420_000, unconverted: 0 },
    ]);
    expect(vue.summary.netCents).toBe(410_000);
    // SOURCE de la date affichée : un justificatif de l'opération, ouvrable.
    const source = vue.factSources.find((s: Json) => s.field === 'REALIZED');
    expect(source).toMatchObject({ origin: 'DOCUMENT' });
    expect([facture, pv]).toContain(source.fileId);
    expect(vue.documents.map((d: Json) => d.fileId)).toContain(source.fileId);
    // VALEURS DIFFÉRENTES : les deux dates relevées, chacune avec son justificatif ; la valeur affichée est l'une d'elles.
    const ecart = vue.conflicts.find((c: Json) => c.field === 'REALIZED');
    expect(ecart, JSON.stringify(vue.conflicts)).toBeTruthy();
    expect(ecart.values.map((v: Json) => v.value).sort()).toEqual(['2025-04-15', '2025-05-20']);
    expect(ecart.values.find((v: Json) => v.value === '2025-04-15').sources.map((s: Json) => s.fileId)).toEqual([facture]);
    expect(ecart.values.find((v: Json) => v.value === '2025-05-20').sources.map((s: Json) => s.fileId)).toEqual([pv]);
    // « Valeur affichée » : exactement la date que la fiche montre.
    expect(ecart.retained).toBe(vue.dates.find((d: Json) => d.role === 'REALIZED').date);
    expect(source.fileId).toBe(ecart.values.find((v: Json) => v.value === ecart.retained).sources[0].fileId);
    expect(devis).toBeGreaterThan(0);

    // CORRECTION par l'utilisateur : la date devient la sienne — T3 ne la réécrit pas.
    const f = await facade();
    expect(await f.correctOperation(user(compte), { operationId: op, expectedVersion: vue.version, attributes: { realizedDate: '2025-05-02' } })).toMatchObject({ status: 'APPLIED', changed: true });
    await k.passer(compte);
    const apres = (await fiche(op))!;
    expect(apres.dates).toEqual([{ role: 'REALIZED', date: '2025-05-02' }]);
    // La date affichée n'est plus celle d'un justificatif : la fiche ne lui attribue AUCUNE source documentaire, et
    // aucune des deux valeurs relevées n'est marquée « valeur affichée ».
    expect(apres.factSources.find((s: Json) => s.field === 'REALIZED')).toBeUndefined();
    expect(apres.conflicts.find((c: Json) => c.field === 'REALIZED')?.retained ?? null).toBeNull();
    // Les montants ne bougent pas avec la date.
    expect(apres.amounts).toEqual(vue.amounts);
  }, 180000);
});
