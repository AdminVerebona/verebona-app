/**
 * Lot 109A — relations métier autour de l'Opération pivot (ticket P1), sur
 * PostgreSQL 16 réel : persistance T1 réelle des candidats, consolidation T3
 * réelle (aucun appel IA), service de regroupement, MÊMES routes que les
 * fiches, MÊME orchestrateur de cohérence que la tâche quotidienne, rapport
 * BO (même fonction que le diagnostic durable).
 *
 *  L109A-E2E-AC01-05  série prouvée → une Opération, fournisseur persisté (PROVIDER), émetteur de la
 *                     preuve de paiement exclu ; fiches fournisseur / équipement / document : DIRECT et
 *                     VIA_OPERATION distincts, aucun lien direct inventé (anti-cartésien), route équipement
 *  L109A-E2E-AC06     Agenda : principal de l'ensemble, documents du groupe et lien direct conservés après T3
 *  L109A-E2E-AC07-11  mise à jour tardive (facture, équipement, correction du fournisseur) ; refus utilisateur
 *                     jamais rétabli ; fusion sans héritage fantôme ; idempotence (aucun historique parasite)
 *  L109A-E2E-AC10     > 50 documents : pagination complète, total exact, chaque document une fois
 *  L109A-E2E-AC12-16  stock ancien repris par le contrôle de cohérence (à blanc puis correctif), rapport
 *                     avant / après ; sécurité intercomptes
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runCoherenceFor, proofOf } from '../coherence-run';
import type { AccountRow, AssetRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, fh, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const req = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const PROVIDER = 'Alarme Service';
type Json = Record<string, any>;

/** Pièce d'un abonnement (contrat ou échéance) : même n° de contrat, prestataire désigné. */
function piece(assetId: number, o: { role: 'CONTRACT_DOCUMENT' | 'INVOICE' | 'PAYMENT_PROOF'; n: number; contrat?: string; provider?: string; type?: AnchoredOperationCandidate['typeHint'] }): AnchoredOperationCandidate {
  const m = String(o.n).padStart(2, '0');
  return cand({
    typeHint: o.type ?? 'CONTRACT', provider: o.provider ?? PROVIDER, sourceRoleHint: o.role, summary: `Télésurveillance ${m}`,
    targetHints: [cible(assetId)],
    businessReferences: [ref('CONTRACT', o.contrat ?? 'CT-2026-001'), ...(o.role === 'INVOICE' ? [ref('INVOICE', `${o.contrat ?? 'CT'}-F-${m}`)] : [])] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: o.role === 'CONTRACT_DOCUMENT' ? { startDate: '2026-01-01' } : { startDate: `2026-${m}-01`, endDate: `2026-${m}-28` },
    financialHints: o.role === 'CONTRACT_DOCUMENT' ? [] : [fh('REALIZED_COST', 3990, { amountScope: 'INSTALLMENT', economicDate: `2026-${m}-05`, periodStart: `2026-${m}-01`, periodEnd: `2026-${m}-28` })],
  });
}

