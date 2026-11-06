/**
 * Lot 113N — carte #712 « [P1][Pré-MEP] TCO — Confirmer une dépense conservée
 * sans date et clôturer le point à vérifier », sur PostgreSQL 16 RÉEL (routes
 * GET / POST du TCO, moteur, persistance 1515, journal, consolidation T3 des
 * données de la fiche, campagne de cohérence, reconstruction des Opérations).
 * Aucun appel IA. Assertions limitées aux comptes créés ici.
 *
 *   L113N-E01 capture du 06/11 (moto : prix de la fiche sans date 2 023,00 €,
 *             quittances APRIL 214,76 €, avis d'échéance APRIL 313,59 €) :
 *             « Conserver dans le TCO sans date » sur chacune → 0 choix restant,
 *             TCO total identique (2 551,35 €), aucune année, choix confirmés ;
 *   L113N-E02 persistance : nouveau GET, T3 (fiche + documents), contrôle de
 *             cohérence correctif → aucun point confirmé ne réapparaît ;
 *   L113N-E03 date fiable ajoutée ensuite (date d'achat de la fiche) : ligne
 *             datée et ventilée, aucune date inventée pour les autres ;
 *   L113N-E04 « Annuler mon choix » : point rouvert, montant inchangé, journal ;
 *   L113N-E05 dépense AJOUTÉE (INCLUDE) puis confirmée sans date : les deux
 *             décisions coexistent ; le retrait / ré-ajout ne perd jamais la
 *             confirmation ; « Renseigner la date » ouvre le justificatif ;
 *   L113N-E06 dépenses retirées : aucun signalement orphelin ; geste refusé
 *             (422) sur une ligne datée ;
 *   L113N-E07 droits et isolation : Standard 403, autre compte 404, lecture
 *             seule refusée, aucune écriture ;
 *   L113N-E08 migration 1515 rejouable ; garde-fou « au moins une décision » ;
 *             reconstruction des Opérations : fusion de deux lignes de
 *             décision sans perte de l'une ou de l'autre.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { operationsKit } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, role: 'USER', email: '' }));
type Json = Record<string, any>;

const ACHAT = 202_300;
const QUITTANCES = 21_476;
const AVIS = 31_359;
const TOTAL = ACHAT + QUITTANCES + AVIS;

scenario('L113N', 'TCO — dépense conservée sans date : point clos, persistant, réversible, calcul inchangé', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role, email: session.email }) as never);
    ({ NextRequest } = await import('next/server'));
    await import('@/services/business-operations/consolidation/queue');
  });

  const as = (compte: AccountRow, userId = compte.ownerUserId) => { session.currentAccountId = compte.id; session.userId = userId; session.role = 'USER'; };
  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const decide = async (assetId: number, body: Json) => {
    const { POST } = await import('@/app/api/assets/[id]/tco/decisions/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${assetId}/tco/decisions`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const fiche = async (compte: AccountRow, assetId: number, fields: Record<string, unknown>) =>
    (await import('@/services/asset-details-write.service')).updateAssetDetails({ assetId, accountId: compte.id, section: 'common', fields, actorUserId: compte.ownerUserId });
  const reconcilier = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/consolidation/asset-data-consolidator')).consolidateAssetData(compte.id, assetId);
  const diag = (tco: Json, code: string): Json | undefined => (tco.diagnostics.items as Json[]).find((d) => d.code === code);
  const sansDate = (tco: Json) => diag(tco, 'ECONOMIC_DATE_UNDETERMINED');
  const confirmees = (tco: Json) => (tco.diagnostics.items as Json[]).filter((d) => d.status === 'DECIDED')
    .flatMap((d) => d.sources as Json[]).filter((s) => s.decision?.value === 'CONFIRM_UNDATED');
  const coherent = (tco: Json) => {
    const a = tco.annual;
    expect(a.years.reduce((n: number, y: Json) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(tco.summary.cumulativeCostCents);
  };
  const lignes = (assetId: number) => sql<Json[]>`
    SELECT line_key, decision, date_decision, date_decided_by, decided_by FROM asset_cost_line_decisions WHERE asset_id = ${assetId} ORDER BY id`;
  const journal = (assetId: number) => sql<Json[]>`
    SELECT action, previous_decision, user_id, detail FROM asset_cost_line_decision_events WHERE asset_id = ${assetId} ORDER BY id`;

  /** Justificatif rattaché au bien, analysé, SANS date (ni de document, ni de paiement). */
  const fichier = async (compte: AccountRow, asset: AssetRow, titre: string, cents: number, type = 'INSURANCE_PREMIUM_NOTICE') => {
    const f = await make.assetFile(compte, { assetId: asset.id });
    await sql`UPDATE asset_files SET document_type_code = ${type}, retained_title = ${titre}, document_date = NULL, amount_cents = ${cents}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  };

  /**
   * Bien de la capture : moto, prix d'achat saisi sur la fiche SANS date (consolidé par T3 en événement de
   * référence d'achat), contrat APRIL : quittances et avis d'échéance sur deux périodes, sans date de paiement.
   */
  async function moto(compte: AccountRow) {
    const asset = await make.asset(compte, { category: 'VEHICULE', name: 'Moto' });
    await fiche(compte, asset.id, { acquisitionPrice: ACHAT / 100 });
    await reconcilier(compte, asset.id);
    const quittances = await fichier(compte, asset, 'Historique des quittances APRIL Moto Vélo', QUITTANCES);
    const avis = await fichier(compte, asset, 'Avis d’échéance APRIL Moto du 24/09/2026', AVIS);
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => {
      const op = await repo.create({
        type: { code: 'CONTRACT' }, status: 'REALIZED', startDate: '2025-09-24',
        source: { kind: 'DOCUMENT', entityKey: quittances, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: asset.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L113N',
      });
      await repo.addFinancialComponent(op.id, {
        kind: 'REALIZED_COST', amountMinor: QUITTANCES, currency: 'EUR', periodStart: '2025-09-24', periodEnd: '2026-09-23',
        sources: [{ sourceId: op.sourceId }], fingerprint: `e2e-l113n-${quittances}`,
      } as never, 'E2E_L113N');
      const s = await repo.addSource(op.id, { kind: 'DOCUMENT', entityKey: avis, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' }, 'E2E_L113N');
      await repo.addFinancialComponent(op.id, {
        kind: 'REALIZED_COST', amountMinor: AVIS, currency: 'EUR', periodStart: '2026-09-24', periodEnd: '2027-09-23',
        sources: [{ sourceId: s }], fingerprint: `e2e-l113n-${avis}`,
      } as never, 'E2E_L113N');
    });
    return { asset, quittances, avis };
  }
  const parMontant = (tco: Json, cents: number) => (tco.lines as Json[]).find((l) => l.includedCents === cents && l.status.startsWith('RETAINED'))!;
  const source = (tco: Json, cents: number) => (sansDate(tco)!.sources as Json[]).find((s) => s.amountCents === cents)!;
  const garder = async (assetId: number, tco: Json, cents: number) => {
    const s = source(tco, cents);
    expect(s.actions.map((o: Json) => o.label)).toContain('Conserver dans le TCO sans date');
    return decide(assetId, { lineId: s.lineId, lineKey: s.lineKey, action: 'CONFIRM_UNDATED' });
  };

  it('L113N-E01 — capture : 3 dépenses sans date conservées une à une → 0 choix restant, TCO total identique, aucune année artificielle', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await moto(compte);
    as(compte);
    const r = await getTco(asset.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const t = r.body.tco;
    expect(t.summary.cumulativeCostCents).toBe(TOTAL);
    const d = sansDate(t)!;
    expect(d).toMatchObject({ status: 'OPEN', count: 3, amountCents: TOTAL });
    for (const s of d.sources as Json[]) {
      const labels = s.actions.map((o: Json) => o.label);
      expect(labels).toEqual(expect.arrayContaining(['Conserver dans le TCO sans date', 'Retirer du TCO']));
    }
    // « Renseigner la date » : seulement pour le prix de la fiche (date d'achat), jamais pour les échéances APRIL.
    expect(source(t, ACHAT).actions.find((o: Json) => o.label === 'Renseigner la date')).toMatchObject({ action: 'EDIT_ASSET_FIELD', field: 'acquisitionDate' });
    expect(source(t, QUITTANCES).actions.some((o: Json) => o.label === 'Renseigner la date')).toBe(false);
    expect(source(t, AVIS).actions.some((o: Json) => o.label === 'Renseigner la date')).toBe(false);
    const avant = t.diagnostics.open.decisions;
    expect(avant).toBeGreaterThanOrEqual(3);

    // Une première : la carte se met à jour par ligne (DTO et diagnostics rendus immédiatement).
    const r1 = await garder(asset.id, t, ACHAT);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.outcome).toBe('SET');
    expect(r1.body.tco.summary.cumulativeCostCents).toBe(TOTAL);
    expect(sansDate(r1.body.tco)).toMatchObject({ count: 2, amountCents: QUITTANCES + AVIS });
    expect(r1.body.tco.diagnostics.open.decisions).toBe(avant - 1);
    // Persistance : décision TYPÉE sur la date, sans décision d'inclusion ; journal (qui, quoi).
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ decision: null, date_decision: 'CONFIRM_UNDATED', date_decided_by: compte.ownerUserId })]);
    expect(await journal(asset.id)).toEqual([expect.objectContaining({ action: 'CONFIRM_UNDATED', previous_decision: null, user_id: compte.ownerUserId })]);

    const r2 = await garder(asset.id, r1.body.tco, QUITTANCES);
    const r3 = await garder(asset.id, r2.body.tco, AVIS);
    expect(r3.status).toBe(200);
    const fin = r3.body.tco;
    expect(sansDate(fin)).toBeUndefined();
    expect(fin.diagnostics.open.decisions).toBe(avant - 3);
    expect(fin.summary.cumulativeCostCents).toBe(TOTAL);
    expect(fin.annual.undated).toEqual(t.annual.undated);
    expect(fin.annual.years).toEqual(t.annual.years);
    coherent(fin);
    // Les dépenses restent consultables dans « Dépenses retenues » avec « Date non établie », confirmées par l'utilisateur.
    for (const c of [ACHAT, QUITTANCES, AVIS]) {
      expect(parMontant(fin, c)).toMatchObject({ date: null, annualYear: null, dateLabel: 'Date non établie', undatedConfirmation: expect.any(Object) });
    }
    expect(confirmees(fin)).toHaveLength(3);
    expect(confirmees(fin).every((s) => s.actions.some((o: Json) => o.action === 'REVERT_UNDATED' && o.label === 'Annuler mon choix'))).toBe(true);
    // Rejouer le geste : aucune nouvelle écriture.
    const rejoue = await decide(asset.id, { lineId: parMontant(fin, AVIS).id, lineKey: parMontant(fin, AVIS).decisionKey, action: 'CONFIRM_UNDATED' });
    expect(rejoue.body.outcome).toBe('UNCHANGED');
    expect(await journal(asset.id)).toHaveLength(3);
  });

  it('L113N-E02 — persistance : nouveau GET, T3 (fiche + documents), contrôle de cohérence correctif → aucun point confirmé ne réapparaît', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await moto(compte);
    as(compte);
    let t = (await getTco(asset.id)).body.tco;
    for (const c of [ACHAT, QUITTANCES, AVIS]) t = (await garder(asset.id, t, c)).body.tco;
    expect(sansDate(t)).toBeUndefined();
    const decisions = await lignes(asset.id);
    // Fermeture / réouverture du tiroir : nouvelle lecture.
    expect(sansDate((await getTco(asset.id)).body.tco)).toBeUndefined();
    // T3 : reconsolidation des données de la fiche et des documents.
    await reconcilier(compte, asset.id);
    await k.passer(compte);
    // Contrôle quotidien de cohérence (campagne corrective, tous contrôles du registre).
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode: 'CORRECTIVE', scopeAccountIds: [compte.id] });
    for (let i = 0; i < 30; i++) { if ((await o.runCampaignStep(id, { deadline: Date.now() + 120_000 })).done) break; }
    const apres = (await getTco(asset.id)).body.tco;
    expect(sansDate(apres)).toBeUndefined();
    expect(confirmees(apres)).toHaveLength(3);
    expect(apres.summary.cumulativeCostCents).toBe(TOTAL);
    expect(await lignes(asset.id)).toEqual(decisions);
  });

  it('L113N-E03 — date fiable ajoutée ensuite (date d’achat de la fiche) : dépense datée et ventilée, aucune date inventée pour les autres', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await moto(compte);
    as(compte);
    let t = (await getTco(asset.id)).body.tco;
    for (const c of [ACHAT, QUITTANCES, AVIS]) t = (await garder(asset.id, t, c)).body.tco;
    await fiche(compte, asset.id, { acquisitionDate: '2024-05-12' });
    await reconcilier(compte, asset.id);
    const apres = (await getTco(asset.id)).body.tco;
    expect(parMontant(apres, ACHAT)).toMatchObject({ date: '2024-05-12', annualYear: 2024 });
    expect(parMontant(apres, ACHAT).undatedConfirmation).toBeUndefined();
    expect(apres.annual.years.find((y: Json) => y.year === 2024)?.costsCents).toBe(ACHAT);
    // Les échéances APRIL restent sans date (jamais la date d'échéance ni le début de période), toujours confirmées.
    for (const c of [QUITTANCES, AVIS]) expect(parMontant(apres, c)).toMatchObject({ date: null, annualYear: null, undatedConfirmation: expect.any(Object) });
    expect(sansDate(apres)).toBeUndefined();
    expect(apres.summary.cumulativeCostCents).toBe(TOTAL);
    coherent(apres);
  });

  it('L113N-E04 — « Annuler mon choix » : point rouvert si la date est toujours inconnue, montant inchangé, journalisé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await moto(compte);
    as(compte);
    const t = (await getTco(asset.id)).body.tco;
    const ok = (await garder(asset.id, t, QUITTANCES)).body.tco;
    const l = parMontant(ok, QUITTANCES);
    const option = (l.actions.options as Json[]).find((o) => o.action === 'REVERT_UNDATED');
    expect(option).toMatchObject({ label: 'Annuler mon choix' });
    const r = await decide(asset.id, { lineId: l.id, lineKey: l.decisionKey, action: 'REVERT_UNDATED' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe('REVERTED');
    expect(sansDate(r.body.tco)).toMatchObject({ count: 3 });
    expect(r.body.tco.summary.cumulativeCostCents).toBe(TOTAL);
    expect(await lignes(asset.id)).toEqual([]);
    expect((await journal(asset.id)).map((e) => [e.action, e.previous_decision])).toEqual([['CONFIRM_UNDATED', null], ['REVERT_UNDATED', 'CONFIRM_UNDATED']]);
  });

  it('L113N-E05 — dépense AJOUTÉE au TCO puis confirmée sans date : la décision d’inclusion subsiste ; retrait / ré-ajout sans perte', async () => {
    const compte = await make.account({ plan: 'premium' });
    const asset = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: 30_000_000, keyCharacteristics: { acquisitionDate: '2015-03-02' } });
    // Avis de taxe foncière sans indice T1 ni date : « nature à confirmer » ; ajouté par l'utilisateur.
    const f = await fichier(compte, asset, 'Avis de taxe foncière', 140_000, 'PROPERTY_TAX_NOTICE');
    await sql`UPDATE asset_files SET document_type = 'AUTRE' WHERE id = ${f}`;
    as(compte);
    const t = (await getTco(asset.id)).body.tco;
    const l0 = (t.lines as Json[]).find((x) => x.fileId === f)!;
    expect(l0.status).toBe('NOT_QUALIFIED');
    const inc = await decide(asset.id, { lineId: l0.id, lineKey: l0.decisionKey, action: 'INCLUDE' });
    expect(inc.status, JSON.stringify(inc.body)).toBe(200);
    const total = inc.body.tco.summary.cumulativeCostCents;
    const l1 = (inc.body.tco.lines as Json[]).find((x) => x.fileId === f)!;
    expect(l1).toMatchObject({ status: 'RETAINED_DIRECT', undated: true, userDecision: { decision: 'INCLUDE', applied: true } });
    const s = (sansDate(inc.body.tco)!.sources as Json[]).find((x) => x.lineId === l1.id)!;
    // Date du justificatif absente, aucune autre preuve : « Renseigner la date » ouvre ce justificatif.
    expect(s.actions.find((o: Json) => o.label === 'Renseigner la date')).toMatchObject({ action: 'EDIT_DOCUMENT', fileId: f });
    const c = await decide(asset.id, { lineId: l1.id, lineKey: l1.decisionKey, action: 'CONFIRM_UNDATED' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.tco.summary.cumulativeCostCents).toBe(total);
    expect(sansDate(c.body.tco)).toBeUndefined();
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ decision: 'INCLUDE', date_decision: 'CONFIRM_UNDATED' })]);
    const l2 = (c.body.tco.lines as Json[]).find((x) => x.fileId === f)!;
    expect(l2).toMatchObject({ userDecision: { decision: 'INCLUDE', applied: true }, undatedConfirmation: expect.any(Object) });
    // « Retirer du TCO » (annule l'ajout) : la confirmation de date est conservée, sans objet tant que la ligne n'est pas comptée.
    const ex = await decide(asset.id, { lineId: l2.id, lineKey: l2.decisionKey, action: 'EXCLUDE' });
    expect(ex.status).toBe(200);
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ decision: null, date_decision: 'CONFIRM_UNDATED' })]);
    expect(sansDate(ex.body.tco)).toBeUndefined();
    // Ré-ajout : la confirmation s'applique de nouveau, sans nouvelle sollicitation.
    const l3 = (ex.body.tco.lines as Json[]).find((x) => x.fileId === f)!;
    const re = await decide(asset.id, { lineId: l3.id, lineKey: l3.decisionKey, action: 'INCLUDE' });
    expect(re.status).toBe(200);
    expect(sansDate(re.body.tco)).toBeUndefined();
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ decision: 'INCLUDE', date_decision: 'CONFIRM_UNDATED' })]);
    // Date du document renseignée ensuite : la dépense est datée, la confirmation devient sans objet.
    await sql`UPDATE asset_files SET document_date = '2026-09-01' WHERE id = ${f}`;
    const date = (await getTco(asset.id)).body.tco;
    const ld = (date.lines as Json[]).find((x) => x.fileId === f)!;
    expect(ld.undatedConfirmation).toBeUndefined();
  });

  it('L113N-E06 — dépenses retirées : aucun signalement orphelin ; confirmation refusée (422) sur une ligne déjà datée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await moto(compte);
    as(compte);
    let t = (await getTco(asset.id)).body.tco;
    for (const c of [ACHAT, QUITTANCES, AVIS]) {
      const l = parMontant(t, c);
      const r = await decide(asset.id, { lineId: l.id, lineKey: l.decisionKey, action: 'EXCLUDE' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      t = r.body.tco;
    }
    expect(t.reliability.warnings).not.toContain('ECONOMIC_DATE_UNDETERMINED');
    expect(sansDate(t)).toBeUndefined();
    expect((t.diagnostics.items as Json[]).filter((d) => d.status === 'OPEN' && d.traced === false)).toEqual([]);
    // Ligne datée (prix d'un autre bien daté) : le geste n'est pas proposé, le serveur le refuse.
    const autre = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo' });
    await fiche(compte, autre.id, { acquisitionPrice: 900, acquisitionDate: '2023-04-01' });
    await reconcilier(compte, autre.id);
    const tv = (await getTco(autre.id)).body.tco;
    const lv = (tv.lines as Json[]).find((l) => l.status.startsWith('RETAINED'))!;
    expect(lv.date).toBe('2023-04-01');
    const refus = await decide(autre.id, { lineId: lv.id, lineKey: lv.decisionKey, action: 'CONFIRM_UNDATED' });
    expect(refus.status).toBe(422);
    expect(await lignes(autre.id)).toEqual([]);
  });

  it('L113N-E07 — droits et isolation : Standard 403, autre compte 404, lecture seule refusée, aucune écriture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await moto(compte);
    as(compte);
    const t = (await getTco(asset.id)).body.tco;
    const s = source(t, AVIS);
    // Autre compte : le bien n'existe pas pour lui.
    const intrus = await make.account({ plan: 'premium' });
    as(intrus);
    expect((await decide(asset.id, { lineId: s.lineId, lineKey: s.lineKey, action: 'CONFIRM_UNDATED' })).status).toBe(404);
    // Standard : TCO verrouillé (Premium), aucune écriture.
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${compte.id}`;
    as(compte);
    expect((await decide(asset.id, { lineId: s.lineId, lineKey: s.lineKey, action: 'CONFIRM_UNDATED' })).status).toBe(403);
    expect((await getTco(asset.id)).status).toBe(403);
    // Lecture seule (essai échu) : refusé.
    await sql`UPDATE account_subscriptions SET plan_code = 'premium', status = 'readonly' WHERE account_id = ${compte.id}`;
    expect([403, 423]).toContain((await decide(asset.id, { lineId: s.lineId, lineKey: s.lineKey, action: 'CONFIRM_UNDATED' })).status);
    expect(await lignes(asset.id)).toEqual([]);
    expect(await journal(asset.id)).toEqual([]);
  });

  it('L113N-E08 — migration 1515 rejouable, garde-fou « au moins une décision », fusion de reconstruction sans perte', async () => {
    const ddl = readFileSync(join(process.cwd(), 'src/db/migrations/1515_l113n_tco_depense_sans_date.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(ddl); });
    await sql.begin(async (tx) => { await tx.unsafe(ddl); });
    const compte = await make.account({ plan: 'premium' });
    const asset = await make.asset(compte, { category: 'VEHICULE', name: 'Scooter' });
    await expect(sql`INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision) VALUES (${compte.id}, ${asset.id}, 'f:1:REALIZED_COST:1:EUR', NULL)`).rejects.toThrow();
    await expect(sql`INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, date_decision) VALUES (${compte.id}, ${asset.id}, 'f:2:REALIZED_COST:1:EUR', 'CONFIRM_UNDATED')`).rejects.toThrow();
    await expect(sql`INSERT INTO asset_cost_line_decision_events (account_id, asset_id, line_key, action) VALUES (${compte.id}, ${asset.id}, 'k', 'CONFIRM_UNDATED')`).resolves.toBeDefined();
    // Reconstruction des Opérations : une décision `o:` re-clée sur la clé stable où une confirmation « sans date » existe
    // déjà — les deux sont gardées (jamais la plus récente seule), sur une seule ligne.
    const [inc] = await sql<{ id: number }[]>`
      INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, decided_at) VALUES (${compte.id}, ${asset.id}, 'o:77:REALIZED_COST:500:EUR', 'INCLUDE', now() - interval '2 days')
      RETURNING id::int AS id`;
    await sql`
      INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, date_decision, date_decided_at, date_decided_by)
      VALUES (${compte.id}, ${asset.id}, 's:AGENDA:9:REALIZED_COST:500:EUR', NULL, 'CONFIRM_UNDATED', now(), ${compte.ownerUserId})`;
    const { applyPurge } = await import('@/services/business-operations/rebuild/purge');
    await sql.begin(async (tx) => applyPurge(tx, compte.id, {
      tcoDecisionsRekeyed: [{ id: inc.id, from: 'o:77:REALIZED_COST:500:EUR', to: 's:AGENDA:9:REALIZED_COST:500:EUR' }], cardsClosed: [], projectionsRemoved: [], purged: [],
    } as never, { runId: 'e2e-l113n', now: new Date() }));
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ line_key: 's:AGENDA:9:REALIZED_COST:500:EUR', decision: 'INCLUDE', date_decision: 'CONFIRM_UNDATED', date_decided_by: compte.ownerUserId })]);
  });
});
