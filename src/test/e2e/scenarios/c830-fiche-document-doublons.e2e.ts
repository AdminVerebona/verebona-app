/**
 * Carte Trello #830 (P2, Pré-MEP) — FICHE D'UN DOCUMENT : données de CORRESPONDANCE événement ↔ opération ↔
 * document, sur PostgreSQL 16 réel, par les chemins de PRODUCTION : vraies routes
 * (`GET /api/documents/:id/agenda-liens`, `GET /api/documents/:id/evenements-reference`, `GET /api/files/:id`,
 * `DELETE /api/evenements-reference/:id/documents`), vrais services d'écriture des opérations et du regroupement
 * pour CONSTRUIRE les cas. Seule la session est simulée. Aucune IA. Dates fixes.
 *
 * La carte ne change que des AFFICHAGES : ce scénario prouve (1) que la route des liens fournit, pour chaque
 * événement lié au document, les opérations ACTIVES du document dont il PORTE UN FAIT — il en est la représentation
 * dans l'Agenda (`representedOperationIds`), (2) que la règle d'affichage appliquée à ces données réelles masque le
 * doublon et lui seul, (3) qu'AUCUNE association n'est modifiée en base par ces lectures.
 *
 *   C830-E01  DECATHLON : bon de commande du 17/11/2026, vélo, opération d'achat et son événement du 20/11/2026 →
 *             l'événement est rendu avec l'opération qu'il représente ; cette opération est celle que la rubrique
 *             « Opérations » liste ; la règle masque tout le bloc ; rien n'est écrit
 *   C830-E02  CONFORAMA : reçu d'acompte du 14/11/2026, 35,00 €, bien « Maison » → même correspondance ; la date,
 *             le montant et le bien servis par `GET /api/files/:id` sont inchangés ; rien n'est écrit
 *   C830-E03  AUTONOME, MIXTE, OPÉRATION SANS ÉVÉNEMENT, DEUX OPÉRATIONS : l'événement lié directement n'est jamais
 *             un doublon — même quand le geste « Associer à l'agenda » l'a fait rejoindre l'opération du document
 *             (simple membre, sans fait porté) ; seul l'événement qui représente l'opération est masqué ; une
 *             opération sans événement ne masque rien ; deux opérations : chacune masque le sien
 *   C830-E04  OPÉRATION NON AFFICHÉE : document RETIRÉ d'une opération (vraie route), opération supprimée →
 *             l'opération n'est plus nommée ; l'événement qui resterait lié au document n'est plus un doublon
 *   C830-E05  ISOLATION : document d'un autre compte introuvable ; l'opération et l'événement d'un autre compte
 *             ne sont jamais nommés
 *   C830-E06  REQUÊTE DE CONTRÔLE en lecture seule de la fiche de recette (pour le PO, en préproduction) : sa
 *             syntaxe est valide sur le schéma réel et elle rend la même correspondance que la route
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import { documentEventsView, type DocumentAgendaLinkFacts } from '@/lib/documents/document-event-duplicates';

const session = vi.hoisted(() => ({ currentAccountId: 0 as number | null, userId: 0, role: 'USER' as string }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const facade = () => import('@/services/business-operations/operation-write.facade');
const grouping = () => import('@/services/business-operations/grouping/service');

/**
 * Requête de contrôle en LECTURE SEULE de la fiche de recette 117E (à exécuter par le PO en préproduction) :
 * pour un document d'un compte, chaque événement lié et les opérations actives du document dont il porte un fait.
 * `operations_representees` vide → événement distinct (affiché) ; sinon → il représente ces opérations (masqué si la
 * fiche en affiche une).
 */
