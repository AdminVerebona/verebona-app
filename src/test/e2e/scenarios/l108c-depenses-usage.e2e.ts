/**
 * Lot 108C (ticket TCO-646 §E) — dépenses d'usage = estimation
 * COMPLÉMENTAIRE, sur PostgreSQL 16 réel (migrations 1050 et 1051 réelles).
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats (tickets),
 * service TCO réel (`readAssetTco`, date de référence fixée pour des
 * montants exacts), routes HTTP réelles des forfaits (création, révision
 * datée, chevauchement refusé, arrêt, suppression), du classement d'une
 * dépense et des décisions « Retirer du TCO ». Seules les sessions sont
 * simulées. Aucun appel IA. Assertions limitées aux comptes créés ici.
 *
 *   L108C-E01 forfait carburant 100 € / mois + tickets 0 / 40 / 140 € : complément
 *             100 + 60 + 0, coût documenté strictement réel, TCO avec
 *             estimations = documenté + 160 € ; route GET ; T2 annonce la part estimée ;
 *   L108C-E02 ticket ajouté puis retiré du TCO : le complément se recalcule, le
 *             total avec estimations ne saute pas ; le document reste en base ;
 *   L108C-E03 révision datée (PATCH effectiveFrom) : périodes closes inchangées,
 *             nouvelle version liée ; chevauchement refusé (409) ; arrêt et
 *             suppression complète ;
 *   L108C-E04 dépense sans vocabulaire : à classer ; classement utilisateur
 *             (route), « pas une dépense d'usage », annulation ; Standard 403 ;
 *   L108C-E05 migrations 1050 / 1051 rejouables sans effet.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, role: 'USER', email: '' }));
type Json = Record<string, any>;

const AUJOURDHUI = '2026-11-03';
const PRIX = 1_000_000;

scenario('L108C', 'TCO — dépenses d’usage : estimation complémentaire max(forfait, réel)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role, email: session.email }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const as = (compte: AccountRow) => { session.currentAccountId = compte.id; session.userId = compte.ownerUserId; session.role = 'USER'; };
  const req = (method: string, url: string, body?: unknown) => new NextRequest(`http://x${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ctx = <E extends Record<string, string> = Record<never, string>>(id: number, extra?: E) =>
    ({ params: Promise.resolve({ id: String(id), ...(extra ?? {}) } as { id: string } & E) });
  const tco = async (compte: AccountRow, assetId: number) => {
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    return readAssetTco(compte.id, assetId, { today: AUJOURDHUI });
  };
  const creerForfait = async (assetId: number, body: Json) => {
    const { POST } = await import('@/app/api/assets/[id]/usage-budgets/route');
    const res = await POST(req('POST', `/api/assets/${assetId}/usage-budgets`, body), ctx(assetId));
    return { status: res.status, body: await res.json() as Json };
  };
  const ticket = (compte: AccountRow, assetId: number, titre: string, cents: number, date: string, n: string) => k.document(compte, assetId, [cand({
    typeHint: 'OTHER', summary: titre, provider: 'Station', sourceRoleHint: 'INVOICE', targetHints: [cible(assetId)],
    businessReferences: [ref('INVOICE', `T-${n}`)], temporalHints: { realizedDate: date }, financialHints: [fh('REALIZED_COST', cents, { economicDate: date })],
  })], { title: titre, amountCents: cents, date });

  async function vehicule(compte: AccountRow) {
    const auto = await make.asset(compte, { category: 'VEHICULE', name: 'Voiture', purchasePriceCents: PRIX, keyCharacteristics: { acquisitionDate: '2026-01-01' } });
    as(compte);
    const f = await creerForfait(auto.id, { category: 'FUEL', amountMinor: 10_000, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2026-08-01', validTo: null });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    return { auto, forfaitId: Number(f.body.id) };
  }
  const fenetre = (t: Json, debut: string, key = 'FUEL') => (t.usage.complement.windows as Json[]).find((w) => w.key === key && w.periodStart === debut)!;

  it('L108C-E01 — forfait 100 € / mois, tickets 0 / 40 / 140 € : complément 100 + 60 + 0 ; documenté inchangé ; GET et T2', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { auto } = await vehicule(compte);
    await ticket(compte, auto.id, 'Ticket carburant septembre', 4_000, '2026-09-12', 'S');
    await ticket(compte, auto.id, 'Plein gazole octobre', 14_000, '2026-10-05', 'O');
    const t = await tco(compte, auto.id) as unknown as Json;
    expect(t.summary.cumulativeCostCents).toBe(PRIX + 4_000 + 14_000);
    expect([fenetre(t, '2026-08-01'), fenetre(t, '2026-09-01'), fenetre(t, '2026-10-01')].map((w) => [w.realCents, w.complementCents, w.contributionCents]))
      .toEqual([[0, 10_000, 10_000], [4_000, 6_000, 10_000], [14_000, 0, 14_000]]);
    expect(fenetre(t, '2026-11-01').closed).toBe(false);
    expect(t.summary.estimatedUsageComplementCents).toBe(16_000);
    expect(t.summary.totalWithEstimatesCents).toBe(PRIX + 18_000 + 16_000);
    // Les tickets restent des lignes réelles retenues, inchangées ; aucune Opération créée par l'estimation.
    expect((t.lines as Json[]).filter((l) => l.includedCents === 4_000 || l.includedCents === 14_000)).toHaveLength(2);
    const [ops] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id}`;
    expect(ops.n).toBe(0);
    // Route réelle (date du jour réelle : au moins les trois mois échus ci-dessus).
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const g = await GET(req('GET', `/api/assets/${auto.id}/tco`), ctx(auto.id));
    const body = await g.json() as Json;
    expect(g.status).toBe(200);
    expect(body.tco.summary.cumulativeCostCents).toBe(PRIX + 18_000);
    expect(body.tco.summary.estimatedUsageComplementCents).toBeGreaterThanOrEqual(16_000);
    expect(body.tco.usageLabels.budgetStatuses.APPLIED).toBeTruthy();
    // T2 : coût documenté annoncé tel quel, puis TCO complet estimé avec la part estimée.
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const r = ownershipCostAnswer({ id: auto.id, name: 'Voiture' } as never, t as never) as { answer: string; sources: Array<{ meta: Json }> };
    expect(r.answer).toContain('coût cumulé documenté 10');
    expect(r.answer).toMatch(/En incluant les estimations de dépenses d’usage \(160,00\s€ estimés/);
    expect(r.sources[0].meta).toMatchObject({ cumulativeCostCents: PRIX + 18_000, estimatedUsageComplementCents: 16_000, totalWithEstimatesCents: PRIX + 34_000 });
  });

  it('L108C-E02 — ticket ajouté puis retiré du TCO : complément recalculé, total avec estimations stable ; document conservé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { auto } = await vehicule(compte);
    const avant = await tco(compte, auto.id) as unknown as Json;
    const doc = await ticket(compte, auto.id, 'Ticket carburant août', 3_000, '2026-08-20', 'A');
    const apres = await tco(compte, auto.id) as unknown as Json;
    expect(fenetre(apres, '2026-08-01')).toMatchObject({ realCents: 3_000, complementCents: 7_000 });
    expect(apres.summary.totalWithEstimatesCents).toBe(avant.summary.totalWithEstimatesCents);
    expect(apres.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents + 3_000);
    // Retrait par l'utilisateur (« Retirer du TCO ») : la dépense ne compte plus, l'estimation reprend sa place.
    const ligne = (apres.lines as Json[]).find((l) => l.fileId === doc && l.includedCents === 3_000)!;
    const { POST } = await import('@/app/api/assets/[id]/tco/decisions/route');
    const r = await POST(req('POST', `/api/assets/${auto.id}/tco/decisions`, { lineId: ligne.id, lineKey: ligne.decisionKey, action: 'EXCLUDE' }), ctx(auto.id));
    expect(r.status).toBe(200);
    const retire = await tco(compte, auto.id) as unknown as Json;
    expect(fenetre(retire, '2026-08-01')).toMatchObject({ realCents: 0, complementCents: 10_000 });
    expect(retire.summary.totalWithEstimatesCents).toBe(avant.summary.totalWithEstimatesCents);
    const [f] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE id = ${doc}`;
    expect(f.n).toBe(1);
  });

  it('L108C-E03 — révision datée, chevauchement refusé, arrêt puis suppression complète', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { auto, forfaitId } = await vehicule(compte);
    const { PATCH, DELETE } = await import('@/app/api/assets/[id]/usage-budgets/[budgetId]/route');
    const p = await PATCH(req('PATCH', `/api/assets/${auto.id}/usage-budgets/${forfaitId}`, {
      category: 'FUEL', amountMinor: 12_000, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2026-08-01', validTo: null, effectiveFrom: '2026-10-01',
    }), ctx(auto.id, { budgetId: String(forfaitId) }));
    const pb = await p.json() as Json;
    expect(p.status, JSON.stringify(pb)).toBe(200);
    expect(pb).toMatchObject({ revised: true, effectiveFrom: '2026-10-01' });
    const lignes = await sql<{ id: number; amount_minor: string; valid_from: string; valid_to: string | null; revises_budget_id: number | null }[]>`
      SELECT id::int, amount_minor::text, valid_from::text, valid_to::text, revises_budget_id::int FROM asset_usage_budgets WHERE asset_id = ${auto.id} ORDER BY id`;
    expect(lignes.map((l) => [Number(l.amount_minor), l.valid_from, l.valid_to, l.revises_budget_id])).toEqual([
      [10_000, '2026-08-01', '2026-09-30', null], [12_000, '2026-10-01', null, forfaitId],
    ]);
    const t = await tco(compte, auto.id) as unknown as Json;
    expect([fenetre(t, '2026-08-01').forfaitCents, fenetre(t, '2026-09-01').forfaitCents, fenetre(t, '2026-10-01').forfaitCents]).toEqual([10_000, 10_000, 12_000]);
    expect(t.usage.complement.warnings).not.toContain('USAGE_BUDGET_OVERLAP');
    // Chevauchement : refusé avec un message explicite, rien n'est écrit.
    const doublon = await creerForfait(auto.id, { category: 'FUEL', amountMinor: 5_000, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2026-10-15', validTo: null });
    expect(doublon.status).toBe(409);
    expect(doublon.body).toMatchObject({ code: 'USAGE_BUDGET_OVERLAP', message: expect.stringMatching(/couvre déjà/) });
    // Autre catégorie : accepté (rapprochement catégoriel).
    expect((await creerForfait(auto.id, { category: 'TOLLS', amountMinor: 3_000, currency: 'EUR', periodicity: 'MONTHLY', validFrom: '2026-10-01', validTo: null })).status).toBe(201);
    // Arrêt : la version courante se termine à la fin de la dernière période échue (date réelle du jour).
    const nouvelle = lignes[1].id;
    const s = await DELETE(req('DELETE', `/api/assets/${auto.id}/usage-budgets/${nouvelle}?mode=STOP`), ctx(auto.id, { budgetId: String(nouvelle) }));
    expect(s.status).toBe(200);
    const [arrete] = await sql<{ valid_to: string | null }[]>`SELECT valid_to::text FROM asset_usage_budgets WHERE id = ${nouvelle}`;
    expect(arrete.valid_to).not.toBeNull();
    expect(arrete.valid_to! < new Date().toISOString().slice(0, 10)).toBe(true);
    // Suppression complète (saisie erronée) : toutes les versions.
    const e = await DELETE(req('DELETE', `/api/assets/${auto.id}/usage-budgets/${nouvelle}?mode=ERASE_HISTORY`), ctx(auto.id, { budgetId: String(nouvelle) }));
    expect(e.status).toBe(200);
    const reste = await sql<{ category: string }[]>`SELECT category FROM asset_usage_budgets WHERE asset_id = ${auto.id}`;
    expect(reste.map((x) => x.category)).toEqual(['TOLLS']);
  });

  it('L108C-E04 — dépense sans vocabulaire : à classer ; classement, « pas une dépense d’usage », annulation ; Standard 403', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { auto } = await vehicule(compte);
    await ticket(compte, auto.id, 'Station Total Lyon', 5_000, '2026-08-10', 'X');
    const t = await tco(compte, auto.id) as unknown as Json;
    expect(fenetre(t, '2026-08-01').realCents).toBe(0);
    const u = (t.usage.complement.unclassified as Json[])[0];
    expect(u).toMatchObject({ cents: 5_000, ambiguous: [] });
    const { POST } = await import('@/app/api/assets/[id]/tco/usage-assignments/route');
    const classer = async (category: string | null) => {
      const res = await POST(req('POST', `/api/assets/${auto.id}/tco/usage-assignments`, { lineId: u.lineId, lineKey: u.decisionKey, category }), ctx(auto.id));
      return { status: res.status, body: await res.json() as Json };
    };
    const c1 = await classer('FUEL');
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    const w = (c1.body.tco.usage.complement.windows as Json[]).find((x) => x.key === 'FUEL' && x.periodStart === '2026-08-01')!;
    expect(w).toMatchObject({ realCents: 5_000, complementCents: 5_000 });
    expect(w.lines[0].basis).toBe('USER');
    const [persiste] = await sql<{ usage_category: string; line_key: string }[]>`SELECT usage_category, line_key FROM asset_usage_line_assignments WHERE asset_id = ${auto.id}`;
    expect(persiste).toMatchObject({ usage_category: 'FUEL', line_key: u.decisionKey });
    expect(fenetre(await tco(compte, auto.id) as unknown as Json, '2026-08-01').realCents).toBe(5_000);
    // « Pas une dépense d'usage » : jamais rapprochée, plus proposée au classement.
    await classer('NONE');
    const t2 = await tco(compte, auto.id) as unknown as Json;
    expect(fenetre(t2, '2026-08-01').realCents).toBe(0);
    expect(t2.usage.complement.unclassified).toHaveLength(0);
    // Annulation : retour au classement automatique.
    await classer(null);
    expect((await tco(compte, auto.id) as unknown as Json).usage.complement.unclassified).toHaveLength(1);
    expect(await sql`SELECT id FROM asset_usage_line_assignments WHERE asset_id = ${auto.id}`).toHaveLength(0);
    // Standard : aucun classement, aucun forfait.
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${compte.id}`;
    expect((await classer('FUEL')).status).toBe(403);
    expect((await creerForfait(auto.id, { category: 'TOLLS', amountMinor: 1, currency: 'EUR', periodicity: 'YEARLY' })).status).toBe(403);
  });

  it('L108C-E05 — migrations 1050 / 1051 rejouables sans effet (idempotentes)', async () => {
    for (const f of ['1050_l108c_forfaits_usage_revisions.sql', '1051_l108c_classement_depenses_usage.sql']) {
      const m = readFileSync(join(process.cwd(), 'src/db/migrations', f), 'utf8');
      await sql.begin(async (tx) => { await tx.unsafe(m); });
      await sql.begin(async (tx) => { await tx.unsafe(m); });
    }
    const [n] = await sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'asset_usage_line_assignments_isolation_guard'`;
    expect(n.n).toBe(1);
    const [c] = await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'asset_usage_budgets' AND column_name = 'revises_budget_id'`;
    expect(c.n).toBe(1);
  });
});
