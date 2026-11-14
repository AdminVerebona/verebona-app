/**
 * Lot 113X — carte #722 « [P2][Post-MEP] TCO — Supprimer l'alerte de dates en doublon et permettre de renseigner
 * les dates », sur PostgreSQL 16 RÉEL (routes GET /tco, GET + POST /tco/dates, POST /tco/decisions, moteur,
 * écritures canoniques de la fiche du bien et de l'équipement, date du justificatif). Aucun appel IA.
 * Assertions limitées aux comptes créés ici.
 *
 *   L113X-E01 liste exacte : 5 dépenses retenues sans date (prix de la fiche, 2 échéances d'assurance,
 *             facture d'intervention seule, prix d'un équipement) = `annual.undated` ; champ métier de
 *             chacune ; événement de référence ouvrable ; diagnostics du DTO inchangés (T2 / BO) ;
 *   L113X-E02 enregistrement PARTIEL (1 date) : 4 restantes, montant résiduel exact, ventilée dans son année,
 *             TCO total inchangé ; date du justificatif marquée correction utilisateur, journal d'audit ;
 *   L113X-E03 plusieurs dates en une fois (fiche du bien + équipement) : journal canonique origine USER ;
 *             restent les seules échéances à période (aucune date inventée), relecture identique ;
 *   L113X-E04 garde-fous : date future / impossible refusée, contradiction avec la possession à confirmer,
 *             ligne sans champ (période seule) non modifiable, ligne déjà datée refusée, preuve jamais écrasée ;
 *   L113X-E05 compatibilité #712 : « Conserver dans le TCO sans date » clôt le point de décision, l'information
 *             neutre demeure (compte et montant), aucune carte « À traiter » créée ; puis une date reste possible ;
 *   L113X-E06 droits et isolation : autre compte 404, Standard 403, lecture seule refusée, aucune écriture ;
 *   L113X-E07 toutes les dates fiables : plus aucune dépense sans date, aucun état positif dans la réponse.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, role: 'USER', email: '' }));
type Json = Record<string, any>;

const ACHAT = 180_000;
const QUITTANCES = 21_476;
const AVIS = 31_359;
const REPARATION = 15_000;
const EQUIPEMENT = 45_000;
const TOTAL = ACHAT + QUITTANCES + AVIS + REPARATION + EQUIPEMENT;

scenario('L113X', 'TCO — une seule alerte « dépenses sans date fiable » et saisie des dates dans le champ métier', ({ sql, make }) => {
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role, email: session.email }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const as = (compte: AccountRow, userId = compte.ownerUserId) => { session.currentAccountId = compte.id; session.userId = userId; session.role = 'USER'; };
  const ctx = (assetId: number) => ({ params: Promise.resolve({ id: String(assetId) }) });
  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), ctx(assetId));
    return { status: res.status, body: await res.json() as Json };
  };
  const getDates = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/dates/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco/dates`), ctx(assetId));
    return { status: res.status, body: await res.json() as Json };
  };
  const saisir = async (assetId: number, entries: Json[]) => {
    const { POST } = await import('@/app/api/assets/[id]/tco/dates/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${assetId}/tco/dates`, { method: 'POST', body: JSON.stringify({ entries }) }), ctx(assetId));
    return { status: res.status, body: await res.json() as Json };
  };
  const decide = async (assetId: number, body: Json) => {
    const { POST } = await import('@/app/api/assets/[id]/tco/decisions/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${assetId}/tco/decisions`, { method: 'POST', body: JSON.stringify(body) }), ctx(assetId));
    return { status: res.status, body: await res.json() as Json };
  };
  const fiche = async (compte: AccountRow, assetId: number, fields: Record<string, unknown>) =>
    (await import('@/services/asset-details-write.service')).updateAssetDetails({ assetId, accountId: compte.id, section: 'common', fields, actorUserId: compte.ownerUserId });
  const reconcilier = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/consolidation/asset-data-consolidator')).consolidateAssetData(compte.id, assetId);
  const coherent = (tco: Json) => {
    const a = tco.annual;
    expect(a.years.reduce((n: number, y: Json) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(tco.summary.cumulativeCostCents);
  };
  const item = (tco: Json, cents: number) => (tco.undatedExpenses.items as Json[]).find((i) => i.amountCents === cents)!;
  const entree = (tco: Json, cents: number, date: string, confirm = false) => {
    const i = item(tco, cents);
    return { lineId: i.lineId, lineKey: i.lineKey, date, ...(confirm ? { confirm: true } : {}) };
  };
  const fichier = async (compte: AccountRow, asset: AssetRow, titre: string, cents: number, type: string) => {
    const f = await make.assetFile(compte, { assetId: asset.id });
    await sql`UPDATE asset_files SET document_type_code = ${type}, retained_title = ${titre}, document_date = NULL, amount_cents = ${cents}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  };

  /**
   * Véhicule : prix d'achat saisi sur la fiche SANS date (consolidé par T3), contrat d'assurance à deux échéances
   * (périodes seules), intervention réalisée prouvée par UNE facture sans date, équipement avec prix sans date.
   * Montants propres au test (aucun n'est codé dans l'application).
   */
  async function vehicule(compte: AccountRow) {
    const asset = await make.asset(compte, { category: 'VEHICULE', name: 'Utilitaire' });
    await fiche(compte, asset.id, { acquisitionPrice: ACHAT / 100 });
    await reconcilier(compte, asset.id);
    const quittances = await fichier(compte, asset, 'Quittances assurance', QUITTANCES, 'INSURANCE_PREMIUM_NOTICE');
    const avis = await fichier(compte, asset, 'Avis d’échéance assurance', AVIS, 'INSURANCE_PREMIUM_NOTICE');
    const facture = await fichier(compte, asset, 'Facture de réparation', REPARATION, 'REPAIR_INVOICE');
    const [eq] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, key_characteristics, purchase_price_cents) VALUES (${asset.id}, 'Galerie de toit', '{}'::jsonb, ${EQUIPEMENT}) RETURNING id`;
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    let intervention = 0;
    await withBusinessOperationWrite(compte.id, async (repo) => {
      const op = await repo.create({
        type: { code: 'CONTRACT' }, status: 'REALIZED', startDate: '2025-09-24',
        source: { kind: 'DOCUMENT', entityKey: quittances, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: asset.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L113X',
      });
      await repo.addFinancialComponent(op.id, {
        kind: 'REALIZED_COST', amountMinor: QUITTANCES, currency: 'EUR', periodStart: '2025-09-24', periodEnd: '2026-09-23',
        sources: [{ sourceId: op.sourceId }], fingerprint: `e2e-l113x-${quittances}`,
      } as never, 'E2E_L113X');
      const s = await repo.addSource(op.id, { kind: 'DOCUMENT', entityKey: avis, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' }, 'E2E_L113X');
      await repo.addFinancialComponent(op.id, {
        kind: 'REALIZED_COST', amountMinor: AVIS, currency: 'EUR', periodStart: '2026-09-24', periodEnd: '2027-09-23',
        sources: [{ sourceId: s }], fingerprint: `e2e-l113x-${avis}`,
      } as never, 'E2E_L113X');
      const iv = await repo.create({
        type: { code: 'INTERVENTION' }, status: 'REALIZED', technicalLabel: 'Réparation du véhicule',
        source: { kind: 'DOCUMENT', entityKey: facture, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: asset.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L113X',
      });
      await repo.addFinancialComponent(iv.id, {
        kind: 'REALIZED_COST', amountMinor: REPARATION, currency: 'EUR', sources: [{ sourceId: iv.sourceId }], fingerprint: `e2e-l113x-${facture}`,
      } as never, 'E2E_L113X');
      intervention = iv.id;
    });
    // Événement de référence ouvrable depuis l'interface (élément d'agenda de l'intervention).
    const ev = await make.agendaItem(compte, { title: 'Réparation du véhicule', assetIds: [asset.id] });
    await sql`UPDATE agenda_items SET business_operation_id = ${intervention} WHERE id = ${ev.id}`;
    return { asset, quittances, avis, facture, equipmentId: eq.id, intervention, agendaItemId: ev.id };
  }

  it('L113X-E01 — liste exacte des dépenses retenues sans date (= ventilation annuelle), champ métier de chacune, événement de référence', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await vehicule(compte);
    as(compte);
    const r = await getTco(v.asset.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const t = r.body.tco;
    expect(t.summary.cumulativeCostCents).toBe(TOTAL);
    expect(t.undatedExpenses).toMatchObject({ count: 5, costsCents: TOTAL, truncated: false });
    expect(t.undatedExpenses.count).toBe(t.annual.undated.count);
    expect(t.undatedExpenses.costsCents).toBe(t.annual.undated.costsCents);
    expect(item(t, ACHAT).target).toEqual({ kind: 'ASSET_FIELD', field: 'acquisitionDate' });
    expect(item(t, QUITTANCES).target).toEqual({ kind: 'NONE' });
    expect(item(t, AVIS).target).toEqual({ kind: 'NONE' });
    expect(item(t, REPARATION).target).toEqual({ kind: 'DOCUMENT', fileId: v.facture });
    expect(item(t, EQUIPEMENT).target).toEqual({ kind: 'EQUIPMENT_FIELD', field: 'acquisitionDate', equipmentId: v.equipmentId });
    expect(item(t, REPARATION).documents).toEqual([expect.objectContaining({ fileId: v.facture })]);
    for (const i of t.undatedExpenses.items as Json[]) expect(i.currentDate).toBeNull();
    // Diagnostics du DTO inchangés (T2, BO) : la fiche seule ne répète plus le point dans « Points à vérifier ».
    // (Constat : le point 113N ne compte pas le prix d'un équipement sans date — 4 — alors que la ventilation annuelle
    // le place bien « sans année » : l'alerte unique suit la ventilation, 5.)
    expect((t.diagnostics.items as Json[]).find((d) => d.code === 'ECONOMIC_DATE_UNDETERMINED')).toMatchObject({ status: 'OPEN', count: 4 });
    // Filtre d'année : la liste ne dépend d'aucune année.
    const annee = await (async () => {
      const { GET } = await import('@/app/api/assets/[id]/tco/route');
      const res = await GET(new NextRequest(`http://x/api/assets/${v.asset.id}/tco?linesYear=2025`), ctx(v.asset.id));
      return (await res.json() as Json).tco;
    })();
    expect(annee.undatedExpenses).toEqual(t.undatedExpenses);
    const d = await getDates(v.asset.id);
    expect(d.status).toBe(200);
    expect(d.body.canEdit).toBe(true);
    const ref = (d.body.undated.items as Json[]).find((i) => i.amountCents === REPARATION)!;
    expect(ref).toMatchObject({ operationId: v.intervention, agendaItemId: v.agendaItemId });
    coherent(t);
  });

  it('L113X-E02 — enregistrement partiel : 1 date → 4 restantes, montant résiduel exact, ventilée, TCO total inchangé, correction tracée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await vehicule(compte);
    as(compte);
    const t = (await getTco(v.asset.id)).body.tco;
    const r = await saisir(v.asset.id, [entree(t, REPARATION, '2025-06-02')]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results).toEqual([expect.objectContaining({ outcome: 'SAVED' })]);
    const apres = r.body.tco;
    expect(apres.undatedExpenses).toMatchObject({ count: 4, costsCents: TOTAL - REPARATION });
    expect(apres.summary.cumulativeCostCents).toBe(TOTAL);
    expect(apres.annual.years.find((y: Json) => y.year === 2025).costsCents).toBe(REPARATION);
    expect((apres.lines as Json[]).find((l) => l.includedCents === REPARATION && l.status.startsWith('RETAINED'))).toMatchObject({ date: '2025-06-02', annualYear: 2025 });
    coherent(apres);
    const [f] = await sql<Json[]>`SELECT document_date::text AS d, user_edited_fields AS u FROM asset_files WHERE id = ${v.facture}`;
    expect(f).toMatchObject({ d: '2025-06-02', u: expect.objectContaining({ documentDate: true }) });
    expect((await sql`SELECT 1 FROM admin_audit_log WHERE target_type = 'document' AND target_id = ${v.facture} AND admin_user_id = ${compte.ownerUserId}`).length).toBe(1);
    // Rafraîchissement / réouverture : même résultat.
    expect((await getTco(v.asset.id)).body.tco.undatedExpenses).toEqual(apres.undatedExpenses);
  });

  it('L113X-E03 — plusieurs dates en une fois (fiche du bien + équipement) : journal canonique USER ; restent les échéances (aucune date inventée)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await vehicule(compte);
    as(compte);
    const t = (await getTco(v.asset.id)).body.tco;
    const r = await saisir(v.asset.id, [entree(t, ACHAT, '2024-03-15'), entree(t, EQUIPEMENT, '2024-04-01')]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results.map((x: Json) => x.outcome)).toEqual(['SAVED', 'SAVED']);
    const apres = r.body.tco;
    expect(apres.undatedExpenses).toMatchObject({ count: 3, costsCents: QUITTANCES + AVIS + REPARATION });
    expect(apres.summary.cumulativeCostCents).toBe(TOTAL);
    expect(apres.annual.years.find((y: Json) => y.year === 2024).costsCents).toBe(ACHAT + EQUIPEMENT);
    coherent(apres);
    const journal = await sql<Json[]>`
      SELECT canonical_key, origin, source_type FROM canonical_field_writes WHERE account_id = ${compte.id} AND canonical_key = 'acquisitionDate' AND outcome = 'written' ORDER BY id`;
    expect(journal.length).toBeGreaterThanOrEqual(1);
    expect(journal.every((j) => j.origin === 'USER')).toBe(true);
    const [eq] = await sql<Json[]>`SELECT key_characteristics->>'acquisitionDate' AS d, key_characteristics->>'acquisitionDate__origin' AS o FROM equipments WHERE id = ${v.equipmentId}`;
    expect(eq).toMatchObject({ d: '2024-04-01', o: 'USER' });
    // Échéances : seule la période couverte est connue — toujours sans date, sans champ de saisie.
    for (const c of [QUITTANCES, AVIS]) expect(item(apres, c)).toMatchObject({ currentDate: null, target: { kind: 'NONE' } });
  });

  it('L113X-E04 — garde-fous : dates refusées, contradiction à confirmer, ligne sans champ, ligne déjà datée, preuve jamais écrasée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await vehicule(compte);
    as(compte);
    let t = (await getTco(v.asset.id)).body.tco;
    // La date d'achat de la fiche d'abord (période de possession).
    t = (await saisir(v.asset.id, [entree(t, ACHAT, '2024-03-15')])).body.tco;
    const r = await saisir(v.asset.id, [
      entree(t, REPARATION, '2099-01-01'), entree(t, EQUIPEMENT, '2025-02-29'), entree(t, QUITTANCES, '2025-10-01'),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: Json) => x.outcome)).toEqual(['FUTURE_DATE', 'INVALID_DATE', 'NOT_EDITABLE']);
    expect(r.body.tco.undatedExpenses.count).toBe(4);
    // Dépense antérieure à l'achat du bien : signalée, enregistrée seulement après confirmation.
    const avant = await saisir(v.asset.id, [entree(t, REPARATION, '2023-05-05')]);
    expect(avant.body.results).toEqual([expect.objectContaining({ outcome: 'NEEDS_CONFIRMATION' })]);
    expect((await sql<Json[]>`SELECT document_date FROM asset_files WHERE id = ${v.facture}`)[0].document_date).toBeNull();
    const ok = await saisir(v.asset.id, [entree(t, REPARATION, '2023-05-05', true)]);
    expect(ok.body.results).toEqual([expect.objectContaining({ outcome: 'SAVED' })]);
    // Ligne désormais datée : refusée (liste actualisée) ; la date du justificatif n'est jamais écrasée.
    const encore = await saisir(v.asset.id, [entree(t, REPARATION, '2025-01-01')]);
    expect(encore.body.results).toEqual([expect.objectContaining({ outcome: 'NOT_UNDATED' })]);
    expect((await sql<Json[]>`SELECT document_date::text AS d FROM asset_files WHERE id = ${v.facture}`)[0].d).toBe('2023-05-05');
    // Corps invalide : 422, rien d'écrit.
    expect((await saisir(v.asset.id, [])).status).toBe(422);
  });

  it('L113X-E05 — #712 : « Conserver sans date » clôt la décision, l’information neutre demeure, aucune carte « À traiter » ; une date reste possible', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await vehicule(compte);
    as(compte);
    const cartesAvant = (await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${compte.id}`).length;
    let t = (await getTco(v.asset.id)).body.tco;
    for (const c of [QUITTANCES, AVIS]) {
      const i = item(t, c);
      // Règle remplacée (carte #769, écart B) : « Retirer du TCO » est aussi proposé depuis la même dépense du panneau.
      expect(i.options.map((o: Json) => o.label)).toEqual(['Conserver dans le TCO sans date', 'Retirer du TCO']);
      const r = await decide(v.asset.id, { lineId: i.lineId, lineKey: i.lineKey, action: 'CONFIRM_UNDATED' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      t = r.body.tco;
    }
    expect(t.undatedExpenses.count).toBe(5);
    // Règle remplacée (carte #769, écart B) : « Annuler mon choix » ET « Retirer du TCO » depuis la même dépense.
    for (const c of [QUITTANCES, AVIS]) {
      expect(item(t, c)).toMatchObject({ confirmedUndated: true, options: [expect.objectContaining({ action: 'REVERT_UNDATED' }), expect.objectContaining({ action: 'EXCLUDE' })] });
    }
    const ouvert = (t.diagnostics.items as Json[]).find((d) => d.code === 'ECONOMIC_DATE_UNDETERMINED');
    expect(ouvert).toMatchObject({ status: 'OPEN', count: 2 });
    // Une date sur une autre dépense ne rouvre aucun choix confirmé.
    t = (await saisir(v.asset.id, [entree(t, REPARATION, '2025-06-02')])).body.tco;
    for (const c of [QUITTANCES, AVIS]) expect(item(t, c).confirmedUndated).toBe(true);
    expect(t.undatedExpenses.count).toBe(4);
    expect((await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${compte.id}`).length).toBe(cartesAvant);
  });

  it('L113X-E06 — droits et isolation : autre compte 404, Standard 403, lecture seule refusée, aucune écriture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await vehicule(compte);
    as(compte);
    const t = (await getTco(v.asset.id)).body.tco;
    const e = [entree(t, REPARATION, '2025-06-02')];
    const intrus = await make.account({ plan: 'premium' });
    as(intrus);
    expect((await saisir(v.asset.id, e)).status).toBe(404);
    expect((await getDates(v.asset.id)).status).toBe(404);
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${compte.id}`;
    as(compte);
    expect((await saisir(v.asset.id, e)).status).toBe(403);
    expect((await getDates(v.asset.id)).status).toBe(403);
    await sql`UPDATE account_subscriptions SET plan_code = 'premium', status = 'readonly' WHERE account_id = ${compte.id}`;
    expect([403, 423]).toContain((await saisir(v.asset.id, e)).status);
    expect((await sql<Json[]>`SELECT document_date FROM asset_files WHERE id = ${v.facture}`)[0].document_date).toBeNull();
  });

  it('L113X-E07 — toutes les dates fiables enregistrées : plus aucune dépense sans date (alerte et bouton disparaissent)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const asset = await make.asset(compte, { category: 'VEHICULE', name: 'Scooter' });
    await fiche(compte, asset.id, { acquisitionPrice: ACHAT / 100 });
    await reconcilier(compte, asset.id);
    const [eq] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, key_characteristics, purchase_price_cents) VALUES (${asset.id}, 'Top case', '{}'::jsonb, ${EQUIPEMENT}) RETURNING id`;
    expect(eq.id).toBeGreaterThan(0);
    as(compte);
    const t = (await getTco(asset.id)).body.tco;
    expect(t.undatedExpenses.count).toBe(2);
    const r = await saisir(asset.id, [entree(t, ACHAT, '2024-03-15'), entree(t, EQUIPEMENT, '2024-03-15')]);
    // Règle remplacée (carte #769, écart C) : le résultat porte aussi les deux compteurs de confirmations (0 ici).
    expect(r.body.tco.undatedExpenses).toEqual({ count: 0, costsCents: 0, pendingCount: 0, confirmedCount: 0, items: [], truncated: false });
    expect(r.body.tco.summary.cumulativeCostCents).toBe(ACHAT + EQUIPEMENT);
    coherent(r.body.tco);
  });
});