const REQUETE_CONTROLE = `
SELECT i.id AS evenement, i.title AS titre, to_char(i.start_date, 'YYYY-MM-DD') AS date_evenement, l.provenances,
       (SELECT string_agg(DISTINCT g.operation_id::text, ',')
          FROM business_operation_agenda_links g
          JOIN business_operations o ON o.id = g.operation_id AND o.account_id = g.account_id
               AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
          JOIN business_operation_documents d ON d.account_id = g.account_id AND d.operation_id = g.operation_id
               AND d.file_id = f.id AND d.active
         WHERE g.account_id = i.account_id AND g.agenda_item_id = i.id AND g.state = 'ACTIVE'
           AND g.fact_key IS NOT NULL) AS operations_representees
  FROM asset_files f
  JOIN agenda_file_links l ON l.asset_file_id = f.id
  JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = f.account_id
 WHERE f.account_id = $1 AND f.id = $2 AND f.deleted_at IS NULL
 ORDER BY i.start_date NULLS LAST, i.id`;

scenario('C830', 'Fiche document #830 — correspondance événement ↔ opération ↔ document, lecture seule', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; session.role = 'USER'; };

  async function fichier(compte: AccountRow, assetId: number, o: { titre: string; type: string; date: string; montant?: number; fournisseur?: string }): Promise<number> {
    const f = await make.assetFile(compte, { assetId, name: `${o.titre}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${o.titre}, document_date = ${o.date}, document_type_code = ${o.type}, analysis_state = 'ANALYZED',
                     amount_cents = ${o.montant ?? null}, supplier = ${o.fournisseur ?? null} WHERE id = ${f.id}`;
    return f.id;
  }
  /** Opération créée par le vrai service d'écriture ; `fileId` : le document en est la source (il en est membre). */
  async function operation(compte: AccountRow, o: { type: string; label: string; realized: string; assetId: number; fileId?: number }): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: o.type } as never, status: 'REALIZED', realizedDate: o.realized, technicalLabel: o.label,
      source: o.fileId
        ? { kind: 'DOCUMENT', entityKey: o.fileId, authority: 'DOCUMENT', confidence: 'certain' }
        : { kind: 'MIGRATION', entityKey: `c830-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      assets: [{ assetId: o.assetId, role: 'PRIMARY', authority: 'STRUCTURED' as const }], reasonCode: 'C830_E2E',
    } as never)).id);
  }
  const evenement = async (compte: AccountRow, title: string, date: string, assetId: number): Promise<number> =>
    (await make.agendaItem(compte, { title, startDate: date, assetIds: [assetId] })).id;
  /** L'événement devient le JALON de l'opération (vrai service de regroupement) : ses documents lui sont propagés. */
  async function jalon(compte: AccountRow, operationId: number, itemId: number): Promise<void> {
    const { designatePrincipal, withGroupingWrite } = await grouping();
    await withGroupingWrite(compte.id, async (ctx) => { await designatePrincipal(ctx, { operationId, itemId, origin: 'T4', reasonCode: 'C830_E2E' }); });
  }
  const lierDoc = async (compte: AccountRow, operationId: number, fileId: number) =>
    expect(await (await facade()).linkDocument(user(compte), { operationId, fileId })).toMatchObject({ status: 'APPLIED' });
  const lierEvt = async (compte: AccountRow, operationId: number, agendaItemId: number) =>
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId })).toMatchObject({ status: 'APPLIED' });
  /** Lien DIRECT Document ↔ événement, par la vraie route du bouton « Associer à l'agenda ». */
  async function associer(fileId: number, itemId: number): Promise<void> {
    const route = await import('@/app/api/documents/[id]/agenda-liens/route');
    const r = await route.POST(new NextRequest(`http://x/api/documents/${fileId}/agenda-liens`, { method: 'POST', body: JSON.stringify({ itemId }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: String(fileId) }) });
    expect(r.status).toBe(200);
  }

  async function liens(fileId: number): Promise<{ status: number; links: DocumentAgendaLinkFacts[] }> {
    const route = await import('@/app/api/documents/[id]/agenda-liens/route');
    const r = await route.GET(new NextRequest(`http://x/api/documents/${fileId}/agenda-liens`), { params: Promise.resolve({ id: String(fileId) }) });
    const body = await r.json() as Json;
    return { status: r.status, links: (body.links ?? []) as DocumentAgendaLinkFacts[] };
  }
  async function operations(fileId: number): Promise<{ status: number; references: Array<{ id: number; label: string }> }> {
    const route = await import('@/app/api/documents/[id]/evenements-reference/route');
    const r = await route.GET(new NextRequest(`http://x/api/documents/${fileId}/evenements-reference`), { params: Promise.resolve({ id: String(fileId) }) });
    const body = await r.json() as Json;
    return { status: r.status, references: (body.references ?? []) as Array<{ id: number; label: string }> };
  }
  /** Événements que l'écran liste pour le document (même source que `GET /api/agenda?fileId=` : `agenda_file_links`). */
  const evenementsDuDocument = (compte: AccountRow, fileId: number) => sql<{ id: number; title: string }[]>`
    SELECT i.id, i.title FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = ${compte.id}
     WHERE l.asset_file_id = ${fileId} ORDER BY i.start_date NULLS LAST, i.id`;
  /** Ce que la fiche affiche, calculé par la VRAIE règle sur les VRAIES réponses des deux routes. */
  async function ficheAffichee(compte: AccountRow, fileId: number) {
    const [l, o, items] = [await liens(fileId), await operations(fileId), await evenementsDuDocument(compte, fileId)];
    expect(l.status).toBe(200);
    expect(o.status).toBe(200);
    const vue = documentEventsView(items, { status: 'ready', links: new Map(l.links.map((x) => [x.itemId, x])) }, o.references.map((r) => r.id));
    return { liens: l.links, operations: o.references, evenements: vue.events.map((e) => e.title), masques: vue.hiddenIds, bouton: vue.showAssociate };
  }
  /** Tout ce qu'une lecture ne doit JAMAIS toucher : documents, événements, opérations, dates et associations. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_documents t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_match_decisions t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_relations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(l::text, '|' ORDER BY l.id)), '') FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM asset_files t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  it('C830-E01 — Decathlon : l’événement d’achat est rendu avec l’opération du document qui le porte ; la règle masque tout le bloc ; rien n’est écrit', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'MOBILIER', name: 'Vélo Jean Fourche' });
    const bon = await fichier(compte, velo.id, { titre: 'Bon de commande Decathlon France', type: 'ACQUISITION_ORDER', date: '2026-11-17', montant: 54900, fournisseur: 'Decathlon France' });
    const achat = await operation(compte, { type: 'ACQUISITION', label: 'Achat Decathlon', realized: '2026-11-20', assetId: velo.id, fileId: bon });
    const evt = await evenement(compte, 'Achat Decathlon', '2026-11-20', velo.id);
    await jalon(compte, achat, evt);
    asUser(compte);
    const avant = await empreinte(compte);

    const f = await ficheAffichee(compte, bon);
    // Rubrique « Opérations (1) » : l'achat, sous son nom d'opération.
    expect(f.operations).toHaveLength(1);
    expect(f.operations[0]).toMatchObject({ id: achat, label: 'Achat Decathlon' });
    // Le lien du document avec l'événement : propagé par l'opération, jalon, et l'opération qui le porte est NOMMÉE.
    expect(f.liens).toEqual([{ itemId: evt, direct: false, viaGroup: true, isMain: true, outsideOperation: false, representedOperationIds: [achat] }]);
    // Règle A : le seul événement est le doublon de l'opération affichée → bloc entier absent (cartes ET bouton).
    expect(f.evenements).toEqual([]);
    expect(f.masques).toEqual([evt]);
    expect(f.bouton).toBe(false);
    // Aucune association n'est modifiée par ces lectures (répétées : ouverture, réouverture, rafraîchissement).
    await ficheAffichee(compte, bon);
    await ficheAffichee(compte, bon);
    expect(await empreinte(compte)).toBe(avant);
    // Le lien propagé existe toujours en base : il est seulement non répété à l'écran.
    expect(await sql`SELECT provenances FROM agenda_file_links WHERE agenda_item_id = ${evt} AND asset_file_id = ${bon}`).toEqual([{ provenances: ['OPERATION_PRINCIPAL'] }]);
  }, 120000);

  it('C830-E02 — Conforama : reçu d’acompte du 14/11/2026, 35,00 €, bien « Maison » — même correspondance ; date, montant et bien inchangés', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const recu = await fichier(compte, maison.id, { titre: 'Reçu Acompte CONFORAMA FRANCE SA', type: 'ACQUISITION_PAYMENT', date: '2026-11-14', montant: 3500, fournisseur: 'CONFORAMA FRANCE SA' });
    const achat = await operation(compte, { type: 'ACQUISITION', label: 'Achat d’une table de cuisson à induction', realized: '2026-11-14', assetId: maison.id, fileId: recu });
    const evt = await evenement(compte, 'Achat', '2026-11-14', maison.id);
    await jalon(compte, achat, evt);
    asUser(compte);
    const avant = await empreinte(compte);

    const f = await ficheAffichee(compte, recu);
    expect(f.operations.map((o) => o.id)).toEqual([achat]);
    expect(f.operations[0].label).toContain('table de cuisson à induction');
    expect(f.liens).toEqual([{ itemId: evt, direct: false, viaGroup: true, isMain: true, outsideOperation: false, representedOperationIds: [achat] }]);
    expect(f.evenements).toEqual([]);
    expect(f.bouton).toBe(false);
    // Les champs du document servis à la fiche : date du document, montant, fournisseur, bien.
    const route = await import('@/app/api/files/[id]/route');
    const r = await route.GET(new NextRequest(`http://x/api/files/${recu}`), { params: Promise.resolve({ id: String(recu) }) } as never);
    expect(r.status).toBe(200);
    const doc = await r.json() as Json;
    expect(String(doc.documentDate ?? doc.document_date)).toContain('2026-11-14');
    expect(doc.amountCents ?? doc.amount_cents).toBe(3500);
    expect(doc.supplier).toBe('CONFORAMA FRANCE SA');
    expect(doc.assetId ?? doc.asset_id).toBe(maison.id);
    expect(await empreinte(compte)).toBe(avant);
    expect((await sql`SELECT to_char(document_date, 'YYYY-MM-DD') AS d, amount_cents, asset_id FROM asset_files WHERE id = ${recu}`)[0]).toEqual({ d: '2026-11-14', amount_cents: 3500, asset_id: maison.id });
  }, 120000);

  it('C830-E03 — autonome, mixte, opération sans événement, événement de deux opérations : seul le doublon prouvé est masqué', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    // a) Événement AUTONOME seul : document sans opération, lié directement à un événement (vraie route).
    const devis = await fichier(compte, maison.id, { titre: 'Devis de ramonage', type: 'MAINTENANCE_INVOICE', date: '2026-10-02' });
    const ramoneur = await evenement(compte, 'Passage du ramoneur', '2026-12-03', maison.id);
    asUser(compte);
    await associer(devis, ramoneur);
    let f = await ficheAffichee(compte, devis);
    expect(f.operations).toEqual([]);
    expect(f.liens).toEqual([expect.objectContaining({ itemId: ramoneur, direct: true, representedOperationIds: [] })]);
    expect(f.evenements).toEqual(['Passage du ramoneur']);
    expect(f.masques).toEqual([]);
    expect(f.bouton).toBe(true);

    // b) MIXTE : la facture appartient à l'opération « Pose » (dont l'événement porte le fait) et l'utilisateur l'associe à un rappel
    //    indépendant par le VRAI geste « Associer à l'agenda ». Ce geste fait rejoindre l'opération au rappel (règle existante,
    //    lot 84B) : il en devient un simple membre, sans fait porté — il reste un événement DISTINCT, jamais masqué.
    const facture = await fichier(compte, maison.id, { titre: 'Facture de la chaudière', type: 'MAINTENANCE_INVOICE', date: '2026-09-12' });
    const pose = await operation(compte, { type: 'INTERVENTION', label: 'Pose de la chaudière', realized: '2026-09-10', assetId: maison.id, fileId: facture });
    const jour = await evenement(compte, 'Pose de la chaudière', '2026-09-10', maison.id);
    await jalon(compte, pose, jour);
    const rappel = await evenement(compte, 'Rappel : relever le compteur', '2026-12-01', maison.id);
    await associer(facture, rappel);
    const avant = await empreinte(compte);
    f = await ficheAffichee(compte, facture);
    expect(f.operations.map((o) => o.id)).toEqual([pose]);
    expect(f.liens.find((l) => l.itemId === jour)).toMatchObject({ representedOperationIds: [pose], outsideOperation: false, isMain: true });
    expect(f.liens.find((l) => l.itemId === rappel)).toMatchObject({ representedOperationIds: [], direct: true });
    expect((await sql`SELECT fact_key FROM business_operation_agenda_links WHERE account_id = ${compte.id} AND agenda_item_id = ${rappel} AND state = 'ACTIVE'`).every((r) => r.fact_key === null)).toBe(true);
    expect(f.evenements).toEqual(['Rappel : relever le compteur']);
    expect(f.masques).toEqual([jour]);
    expect(f.bouton).toBe(true);
    expect(await empreinte(compte)).toBe(avant);

    // c) Opération SANS événement correspondant : elle ne masque aucun événement autonome du document.
    const contrat = await fichier(compte, maison.id, { titre: 'Contrat d’entretien', type: 'MAINTENANCE_INVOICE', date: '2026-01-15' });
    const entretien = await operation(compte, { type: 'CONTRACT', label: 'Entretien de la chaudière', realized: '2026-01-15', assetId: maison.id, fileId: contrat });
    const visite = await evenement(compte, 'Visite annuelle', '2027-01-15', maison.id);
    await associer(contrat, visite);
    f = await ficheAffichee(compte, contrat);
    expect(f.operations.map((o) => o.id)).toEqual([entretien]);
    expect(f.liens.find((l) => l.itemId === visite)).toMatchObject({ representedOperationIds: [], direct: true });
    expect(f.evenements).toEqual(['Visite annuelle']);
    expect(f.masques).toEqual([]);
    expect(f.bouton).toBe(true);

    // d) Document de DEUX opérations, chacune représentée par son événement, et un événement partagé simplement rattaché aux deux :
    //    les deux représentations sont masquées, l'événement partagé (aucun fait porté) reste.
    const attestation = await fichier(compte, maison.id, { titre: 'Attestation commune', type: 'MAINTENANCE_INVOICE', date: '2026-05-02' });
    const opA = await operation(compte, { type: 'INTERVENTION', label: 'Travaux A', realized: '2026-05-01', assetId: maison.id });
    const opB = await operation(compte, { type: 'CLAIM', label: 'Sinistre B', realized: '2026-04-20', assetId: maison.id });
    await lierDoc(compte, opA, attestation);
    await lierDoc(compte, opB, attestation);
    const evtA = await evenement(compte, 'Travaux A', '2026-05-01', maison.id);
    const evtB = await evenement(compte, 'Sinistre B', '2026-04-20', maison.id);
    await jalon(compte, opA, evtA);
    await jalon(compte, opB, evtB);
    const expertise = await evenement(compte, 'Expertise', '2026-05-03', maison.id);
    await lierEvt(compte, opA, expertise);
    await lierEvt(compte, opB, expertise);
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${expertise}, ${attestation}, ARRAY['MANUAL_DIRECT']::text[])
              ON CONFLICT (agenda_item_id, asset_file_id) DO NOTHING`;
    f = await ficheAffichee(compte, attestation);
    expect(f.operations.map((o) => o.id)).toEqual([opA, opB].sort((x, y) => x - y));
    expect(f.liens.find((l) => l.itemId === evtA)!.representedOperationIds).toEqual([opA]);
    expect(f.liens.find((l) => l.itemId === evtB)!.representedOperationIds).toEqual([opB]);
    expect(f.liens.find((l) => l.itemId === expertise)).toMatchObject({ representedOperationIds: [], outsideOperation: false });
    expect(f.evenements).toEqual(['Expertise']);
    expect([...f.masques].sort((x, y) => x - y)).toEqual([evtA, evtB].sort((x, y) => x - y));
  }, 180000);

  it('C830-E04 — opération non affichée (document retiré, opération supprimée) : elle n’est plus nommée ; son événement n’est plus un doublon', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await fichier(compte, maison.id, { titre: 'Devis de couverture', type: 'MAINTENANCE_INVOICE', date: '2026-04-03' });
    const toiture = await operation(compte, { type: 'INTERVENTION', label: 'Toiture', realized: '2026-04-02', assetId: maison.id });
    const tempete = await operation(compte, { type: 'CLAIM', label: 'Tempête', realized: '2026-03-20', assetId: maison.id });
    await lierDoc(compte, toiture, doc);
    await lierDoc(compte, tempete, doc);
    const chantier = await evenement(compte, 'Toiture', '2026-04-02', maison.id);
    await jalon(compte, toiture, chantier);
    const sinistre = await evenement(compte, 'Tempête', '2026-03-20', maison.id);
    await jalon(compte, tempete, sinistre);
    // Le document est AUSSI lié directement aux deux événements (lien saisi) : ces liens survivent au retrait de l'opération.
    for (const e of [chantier, sinistre]) {
      await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${e}, ${doc}, ARRAY['MANUAL_DIRECT']::text[])
                ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE SET provenances = (SELECT array_agg(DISTINCT p) FROM unnest(agenda_file_links.provenances || ARRAY['MANUAL_DIRECT']::text[]) p)`;
    }
    asUser(compte);
    let f = await ficheAffichee(compte, doc);
    expect(f.operations.map((o) => o.id)).toEqual([toiture, tempete].sort((x, y) => x - y));
    // Lien direct ET représentation de l'opération affichée : c'est la même chose montrée deux fois → masqué.
    expect(f.liens.find((l) => l.itemId === chantier)).toMatchObject({ direct: true, representedOperationIds: [toiture] });
    expect(f.evenements).toEqual([]);
    expect(f.bouton).toBe(false);

    // L'utilisateur RETIRE le document de l'opération « Toiture » (vraie route) : elle n'est plus affichée sur la fiche.
    const route = await import('@/app/api/evenements-reference/[id]/documents/route');
    const r = await route.DELETE(new NextRequest(`http://x/api/evenements-reference/${toiture}/documents?fileId=${doc}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(toiture) }) });
    expect(r.status).toBe(200);
    f = await ficheAffichee(compte, doc);
    expect(f.operations.map((o) => o.id)).toEqual([tempete]);
    // Jamais une opération non affichée dans la correspondance ; le lien direct au chantier subsiste → il redevient visible.
    for (const l of f.liens) expect(l.representedOperationIds ?? []).not.toContain(toiture);
    expect(f.liens.find((l) => l.itemId === chantier)).toMatchObject({ direct: true, representedOperationIds: [], outsideOperation: true });
    expect(f.evenements).toEqual(['Toiture']);
    expect(f.masques).toEqual([sinistre]);
    expect(f.bouton).toBe(true);

    // L'opération « Tempête » est SUPPRIMÉE (invalidée) : plus affichée, plus nommée ; son événement, s'il reste lié, redevient visible.
    expect(await (await facade()).invalidateOperation(user(compte), { operationId: tempete })).toMatchObject({ status: 'APPLIED' });
    f = await ficheAffichee(compte, doc);
    expect(f.operations).toEqual([]);
    for (const l of f.liens) expect(l.representedOperationIds).toEqual([]);
    expect(f.masques).toEqual([]);
    expect(f.evenements).toHaveLength(f.liens.length);
    expect(f.evenements).toContain('Toiture');
  }, 180000);

  it('C830-E05 — isolation des comptes : document d’un autre compte introuvable ; opération et événement d’un autre compte jamais nommés', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const ailleurs = await make.asset(autre, { category: 'IMMOBILIER', name: 'Appartement' });
    const doc = await fichier(compte, maison.id, { titre: 'Facture isolée', type: 'MAINTENANCE_INVOICE', date: '2026-06-01' });
    const op = await operation(compte, { type: 'INTERVENTION', label: 'Travaux', realized: '2026-06-01', assetId: maison.id, fileId: doc });
    const evt = await evenement(compte, 'Travaux', '2026-06-01', maison.id);
    await jalon(compte, op, evt);
    const docAutre = await fichier(autre, ailleurs.id, { titre: 'Facture de l’autre compte', type: 'MAINTENANCE_INVOICE', date: '2026-06-02' });
    const opAutre = await operation(autre, { type: 'INTERVENTION', label: 'Travaux de l’autre', realized: '2026-06-02', assetId: ailleurs.id, fileId: docAutre });
    const evtAutre = await evenement(autre, 'Travaux de l’autre', '2026-06-02', ailleurs.id);
    await jalon(autre, opAutre, evtAutre);

    asUser(autre);
    expect((await liens(doc)).status).toBe(404);
    expect((await operations(doc)).status).toBe(404);
    const chezLui = await liens(docAutre);
    expect(chezLui.links).toEqual([expect.objectContaining({ itemId: evtAutre, representedOperationIds: [opAutre] })]);
    expect(JSON.stringify(chezLui.links)).not.toContain(String(op));

    asUser(compte);
    expect((await liens(docAutre)).status).toBe(404);
    const chezMoi = await liens(doc);
    expect(chezMoi.links).toEqual([expect.objectContaining({ itemId: evt, representedOperationIds: [op] })]);
    expect(chezMoi.links.map((l) => l.itemId)).not.toContain(evtAutre);
  }, 120000);

  it('C830-E06 — requête de contrôle de la fiche de recette (lecture seule) : valide sur le schéma réel, même correspondance que la route', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await fichier(compte, maison.id, { titre: 'Facture de contrôle', type: 'MAINTENANCE_INVOICE', date: '2026-07-01' });
    const op = await operation(compte, { type: 'INTERVENTION', label: 'Contrôle', realized: '2026-07-01', assetId: maison.id, fileId: doc });
    const evt = await evenement(compte, 'Contrôle', '2026-07-01', maison.id);
    await jalon(compte, op, evt);
    const libre = await evenement(compte, 'Rappel libre', '2026-08-01', maison.id);
    asUser(compte);
    await associer(doc, libre);
    const avant = await empreinte(compte);
    const lignes = await sql.unsafe(REQUETE_CONTROLE, [compte.id, doc] as never[]) as unknown as Array<{ evenement: number; titre: string; operations_representees: string | null }>;
    const route = (await liens(doc)).links;
    expect(lignes.map((l) => [Number(l.evenement), (l.operations_representees ?? '').split(',').filter(Boolean).map(Number)]))
      .toEqual(route.map((l) => [l.itemId, l.representedOperationIds ?? []]));
    expect(lignes.find((l) => Number(l.evenement) === evt)!.operations_representees).toBe(String(op));
    expect(await empreinte(compte)).toBe(avant);
  }, 120000);
});
