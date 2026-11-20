/**
 * Carte Trello #806, volet B §11 (partie T3) — « ÉCHÉANCE » GÉNÉRIQUE ≠
 * FINANCEMENT, et REQUALIFICATION après une correction ou une scission (CDC
 * « Opérations / Agenda V2.0 » §9, §18 ; AC46, AC51, AC52, AC68) — sur
 * PostgreSQL 16 réel, par les chemins de PRODUCTION : persistance T1 des
 * candidats, consolidation T3, façade d'écriture (corriger, scinder), vraies
 * routes de l'Agenda, de la Timeline du bien et de la fiche, service du coût de
 * possession, source des dossiers d'export. Seule la session est simulée.
 * AUCUNE IA (rapprochement sémantique coupé). Dates fixes.
 *
 *   L116CB-T01  Une « échéance » que T1 a proposée comme FINANCEMENT sans preuve d'un prêt (avis d'échéance
 *               d'assurance, facture à échéance) ne devient PAS un financement : type non qualifié (jamais « Autre »),
 *               aucune ligne ni aucun poste « Financement » au coût de possession, aucune échéance présumée honorée ;
 *               trois preuves des référentiels existants suffisent chacune : Type du document, référence de prêt,
 *               capital emprunté ; un passage T3 rejoué ne change rien
 *   L116CB-T02  Après une CORRECTION (date, puis type) faite par l'utilisateur : la Timeline du bien, la fiche et la
 *               recherche suivent ; l'événement de l'Agenda qui porte le même fait suit, le devis garde sa date ; le
 *               coût de possession garde le même total et les mêmes lignes (changement de poste seulement) ; les
 *               dossiers d'export restent identiques ; T3 rejoué ne réécrit pas la correction ; aucun événement,
 *               aucun rappel, aucune carte créés
 *   L116CB-T03  Après une SCISSION (un sinistre dont l'assurance avait été réunie à tort) puis T3 rejoué trois fois :
 *               deux opérations distinctes, le sinistre N'EST PAS absorbé par l'assurance (ni l'inverse) ; aucun
 *               montant compté deux fois (total du coût de possession identique, chaque montant une seule ligne
 *               retenue) ; aucune date inventée (l'opération créée reste « Sans date » tant qu'aucun fait ne la date) ;
 *               Agenda inchangé (mêmes événements, mêmes dates, aucun rappel) ; Timeline : deux groupes ; dossier
 *               « Assurance — sinistre » : la pièce déplacée n'y est plus, les autres dossiers sont inchangés
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import type { DossierCode } from '@/services/exports/catalog';

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
const AUJ = '2026-10-12';
const DOSSIERS: DossierCode[] = ['VENTE', 'ASSURANCE_SOUSCRIPTION', 'DOSSIER_COMPLET'];
const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L116CB-T', 'Opérations / Agenda #806 volet B §11 (T3) — échéance générique ≠ financement ; requalification après correction ou scission', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const G = (op: number) => `op-${op}`;

  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  type Tco = Awaited<ReturnType<typeof tco>>;
  const postes = (t: Tco) => Object.fromEntries(t.breakdown.filter((b) => b.costsCents !== 0 || b.count !== 0).map((b) => [b.category, b.costsCents]));
  /** Montants RETENUS, triés : un montant compté deux fois y figurerait deux fois. */
  const retenus = (t: Tco) => t.lines.filter((l) => l.includedCents !== 0).map((l) => l.includedCents).sort((a, b) => a - b);
  const operationDe = async (compte: AccountRow, fileId: number): Promise<Json> => (await sql<Json[]>`
    SELECT o.id::int AS id, o.type_code, o.status, to_char(o.realized_date, 'YYYY-MM-DD') AS realized_date, to_char(o.start_date, 'YYYY-MM-DD') AS start_date
      FROM business_operation_documents d JOIN business_operations o ON o.id = d.operation_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     WHERE d.account_id = ${compte.id} AND d.file_id = ${fileId} AND d.active ORDER BY o.id`)[0];
  async function timeline(assetId: number, mode: 'grouped' | 'detailed' = 'grouped'): Promise<Json[]> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const r = await route.GET(new NextRequest(`http://x/api/assets/${assetId}/overview?section=timeline&mode=${mode}&limit=100`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(r.status).toBe(200);
    return (await r.json()).timeline as Json[];
  }
  async function fiche(operationId: number): Promise<Json | null> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${operationId}/fiche`), { params: Promise.resolve({ id: String(operationId) }) });
    return r.status === 200 ? (await r.json()).fiche as Json : null;
  }
  async function recherche(q: string): Promise<Json[]> {
    const route = await import('@/app/api/search/route');
    const r = await route.GET(new NextRequest(`http://x/api/search?instant=1&q=${encodeURIComponent(q)}`));
    expect(r.status).toBe(200);
    return ((await r.json()).results as Json[]).filter((x) => x.category === 'Événement de référence');
  }
  /** L'Agenda du compte tel qu'il est enregistré : événements, dates, rappels en file. */
  const agenda = async (compte: AccountRow) => ({
    evenements: (await sql<Json[]>`SELECT id::int AS id, title, to_char(start_date, 'YYYY-MM-DD') AS d FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`).map((e) => `${e.id}|${e.title}|${e.d ?? ''}`),
    rappels: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`)[0].n,
    cartes: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id}`)[0].n,
  });
  const source = async (compte: AccountRow, assetId: number, exportType: DossierCode, claimOperationId?: number) => {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    return loadExportSource({ assetId, accountId: compte.id, userId: compte.ownerUserId, exportType, ...(claimOperationId ? { claimOperationId } : {}) });
  };
  const contenu = (src: Awaited<ReturnType<typeof source>>): Json => ({
    documents: src.documents.map((d) => d.id).sort((a, b) => a - b),
    events: src.events.map((e) => e.key).sort(),
    claimDocuments: [...(src.claimFile?.documentIds ?? [])].sort((a, b) => a - b),
    claimAgenda: [...(src.claimFile?.agendaKeys ?? [])].sort(),
  });
  const dossiers = async (compte: AccountRow, assetId: number): Promise<Json> => {
    const out: Json = {};
    for (const code of DOSSIERS) out[code] = contenu(await source(compte, assetId, code));
    return out;
  };

  // ══ « Échéance » générique ≠ financement ══════════════════════════════════

  it('L116CB-T01 — une échéance proposée « Financement » sans preuve d’un prêt reste non qualifiée ; Type du document, référence de prêt ou capital emprunté la prouvent ; rejeu T3 sans effet', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchaseDate: '2020-06-01', purchasePriceCents: 30_000_000 });
    const echeance = (o: { resume: string; fournisseur: string; reference: string; montant: number; date: string; role?: string }) => [cand({
      typeHint: 'FINANCING', sourceRoleHint: 'INVOICE', summary: o.resume, provider: o.fournisseur, targetHints: [cible(maison.id)],
      businessReferences: [ref('INVOICE', o.reference)], temporalHints: { realizedDate: o.date },
      financialHints: [fh(o.role ?? 'REALIZED_COST', o.montant, { economicDate: o.date })],
    })];
    // SANS PREUVE : avis d'échéance d'assurance ; facture d'entretien « échéance de paiement » ; échéance À VENIR d'un abonnement.
    const avis = await k.document(compte, maison.id, echeance({ resume: 'Échéance annuelle', fournisseur: 'Mutuelle du Centre', reference: 'AV-806T', montant: 42_000, date: '2025-01-05' }),
      { type: 'INSURANCE_DUE_NOTICE', title: 'Avis d’échéance 806T', amountCents: 42_000, date: '2025-01-05' });
    const facture = await k.document(compte, maison.id, echeance({ resume: 'Échéance de paiement', fournisseur: 'Chauffage Martin', reference: 'FA-806T', montant: 18_000, date: '2025-03-10' }),
      { type: 'MAINTENANCE_INVOICE', title: 'Facture à échéance 806T', amountCents: 18_000, date: '2025-03-10' });
    const aVenir = await k.document(compte, maison.id, echeance({ resume: 'Prochaine échéance', fournisseur: 'Télésurveillance Durand', reference: 'EC-806T', montant: 9_900, date: '2026-01-15', role: 'FORECAST_COST' }),
      { type: 'MAINTENANCE_INVOICE', title: 'Échéancier d’abonnement 806T', amountCents: 9_900, date: '2025-12-01' });
    // AVEC PREUVE, chacune seule : (1) Type du document ; (2) référence de PRÊT ; (3) capital emprunté.
    const parType = await k.document(compte, maison.id, echeance({ resume: 'Échéance du crédit auto', fournisseur: 'Banque A', reference: 'EA-806T', montant: 30_000, date: '2025-02-05' }),
      { type: 'LEASING_FINANCING_CONTRACT', title: 'Contrat de leasing 806T', amountCents: 30_000, date: '2025-02-05' });
    const parReference = await k.document(compte, maison.id, [cand({
      typeHint: 'FINANCING', sourceRoleHint: 'INVOICE', summary: 'Intérêts de l’année', provider: 'Banque B', targetHints: [cible(maison.id)],
      businessReferences: [ref('LOAN', 'PR-806T'), ref('INVOICE', 'INT-806T')], temporalHints: { realizedDate: '2025-12-31' }, financialHints: [fh('REALIZED_COST', 55_000, { economicDate: '2025-12-31' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Relevé d’intérêts 806T', amountCents: 55_000, date: '2025-12-31' });
    const parCapital = await k.document(compte, maison.id, [cand({
      typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Offre de financement', provider: 'Banque C', targetHints: [cible(maison.id)],
      businessReferences: [ref('CONTRACT', 'OF-806T')], temporalHints: { startDate: '2024-09-01' }, financialHints: [fh('LOAN_PRINCIPAL', 1_500_000)],
    })], { type: null, title: 'Offre 806T', amountCents: null, date: '2024-08-20' });
    await k.passer(compte);

    // SANS PREUVE : une opération existe (rien n'est perdu), mais elle n'est PAS un financement — ni « Autre » par défaut.
    for (const [nom, f] of [['avis d’échéance', avis], ['facture à échéance', facture], ['échéance à venir', aVenir]] as const) {
      const op = await operationDe(compte, f);
      expect(op, nom).toBeTruthy();
      expect(op.type_code, nom).not.toBe('FINANCING');
      expect(op.type_code, nom).not.toBe('OTHER');
      expect(await sql`SELECT 1 FROM business_operation_financing_details WHERE operation_id = ${op.id}`, nom).toHaveLength(0);
    }
    // AVEC PREUVE : trois financements.
    for (const [nom, f] of [['Type du document', parType], ['référence de prêt', parReference], ['capital emprunté', parCapital]] as const) {
      expect((await operationDe(compte, f)).type_code, nom).toBe('FINANCING');
    }
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'FINANCING' AND invalidated_at IS NULL`)[0].n).toBe(3);

    // COÛT DE POSSESSION : le poste « Financement » ne porte que les deux coûts PROUVÉS (300 € + 550 €) — jamais
    // l'avis d'échéance (420 €), la facture (180 €) ni l'échéance à venir (99 €). Le capital emprunté n'est pas un coût.
    asUser(compte);
    const t = await tco(compte, maison.id);
    expect(postes(t).FINANCING).toBe(85_000);
    const lignesFinancement = t.lines.filter((l) => l.category === 'FINANCING' && l.includedCents !== 0).map((l) => l.includedCents).sort((a, b) => a - b);
    expect(lignesFinancement).toEqual([30_000, 55_000]);
    // Les deux échéances passées sans preuve restent comptées UNE fois, ailleurs que dans « Financement ».
    expect(retenus(t).filter((c) => c === 42_000)).toHaveLength(1);
    expect(retenus(t).filter((c) => c === 18_000)).toHaveLength(1);
    // L'échéance à venir n'est jamais « présumée honorée » : rien n'est compté pour elle.
    expect(retenus(t)).not.toContain(9_900);
    // Seules les échéances des financements PROUVÉS relèvent de la base contractuelle d'un prêt.
    expect(t.lines.filter((l) => l.financingBasis === 'SCHEDULE').map((l) => l.includedCents).filter((c) => [42_000, 18_000, 9_900].includes(c))).toEqual([]);
    expect(retenus(t)).not.toContain(1_500_000);

    // La fiche et la recherche ne disent « Financement » que pour les trois prouvés.
    const opAvis = await operationDe(compte, avis);
    expect((await fiche(opAvis.id))!.typeLabel ?? null).not.toBe('Financement');
    expect((await recherche('806T')).filter((r) => /^Financement/.test(String(r.label))).length).toBeLessThanOrEqual(3);

    // REJEU T3 (deux passes) : mêmes types, mêmes postes, aucune opération de plus.
    const avant = { ops: (await k.actives(compte)).map((o) => `${o.id}:${o.type_code}`), postes: postes(t), retenus: retenus(t) };
    await k.passer(compte);
    await k.passer(compte);
    const t2 = await tco(compte, maison.id);
    expect({ ops: (await k.actives(compte)).map((o) => `${o.id}:${o.type_code}`), postes: postes(t2), retenus: retenus(t2) }).toEqual(avant);
  }, 180000);

  // ══ Requalification après une CORRECTION ═════════════════════════════════

  it('L116CB-T02 — après une correction de date puis de type : Timeline, fiche, recherche et événement porteur suivent ; coût de possession sans double compte ; exports identiques ; T3 ne réécrit pas', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchaseDate: '2020-06-01', purchasePriceCents: 30_000_000 });
    const devis = await k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', summary: 'Remplacement de la chaudière', provider: 'Chauffage Martin', targetHints: [cible(maison.id)],
      businessReferences: [ref('QUOTE', 'DV-806T')], temporalHints: {}, financialHints: [fh('FORECAST_COST', 420_000)],
    })], { type: 'QUOTE', title: 'Devis chaudière 806T', amountCents: 420_000, date: '2025-03-01' });
    const factureChaudiere = await k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'INVOICE', summary: 'Remplacement de la chaudière', provider: 'Chauffage Martin', targetHints: [cible(maison.id)],
      businessReferences: [ref('QUOTE', 'DV-806T'), ref('INVOICE', 'FA-CH-806T')], temporalHints: { realizedDate: '2025-04-15' }, financialHints: [fh('REALIZED_COST', 410_000, { economicDate: '2025-04-15' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Facture chaudière 806T', amountCents: 410_000, date: '2025-04-15' });
    await k.passer(compte);
    const op = await operationDe(compte, factureChaudiere);
    expect((await operationDe(compte, devis)).id).toBe(op.id);
    expect(op).toMatchObject({ type_code: 'INTERVENTION', realized_date: '2025-04-15' });
    // Événements réels de l'Agenda : la POSE (porte le fait « réalisation »), la visite du devis (ne porte aucun fait).
    const pose = await make.agendaItem(compte, { title: 'Pose de la chaudière 806T', startDate: '2025-04-15', assetIds: [maison.id] });
    const visite = await make.agendaItem(compte, { title: 'Visite pour devis 806T', startDate: '2025-03-01', assetIds: [maison.id] });
    const f = await facade();
    for (const e of [pose, visite]) expect(await f.linkAgendaItem(user(compte), { operationId: op.id, agendaItemId: e.id })).toMatchObject({ status: 'APPLIED' });
    await sql`UPDATE business_operation_agenda_links SET fact_key = 'INTERVENTION' WHERE account_id = ${compte.id} AND operation_id = ${op.id} AND agenda_item_id = ${pose.id}`;
    asUser(compte);
    const tcoAvant = await tco(compte, maison.id);
    const dossiersAvant = await dossiers(compte, maison.id);
    const agendaAvant = await agenda(compte);
    expect(retenus(tcoAvant).filter((c) => c === 410_000)).toHaveLength(1);
    expect(retenus(tcoAvant)).not.toContain(420_000);

    // 1. CORRECTION DE LA DATE de réalisation par l'utilisateur (la facture était datée du 15, la pose a eu lieu le 22).
    const v0 = (await fiche(op.id))!.version as number;
    expect(await f.correctOperation(user(compte), { operationId: op.id, expectedVersion: v0, attributes: { realizedDate: '2025-04-22' } })).toMatchObject({ status: 'APPLIED', changed: true });
    // Timeline (regroupée), fiche et recherche : la même date, la nouvelle.
    expect((await timeline(maison.id)).find((e) => e.id === G(op.id))).toMatchObject({ kind: 'group', effectiveDate: '2025-04-22', dateBasis: 'REALIZED' });
    expect((await fiche(op.id))!.dates).toEqual([{ role: 'REALIZED', date: '2025-04-22' }]);
    expect(JSON.stringify(await recherche('chaudière'))).toContain('22/04/2025');
    // Agenda : l'événement qui porte LE MÊME FAIT suit ; la visite du devis (autre fait) garde SA date ; rien n'est créé.
    const apresDate = await agenda(compte);
    expect(apresDate.evenements).toEqual(agendaAvant.evenements.map((l) => (l.startsWith(`${pose.id}|`) ? `${pose.id}|Pose de la chaudière 806T|2025-04-22` : l)));
    expect({ rappels: apresDate.rappels, cartes: apresDate.cartes }).toEqual({ rappels: agendaAvant.rappels, cartes: agendaAvant.cartes });
    expect((await timeline(maison.id, 'detailed')).map((e) => [e.id, e.effectiveDate]).sort()).toEqual([[String(pose.id), '2025-04-22'], [String(visite.id), '2025-03-01']].sort());
    // Coût de possession : même total, mêmes montants retenus — la facture comptée UNE fois, le devis jamais.
    const tcoDate = await tco(compte, maison.id);
    expect(tcoDate.summary.cumulativeCostCents).toBe(tcoAvant.summary.cumulativeCostCents);
    expect(retenus(tcoDate)).toEqual(retenus(tcoAvant));
    expect(postes(tcoDate)).toEqual(postes(tcoAvant));
    // Exports : les dossiers du bien contiennent les mêmes pièces et les mêmes événements.
    expect(await dossiers(compte, maison.id)).toEqual(dossiersAvant);

    // 2. T3 REJOUÉ deux fois : la correction de l'utilisateur n'est pas réécrite (ni la date, ni l'événement).
    await k.passer(compte);
    await k.passer(compte);
    expect((await fiche(op.id))!.dates).toEqual([{ role: 'REALIZED', date: '2025-04-22' }]);
    expect((await agenda(compte)).evenements).toEqual(apresDate.evenements);
    expect((await k.actives(compte)).map((o) => o.id)).toEqual([op.id]);

    // 3. CORRECTION DU TYPE : l'utilisateur dit que c'est un CONTRAT (entretien sous contrat), pas une intervention.
    const v1 = (await fiche(op.id))!.version as number;
    expect(await f.correctOperation(user(compte), { operationId: op.id, expectedVersion: v1, type: { code: 'CONTRACT' } })).toMatchObject({ status: 'APPLIED', changed: true });
    expect((await fiche(op.id))!).toMatchObject({ typeCode: 'CONTRACT', typeLabel: 'Contrat' });
    // Coût de possession : la facture change de POSTE, elle n'est ni perdue ni comptée deux fois ; le total ne bouge pas.
    const tcoType = await tco(compte, maison.id);
    expect(tcoType.summary.cumulativeCostCents).toBe(tcoAvant.summary.cumulativeCostCents);
    expect(retenus(tcoType)).toEqual(retenus(tcoAvant));
    expect(Object.values(postes(tcoType)).reduce((a, b) => a + b, 0)).toBe(Object.values(postes(tcoAvant)).reduce((a, b) => a + b, 0));
    expect(postes(tcoType).MAINTENANCE ?? 0).toBe((postes(tcoAvant).MAINTENANCE ?? 0) - 410_000);
    expect(postes(tcoType).CONTRACTS ?? 0).toBe((postes(tcoAvant).CONTRACTS ?? 0) + 410_000);
    // T3 rejoué : le type choisi par l'utilisateur tient ; toujours UNE opération ; exports et Agenda inchangés.
    await k.passer(compte);
    expect((await k.actives(compte)).map((o) => `${o.id}:${o.type_code}`)).toEqual([`${op.id}:CONTRACT`]);
    expect(await dossiers(compte, maison.id)).toEqual(dossiersAvant);
    expect(await agenda(compte)).toEqual(apresDate);
    expect(retenus(await tco(compte, maison.id))).toEqual(retenus(tcoAvant));
  }, 180000);

  // ══ Requalification après une SCISSION ════════════════════════════════════

  it('L116CB-T03 — après une scission puis trois passes T3 : le sinistre n’est pas absorbé par l’assurance, aucun double compte, aucune date inventée, Agenda inchangé, deux groupes en Timeline, dossier du sinistre recentré', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchaseDate: '2020-06-01', purchasePriceCents: 30_000_000 });
    // Le SINISTRE (déclaré avant le lot 83D), sa facture de réparation qui cite le dossier (rapprochée par T3)…
    const sinistre = await k.sinistre(compte, { id: compte.ownerUserId }, maison, { claimType: 'DEGAT_DES_EAUX', occurredOn: '2025-04-02', insurerClaimRef: 'SIN-806T', status: 'A_DECLARER' });
    const reparation = await k.document(compte, maison.id, [cand({
      typeHint: 'CLAIM', sourceRoleHint: 'INVOICE', summary: 'Réparation du plafond', provider: 'Plâtrerie Morel', targetHints: [cible(maison.id)],
      businessReferences: [ref('CLAIM', 'SIN-806T'), ref('INVOICE', 'FA-PL-806T')], temporalHints: {}, financialHints: [fh('REALIZED_COST', 240_000, { economicDate: '2025-05-12' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Facture plafond 806T', amountCents: 240_000, date: '2025-05-12' });
    // … et l'AVIS D'ÉCHÉANCE de l'assurance, que l'utilisateur avait rattaché AU SINISTRE par erreur (il cite le dossier).
    const avis = await k.document(compte, maison.id, [cand({
      typeHint: 'CLAIM', sourceRoleHint: 'INVOICE', summary: 'Cotisation annuelle habitation', provider: 'Mutuelle du Centre', targetHints: [cible(maison.id)],
      businessReferences: [ref('CLAIM', 'SIN-806T'), ref('INVOICE', 'AV-806T')], temporalHints: {}, financialHints: [fh('REALIZED_COST', 42_000, { economicDate: '2025-01-05' })],
    })], { type: 'INSURANCE_DUE_NOTICE', title: 'Avis d’échéance 806T', amountCents: 42_000, date: '2025-01-05' });
    await k.passer(compte);
    expect((await operationDe(compte, reparation)).id).toBe(sinistre);
    expect((await operationDe(compte, avis)).id).toBe(sinistre);
    expect((await k.actives(compte)).map((o) => o.id)).toEqual([sinistre]);
    // Événements réels : le passage de l'expert (sinistre) et l'échéance de l'assurance (réunie à tort).
    const expert = await make.agendaItem(compte, { title: 'Passage de l’expert 806T', startDate: '2025-04-10', assetIds: [maison.id] });
    const echeance = await make.agendaItem(compte, { title: 'Échéance de l’assurance 806T', startDate: '2026-01-05', assetIds: [maison.id] });
    const f = await facade();
    for (const e of [expert, echeance]) expect(await f.linkAgendaItem(user(compte), { operationId: sinistre, agendaItemId: e.id })).toMatchObject({ status: 'APPLIED' });
    asUser(compte);
    const tcoAvant = await tco(compte, maison.id);
    const agendaAvant = await agenda(compte);
    const dossiersAvant = await dossiers(compte, maison.id);
    const sinistreAvant = contenu(await source(compte, maison.id, 'ASSURANCE_SINISTRE', sinistre));
    expect(sinistreAvant.claimDocuments).toEqual([reparation, avis].sort((a, b) => a - b));
    expect(retenus(tcoAvant).filter((c) => c === 240_000)).toHaveLength(1);
    expect(retenus(tcoAvant).filter((c) => c === 42_000)).toHaveLength(1);

    // SCISSION : l'avis d'échéance et l'échéance partent dans une nouvelle opération, que l'utilisateur dit être un CONTRAT.
    const v = (await fiche(sinistre))!.version as number;
    const scission = await f.splitOperation(user(compte), {
      operationId: sinistre, expectedVersion: v, label: 'Assurance habitation', type: { code: 'CONTRACT' }, fileIds: [avis], agendaItemIds: [echeance.id],
    });
    expect(scission).toMatchObject({ status: 'APPLIED', changed: true });
    const assurance = scission.data!.newOperationId;
    // La scission REDEMANDE à T3 le justificatif déplacé (file existante, déclencheur « document déplacé ») : sans cela
    // son montant ne rejoindrait jamais la nouvelle opération.
    await new Promise((r) => setTimeout(r, 300));
    const demandes = (await sql<Json[]>`SELECT payload::text AS p FROM ai_job_queue`).map((j) => String(j.p).replace(/\s+/g, ''))
      .filter((p) => p.includes('"trigger":"document_moved"') && p.includes(`"fileId":${avis}`));
    expect(demandes.length, 'demande T3 du justificatif déplacé').toBeGreaterThan(0);

    // Le passage T3 demandé (rejoué ici comme l'exécutant le fait : document désigné par l'événement), puis TROIS
    // passes de plus : la preuve commune (le dossier cité par les deux pièces) ne réunit plus rien.
    await k.passer(compte, { fileIds: [avis] });
    for (let i = 0; i < 3; i++) await k.passer(compte);
    expect(await k.candidat(avis)).toEqual([expect.objectContaining({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: assurance })]);
    const vivantes = await k.actives(compte);
    expect(vivantes.map((o) => `${o.id}:${o.type_code}`)).toEqual([`${sinistre}:CLAIM`, `${assurance}:CONTRACT`]);
    // Le sinistre n'est PAS absorbé par l'assurance, ni l'inverse : chacun ses pièces, chacun ses événements.
    expect((await fiche(sinistre))!.documents.map((d: Json) => d.fileId)).toEqual([reparation]);
    expect((await fiche(assurance))!.documents.map((d: Json) => d.fileId)).toEqual([avis]);
    expect((await fiche(sinistre))!.agendaItems.map((a: Json) => a.id)).toEqual([expert.id]);
    expect((await fiche(assurance))!.agendaItems.map((a: Json) => a.id)).toEqual([echeance.id]);
    expect((await fiche(sinistre))!.relations.map((r: Json) => r.operationId)).toEqual([assurance]);
    expect(await sql`SELECT 1 FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NOT NULL`).toHaveLength(0);
    // Le contrat est consultable depuis le sinistre SANS copie : la pièce d'assurance y est lue par la relation.
    expect((await fiche(sinistre))!.relatedDocuments.map((d: Json) => [d.fileId, d.operationId])).toEqual([[avis, assurance]]);

    // AUCUN DOUBLE COMPTE : total identique ; la réparation et la cotisation comptées UNE fois chacune ; la cotisation
    // a quitté le poste des sinistres.
    const tcoApres = await tco(compte, maison.id);
    expect(tcoApres.summary.cumulativeCostCents).toBe(tcoAvant.summary.cumulativeCostCents);
    expect(retenus(tcoApres)).toEqual(retenus(tcoAvant));
    expect(retenus(tcoApres).filter((c) => c === 240_000)).toHaveLength(1);
    expect(retenus(tcoApres).filter((c) => c === 42_000)).toHaveLength(1);
    expect(postes(tcoApres).CLAIMS ?? 0).toBe((postes(tcoAvant).CLAIMS ?? 0) - 42_000);
    // Composantes : la cotisation est portée par le CONTRAT, plus par le sinistre ; elle est désormais au poste des contrats.
    expect((await k.composantes(sinistre)).map((c) => c.amount_minor)).toEqual([240_000]);
    expect((await k.composantes(assurance)).map((c) => c.amount_minor)).toEqual([42_000]);
    expect(postes(tcoApres).CONTRACTS ?? 0).toBe((postes(tcoAvant).CONTRACTS ?? 0) + 42_000);
    expect((await fiche(assurance))!.summary.netCents).toBe(42_000);

    // AUCUNE DATE INVENTÉE : le sinistre garde sa date de survenance ; le contrat n'a AUCUNE date propre fabriquée
    // (ni date du jour, ni date de l'échéance, ni date du document recopiée comme prise d'effet).
    const [dSinistre] = await sql<Json[]>`SELECT to_char(realized_date, 'YYYY-MM-DD') AS r FROM business_operations WHERE id = ${sinistre}`;
    expect(dSinistre.r).toBe('2025-04-02');
    const [dContrat] = await sql<Json[]>`
      SELECT to_char(planned_date, 'YYYY-MM-DD') AS p, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(realized_date, 'YYYY-MM-DD') AS r, to_char(end_date, 'YYYY-MM-DD') AS e
        FROM business_operations WHERE id = ${assurance}`;
    expect(dContrat).toEqual({ p: null, s: null, r: null, e: null });
    expect((await fiche(assurance))!.dates).toEqual([]);

    // AGENDA : exactement les mêmes événements, aux mêmes dates ; aucun rappel, aucune carte de plus.
    expect(await agenda(compte)).toEqual(agendaAvant);
    // TIMELINE regroupée : DEUX groupes, chacun avec ses événements réels.
    const groupes = (await timeline(maison.id)).filter((e) => e.kind === 'group');
    expect(groupes.map((g) => g.id).sort()).toEqual([G(sinistre), G(assurance)].sort());
    expect(groupes.find((g) => g.id === G(sinistre))!.members.map((m: Json) => m.id)).toEqual([String(expert.id)]);
    expect(groupes.find((g) => g.id === G(assurance))!.members.map((m: Json) => m.id)).toEqual([String(echeance.id)]);
    expect((await timeline(maison.id, 'detailed')).map((e) => e.id).sort()).toEqual([String(expert.id), String(echeance.id)].sort());

    // EXPORTS : le dossier « Assurance — sinistre » ne contient plus la pièce ni l'échéance déplacées ; les autres
    // dossiers du bien (qui ne lisent aucune opération) sont identiques.
    const sinistreApres = contenu(await source(compte, maison.id, 'ASSURANCE_SINISTRE', sinistre));
    expect(sinistreApres.claimDocuments).toEqual([reparation]);
    expect(sinistreApres.claimAgenda.length).toBe(sinistreAvant.claimAgenda.length - 1);
    expect(await dossiers(compte, maison.id)).toEqual(dossiersAvant);
  }, 180000);
});
