/**
 * Carte Trello #806, volet B §7 — DOCUMENTS, TIROIRS ET SUPPRESSION (CDC
 * « Opérations / Agenda V2.0 » §14, §19 ; AC43, AC44, AC47, AC60) — sur
 * PostgreSQL 16 réel, par les chemins de PRODUCTION : vraies routes
 * (`/api/documents/:id/evenements-reference`, `/api/documents/:id/agenda-liens`,
 * `/api/evenements-reference/:id/documents`, `/api/evenements-reference/:id/fiche`,
 * `/api/files/:id`), lecture du tiroir de l'Agenda, façade d'écriture,
 * persistance T1 et consolidation T3 réelles, coût de possession. Seule la
 * session est simulée. Aucune IA. Dates fixes.
 *
 *   L116CB-D01  TIROIR DU DOCUMENT : TOUTES ses opérations (douze : plus de coupe à dix), jamais une opération
 *               supprimée ; les événements de l'Agenda liés DIRECTEMENT hors opération sont distingués de ceux de
 *               ses opérations ; opérations candidates au rattachement filtrées, sans celles qu'il a déjà ; document
 *               ou opération d'un autre compte : introuvable
 *   L116CB-D02  GESTES DU TIROIR par les vraies routes : RETIRER le document d'UNE opération laisse le fichier, son
 *               autre opération, son lien direct à l'événement et le refus mémorisé ; RATTACHER le remet ; compte en
 *               lecture seule : 403, rien n'est écrit ; autre compte : introuvable, rien n'est écrit
 *   L116CB-D03  FICHE : « appartient à cette opération », « justificatif partagé », « lié directement à un événement »,
 *               « document de l'opération associée » (contrat d'assurance vu du sinistre) — chaque document UNE fois ;
 *               un document RETIRÉ de l'opération n'y revient pas par son événement ; le document d'une autre opération
 *               d'un événement PARTAGÉ n'est pas exposé ; un document supprimé n'apparaît nulle part ; la lecture
 *               n'écrit rien et ne change aucun montant
 *   L116CB-D04  TIROIR DE L'AGENDA : chaque document de l'événement porte sa nature (lien direct, appartenance à
 *               l'opération, partagé) et l'opération ASSOCIÉE est nommée — sans dupliquer le document
 *   L116CB-D05  SUPPRIMER UNE OPÉRATION ne supprime aucun document, aucune pièce, aucun équipement, aucun événement ;
 *               la suppression s'annule
 *   L116CB-D06  SUPPRESSION D'UN DOCUMENT (vraie route) puis passage T3 : ses contributions (montant) et ses preuves
 *               sont retirées, l'opération est RECALCULÉE et garde ses autres preuves ; une opération qui n'avait que
 *               ce document est invalidée (jamais supprimée) ; le coût de possession ne compte plus la pièce ; avant
 *               la purge rien n'est détruit ; après la purge définitive : aucune référence orpheline
 *   L116CB-D07  AC60 — CONSTAT (aucun changement de comportement : le devenir des opérations d'un bien supprimé n'est
 *               PAS décidé) : à la suppression complète d'un bien, l'opération qui ne tenait qu'à lui est invalidée
 *               (jamais supprimée) ; l'opération multi-biens et l'opération déclarée par l'utilisateur SURVIVENT, la
 *               seconde sans aucun bien ; les événements de l'Agenda du bien survivent sans bien ; l'autre bien, ses
 *               pièces, ses dossiers d'export, la recherche et la liste restent justes ; aucun rappel n'est créé
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

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

scenario('L116CB-D', 'Opérations / Agenda #806 volet B §7 — documents, tiroirs et suppression (AC43, AC44, AC47, AC60)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; session.role = 'USER'; };

  async function operation(compte: AccountRow, type: string, over: { label?: string; realized?: string; assetId?: number } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: over.realized ? 'REALIZED' : 'ENVISAGED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l116cb-d-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, authority: 'STRUCTURED' as const }] } : {}),
      reasonCode: 'L116CB_D_E2E',
    })).id);
  }
  async function fichier(compte: AccountRow, assetId: number | null, titre: string, type = 'MAINTENANCE_INVOICE', date = '2025-04-03'): Promise<number> {
    const f = await make.assetFile(compte, { assetId, name: `${titre}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_date = ${date}, document_type_code = ${type}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  }
  const element = async (compte: AccountRow, title: string, date: string, assetIds: number[] = []): Promise<number> =>
    (await make.agendaItem(compte, { title, startDate: date, assetIds })).id;
  const lierDoc = async (compte: AccountRow, operationId: number, fileId: number) =>
    expect(await (await facade()).linkDocument(user(compte), { operationId, fileId })).toMatchObject({ status: 'APPLIED' });
  const lierEvt = async (compte: AccountRow, operationId: number, agendaItemId: number) =>
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId })).toMatchObject({ status: 'APPLIED' });
  /** Lien DIRECT Document ↔ événement, posé comme l'écran le pose (« Associer à l'agenda »), sans rien d'autre. */
  const lienDirect = (itemId: number, fileId: number) => sql`
    INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${itemId}, ${fileId}, ARRAY['MANUAL_DIRECT']::text[])
    ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE SET provenances = ARRAY['MANUAL_DIRECT']::text[]`;

  async function operationsDuDocument(fileId: number, query = ''): Promise<{ status: number; body: Json }> {
    const route = await import('@/app/api/documents/[id]/evenements-reference/route');
    const r = await route.GET(new NextRequest(`http://x/api/documents/${fileId}/evenements-reference${query}`), { params: Promise.resolve({ id: String(fileId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function liensAgendaDuDocument(fileId: number): Promise<Json[]> {
    const route = await import('@/app/api/documents/[id]/agenda-liens/route');
    const r = await route.GET(new NextRequest(`http://x/api/documents/${fileId}/agenda-liens`), { params: Promise.resolve({ id: String(fileId) }) });
    expect(r.status).toBe(200);
    return (await r.json()).links as Json[];
  }
  async function geste(methode: 'POST' | 'DELETE', operationId: number, fileId: number): Promise<{ status: number; body: Json }> {
    const route = await import('@/app/api/evenements-reference/[id]/documents/route');
    const ctx = { params: Promise.resolve({ id: String(operationId) }) };
    const r = methode === 'POST'
      ? await route.POST(new NextRequest(`http://x/api/evenements-reference/${operationId}/documents`, { method: 'POST', body: JSON.stringify({ fileId }), headers: { 'content-type': 'application/json' } }), ctx)
      : await route.DELETE(new NextRequest(`http://x/api/evenements-reference/${operationId}/documents?fileId=${fileId}`, { method: 'DELETE' }), ctx);
    return { status: r.status, body: await r.json() as Json };
  }
  async function fiche(operationId: number): Promise<Json | null> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${operationId}/fiche`), { params: Promise.resolve({ id: String(operationId) }) });
    return r.status === 200 ? (await r.json()).fiche as Json : null;
  }
  /** Ce qu'une LECTURE ou un geste refusé ne doit jamais toucher. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_documents t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_match_decisions t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_relations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_financial_components t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(l::text, '|' ORDER BY l.id)), '') FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM asset_files t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  // ══ Tiroir du document ════════════════════════════════════════════════════

  it('L116CB-D01 — tiroir du document : toutes ses opérations (douze), les événements liés directement hors opération distingués, candidates filtrées, isolation des comptes', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await fichier(compte, maison.id, 'Facture commune 806B');
    // DOUZE opérations portent le document (l'ancienne lecture en rendait dix au plus, sans le dire).
    const ops: number[] = [];
    for (let i = 0; i < 12; i++) {
      const op = await operation(compte, 'INTERVENTION', { label: `Lot de travaux ${String(i + 1).padStart(2, '0')}`, realized: '2025-04-02', assetId: maison.id });
      await lierDoc(compte, op, doc);
      ops.push(op);
    }
    // Une treizième, que l'utilisateur supprime : elle ne doit plus être listée.
    const supprimee = await operation(compte, 'INTERVENTION', { label: 'Créée à tort', assetId: maison.id });
    await lierDoc(compte, supprimee, doc);
    expect(await (await facade()).invalidateOperation(user(compte), { operationId: supprimee })).toMatchObject({ status: 'APPLIED' });
    // Deux opérations qui ne portent PAS le document : candidates au rattachement.
    const toiture = await operation(compte, 'INTERVENTION', { label: 'Réfection de la toiture', assetId: maison.id });
    const assurance = await operation(compte, 'CONTRACT', { label: 'Assurance habitation', assetId: maison.id });
    // Événements : un événement de la première opération (lié aussi directement), un événement AUTONOME lié directement.
    const visite = await element(compte, 'Visite de chantier 806B', '2025-04-01', [maison.id]);
    await lierEvt(compte, ops[0], visite);
    await lienDirect(visite, doc);
    const rappel = await element(compte, 'Rappel sans opération 806B', '2025-06-01', [maison.id]);
    await lienDirect(rappel, doc);
    asUser(compte);
    const avant = await empreinte(compte);

    const liste = await operationsDuDocument(doc);
    expect(liste.status).toBe(200);
    expect(liste.body.references.map((r: Json) => r.id)).toEqual(ops);
    expect(liste.body.references[0]).toMatchObject({ id: ops[0], label: 'Intervention — Lot de travaux 01', directAgendaItemIds: [visite] });
    expect(liste.body.references[1].directAgendaItemIds).toEqual([]);
    expect(JSON.stringify(liste.body)).not.toContain('Créée à tort');

    // Liens directs avec l'Agenda : celui de l'événement de l'opération n'est pas « hors opération » ; l'autonome l'est.
    const liens = await liensAgendaDuDocument(doc);
    expect(liens.find((l) => l.itemId === visite)).toMatchObject({ direct: true, outsideOperation: false });
    expect(liens.find((l) => l.itemId === rappel)).toMatchObject({ direct: true, outsideOperation: true });

    // Candidates : les opérations du compte qui ne portent pas le document ; filtre sur le titre ; jamais la supprimée.
    const toutes = await operationsDuDocument(doc, '?candidats=1&q=');
    expect(toutes.status).toBe(200);
    expect(toutes.body.candidates.map((c: Json) => c.id).sort((a: number, b: number) => a - b)).toEqual([toiture, assurance].sort((a, b) => a - b));
    expect(toutes.body.more).toBe(false);
    const filtre = await operationsDuDocument(doc, `?candidats=1&q=${encodeURIComponent('toiture')}`);
    expect(filtre.body.candidates.map((c: Json) => c.id)).toEqual([toiture]);
    expect((await operationsDuDocument(doc, `?candidats=1&q=${encodeURIComponent('introuvable-xyz')}`)).body.candidates).toEqual([]);

    // Aucune de ces lectures n'écrit quoi que ce soit.
    expect(await empreinte(compte)).toBe(avant);

    // Autre compte : le document n'existe pas pour lui (liste et candidates).
    asUser(autre);
    expect((await operationsDuDocument(doc)).status).toBe(404);
    expect((await operationsDuDocument(doc, '?candidats=1&q=')).status).toBe(404);
  }, 120000);

  it('L116CB-D02 — retirer le document d’une opération : le fichier, son autre opération, son lien direct et le refus restent ; rattacher le remet ; lecture seule et autre compte : rien n’est écrit', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await fichier(compte, maison.id, 'Devis de couverture 806B');
    const a = await operation(compte, 'INTERVENTION', { label: 'Toiture', realized: '2025-04-02', assetId: maison.id });
    const b = await operation(compte, 'CLAIM', { label: 'Tempête', realized: '2025-03-20', assetId: maison.id });
    await lierDoc(compte, a, doc);
    await lierDoc(compte, b, doc);
    const visite = await element(compte, 'Visite du couvreur 806B', '2025-04-01', [maison.id]);
    await lierEvt(compte, a, visite);
    await lienDirect(visite, doc);
    const lienAvant = await sql<Json[]>`SELECT provenances FROM agenda_file_links WHERE agenda_item_id = ${visite} AND asset_file_id = ${doc}`;

    // AUTRE COMPTE : l'opération est introuvable pour lui, rien n'est écrit.
    asUser(autre);
    const avantRefus = await empreinte(compte);
    expect((await geste('DELETE', a, doc)).status).toBe(404);
    expect((await geste('POST', a, doc)).status).toBe(404);
    expect(await empreinte(compte)).toBe(avantRefus);

    // RETIRER de A par la vraie route.
    asUser(compte);
    const retrait = await geste('DELETE', a, doc);
    expect(retrait.status, JSON.stringify(retrait.body)).toBe(200);
    expect(retrait.body).toMatchObject({ ok: true, changed: true });
    // Le fichier reste ; B le porte toujours ; le lien DIRECT à l'événement est inchangé ; l'événement reste dans A.
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${doc} AND deleted_at IS NULL`).toHaveLength(1);
    expect((await operationsDuDocument(doc)).body.references.map((r: Json) => r.id)).toEqual([b]);
    expect(await sql<Json[]>`SELECT provenances FROM agenda_file_links WHERE agenda_item_id = ${visite} AND asset_file_id = ${doc}`).toEqual(lienAvant);
    expect((await fiche(a))!.agendaItems.map((x: Json) => x.id)).toEqual([visite]);
    expect((await fiche(b))!.documents.map((x: Json) => x.fileId)).toEqual([doc]);
    // Refus MÉMORISÉ : T3 ne le rattachera plus de lui-même à A.
    expect(await sql<Json[]>`
      SELECT decision FROM business_operation_match_decisions
       WHERE account_id = ${compte.id} AND candidate_operation_id = ${a} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(doc)} AND active`).toEqual([{ decision: 'REJECTED' }]);
    // Le lien direct est désormais « hors opération » pour ce document (il n'appartient plus à A).
    expect((await liensAgendaDuDocument(doc)).find((l) => l.itemId === visite)).toMatchObject({ direct: true, outsideOperation: true });
    // Rejouer le retrait : rien ne change.
    expect((await geste('DELETE', a, doc)).body).toMatchObject({ ok: true, changed: false });

    // RATTACHER de nouveau (décision explicite : elle lève le refus).
    const rattache = await geste('POST', a, doc);
    expect(rattache.body).toMatchObject({ ok: true, changed: true });
    expect((await operationsDuDocument(doc)).body.references.map((r: Json) => r.id)).toEqual([a, b]);
    expect(await sql<Json[]>`
      SELECT decision FROM business_operation_match_decisions
       WHERE account_id = ${compte.id} AND candidate_operation_id = ${a} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(doc)} AND active`).toEqual([{ decision: 'CONFIRMED' }]);

    // COMPTE EN LECTURE SEULE (abonnement retiré) : 403, rien n'est écrit ; la lecture du tiroir reste permise.
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${compte.id}`;
    const avantLecture = await empreinte(compte);
    expect((await geste('DELETE', a, doc)).status).toBe(403);
    expect((await geste('POST', b, doc)).status).toBe(403);
    expect(await empreinte(compte)).toBe(avantLecture);
    expect((await operationsDuDocument(doc)).status).toBe(200);
  }, 120000);

  // ══ Fiche de l'opération ══════════════════════════════════════════════════

  it('L116CB-D03 — fiche : appartient / partagé / lié directement à un événement / document de l’opération associée, chaque document une fois ; exclusions respectées ; la lecture n’écrit rien', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', realized: '2025-04-02', assetId: maison.id });
    const reparation = await operation(compte, 'INTERVENTION', { label: 'Réparation du plafond', realized: '2025-05-10', assetId: maison.id });
    const assurance = await operation(compte, 'CONTRACT', { label: 'Assurance habitation', assetId: maison.id });
    // Justificatifs du sinistre : la déclaration (propre), la facture (PARTAGÉE avec la réparation).
    const declaration = await fichier(compte, maison.id, 'Déclaration 806B', 'CLAIM_DECLARATION', '2025-04-03');
    const facture = await fichier(compte, maison.id, 'Facture du plafond 806B', 'MAINTENANCE_INVOICE', '2025-05-12');
    await lierDoc(compte, sinistre, declaration);
    await lierDoc(compte, sinistre, facture);
    await lierDoc(compte, reparation, facture);
    // Événement du sinistre, avec : la déclaration liée aussi directement, une photo liée SEULEMENT à l'événement.
    const expertise = await element(compte, 'Passage de l’expert 806B', '2025-04-10', [maison.id]);
    await lierEvt(compte, sinistre, expertise);
    await lienDirect(expertise, declaration);
    const photo = await fichier(compte, maison.id, 'Photo du plafond 806B', 'PHOTO', '2025-04-10');
    await lienDirect(expertise, photo);
    // Un document RETIRÉ du sinistre par l'utilisateur, mais toujours lié directement à l'événement (AC44).
    const retire = await fichier(compte, maison.id, 'Courrier retiré 806B', 'OTHER_INSURANCE_CLAIMS', '2025-04-11');
    await lierDoc(compte, sinistre, retire);
    await lienDirect(expertise, retire);
    expect(await (await facade()).unlinkDocument(user(compte), { operationId: sinistre, fileId: retire })).toMatchObject({ status: 'APPLIED', changed: true });
    // Événement PARTAGÉ entre le sinistre et la réparation : le devis de la réparation y est lié directement.
    const chantier = await element(compte, 'Chantier du plafond 806B', '2025-05-10', [maison.id]);
    await lierEvt(compte, sinistre, chantier);
    await lierEvt(compte, reparation, chantier);
    const devis = await fichier(compte, maison.id, 'Devis du plafond 806B', 'QUOTE', '2025-04-20');
    await lierDoc(compte, reparation, devis);
    await lienDirect(chantier, devis);
    // Un document lié à l'événement puis SUPPRIMÉ (corbeille).
    const efface = await fichier(compte, maison.id, 'Brouillon supprimé 806B', 'PHOTO', '2025-04-10');
    await lienDirect(expertise, efface);
    await sql`UPDATE asset_files SET deleted_at = '2025-06-01T00:00:00Z' WHERE id = ${efface}`;
    // Le CONTRAT D'ASSURANCE : sa police et une attestation (référentiel), et une facture d'entretien qui n'en est pas une pièce.
    const police = await fichier(compte, null, 'Police d’assurance 806B', 'INSURANCE_POLICY', '2024-01-02');
    const attestation = await fichier(compte, null, 'Attestation 2025 806B', 'INSURANCE_CERTIFICATE', '2025-01-02');
    const horsContrat = await fichier(compte, null, 'Facture sans rapport 806B', 'MAINTENANCE_INVOICE', '2025-02-02');
    for (const f of [police, attestation, horsContrat]) await lierDoc(compte, assurance, f);
    const f = await facade();
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: assurance, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED' });
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED' });
    asUser(compte);
    const avant = await empreinte(compte);

    const vue = (await fiche(sinistre))!;
    // APPARTIENT à l'opération : la déclaration (liée aussi directement à l'expertise) et la facture (partagée).
    expect(vue.documents.map((d: Json) => d.fileId)).toEqual([declaration, facture]);
    expect(vue.documents[0]).toMatchObject({ fileId: declaration, directEvents: [{ id: expertise, title: 'Passage de l’expert 806B' }] });
    expect(vue.documents[0].sharedWith).toBeUndefined();
    expect(vue.documents[1]).toMatchObject({ fileId: facture, sharedWith: [{ operationId: reparation, label: 'Intervention — Réparation du plafond' }] });
    // LIÉ DIRECTEMENT à un événement, sans appartenir : la photo seulement — ni le document retiré (AC44), ni le devis
    // de l'autre opération de l'événement partagé (CDC §14), ni le document supprimé.
    expect(vue.eventDocuments).toEqual([{ fileId: photo, title: 'Photo du plafond 806B', date: '2025-04-10', agendaItems: [{ id: expertise, title: 'Passage de l’expert 806B' }] }]);
    // OPÉRATION ASSOCIÉE : les pièces qui établissent le contrat d'assurance, pas sa facture sans rapport ; rien de la réparation.
    expect(vue.relatedDocuments.map((d: Json) => [d.fileId, d.operationId, d.operationLabel])).toEqual([
      [police, assurance, 'Contrat — Assurance habitation'], [attestation, assurance, 'Contrat — Assurance habitation'],
    ]);
    // UNE fois chacun, toutes natures confondues.
    const tous = [...vue.documents.map((d: Json) => d.fileId), ...vue.eventDocuments.map((d: Json) => d.fileId), ...vue.relatedDocuments.map((d: Json) => d.fileId)];
    expect(new Set(tous).size).toBe(tous.length);
    for (const absent of [retire, devis, efface, horsContrat]) expect(tous).not.toContain(absent);
    // Le nombre de la synthèse reste celui des JUSTIFICATIFS de l'opération (rien n'est compté en plus).
    expect(vue.summary.documentCount).toBe(2);

    // Vu de la RÉPARATION : sa facture est partagée avec le sinistre, son devis est lié aussi à l'événement ; aucune pièce d'assurance.
    const vueReparation = (await fiche(reparation))!;
    expect(vueReparation.documents.find((d: Json) => d.fileId === facture).sharedWith).toEqual([{ operationId: sinistre, label: 'Sinistre — Dégât des eaux' }]);
    expect(vueReparation.documents.find((d: Json) => d.fileId === devis).directEvents).toEqual([{ id: chantier, title: 'Chantier du plafond 806B' }]);
    expect(vueReparation.eventDocuments).toEqual([]);
    expect(vueReparation.relatedDocuments).toEqual([]);
    // Vu du CONTRAT : il ne reçoit aucune pièce du sinistre par la relation (lecture à sens unique).
    const vueContrat = (await fiche(assurance))!;
    expect(vueContrat.documents.map((d: Json) => d.fileId).sort((x: number, y: number) => x - y)).toEqual([police, attestation, horsContrat].sort((x, y) => x - y));
    expect(vueContrat.eventDocuments).toEqual([]);
    expect(vueContrat.relatedDocuments).toEqual([]);

    // La lecture n'écrit rien : aucune appartenance créée, aucun montant, aucune décision.
    expect(await empreinte(compte)).toBe(avant);
    // Autre compte : la fiche est introuvable.
    asUser(autre);
    expect(await fiche(sinistre)).toBeNull();
  }, 120000);

  // ══ Tiroir de l'Agenda ════════════════════════════════════════════════════

  it('L116CB-D04 — tiroir de l’Agenda : nature de chaque document (direct, appartenance, partagé) et opération associée nommée, sans doublon', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', realized: '2025-04-02', assetId: maison.id });
    const reparation = await operation(compte, 'INTERVENTION', { label: 'Réparation du plafond', realized: '2025-05-10', assetId: maison.id });
    const assurance = await operation(compte, 'CONTRACT', { label: 'Assurance habitation', assetId: maison.id });
    const expertise = await element(compte, 'Passage de l’expert 806B', '2025-04-10', [maison.id]);
    await lierEvt(compte, sinistre, expertise);
    const rapport = await fichier(compte, maison.id, 'Rapport d’expertise 806B', 'CLAIM_DECLARATION');
    const photo = await fichier(compte, maison.id, 'Photo 806B', 'PHOTO');
    const facture = await fichier(compte, maison.id, 'Facture partagée 806B');
    await lierDoc(compte, sinistre, rapport);
    await lienDirect(expertise, rapport);
    await lienDirect(expertise, photo);
    await lierDoc(compte, sinistre, facture);
    await lierDoc(compte, reparation, facture);
    await lienDirect(expertise, facture);
    expect(await (await facade()).associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: assurance, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED' });

    const { getAgendaGroupingView } = await import('@/services/business-operations/grouping/read');
    const vue = (await getAgendaGroupingView(compte.id, expertise))!;
    const parId = new Map(vue.linkedDocuments.map((d) => [d.id, d]));
    // Chaque document UNE fois.
    expect(vue.linkedDocuments.map((d) => d.id).sort((a, b) => a - b)).toEqual([rapport, photo, facture].sort((a, b) => a - b));
    expect(parId.get(rapport)).toMatchObject({ link: 'DIRECT', member: true, shared: false });
    expect(parId.get(photo)).toMatchObject({ link: 'DIRECT', member: false, shared: false });
    expect(parId.get(facture)).toMatchObject({ link: 'DIRECT', member: true, shared: true });
    // L'opération de l'événement, et l'opération ASSOCIÉE nommée à part (jamais confondue avec la sienne).
    expect(vue.referenceEvents).toEqual([{ id: sinistre, label: expect.stringContaining('Sinistre'), associated: [{ id: assurance, label: 'Contrat — Assurance habitation' }] }]);
    // Un événement autonome : aucune opération, aucun « associé ».
    const seul = await element(compte, 'Autonome 806B', '2025-07-01', [maison.id]);
    await lienDirect(seul, photo);
    const vueSeul = (await getAgendaGroupingView(compte.id, seul))!;
    expect(vueSeul.referenceEvents).toEqual([]);
    expect(vueSeul.linkedDocuments).toEqual([expect.objectContaining({ id: photo, link: 'DIRECT', member: false, shared: false })]);
  }, 120000);

  // ══ Suppression d'une opération ═══════════════════════════════════════════

  it('L116CB-D05 — supprimer une opération ne supprime aucun document, aucune pièce, aucun équipement, aucun événement ; la suppression s’annule', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const [piece] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${maison.id}, 'Cuisine') RETURNING id`;
    const [equipement] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Chaudière') RETURNING id`;
    const op = await operation(compte, 'INTERVENTION', { label: 'Entretien de la chaudière', realized: '2025-04-02', assetId: maison.id });
    const doc = await fichier(compte, maison.id, 'Facture d’entretien 806B');
    await lierDoc(compte, op, doc);
    const visite = await element(compte, 'Passage du chauffagiste 806B', '2025-04-02', [maison.id]);
    await lierEvt(compte, op, visite);
    await lienDirect(visite, doc);
    await sql`INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority, active)
              VALUES (${compte.id}, ${op}, ${equipement.id}, ${maison.id}, 'USER', true)`;
    await sql`INSERT INTO business_operation_room_links (account_id, operation_id, substructure_id, authority, active)
              VALUES (${compte.id}, ${op}, ${piece.id}, 'USER', true)`;
    asUser(compte);
    // La fiche montre la pièce et l'équipement (identifiants cliquables).
    const vue = (await fiche(op))!;
    expect(vue.rooms).toEqual([{ id: piece.id, name: 'Cuisine', assetId: maison.id, assetName: 'Maison' }]);
    expect(vue.equipments.map((e: Json) => e.id)).toEqual([equipement.id]);
    expect(vue.typeLabel).toBe('Intervention');
    const objets = async () => (await sql<Json[]>`
      SELECT (SELECT count(*)::int FROM asset_files WHERE id = ${doc} AND deleted_at IS NULL) AS documents,
             (SELECT count(*)::int FROM substructures WHERE id = ${piece.id}) AS pieces,
             (SELECT count(*)::int FROM equipments WHERE id = ${equipement.id} AND archived_at IS NULL) AS equipements,
             (SELECT count(*)::int FROM agenda_items WHERE id = ${visite}) AS evenements,
             (SELECT to_char(start_date, 'YYYY-MM-DD') FROM agenda_items WHERE id = ${visite}) AS date_evenement,
             (SELECT count(*)::int FROM agenda_file_links WHERE agenda_item_id = ${visite} AND asset_file_id = ${doc}) AS lien_direct,
             (SELECT count(*)::int FROM assets WHERE id = ${maison.id} AND deleted_at IS NULL) AS biens`)[0];
    const avant = await objets();
    expect(avant).toEqual({ documents: 1, pieces: 1, equipements: 1, evenements: 1, date_evenement: '2025-04-02', lien_direct: 1, biens: 1 });

    const f = await facade();
    const suppression = await f.invalidateOperation(user(compte), { operationId: op });
    expect(suppression).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await fiche(op)).toBeNull();
    // RIEN d'autre n'a disparu : le document, la pièce, l'équipement, l'événement à sa date, son lien direct, le bien.
    expect(await objets()).toEqual(avant);
    // Le document n'a plus d'opération listée ; son lien à l'événement est direct, hors opération.
    expect((await operationsDuDocument(doc)).body.references).toEqual([]);
    expect((await liensAgendaDuDocument(doc))[0]).toMatchObject({ itemId: visite, direct: true, outsideOperation: true });

    // La suppression s'annule (restauration existante) : l'opération revient avec son justificatif.
    expect(await f.restoreOperation(user(compte), { operationId: op })).toMatchObject({ status: 'APPLIED', changed: true });
    expect((await fiche(op))!.documents.map((d: Json) => d.fileId)).toEqual([doc]);
    expect(await objets()).toEqual(avant);
  }, 120000);

  // ══ Suppression d'un document ═════════════════════════════════════════════

  it('L116CB-D06 — suppression d’un document : contributions et preuves retirées, opération recalculée ou invalidée, coût de possession à jour, purge sans référence orpheline', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    // UNE intervention fondée sur deux factures (acompte et solde, même référence d'ordre de travail) ; UNE autre fondée sur un seul document.
    const intervention = (o: { ref: string; montant: number; date: string; resume: string }) => [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'INVOICE', summary: o.resume, provider: 'Couverture Martin', targetHints: [cible(maison.id)],
      businessReferences: [ref('WORK_ORDER', 'OT-806B'), ref('INVOICE', o.ref)], temporalHints: { realizedDate: o.date },
      financialHints: [fh('REALIZED_COST', o.montant, { economicDate: o.date })],
    })];
    const f1 = await k.document(compte, maison.id, intervention({ ref: 'FA-806B-1', montant: 120_000, date: '2025-04-02', resume: 'Réfection de la toiture' }), { type: 'MAINTENANCE_INVOICE', title: 'Facture toiture 1 806B', amountCents: 120_000, date: '2025-04-02' });
    const f2 = await k.document(compte, maison.id, intervention({ ref: 'FA-806B-2', montant: 80_000, date: '2025-04-20', resume: 'Réfection de la toiture' }), { type: 'MAINTENANCE_INVOICE', title: 'Facture toiture 2 806B', amountCents: 80_000, date: '2025-04-20' });
    const seul = await k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'INVOICE', summary: 'Ramonage', provider: 'Ramoneur Durand', targetHints: [cible(maison.id)],
      businessReferences: [ref('INVOICE', 'RAM-806B')], temporalHints: { realizedDate: '2025-02-10' }, financialHints: [fh('REALIZED_COST', 9_000, { economicDate: '2025-02-10' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Facture ramonage 806B', amountCents: 9_000, date: '2025-02-10' });
    await k.passer(compte);
    const actives = await k.actives(compte);
    expect(actives).toHaveLength(2);
    const [toiture] = await sql<{ id: number }[]>`
      SELECT operation_id::int AS id FROM business_operation_documents WHERE account_id = ${compte.id} AND file_id = ${f1} AND active`;
    const [ramonage] = await sql<{ id: number }[]>`
      SELECT operation_id::int AS id FROM business_operation_documents WHERE account_id = ${compte.id} AND file_id = ${seul} AND active`;
    expect(toiture.id).not.toBe(ramonage.id);
    expect(await k.coutNet(toiture.id)).toBe(200_000);
    expect(await k.coutNet(ramonage.id)).toBe(9_000);
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const total = async () => (await readAssetTco(compte.id, maison.id, { today: '2026-10-12' })).summary.cumulativeCostCents;
    const totalAvant = await total();

    // SUPPRESSION par la vraie route de la seconde facture de la toiture, puis du seul document du ramonage.
    asUser(compte);
    const { DELETE } = await import('@/app/api/files/[id]/route');
    for (const id of [f2, seul]) {
      const rep = await DELETE(new NextRequest(`http://x/api/files/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(id) }) });
      expect(rep.status).toBe(200);
    }
    // Passage T3 demandé par la suppression (rejoué ici de façon déterministe).
    await k.passer(compte);

    // CONTRIBUTIONS : le montant de la facture supprimée n'est plus compté ; l'opération GARDE sa première facture.
    expect(await k.coutNet(toiture.id)).toBe(120_000);
    const sourcesToiture = await k.sources(toiture.id);
    expect(sourcesToiture.filter((s) => s.source_kind === 'DOCUMENT' && s.active).map((s) => s.source_entity_key)).toEqual([String(f1)]);
    expect(sourcesToiture.find((s) => s.source_entity_key === String(f2))).toMatchObject({ active: false });
    const [etatToiture] = await sql<Json[]>`SELECT invalidated_at IS NULL AS vivante FROM business_operations WHERE id = ${toiture.id}`;
    expect(etatToiture.vivante).toBe(true);
    expect((await fiche(toiture.id))!.documents.map((d: Json) => d.fileId)).toEqual([f1]);
    // L'opération qui n'avait QUE ce document : invalidée (signalée), jamais supprimée ; plus aucune contribution active.
    const [etatRamonage] = await sql<Json[]>`SELECT invalidated_at IS NOT NULL AS invalidee FROM business_operations WHERE id = ${ramonage.id}`;
    expect(etatRamonage.invalidee).toBe(true);
    expect(await k.composantes(ramonage.id)).toEqual([]);
    expect(await fiche(ramonage.id)).toBeNull();
    // COÛT DE POSSESSION : ni la facture supprimée ni le ramonage ne sont plus comptés (aucun repli documentaire sur un fichier supprimé).
    const totalApres = await total();
    expect((totalAvant ?? 0) - (totalApres ?? 0)).toBe(89_000);

    // AVANT LA PURGE : rien n'est détruit — le fichier est en corbeille, sa ligne d'appartenance existe toujours.
    expect(await sql<Json[]>`SELECT deleted_at IS NOT NULL AS corbeille FROM asset_files WHERE id = ${f2}`).toEqual([{ corbeille: true }]);
    // PURGE DÉFINITIVE (effet final de la tâche planifiée : la ligne du fichier part) : aucune référence orpheline.
    await sql`DELETE FROM asset_files WHERE id IN (${f2}, ${seul})`;
    expect(await sql`SELECT 1 FROM business_operation_documents d WHERE d.account_id = ${compte.id} AND NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.id = d.file_id)`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM agenda_file_links l WHERE NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.id = l.asset_file_id)`).toHaveLength(0);
    const { auditOperationGraph } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    expect(await auditOperationGraph(postgresRunner(sql as never), compte.id)).toEqual([]);
    // L'opération de la toiture est toujours consultable, inchangée par la purge.
    expect((await fiche(toiture.id))!.documents.map((d: Json) => d.fileId)).toEqual([f1]);
    expect(await k.coutNet(toiture.id)).toBe(120_000);
  }, 180000);
  // ══ AC60 : suppression d'un bien — constat, aucune décision ══════════════

  it('L116CB-D07 — AC60, constat : suppression complète d’un bien — ce qui est invalidé, ce qui survit sans bien, ce qui reste juste pour l’autre bien (aucun comportement modifié)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Clio 806B' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison 806B' });
    const depuisDocument = async (type: string, label: string, fileId: number, assetIds: number[]): Promise<number> => {
      const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
      return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
        type: { code: type } as never, status: 'REALIZED', technicalLabel: label,
        source: { kind: 'DOCUMENT', entityKey: fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { e2e: 'l116cb-d07' } },
        assets: assetIds.map((assetId) => ({ assetId, authority: 'DOCUMENT' as const })),
        reasonCode: 'L116CB_D_E2E',
      })).id);
    };
    // (1) Opération qui ne tient qu'à la voiture (fondée sur une facture de la voiture).
    const factureVoiture = await fichier(compte, voiture.id, 'Facture révision Clio 806B');
    const revision = await depuisDocument('INTERVENTION', 'Révision de la Clio', factureVoiture, [voiture.id]);
    await lierDoc(compte, revision, factureVoiture);
    // (2) Opération MULTI-BIENS (voiture et maison), fondée sur une pièce de la maison.
    const contratCommun = await fichier(compte, maison.id, 'Contrat multirisque 806B', 'INSURANCE_POLICY');
    const multirisque = await depuisDocument('CONTRACT', 'Assurance multirisque', contratCommun, [voiture.id, maison.id]);
    await lierDoc(compte, multirisque, contratCommun);
    // (3) Opération DÉCLARÉE par l'utilisateur pour la voiture seule (aucun justificatif).
    const declaree = await (await facade()).createOperation({ accountId: compte.id, actor: { kind: 'USER', userId: compte.ownerUserId, channel: 'ASSISTANT' } },
      { declaration: 'Faire repeindre la Clio 806B', type: { code: 'INTERVENTION' }, status: 'ENVISAGED', assetIds: [voiture.id] });
    expect(declaree).toMatchObject({ status: 'APPLIED' });
    const peinture = declaree.data!.operationId;
    // Événements : un de la voiture seule (dans l'opération multi-biens), un commun aux deux biens, un de la maison.
    const controle = await element(compte, 'Contrôle technique 806B', '2026-03-01', [voiture.id]);
    const echeance = await element(compte, 'Échéance multirisque 806B', '2026-12-31', [voiture.id, maison.id]);
    const ramonage = await element(compte, 'Ramonage 806B', '2026-10-01', [maison.id]);
    await lierEvt(compte, revision, controle);
    await lierEvt(compte, multirisque, echeance);
    asUser(compte);
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const dossierMaison = async () => {
      const src = await loadExportSource({ assetId: maison.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'DOSSIER_COMPLET' });
      return { documents: src.documents.map((d) => d.id).sort((a, b) => a - b), events: src.events.map((e) => e.key).sort() };
    };
    const maisonAvant = await dossierMaison();
    const rappelsAvant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`)[0].n;
    const autreAvant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${autre.id}`)[0].n;

    const { deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    await deleteAssetCompletely({ id: voiture.id, thumbnailUrl: null });

    // (1) INVALIDÉE, jamais supprimée : la ligne existe, avec son motif ; sa fiche n'est plus consultable.
    const [etatRevision] = await sql<Json[]>`SELECT invalidated_at IS NOT NULL AS invalidee, invalidation_reason AS motif FROM business_operations WHERE id = ${revision}`;
    expect(etatRevision.invalidee).toBe(true);
    expect(String(etatRevision.motif)).toContain('ASSET_DELETED');
    expect(await fiche(revision)).toBeNull();
    // (2) MULTI-BIENS : elle survit, liée à la maison seule, avec sa pièce et son événement commun.
    const vueMulti = (await fiche(multirisque))!;
    expect(vueMulti.assets.map((a: Json) => a.id)).toEqual([maison.id]);
    expect(vueMulti.documents.map((d: Json) => d.fileId)).toEqual([contratCommun]);
    expect(vueMulti.agendaItems.map((a: Json) => a.id)).toEqual([echeance]);
    // (3) DÉCLARÉE : elle survit SANS AUCUN BIEN (sa déclaration la fonde) — c'est le cas à trancher.
    const vuePeinture = (await fiche(peinture))!;
    expect(vuePeinture.assets).toEqual([]);
    expect(vuePeinture.declarations.map((d: Json) => d.text)).toEqual(['Faire repeindre la Clio 806B']);
    // ÉVÉNEMENTS : aucun n'est supprimé ; celui de la voiture seule reste dans l'Agenda SANS BIEN ; le commun garde la maison.
    const liensBiens = async (itemId: number) => (await sql<{ asset_id: number }[]>`SELECT asset_id FROM agenda_asset_links WHERE agenda_item_id = ${itemId} ORDER BY asset_id`).map((l) => l.asset_id);
    expect(await sql`SELECT 1 FROM agenda_items WHERE id IN (${controle}, ${echeance}, ${ramonage})`).toHaveLength(3);
    expect(await liensBiens(controle)).toEqual([]);
    expect(await liensBiens(echeance)).toEqual([maison.id]);
    expect(await sql<Json[]>`SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM agenda_items WHERE id = ${controle}`).toEqual([{ d: '2026-03-01' }]);
    // Les pièces de la voiture sont parties avec elle ; celles de la maison sont intactes.
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${factureVoiture} AND deleted_at IS NULL`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${contratCommun} AND deleted_at IS NULL`).toHaveLength(1);
    // GARANTIES : le dossier d'export de la maison est identique ; la liste montre les deux opérations vivantes et
    // pas l'invalidée ; aucun rappel créé ; aucune référence orpheline ; aucune anomalie de graphe ; autre compte intact.
    expect(await dossierMaison()).toEqual(maisonAvant);
    const route = await import('@/app/api/evenements-reference/route');
    const liste = await (await route.GET(new NextRequest('http://x/api/evenements-reference'))).json() as Json;
    expect(liste.items.map((i: Json) => i.id).sort((a: number, b: number) => a - b)).toEqual([multirisque, peinture].sort((a, b) => a - b));
    expect(liste.items.find((i: Json) => i.id === peinture).assets).toEqual([]);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`)[0].n).toBe(rappelsAvant);
    expect(await sql`SELECT 1 FROM business_operation_asset_links l WHERE l.account_id = ${compte.id} AND l.active AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = l.asset_id)`).toHaveLength(0);
    const { auditOperationGraph } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    expect(await auditOperationGraph(postgresRunner(sql as never), compte.id)).toEqual([]);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${autre.id}`)[0].n).toBe(autreAvant);
  }, 180000);
});