scenario('L109A-RELATIONS-METIER', 'Relations métier : Opération pivot, contrat de lecture unique, reprise (lot 109A)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
  });
  const connecter = (a: AccountRow) => { session.userId = a.ownerUserId; session.currentAccountId = a.id; };
  const rc = () => import('@/services/relations/read-contract');
  const os = () => import('@/services/relations/operation-suppliers');
  const fournisseur = async (a: AccountRow, name: string) => {
    const { normalizeName } = await import('@/services/suppliers/supplier-service');
    return (await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status)
      VALUES (${a.id}, ${a.ownerUserId}, ${name}, ${normalizeName(name)}, 'active') RETURNING id`)[0].id;
  };
  const relier = (fileId: number, supplierId: number, confirmed = true) =>
    sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed, confidence_score) VALUES (${fileId}, ${supplierId}, ${confirmed}, ${confirmed ? '1' : '0.7'}) ON CONFLICT DO NOTHING`;
  const liensOp = (opId: number) => sql<{ supplier_id: number; role: string; origin: string; status: string }[]>`
    SELECT supplier_id, role, origin, status FROM business_operation_suppliers WHERE operation_id = ${opId} ORDER BY supplier_id`;
  const historique = async (a: AccountRow) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_supplier_history WHERE account_id = ${a.id}`)[0].n);
  const liensDirectsEquipement = async (a: AccountRow) => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM document_asset_links WHERE account_id = ${a.id} AND equipment_id IS NOT NULL AND status = 'ACTIVE'`)[0].n);
  const lierEquipement = (a: AccountRow, opId: number, equipmentId: number, assetId: number) =>
    sql`INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority) VALUES (${a.id}, ${opId}, ${equipmentId}, ${assetId}, 'USER')`;
  const maison = (a: AccountRow) => make.asset(a, { category: 'IMMOBILIER', name: 'Maison' });

  /** Abonnement prouvé : contrat + 3 échéances (fournisseur fiable) + preuve de paiement (banque). */
  async function abonnement(a: AccountRow, bien: AssetRow, o: { contrat?: string; provider?: string } = {}) {
    const s = await fournisseur(a, `${o.provider ?? PROVIDER} SAS`);
    const banque = await fournisseur(a, `Banque ${o.contrat ?? 'Exemple'}`);
    const contrat = await k.document(a, bien.id, [piece(bien.id, { role: 'CONTRACT_DOCUMENT', n: 1, ...o })], { title: 'Contrat de télésurveillance', date: '2026-01-01' });
    const factures: number[] = [];
    for (const n of [1, 2, 3]) factures.push(await k.document(a, bien.id, [piece(bien.id, { role: 'INVOICE', n, ...o })], { title: `Facture ${n}`, date: `2026-0${n}-05` }));
    const paiement = await k.document(a, bien.id, [piece(bien.id, { role: 'PAYMENT_PROOF', n: 3, ...o })], { title: 'Avis de prélèvement', date: '2026-03-06' });
    for (const f of [contrat, ...factures]) await relier(f, s);
    await relier(paiement, banque);
    await k.passer(a);
    const ops = await k.actives(a);
    return { s, banque, contrat, factures, paiement, ops };
  }

  it('L109A-E2E-AC01..05 — série prouvée, fournisseur persisté, fiches DIRECT / VIA_OPERATION, anti-cartésien', async () => {
    const a = await make.account({ plan: 'premium' });
    connecter(a);
    const bien = await maison(a);
    const x = await abonnement(a, bien);
    // AC01 : une Opération canonique, toutes les pièces membres.
    expect(x.ops).toHaveLength(1);
    const op = x.ops[0].id;
    const membres = (await sql<{ f: number }[]>`SELECT file_id AS f FROM business_operation_documents WHERE operation_id = ${op} AND active ORDER BY 1`).map((r) => r.f);
    expect(membres).toEqual([x.contrat, ...x.factures, x.paiement].sort((p, q) => p - q));
    // AC03 : relation persistée (T3), prestataire ; la banque (émettrice de la preuve de paiement) n'est PAS partie.
    expect(await liensOp(op)).toEqual([{ supplier_id: x.s, role: 'PROVIDER', origin: 'T3', status: 'ACTIVE' }]);

    // Fiche fournisseur : 4 documents directs, la preuve de paiement visible PAR l'Opération (pas émise par lui).
    const page = (await (await rc()).listSupplierDocuments(a.id, x.s, { pageSize: 50 }))!;
    expect(page.totals).toEqual({ all: 5, direct: 4, viaOperationOnly: 1 });
    expect(page.items.find((d) => d.id === x.paiement)).toMatchObject({ provenance: 'VIA_OPERATION', direct: [], viaOperations: [{ operationId: op, role: 'PROVIDER' }] });
    expect(page.items.find((d) => d.id === x.factures[0])).toMatchObject({ provenance: 'DIRECT', viaOperations: [{ operationId: op }] });
    expect(new Set(page.items.map((d) => d.id)).size).toBe(page.items.length);
    // Banque : son document seulement, aucun document de l'Opération (aucun transfert d'identité légale).
    expect((await (await rc()).listSupplierDocuments(a.id, x.banque))!.totals).toEqual({ all: 1, direct: 1, viaOperationOnly: 0 });

    // AC04 / AC05 : deux équipements de l'Opération, une notice directe sans Opération.
    const alarme = await k.equipement(bien, 'Centrale d’alarme', 'OTHER');
    const detecteur = await k.equipement(bien, 'Détecteur', 'OTHER');
    await lierEquipement(a, op, alarme, bien.id);
    await lierEquipement(a, op, detecteur, bien.id);
    const notice = (await make.assetFile(a, { assetId: bien.id })).id;
    await sql`INSERT INTO document_asset_links (account_id, file_id, equipment_id, link_role, origin) VALUES (${a.id}, ${notice}, ${alarme}, 'PRIMARY', 'USER')`;
    const directsAvant = await liensDirectsEquipement(a);
    const { GET } = await import('@/app/api/equipments/[id]/documents/route');
    const r1 = (await (await GET(req(`/api/equipments/${alarme}/documents`), ctx(alarme))).json()) as Json;
    expect(r1.totals).toEqual({ all: 6, direct: 1, viaOperationOnly: 5 });
    expect(r1.documents).toHaveLength(6);
    expect(r1.documents.find((d: Json) => d.id === notice)).toMatchObject({ provenance: 'DIRECT', viaOperations: [] });
    const r2 = (await (await GET(req(`/api/equipments/${detecteur}/documents?page=1&pageSize=2`), ctx(detecteur))).json()) as Json;
    expect(r2).toMatchObject({ total: 5, totals: { all: 5, direct: 0, viaOperationOnly: 5 }, page: 1, pageSize: 2, pageCount: 3, hasMore: true });
    expect(r2.documents).toHaveLength(2);
    // Aucun lien direct inventé (5 documents × 2 équipements ≠ 10 liens).
    expect(await liensDirectsEquipement(a)).toBe(directsAvant);

    // Fiche équipement ↔ fournisseurs, fiche fournisseur ↔ équipements : par l'Opération.
    expect((await (await rc()).listEquipmentSuppliers(a.id, detecteur))!.items.map((s) => [s.id, s.provenance])).toEqual([[x.s, 'VIA_OPERATION']]);
    expect((await (await rc()).listSupplierEquipments(a.id, x.s))!.items.map((e) => e.id).sort()).toEqual([alarme, detecteur].sort());

    // Document : Opération et rattachements directs, sans confusion.
    const doc = (await (await rc()).getDocumentRelations(a.id, x.factures[1]))!;
    expect(doc.direct.suppliers.map((s) => s.supplierId)).toEqual([x.s]);
    expect(doc.direct.equipments).toEqual([]);
    expect(doc.operations).toHaveLength(1);
    expect(doc.operations[0]).toMatchObject({ operationId: op, suppliers: [{ supplierId: x.s, role: 'PROVIDER' }] });
    expect(doc.operations[0].equipments.map((e) => e.equipmentId).sort()).toEqual([alarme, detecteur].sort());
    const { GET: docGet } = await import('@/app/api/documents/[id]/relations/route');
    expect((await docGet(req(`/api/documents/${x.paiement}/relations`), ctx(x.paiement))).status).toBe(200);
    // Compteurs : mêmes périmètres que les listes.
    const c = (await (await rc()).countSupplierRelations(a.id, x.s))!;
    expect(c).toMatchObject({ documents: page.totals, operations: 1, equipments: { all: 2, direct: 0, viaOperationOnly: 2 } });
  });

  it('L109A-E2E-AC02 — abonnement et intervention du même fournisseur : deux Opérations distinctes, liens distincts', async () => {
    const a = await make.account();
    const bien = await maison(a);
    const x = await abonnement(a, bien);
    const inter = await k.document(a, bien.id, [cand({
      typeHint: 'INTERVENTION', provider: PROVIDER, sourceRoleHint: 'INVOICE', summary: 'Dépannage sirène', targetHints: [cible(bien.id)],
      businessReferences: [ref('INVOICE', 'INT-77')] as AnchoredOperationCandidate['businessReferences'], temporalHints: { startDate: '2026-05-02' },
      financialHints: [fh('REALIZED_COST', 12000, { economicDate: '2026-05-02' })],
    })], { title: 'Facture dépannage', date: '2026-05-02' });
    await relier(inter, x.s);
    await k.passer(a);
    const ops = await k.actives(a);
    expect(ops).toHaveLength(2);
    for (const o of ops) expect((await liensOp(o.id)).map((l) => l.supplier_id)).toEqual([x.s]);
    expect((await (await rc()).listSupplierOperations(a.id, x.s))!.map((o) => o.operationId).sort()).toEqual(ops.map((o) => o.id).sort());
  });

  it('L109A-E2E-AC06 — Agenda : principal, documents du groupe, lien direct et événement autonome conservés', async () => {
    const a = await make.account();
    connecter(a);
    const bien = await maison(a);
    const x = await abonnement(a, bien);
    const op = x.ops[0].id;
    const g = await import('@/services/business-operations/grouping/service');
    const principal = (await make.agendaItem(a, { title: 'Abonnement télésurveillance', startDate: '2026-01-01', assetIds: [bien.id] })).id;
    const autonome = (await make.agendaItem(a, { title: 'Ramonage', startDate: '2026-09-01', assetIds: [bien.id] })).id;
    await g.withGroupingWrite(a.id, (c) => g.attachAgendaItem(c, { operationId: op, itemId: principal, role: 'PRINCIPAL', origin: 'USER', reasonCode: 'E2E_L109A' }));
    const notice = (await make.assetFile(a, { assetId: bien.id })).id;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${principal}, ${notice}, '{MANUAL_DIRECT}') ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE SET provenances = '{MANUAL_DIRECT}'`;
    const docs = (await (await rc()).listEntityDocuments(a.id, { kind: 'agenda_item', id: principal }))!;
    expect(docs.totals).toEqual({ all: 6, direct: 1, viaOperationOnly: 5 });
    const ag = (await (await rc()).listSupplierAgendaItems(a.id, x.s))!;
    expect(ag.items.map((i) => [i.id, i.provenance, i.operationRole])).toEqual([[principal, 'VIA_OPERATION', 'PRINCIPAL']]);
    // Un seul principal ; l'événement autonome reste hors de l'ensemble.
    expect((await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op} AND operation_role = 'PRINCIPAL'`)).toHaveLength(1);
    expect((await sql<{ op: number | null }[]>`SELECT business_operation_id AS op FROM agenda_items WHERE id = ${autonome}`)[0].op).toBeNull();
    // Reconsolidation T3 : le lien direct et la provenance du groupe sont conservés.
    await k.passer(a, { fileIds: x.factures });
    const prov = (await sql<{ p: string[] }[]>`SELECT provenances AS p FROM agenda_file_links WHERE agenda_item_id = ${principal} AND asset_file_id = ${notice}`)[0].p;
    expect(prov).toContain('MANUAL_DIRECT');
    // Équipement de l'Opération : l'élément principal apparaît par l'Opération (route Agenda de la fiche équipement).
    const eq = await k.equipement(bien, 'Clavier', 'OTHER');
    await lierEquipement(a, op, eq, bien.id);
    const { GET } = await import('@/app/api/equipments/[id]/agenda/route');
    const r = (await (await GET(req(`/api/equipments/${eq}/agenda`), ctx(eq))).json()) as Json;
    expect(r.items.map((i: Json) => [i.id, i.provenance])).toEqual([[principal, 'VIA_OPERATION']]);
  });

  it('L109A-E2E-AC07..11 — réévaluation tardive, refus respecté, fusion sans héritage, idempotence', async () => {
    const a = await make.account();
    connecter(a);
    const bien = await maison(a);
    const x = await abonnement(a, bien);
    const op = x.ops[0].id;
    // AC07 : nouvelle facture → rejoint l'Opération, preuve du lien mise à jour.
    const notice0 = (await make.assetFile(a, { assetId: bien.id })).id;
    const f4 = await k.document(a, bien.id, [piece(bien.id, { role: 'INVOICE', n: 4 })], { title: 'Facture 4', date: '2026-04-05' });
    await relier(f4, x.s);
    await k.passer(a);
    expect((await k.actives(a)).map((o) => o.id)).toEqual([op]);
    const [l] = await sql<{ evidence: Json }[]>`SELECT evidence FROM business_operation_suppliers WHERE operation_id = ${op} AND supplier_id = ${x.s}`;
    expect(l.evidence.files).toContain(f4);
    // Correction du fournisseur d'un document par l'utilisateur : réévaluation demandée à la file T3 durable.
    const autre = await fournisseur(a, 'Installateur Exemple');
    const { PUT, DELETE } = await import('@/app/api/documents/[id]/supplier/route');
    for (const f of [x.contrat, ...x.factures, f4]) {
      expect((await DELETE(req(`/api/documents/${f}/supplier`, 'DELETE', { supplierId: x.s }), ctx(f))).status).toBe(200);
      expect((await PUT(req(`/api/documents/${f}/supplier`, 'PUT', { supplierId: autre }), ctx(f))).status).toBe(200);
    }
    // Les routes demandent la réévaluation (file T3 durable) pour les documents MEMBRES seulement.
    expect(await (await os()).requestOperationSupplierResync(a.id, [x.contrat, ...x.factures, f4, notice0])).toBe(5);
    await k.passer(a, { fileIds: [x.contrat, ...x.factures, f4] });
    expect(await liensOp(op)).toEqual([
      { supplier_id: x.s, role: 'PROVIDER', origin: 'T3', status: 'REMOVED' },
      // La pièce désigne le prestataire de l'Opération : sa fiche (corrigée) en est le prestataire.
      { supplier_id: autre, role: 'PROVIDER', origin: 'T3', status: 'ACTIVE' },
    ].sort((p, q) => p.supplier_id - q.supplier_id));

    // AC08 : refus de l'utilisateur — jamais rétabli par T3 ni par la cohérence.
    const { decideOperationSupplier } = await os();
    expect(await decideOperationSupplier(a.id, { operationId: op, supplierId: autre, decision: 'REJECT', userId: a.ownerUserId })).toBe(true);
    await k.passer(a, { fileIds: x.factures });
    await runCoherenceFor(sql, [a.id]);
    expect((await liensOp(op)).find((y) => y.supplier_id === autre)).toMatchObject({ origin: 'USER', status: 'REJECTED' });

    // Fusion : décision USER rapatriée, aucun lien actif sur l'absorbée.
    const y = await abonnement(a, bien, { contrat: 'CT-2026-999', provider: 'Autre Télésurveillance' });
    const absorbee = y.ops.map((o) => o.id).find((id) => id !== op)!;
    expect(absorbee).toBeDefined();
    await decideOperationSupplier(a.id, { operationId: absorbee, supplierId: x.banque, decision: 'LINK', role: 'INTERVENER', userId: a.ownerUserId });
    const g = await import('@/services/business-operations/grouping/service');
    expect(await g.withGroupingWrite(a.id, (c) => g.mergeOperations(c, { absorbedId: absorbee, canonicalId: op, reasonCode: 'E2E_L109A_USER_MERGE' }))).toBe(true);
    expect((await liensOp(absorbee)).filter((z) => z.status === 'ACTIVE')).toEqual([]);
    expect((await liensOp(op)).find((z) => z.supplier_id === x.banque)).toMatchObject({ origin: 'USER', role: 'INTERVENER', status: 'ACTIVE' });
    // Recalcul par le service unique (chemin de la réparation) : l'émetteur des pièces de l'absorbée est prouvé sur la canonique.
    const sync = await (await os()).syncOperationSuppliersForAccount(a.id, [op, absorbee]);
    expect(sync.added).toBeGreaterThan(0);
    expect((await liensOp(op)).find((z) => z.supplier_id === y.s)).toMatchObject({ status: 'ACTIVE', origin: 'T3', role: 'DOCUMENT_ISSUER' });

    // AC11 : rejouer T3 et la cohérence sans changement n'écrit ni lien ni historique (après un passage de stabilisation).
    await k.passer(a, { fileIds: x.factures });
    await runCoherenceFor(sql, [a.id]);
    const h = await historique(a);
    const avant = JSON.stringify(await liensOp(op));
    await k.passer(a, { fileIds: x.factures });
    const run = await runCoherenceFor(sql, [a.id]);
    expect(await historique(a)).toBe(h);
    expect(JSON.stringify(await liensOp(op))).toBe(avant);
    expect(run.results['COH-OPERATION-RELATIONS']?.REPAIRED ?? 0).toBe(0);
  });

  it('L109A-E2E-AC10 — plus de 50 documents : pages complètes, total exact, chaque document une fois', async () => {
    const a = await make.account();
    const bien = await maison(a);
    const x = await abonnement(a, bien);
    const op = x.ops[0].id;
    const g = await import('@/services/business-operations/grouping/service');
    const directs: number[] = [];
    for (let i = 0; i < 60; i++) {
      const f = (await make.assetFile(a, { assetId: bien.id })).id;
      await relier(f, x.s);
      directs.push(f);
    }
    const viaSeuls: number[] = [];
    for (let i = 0; i < 10; i++) viaSeuls.push((await make.assetFile(a, { assetId: bien.id })).id);
    await g.withGroupingWrite(a.id, async (c) => {
      for (const f of [...directs.slice(0, 30), ...viaSeuls]) await g.attachDocument(c, { operationId: op, fileId: f, reasonCode: 'E2E_L109A' });
    });
    const vus: number[] = [];
    let p = 1;
    let premiere: { totals: unknown; pageCount: number } | null = null;
    for (;; p++) {
      const page = (await (await rc()).listSupplierDocuments(a.id, x.s, { page: p, pageSize: 25 }))!;
      premiere ??= page;
      vus.push(...page.items.map((d) => d.id));
      if (!page.hasMore) break;
    }
    // 60 directs + 4 pièces directes de l'abonnement ; via seule : 10 + la preuve de paiement.
    expect(premiere!.totals).toEqual({ all: 75, direct: 64, viaOperationOnly: 11 });
    expect(premiere!.pageCount).toBe(3);
    expect(vus).toHaveLength(75);
    expect(new Set(vus).size).toBe(75);
    const vias = (await (await rc()).listSupplierDocuments(a.id, x.s, { provenance: 'VIA_OPERATION_ONLY', pageSize: 200 }))!;
    expect(vias.total).toBe(11);
    expect(vias.items.map((d) => d.id).sort((m, n) => m - n)).toEqual([...viaSeuls, x.paiement].sort((m, n) => m - n));
    // Intégration 109A ↔ 109B : la fiche fournisseur lit la section « via événement de référence » par ce contrat.
    const { listSupplierDocumentsViaOperation } = await import('@/services/suppliers/supplier-operation-documents');
    const p1 = await listSupplierDocumentsViaOperation(a.id, x.s, { offset: 0, limit: 5 });
    expect(p1).toMatchObject({ wired: true, total: 11, offset: 0, limit: 5, nextOffset: 5 });
    const p3 = await listSupplierDocumentsViaOperation(a.id, x.s, { offset: 10, limit: 5 });
    expect(p3).toMatchObject({ wired: true, total: 11, nextOffset: null });
    expect(p3.items).toHaveLength(1);
    const tous = [...p1.items, ...(await listSupplierDocumentsViaOperation(a.id, x.s, { offset: 5, limit: 5 })).items, ...p3.items].map((d) => d.id);
    expect(new Set(tous).size).toBe(11);
    expect(tous.some((id) => !vias.items.some((d) => d.id === id))).toBe(false);
  });

  it('L109A-E2E-AC12..16 — reprise du stock par la cohérence (à blanc, correctif), rapport avant / après, sécurité', async () => {
    const a = await make.account();
    const bien = await maison(a);
    const x = await abonnement(a, bien);
    const op = x.ops[0].id;
    // Stock antérieur au lot : aucune relation Opération ↔ fournisseur persistée.
    await sql`DELETE FROM business_operation_supplier_history WHERE account_id = ${a.id}`;
    await sql`DELETE FROM business_operation_suppliers WHERE account_id = ${a.id}`;
    const blanc = await runCoherenceFor(sql, [a.id], { mode: 'DRY_RUN' });
    expect(blanc.results['COH-OPERATION-RELATIONS']?.WOULD_REPAIR).toBe(1);
    expect(await liensOp(op)).toEqual([]);
    const run = await runCoherenceFor(sql, [a.id]);
    expect(run.results['COH-OPERATION-RELATIONS']?.REPAIRED).toBe(1);
    expect((await proofOf(sql, a.id, 'COH-OPERATION-RELATIONS', op))?.last_result).toBe('REPAIRED');
    expect(await liensOp(op)).toEqual([{ supplier_id: x.s, role: 'PROVIDER', origin: 'T3', status: 'ACTIVE' }]);
    // Rapport BO (même fonction que le diagnostic durable).
    const { buildRelationsAudit } = await import('@/services/relations/diagnostic');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    const audit = await buildRelationsAudit(postgresRunner(sql as never), a.id);
    expect(audit).toMatchObject({
      operations: { actives: 1, avecFournisseur: 1 },
      relationsDirectes: { documentFournisseur: 5 },
      relationsHeritees: { documentFournisseurViaOperation: 1 },
      reprise: { crees: 1 },
      avantApres: { avant: { liensActifs: 0 }, apres: { liensActifs: 1 } },
      anomaliesResiduelles: { aPoser: 0, aRetirer: 0, heritagesApresFusion: 0, intercomptes: 0 },
    });

    // AC13 : autre compte — 404 / null, aucune écriture intercomptes (même en SQL direct).
    const b = await make.account();
    connecter(b);
    expect(await (await rc()).listSupplierDocuments(b.id, x.s)).toBeNull();
    const eq = await k.equipement(bien, 'Sirène', 'OTHER');
    const { GET } = await import('@/app/api/equipments/[id]/documents/route');
    expect((await GET(req(`/api/equipments/${eq}/documents`), ctx(eq))).status).toBe(404);
    const sb = await fournisseur(b, 'Fournisseur B');
    await expect(sql`INSERT INTO business_operation_suppliers (account_id, operation_id, supplier_id, role, origin) VALUES (${a.id}, ${op}, ${sb}, 'PROVIDER', 'USER')`).rejects.toThrow(/CROSS_ACCOUNT/);
    expect(await (await os()).decideOperationSupplier(b.id, { operationId: op, supplierId: sb, decision: 'LINK', userId: b.ownerUserId })).toBe(false);
    // Jonction document ↔ fournisseur intercomptes : refusée par la base (garde existante) ; la lecture re-filtre de toute façon.
    const fb = (await make.assetFile(b)).id;
    await expect(relier(fb, x.s)).rejects.toThrow(/CROSS_ACCOUNT/);
    expect((await (await rc()).listSupplierDocuments(a.id, x.s))!.items.map((d) => d.id)).not.toContain(fb);
  });
});
