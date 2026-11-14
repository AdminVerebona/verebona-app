/**
 * Lot 114C — carte #769 « [P1][Pré-MEP] TCO — Fiabiliser les confirmations sans date : identité du fait, gestes,
 * compteurs et données obsolètes (#712/#722) », sur PostgreSQL 16 RÉEL (routes GET / POST du TCO, moteur,
 * persistance 1515, journal, contrôle de cohérence COH-TCO-SAME-FACT). Aucun appel IA. Assertions limitées aux
 * comptes créés ici. Montants illustratifs (jamais des règles).
 *
 *   L114C-TCO-E01 collision : UN justificatif, DEUX dépenses de même nature / montant / devise, périodes
 *                 distinctes — confirmer l'une : l'autre reste à confirmer ; annuler l'une : seule cette
 *                 confirmation tombe ; total et ventilation inchangés ; compteurs 2 → 1 → 0 ;
 *   L114C-TCO-E02 deux justificatifs distincts de même montant : aucun acquittement croisé ;
 *   L114C-TCO-E03 ancienne clé commune (stock d'avant la carte) : jamais étendue, isolée par le contrôle de
 *                 cohérence (AMBIGUOUS), reprise idempotente ; l'arbitrage ciblé la remplace ; décision
 *                 d'inclusion et journal conservés ;
 *   L114C-TCO-E04 panneau : « Retirer du TCO » depuis la même dépense ; la confirmation de date est conservée
 *                 hors effet et revient avec la dépense ; les trois quantités suivent ;
 *   L114C-TCO-E05 décision obsolète : montant ou période requalifiés après l'affichage → 409 DECISION_STALE,
 *                 aucune écriture ni journal, TCO actuel rendu ; fait inchangé → accepté ; geste sur la date
 *                 sans clé ni version → refusé ;
 *   L114C-TCO-E06 concurrence : deux requêtes identiques simultanées → une seule écriture, un seul journal ;
 *                 deux dépenses différentes simultanées → les deux écrites ; répétition : UNCHANGED.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, role: 'USER', email: '' }));
type Json = Record<string, any>;

const ECHEANCE = 31_359;
const AUJ = '2026-11-13';
const CHECK = 'COH-TCO-SAME-FACT';

scenario('L114C-TCO', 'TCO — confirmations sans date : un fait, trois issues, compteurs, décision obsolète refusée', ({ sql, make }) => {
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
  const lignes = (assetId: number) => sql<Json[]>`
    SELECT line_key, decision, date_decision, line_id FROM asset_cost_line_decisions WHERE asset_id = ${assetId} ORDER BY id`;
  const journal = (assetId: number) => sql<Json[]>`
    SELECT action, previous_decision, line_key, user_id, detail FROM asset_cost_line_decision_events WHERE asset_id = ${assetId} ORDER BY id`;
  const fichier = async (compte: AccountRow, asset: AssetRow, titre: string, cents: number) => {
    const f = await make.assetFile(compte, { assetId: asset.id });
    await sql`UPDATE asset_files SET document_type_code = 'INSURANCE_PREMIUM_NOTICE', retained_title = ${titre}, document_date = NULL, amount_cents = ${cents}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  };
  const PERIODES = [['2025-09-24', '2026-09-23'], ['2026-09-24', '2027-09-23']] as const;

  /**
   * Contrat d'assurance d'un véhicule : deux échéances de MÊME montant, périodes distinctes, sans date de
   * paiement. `unSeulFichier` : les deux échéances sont portées par le même justificatif (collision du ticket).
   */
  async function contrat(compte: AccountRow, unSeulFichier: boolean) {
    const asset = await make.asset(compte, { category: 'VEHICULE', name: 'Moto', keyCharacteristics: { acquisitionDate: '2020-01-10' } });
    const f1 = await fichier(compte, asset, 'Échéancier du contrat', 2 * ECHEANCE);
    const f2 = unSeulFichier ? f1 : await fichier(compte, asset, 'Avis d’échéance', ECHEANCE);
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => {
      const op = await repo.create({
        type: { code: 'CONTRACT' }, status: 'REALIZED', startDate: '2025-09-24',
        source: { kind: 'DOCUMENT', entityKey: f1, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: asset.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L114C',
      });
      const s2 = unSeulFichier ? op.sourceId : await repo.addSource(op.id, { kind: 'DOCUMENT', entityKey: f2, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' }, 'E2E_L114C');
      for (const [i, [debut, fin]] of PERIODES.entries()) {
        await repo.addFinancialComponent(op.id, {
          kind: 'REALIZED_COST', amountMinor: ECHEANCE, currency: 'EUR', periodStart: debut, periodEnd: fin,
          sources: [{ sourceId: i === 0 ? op.sourceId : s2 }], fingerprint: `e2e-l114c-${asset.id}-${i}`,
        } as never, 'E2E_L114C');
      }
    });
    return { asset, f1, f2 };
  }
  /** Dépenses du panneau « Renseigner les dates », dans l'ordre des périodes. */
  const panneau = (tco: Json): Json[] => [...(tco.undatedExpenses.items as Json[])].sort((a, b) => String(a.lineKey).localeCompare(String(b.lineKey)));
  const compteurs = (tco: Json) => [tco.undatedExpenses.count, tco.undatedExpenses.pendingCount, tco.undatedExpenses.confirmedCount];
  const geste = (i: Json, action: string) => ({ lineId: i.lineId, lineKey: i.lineKey, lineVersion: i.lineVersion, action });
  const item = (tco: Json, lineId: string) => (tco.undatedExpenses.items as Json[]).find((i) => i.lineId === lineId)!;

  it('L114C-TCO-E01 — collision : même justificatif, deux échéances de même montant — une confirmation, un fait ; annulation ciblée ; total inchangé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset, f1 } = await contrat(compte, true);
    as(compte);
    const r0 = await getTco(asset.id);
    expect(r0.status, JSON.stringify(r0.body)).toBe(200);
    const t0 = r0.body.tco;
    expect(t0.summary.cumulativeCostCents).toBe(2 * ECHEANCE);
    expect(compteurs(t0)).toEqual([2, 2, 0]);
    const [a, b] = panneau(t0);
    const base = `f:${f1}:REALIZED_COST:${ECHEANCE}:EUR`;
    expect(a.lineKey).toBe(`${base}#p:${PERIODES[0][0]}~${PERIODES[0][1]}`);
    expect(b.lineKey).toBe(`${base}#p:${PERIODES[1][0]}~${PERIODES[1][1]}`);

    const r1 = await decide(asset.id, geste(a, 'CONFIRM_UNDATED'));
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.outcome).toBe('SET');
    const t1 = r1.body.tco;
    // L'autre échéance reste sans date ET à confirmer ; total, ventilation et nombre de dépenses sans date inchangés.
    expect(compteurs(t1)).toEqual([2, 1, 1]);
    expect(item(t1, a.lineId)).toMatchObject({ confirmedUndated: true });
    expect(item(t1, b.lineId)).toMatchObject({ confirmedUndated: false });
    expect(item(t1, b.lineId).options.map((o: Json) => o.action)).toContain('CONFIRM_UNDATED');
    expect(t1.summary.cumulativeCostCents).toBe(2 * ECHEANCE);
    expect(t1.annual).toEqual(t0.annual);
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ line_key: a.lineKey, decision: null, date_decision: 'CONFIRM_UNDATED', line_id: a.lineId })]);
    // Persistance : nouvelle lecture identique.
    expect(compteurs((await getTco(asset.id)).body.tco)).toEqual([2, 1, 1]);

    const r2 = await decide(asset.id, geste(item(t1, b.lineId), 'CONFIRM_UNDATED'));
    expect(compteurs(r2.body.tco)).toEqual([2, 0, 2]);
    expect((await lignes(asset.id)).map((l) => l.line_key).sort()).toEqual([a.lineKey, b.lineKey].sort());

    // Annuler l'une : seule cette confirmation est annulée.
    const r3 = await decide(asset.id, geste(item(r2.body.tco, a.lineId), 'REVERT_UNDATED'));
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);
    expect(r3.body.outcome).toBe('REVERTED');
    expect(compteurs(r3.body.tco)).toEqual([2, 1, 1]);
    expect(item(r3.body.tco, a.lineId).confirmedUndated).toBe(false);
    expect(item(r3.body.tco, b.lineId).confirmedUndated).toBe(true);
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ line_key: b.lineKey, date_decision: 'CONFIRM_UNDATED' })]);
    expect(r3.body.tco.summary.cumulativeCostCents).toBe(2 * ECHEANCE);
    const j = await journal(asset.id);
    expect(j.map((e) => [e.action, e.line_key])).toEqual([['CONFIRM_UNDATED', a.lineKey], ['CONFIRM_UNDATED', b.lineKey], ['REVERT_UNDATED', a.lineKey]]);
    expect(j[0]).toMatchObject({ user_id: compte.ownerUserId, detail: { scope: 'ECONOMIC_DATE', stableKey: base, version: a.lineVersion, period: { start: PERIODES[0][0], end: PERIODES[0][1] } } });
  });

  it('L114C-TCO-E02 — deux justificatifs distincts de même montant : aucun acquittement croisé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset, f1, f2 } = await contrat(compte, false);
    as(compte);
    const t0 = (await getTco(asset.id)).body.tco;
    expect(compteurs(t0)).toEqual([2, 2, 0]);
    const a = (t0.undatedExpenses.items as Json[]).find((i) => i.lineKey === `f:${f1}:REALIZED_COST:${ECHEANCE}:EUR`)!;
    const b = (t0.undatedExpenses.items as Json[]).find((i) => i.lineKey === `f:${f2}:REALIZED_COST:${ECHEANCE}:EUR`)!;
    expect(a && b).toBeTruthy();
    const r = await decide(asset.id, geste(a, 'CONFIRM_UNDATED'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(item(r.body.tco, a.lineId).confirmedUndated).toBe(true);
    expect(item(r.body.tco, b.lineId).confirmedUndated).toBe(false);
    expect(compteurs(r.body.tco)).toEqual([2, 1, 1]);
  });

  it('L114C-TCO-E03 — ancienne clé commune : jamais étendue, isolée par le contrôle de cohérence, reprise idempotente ; l’arbitrage ciblé la remplace', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset, f1 } = await contrat(compte, true);
    const base = `f:${f1}:REALIZED_COST:${ECHEANCE}:EUR`;
    // Stock d'avant la carte : UNE confirmation sous la clé commune (ligne d'origine remplacée depuis), et une
    // décision d'inclusion sans rapport sur une autre clé (à conserver).
    await sql`INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, line_id, amount_minor, currency, label, file_id, decided_by, decided_at, updated_at, date_decision, date_decided_at, date_decided_by)
              VALUES (${compte.id}, ${asset.id}, ${base}, NULL, 'c:1', ${ECHEANCE}, 'EUR', 'Échéance', ${f1}, NULL, now(), now(), 'CONFIRM_UNDATED', now() - interval '3 days', ${compte.ownerUserId})`;
    await sql`INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, line_id, amount_minor, currency, label, file_id, decided_by, decided_at, updated_at)
              VALUES (${compte.id}, ${asset.id}, 'f:999999:REALIZED_COST:100:EUR', 'EXCLUDE', 'doc:999999', 100, 'EUR', 'Autre', NULL, ${compte.ownerUserId}, now(), now())`;
    await sql`INSERT INTO asset_cost_line_decision_events (account_id, asset_id, line_key, action, previous_decision, line_id, amount_minor, currency, label, user_id)
              VALUES (${compte.id}, ${asset.id}, ${base}, 'CONFIRM_UNDATED', NULL, 'c:1', ${ECHEANCE}, 'EUR', 'Échéance', ${compte.ownerUserId})`;
    as(compte);
    const t0 = (await getTco(asset.id)).body.tco;
    // Aucune des deux échéances n'est acquittée en silence : les deux sont « à confirmer ».
    expect(compteurs(t0)).toEqual([2, 2, 0]);
    expect(t0.summary.cumulativeCostCents).toBe(2 * ECHEANCE);
    // Lecture répétée : même résultat, aucune écriture (reprise idempotente).
    const avant = await lignes(asset.id);
    expect(compteurs((await getTco(asset.id)).body.tco)).toEqual([2, 2, 0]);
    expect(await lignes(asset.id)).toEqual(avant);

    // Contrôle de cohérence : le cas est isolé « à arbitrer », sans réparation.
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    await controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode: 'CORRECTIVE', correlationId: `coherence:e2e-114c:${CHECK}` },
      check: getCheck(CHECK)!, accountId: compte.id, ids: [asset.id], trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
    const [preuve] = await sql<Json[]>`SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${compte.id} AND check_id = ${CHECK} AND object_id = ${asset.id}`;
    expect(preuve.last_result).toBe('AMBIGUOUS');
    expect(JSON.stringify(preuve.finding)).toContain('UNDATED_CONFIRMATION_AMBIGUOUS');
    expect(await lignes(asset.id)).toEqual(avant);

    // Arbitrage ciblé : l'utilisateur confirme UNE échéance — l'ancienne clé commune est remplacée (journal conservé).
    const [a, b] = panneau(t0);
    const r = await decide(asset.id, geste(a, 'CONFIRM_UNDATED'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(compteurs(r.body.tco)).toEqual([2, 1, 1]);
    expect(item(r.body.tco, b.lineId).confirmedUndated).toBe(false);
    expect((await lignes(asset.id)).map((l) => [l.line_key, l.decision, l.date_decision]).sort()).toEqual([
      [a.lineKey, null, 'CONFIRM_UNDATED'], ['f:999999:REALIZED_COST:100:EUR', 'EXCLUDE', null],
    ].sort());
    const j = await journal(asset.id);
    expect(j).toHaveLength(2);
    expect(j[1]).toMatchObject({ action: 'CONFIRM_UNDATED', line_key: a.lineKey, detail: { supersededKeys: [base] } });
    expect(r.body.tco.undatedConfirmations?.ambiguous).toBeUndefined();
  });

  it('L114C-TCO-E04 — panneau : « Retirer du TCO » depuis la même dépense ; confirmation de date conservée hors effet, de retour avec la dépense', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await contrat(compte, false);
    as(compte);
    const t0 = (await getTco(asset.id)).body.tco;
    const [a, b] = panneau(t0);
    for (const i of [a, b]) expect(i.options.map((o: Json) => o.label)).toEqual(['Conserver dans le TCO sans date', 'Retirer du TCO']);
    const c = await decide(asset.id, geste(a, 'CONFIRM_UNDATED'));
    expect(compteurs(c.body.tco)).toEqual([2, 1, 1]);
    const conf = item(c.body.tco, a.lineId);
    expect(conf.options.map((o: Json) => o.label)).toEqual(['Annuler mon choix', 'Retirer du TCO']);
    // Retrait : décision d'inclusion existante (EXCLUDE) — jamais un acquittement de la date.
    const ex = await decide(asset.id, geste(conf, 'EXCLUDE'));
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    expect(ex.body.tco.summary.cumulativeCostCents).toBe(ECHEANCE);
    expect(compteurs(ex.body.tco)).toEqual([1, 1, 0]);
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ line_key: a.lineKey, decision: 'EXCLUDE', date_decision: 'CONFIRM_UNDATED' })]);
    // Réversible : « Ajouter au TCO » depuis les dépenses non retenues — la confirmation de date revient avec elle.
    const retiree = (ex.body.tco.lines as Json[]).find((l) => l.id === a.lineId)!;
    expect(retiree).toMatchObject({ status: 'EXCLUDED', userDecision: { decision: 'EXCLUDE', applied: true } });
    const re = await decide(asset.id, { lineId: retiree.id, lineKey: retiree.decisionKey, lineVersion: retiree.version, action: 'INCLUDE' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.tco.summary.cumulativeCostCents).toBe(2 * ECHEANCE);
    expect(compteurs(re.body.tco)).toEqual([2, 1, 1]);
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ decision: null, date_decision: 'CONFIRM_UNDATED' })]);
  });

  it('L114C-TCO-E05 — décision obsolète : montant ou période requalifiés après l’affichage → 409 DECISION_STALE, aucune écriture ; fait inchangé → accepté', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await contrat(compte, false);
    as(compte);
    const t0 = (await getTco(asset.id)).body.tco;
    const [a, b] = panneau(t0);
    const idA = Number(String(a.lineId).slice(2));
    const idB = Number(String(b.lineId).slice(2));
    // Geste sur la date sans clé ni version : la seule égalité de l'identifiant technique ne suffit pas.
    const nu = await decide(asset.id, { lineId: a.lineId, action: 'CONFIRM_UNDATED' });
    expect(nu.status).toBe(409);
    expect(nu.body.code).toBe('DECISION_STALE');

    // Requalification de la PÉRIODE de A après l'affichage (même identifiant, même clé stable).
    await sql`UPDATE business_operation_financial_components SET period_start = '2025-10-01', period_end = '2026-09-30' WHERE id = ${idA} AND account_id = ${compte.id}`;
    const r1 = await decide(asset.id, geste(a, 'CONFIRM_UNDATED'));
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ code: 'DECISION_STALE', message: 'Cette dépense a changé, vérifiez ses nouvelles informations', canEdit: true });
    // Informations pour rafraîchir la vue : le TCO actuel, avec la nouvelle version de la dépense.
    const frais = item(r1.body.tco, a.lineId);
    expect(frais.lineVersion).not.toBe(a.lineVersion);
    // Même refus pour l'annulation et pour un geste d'inclusion portés par l'ancienne vue.
    expect((await decide(asset.id, geste(a, 'REVERT_UNDATED'))).body.code).toBe('DECISION_STALE');
    expect((await decide(asset.id, geste(a, 'EXCLUDE'))).body.code).toBe('DECISION_STALE');

    // Requalification du MONTANT de B (même identifiant technique) : la clé affichée ne désigne plus la dépense.
    await sql`UPDATE business_operation_financial_components SET amount_minor = ${ECHEANCE + 100} WHERE id = ${idB} AND account_id = ${compte.id}`;
    const r2 = await decide(asset.id, geste(b, 'CONFIRM_UNDATED'));
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('DECISION_STALE');
    // Aucun choix écrit, aucun journal.
    expect(await lignes(asset.id)).toEqual([]);
    expect(await journal(asset.id)).toEqual([]);

    // Vue rafraîchie (fait inchangé depuis) : la décision est acceptée.
    const ok = await decide(asset.id, geste(frais, 'CONFIRM_UNDATED'));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.outcome).toBe('SET');
    expect(await journal(asset.id)).toHaveLength(1);
  });

  it('L114C-TCO-E06 — concurrence : requêtes identiques simultanées → une écriture, un journal ; dépenses différentes simultanées → les deux ; répétition : UNCHANGED', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { asset } = await contrat(compte, true);
    as(compte);
    const t0 = (await getTco(asset.id)).body.tco;
    const [a, b] = panneau(t0);
    // Deux sessions envoient le MÊME geste en même temps.
    const memes = await Promise.all([decide(asset.id, geste(a, 'CONFIRM_UNDATED')), decide(asset.id, geste(a, 'CONFIRM_UNDATED'))]);
    expect(memes.map((r) => r.status)).toEqual([200, 200]);
    expect(memes.map((r) => r.body.outcome).sort()).toEqual(['SET', 'UNCHANGED']);
    expect(await lignes(asset.id)).toHaveLength(1);
    expect(await journal(asset.id)).toHaveLength(1);
    // Répétition stricte : idempotente.
    const rejoue = await decide(asset.id, geste(a, 'CONFIRM_UNDATED'));
    expect(rejoue.body.outcome).toBe('UNCHANGED');
    expect(await journal(asset.id)).toHaveLength(1);
    // Deux sessions, deux gestes différents en même temps (annuler A, confirmer B) : les deux sont écrits, chacun une fois.
    const croises = await Promise.all([decide(asset.id, geste(a, 'REVERT_UNDATED')), decide(asset.id, geste(b, 'CONFIRM_UNDATED'))]);
    expect(croises.map((r) => r.status)).toEqual([200, 200]);
    expect(croises.map((r) => r.body.outcome)).toEqual(['REVERTED', 'SET']);
    expect(await lignes(asset.id)).toEqual([expect.objectContaining({ line_key: b.lineKey, date_decision: 'CONFIRM_UNDATED' })]);
    expect((await journal(asset.id)).map((e) => e.action).sort()).toEqual(['CONFIRM_UNDATED', 'CONFIRM_UNDATED', 'REVERT_UNDATED']);
    const fin = (await getTco(asset.id)).body.tco;
    expect(compteurs(fin)).toEqual([2, 1, 1]);
    expect(fin.summary.cumulativeCostCents).toBe(2 * ECHEANCE);
  });
});
