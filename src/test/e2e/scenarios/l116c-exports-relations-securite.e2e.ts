/**
 * Carte Trello #806 §13 — EXPORTS, DUO, SÉCURITÉ (AC69) : la frontière est le
 * COMPTE ACTIF ; une relation entre opérations n'élargit JAMAIS un export ni un
 * accès. Sur PostgreSQL 16 réel, par les chemins de PRODUCTION : source des
 * dossiers (`loadExportSource`), lectures du graphe et de la fiche, façade
 * d'écriture, garde d'accès au compte des sessions
 * (`assertSessionAccountAccess`). Aucune IA.
 *
 *   L116C-X01  ASSURANCE / SINISTRE associés, FINANCEMENT relié, opération d'un AUTRE bien associée : les dossiers
 *              Vente, Assurance-souscription, Dossier complet et Assurance-sinistre du bien sont IDENTIQUES avant et
 *              après les relations ; aucun justificatif ni événement porté par l'opération reliée n'y entre
 *   L116C-X02  DOCUMENT PARTAGÉ entre deux opérations de deux biens : il figure une fois dans le dossier du bien
 *              auquel il est rattaché, jamais dans celui de l'autre bien
 *   L116C-X03  COMPTES DISTINCTS : même en nommant l'identifiant d'un autre compte, aucune source de dossier, aucune
 *              fiche, aucune relation, aucun événement n'est rendu ; associer deux opérations de deux comptes est refusé
 *              sans écriture
 *   L116C-X04  PREMIUM DUO : les deux membres actifs obtiennent le MÊME dossier ; le membre RÉVOQUÉ est refusé par la
 *              garde d'accès des sessions (lecture et export compris) et par la façade (écriture), sans que rien ne
 *              change ; il garde l'accès à son propre compte
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import type { DossierCode } from '@/services/exports/catalog';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const facade = () => import('@/services/business-operations/operation-write.facade');
const DOSSIERS: DossierCode[] = ['VENTE', 'ASSURANCE_SOUSCRIPTION', 'DOSSIER_COMPLET'];

scenario('L116C-X', 'Opérations / Agenda #806 §13 — exports, Duo, sécurité : une relation entre opérations n’élargit ni un export ni un accès (AC69)', ({ sql, make }) => {
  const user = (c: AccountRow, userId = c.ownerUserId): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId, channel: 'UI' } });

  async function operation(compte: AccountRow, type: string, over: { label?: string; realized?: string; assetId?: number } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: over.realized ? 'REALIZED' : 'ENVISAGED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l116c-x-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, authority: 'STRUCTURED' as const }] } : {}),
      reasonCode: 'L116C_X_E2E',
    })).id);
  }
  async function justificatif(compte: AccountRow, assetId: number | null, titre: string, type = 'MAINTENANCE_INVOICE'): Promise<number> {
    const f = await make.assetFile(compte, { assetId, name: `${titre}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_date = '2025-04-03', document_type_code = ${type}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  }
  async function element(compte: AccountRow, title: string, date: string, assetIds: number[]): Promise<number> {
    const i = await make.agendaItem(compte, { title, startDate: date, assetIds });
    await sql`UPDATE agenda_items SET event_nature = 'HISTORICAL', business_type = 'MAINTENANCE' WHERE id = ${i.id}`;
    return i.id;
  }
  const lierDoc = async (compte: AccountRow, operationId: number, fileId: number) =>
    expect(await (await facade()).linkDocument(user(compte), { operationId, fileId })).toMatchObject({ status: 'APPLIED' });
  const lierEvt = async (compte: AccountRow, operationId: number, agendaItemId: number) =>
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId })).toMatchObject({ status: 'APPLIED' });
  const source = async (compte: AccountRow, assetId: number, exportType: DossierCode, over: { userId?: number; claimOperationId?: number } = {}) => {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    return loadExportSource({ assetId, accountId: compte.id, userId: over.userId ?? compte.ownerUserId, exportType, ...(over.claimOperationId ? { claimOperationId: over.claimOperationId } : {}) });
  };
  /** Ce qu'un dossier contient : justificatifs, événements, et — pour le sinistre — son dossier propre. Sans l'horodatage de trace. */
  const contenu = (src: Awaited<ReturnType<typeof source>>): Json => ({
    documents: src.documents.map((d) => d.id).sort((a, b) => a - b),
    events: src.events.map((e) => e.key).sort(),
    claimDocuments: [...(src.claimFile?.documentIds ?? [])].sort((a, b) => a - b),
    claimAgenda: [...(src.claimFile?.agendaKeys ?? [])].sort(),
  });
  const texteDe = (src: unknown) => JSON.stringify(src);

  it('L116C-X01 — assurance / sinistre associés, financement relié, opération d’un autre bien associée : chaque dossier du bien est identique avant et après les relations', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison des Lilas' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio du port' });
    // Opérations de la MAISON.
    const sinistre = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', realized: '2025-04-02', assetId: maison.id });
    const achat = await operation(compte, 'ACQUISITION', { label: 'Achat de la maison', realized: '2020-06-01', assetId: maison.id });
    await lierDoc(compte, sinistre, await justificatif(compte, maison.id, 'Declaration du degat des eaux 806X', 'CLAIM_DECLARATION'));
    await lierEvt(compte, sinistre, await element(compte, 'Passage de l expert 806X', '2025-04-10', [maison.id]));
    // L'ASSURANCE : son contrat et son échéance ne sont PAS rattachés au bien (seule l'opération les porte).
    const assurance = await operation(compte, 'CONTRACT', { label: 'Assurance habitation', assetId: maison.id });
    await lierDoc(compte, assurance, await justificatif(compte, null, 'Police d assurance confidentielle 806X', 'INSURANCE_POLICY'));
    await lierEvt(compte, assurance, await element(compte, 'Echeance de l assurance 806X', '2025-12-31', []));
    // Le FINANCEMENT : son offre de prêt et son échéance ne sont pas rattachées au bien non plus.
    const pret = await operation(compte, 'FINANCING', { label: 'Prêt immobilier', assetId: maison.id });
    await lierDoc(compte, pret, await justificatif(compte, null, 'Offre de pret confidentielle 806X', 'OTHER_INSURANCE_CLAIMS'));
    await lierEvt(compte, pret, await element(compte, 'Echeance du pret 806X', '2025-05-05', []));
    // Une opération d'un AUTRE bien du compte, avec ses pièces rattachées à CET autre bien.
    const travauxStudio = await operation(compte, 'INTERVENTION', { label: 'Travaux du studio', realized: '2025-03-01', assetId: studio.id });
    await lierDoc(compte, travauxStudio, await justificatif(compte, studio.id, 'Facture des travaux du studio 806X'));
    await lierEvt(compte, travauxStudio, await element(compte, 'Chantier du studio 806X', '2025-03-01', [studio.id]));

    const releve = async () => {
      const out: Json = {};
      for (const code of DOSSIERS) out[code] = contenu(await source(compte, maison.id, code));
      out.ASSURANCE_SINISTRE = contenu(await source(compte, maison.id, 'ASSURANCE_SINISTRE', { claimOperationId: sinistre }));
      return out;
    };
    const avant = await releve();
    // Le dossier du bien contient bien ses propres pièces (la comparaison n'est pas vide de sens).
    expect(avant.DOSSIER_COMPLET.documents.length).toBeGreaterThan(0);
    expect(avant.ASSURANCE_SINISTRE.claimDocuments.length).toBeGreaterThan(0);

    // LES RELATIONS : sinistre ↔ assurance, financement → achat, sinistre ↔ travaux d'un autre bien.
    const f = await facade();
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: assurance, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: achat, nature: 'FINANCING' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: travauxStudio, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await f.associateOperations(user(compte), { fromOperationId: achat, toOperationId: travauxStudio, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED', changed: true });

    expect(await releve()).toEqual(avant);
    // Aucune pièce portée par une opération RELIÉE n'entre dans un dossier de la maison.
    for (const code of [...DOSSIERS, 'ASSURANCE_SINISTRE' as const]) {
      const src = await source(compte, maison.id, code, code === 'ASSURANCE_SINISTRE' ? { claimOperationId: sinistre } : {});
      const t = texteDe(src);
      for (const interdit of ['Police d assurance confidentielle 806X', 'Echeance de l assurance 806X', 'Offre de pret confidentielle 806X', 'Echeance du pret 806X', 'Facture des travaux du studio 806X', 'Chantier du studio 806X']) {
        expect(t.includes(interdit), `${code} : « ${interdit} » ne doit pas entrer par une relation`).toBe(false);
      }
    }
    // Et le dossier du studio ne reçoit rien de la maison par la relation inverse.
    const studioComplet = texteDe(await source(compte, studio.id, 'DOSSIER_COMPLET'));
    for (const interdit of ['Declaration du degat des eaux 806X', 'Passage de l expert 806X', 'Police d assurance confidentielle 806X']) expect(studioComplet.includes(interdit), interdit).toBe(false);
    expect(studioComplet.includes('Facture des travaux du studio 806X')).toBe(true);
  }, 120000);

  it('L116C-X02 — document partagé entre deux opérations de deux biens : une fois dans le dossier de SON bien, jamais dans celui de l’autre', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const a = await operation(compte, 'INTERVENTION', { label: 'Travaux de la maison', realized: '2025-04-02', assetId: maison.id });
    const b = await operation(compte, 'INTERVENTION', { label: 'Travaux du studio', realized: '2025-04-02', assetId: studio.id });
    const partage = await justificatif(compte, maison.id, 'Facture commune 806X');
    await lierDoc(compte, a, partage);
    await lierDoc(compte, b, partage);
    expect(await (await facade()).associateOperations(user(compte), { fromOperationId: a, toOperationId: b, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED' });
    for (const code of DOSSIERS) {
      const m = await source(compte, maison.id, code);
      expect(m.documents.filter((d) => d.id === partage), `${code} maison`).toHaveLength(1);
      const s = await source(compte, studio.id, code);
      expect(s.documents.filter((d) => d.id === partage), `${code} studio`).toHaveLength(0);
      expect(texteDe(s).includes('Facture commune 806X'), `${code} studio`).toBe(false);
    }
  }, 120000);

  it('L116C-X03 — comptes distincts : aucun dossier, aucune fiche, aucune relation, aucun événement d’un autre compte ; associer deux opérations de deux comptes est refusé sans écriture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const maisonAutre = await make.asset(autre, { category: 'IMMOBILIER', name: 'Maison' });
    const mienne = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', realized: '2025-04-02', assetId: maison.id });
    const etrangere = await operation(autre, 'CONTRACT', { label: 'Assurance confidentielle 806X', assetId: maisonAutre.id });
    await lierDoc(autre, etrangere, await justificatif(autre, maisonAutre.id, 'Police confidentielle 806X', 'INSURANCE_POLICY'));
    await lierEvt(autre, etrangere, await element(autre, 'Echeance confidentielle 806X', '2025-12-31', [maisonAutre.id]));

    // Associer à travers les comptes : refusé par la façade (dans les deux sens, par les deux comptes), rien n'est écrit.
    const f = await facade();
    for (const [c, from, to] of [[compte, mienne, etrangere], [compte, etrangere, mienne], [autre, mienne, etrangere]] as const) {
      expect(await f.associateOperations(user(c), { fromOperationId: from, toOperationId: to, nature: 'ASSOCIATED' })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT', changed: false });
    }
    expect(await f.linkDocument(user(compte), { operationId: etrangere, fileId: 1 })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
    expect(await sql`SELECT 1 FROM business_operation_relations WHERE account_id IN (${compte.id}, ${autre.id})`).toHaveLength(0);

    // Dossier d'un bien d'un autre compte : introuvable, pour tous les dossiers.
    for (const code of [...DOSSIERS, 'ASSURANCE_SINISTRE' as const]) {
      await expect(source(compte, maisonAutre.id, code, code === 'ASSURANCE_SINISTRE' ? { claimOperationId: etrangere } : {})).rejects.toThrow(/introuvable/i);
    }
    // Sinistre de MON bien demandé avec l'identifiant d'une opération d'un autre compte : rien de cet autre compte.
    const croise = await source(compte, maison.id, 'ASSURANCE_SINISTRE', { claimOperationId: etrangere }).then((s) => texteDe(s), (e) => String((e as Error).message));
    expect(croise).not.toMatch(/confidentielle 806X/);
    // Lectures du graphe et de la fiche : l'opération d'un autre compte n'existe pas.
    const { readOperationGraph } = await import('@/services/business-operations/graph/read');
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    expect(await readOperationGraph(compte.id, etrangere)).toBeNull();
    expect(await readReferenceEventPage(compte.id, etrangere)).toBeNull();
    expect(texteDe(await readReferenceEventPage(compte.id, mienne))).not.toMatch(/confidentielle 806X/);
    const { auditOperationGraph } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    expect([await auditOperationGraph(postgresRunner(sql as never), compte.id), await auditOperationGraph(postgresRunner(sql as never), autre.id)]).toEqual([[], []]);
  }, 120000);

  it('L116C-X04 — Premium Duo : les deux membres actifs obtiennent le même dossier ; le membre révoqué n’a plus aucun accès à ce compte (lecture, export, écriture), mais garde le sien', async () => {
    const compte = await make.account({ plan: 'premium_duo' });
    const conjoint = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${compte.id}, ${conjoint.id}, 'member', 'active')`;
    const compteDuConjoint = await make.account({ plan: 'premium' });
    await sql`UPDATE account_memberships SET user_id = ${conjoint.id} WHERE account_id = ${compteDuConjoint.id}`;
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', realized: '2025-04-02', assetId: maison.id });
    const assurance = await operation(compte, 'CONTRACT', { label: 'Assurance habitation', assetId: maison.id });
    await lierDoc(compte, sinistre, await justificatif(compte, maison.id, 'Declaration 806X', 'CLAIM_DECLARATION'));
    const f = await facade();
    // Le second membre écrit de plein droit : il associe le sinistre et l'assurance.
    expect(await f.associateOperations(user(compte, conjoint.id), { fromOperationId: sinistre, toOperationId: assurance, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED', changed: true });

    const { assertSessionAccountAccess } = await import('@/lib/auth/account-access');
    // Les DEUX membres actifs passent la garde des sessions et obtiennent le même dossier, quel que soit le demandeur.
    for (const u of [compte.ownerUserId, conjoint.id]) await expect(assertSessionAccountAccess({ userId: u, currentAccountId: compte.id })).resolves.toBeUndefined();
    for (const code of DOSSIERS) {
      expect(contenu(await source(compte, maison.id, code, { userId: conjoint.id })), code).toEqual(contenu(await source(compte, maison.id, code)));
    }

    // RÉVOCATION du second membre.
    await sql`UPDATE account_memberships SET status = 'removed', removed_at = now() WHERE account_id = ${compte.id} AND user_id = ${conjoint.id}`;
    // 1. Toute requête portant ce compte est refusée par la garde des sessions (elle précède toute route : fiche, Agenda, exports).
    await expect(assertSessionAccountAccess({ userId: conjoint.id, currentAccountId: compte.id })).rejects.toThrow();
    // 2. Toute écriture est refusée par la façade, rien ne change.
    const relations = () => sql<Json[]>`SELECT id::int AS id, state, version FROM business_operation_relations WHERE account_id = ${compte.id} ORDER BY id`;
    const avant = await relations();
    expect(await f.dissociateOperations(user(compte, conjoint.id), { operationAId: sinistre, operationBId: assurance })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_A_MEMBER', changed: false });
    expect(await f.correctOperation(user(compte, conjoint.id), { operationId: sinistre, label: 'Tentative interdite' })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_A_MEMBER' });
    expect(await relations()).toEqual(avant);
    // 3. Le propriétaire garde son accès ; le membre révoqué garde l'accès à SON propre compte.
    await expect(assertSessionAccountAccess({ userId: compte.ownerUserId, currentAccountId: compte.id })).resolves.toBeUndefined();
    await expect(assertSessionAccountAccess({ userId: conjoint.id, currentAccountId: compteDuConjoint.id })).resolves.toBeUndefined();
    // 4. Aucune relation entre opérations ne lui rend un accès : la relation existe toujours, la garde refuse toujours.
    expect((await relations()).map((r) => r.state)).toEqual(['ACTIVE']);
    await expect(assertSessionAccountAccess({ userId: conjoint.id, currentAccountId: compte.id })).rejects.toThrow();
  }, 120000);
});
