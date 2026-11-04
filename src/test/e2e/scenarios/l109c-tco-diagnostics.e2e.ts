/**
 * Lot 109C — ticket P2 « TCO — rationaliser les alertes de couverture et
 * rendre chaque anomalie contextualisée et actionnable », sur PostgreSQL 16
 * réel.
 *
 * Chemins de PRODUCTION : service TCO réel (`readAssetTco` → `computeTco`,
 * état persisté de la récupération 108B), route HTTP réelle de la fiche
 * (`toTcoDto` → `diagnostics`), route réelle du diagnostic BO, contrôle de
 * cohérence réel `COH-TCO-AMOUNT-RECOVERY` pour l'échec de récupération.
 * Seule la session est simulée. Aucun appel IA. Assertions limitées aux
 * comptes créés ici.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { operationsKit, RECETTE_TODAY } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));

scenario('L109C', 'TCO — diagnostics structurés : anomalies, couverture et informations contextualisées', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const getTco = async (c: AccountRow, assetId: number) => {
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const velo = (c: AccountRow): Promise<AssetRow> =>
    make.asset(c, { category: 'OBJET', name: 'Vélo', purchasePriceCents: 30_000, keyCharacteristics: { acquisitionDate: '2024-03-01' } });
  /** Dépense consolidée (événement de référence + composante + justificatif), comme les lots 76G / 81D. */
  const depense = async (c: AccountRow, a: AssetRow, o: { status: string; cents: number; date: string | null; realized?: string | null; planned?: string | null }) => {
    const [op] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date, planned_date)
      VALUES (${c.id}, 'INTERVENTION', ${o.status}, 'Entretien L109C', 'Atelier', ${o.realized ?? null}, ${o.planned ?? null}) RETURNING id`;
    const [comp] = await sql<{ id: number }[]>`
      INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, active, economic_date)
      VALUES (${c.id}, ${op.id}, 'REALIZED_COST', ${o.cents}, 'EUR', true, ${o.date}) RETURNING id`;
    const f = await make.assetFile(c, { assetId: a.id });
    // Justificatif portant le montant de la dépense (sinon « montant absent de son justificatif », signal réel du moteur).
    await sql`UPDATE asset_files SET amount_cents = ${o.cents} WHERE id = ${f.id}`;
    const [src] = await sql<{ id: number }[]>`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority, confidence, active)
      VALUES (${c.id}, ${op.id}, 'DOCUMENT', ${String(f.id)}, 'INVOICE', 'DOCUMENT', 'certain', true) RETURNING id`;
    await sql`INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, is_primary) VALUES (${comp.id}, ${src.id}, true)`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active) VALUES (${c.id}, ${op.id}, ${a.id}, 'PRIMARY', 'DOCUMENT', true)`;
    return { op: op.id, component: comp.id, fileId: f.id };
  };
  const cartes = async (c: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${c.id}`)[0].n;
  const ouverts = (tco: Record<string, any>) => (tco.diagnostics.items as Array<Record<string, any>>).filter((d) => d.status === 'OPEN').map((d) => d.code);
  const diag = (tco: Record<string, any>, code: string) => (tco.diagnostics.items as any[]).find((d) => d.code === code);

  it('L109C-E01 — dépense prévue non payée : exclue avec motif, aucun point à vérifier, aucune contradiction ; Standard : 403 avant toute lecture', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    const avant = (await getTco(c, v.id)).body.tco;
    const { component, fileId } = await depense(c, v, { status: 'ENVISAGED', cents: 30_000, date: '2027-01-15', planned: '2027-01-15' });
    const r = await getTco(c, v.id);
    expect(r.status).toBe(200);
    const t = r.body.tco;
    expect(t.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents);
    expect(t.status).toBe(avant.status);
    expect(t.reliability.warnings).not.toContain('STATUS_CONTRADICTIONS');
    expect(ouverts(t)).toEqual([]);
    expect(diag(t, 'NOT_REALIZED_EXPENSES')).toMatchObject({ nature: 'INFORMATION', status: 'INFORMATIONAL', count: 1 });
    expect(diag(t, 'NOT_REALIZED_EXPENSES').sources[0]).toMatchObject({ lineId: `c:${component}`, fileId, retained: false });
    expect(t.otherLinesByReason).toEqual([expect.objectContaining({ reason: 'NOT_REALIZED', count: 1, review: 0 })]);
    // Rétrocompatibilité : libellés historiques transmis (sans promesse « à leur date de paiement »).
    expect(t.warningLabels.join(' ')).not.toMatch(/le seront à leur date de paiement/);
    expect(await cartes(c)).toBe(0);
    const s = await make.account({ plan: 'standard' });
    const vs = await velo(s);
    const verrou = await getTco(s, vs.id);
    expect(verrou.status).toBe(403);
    expect(verrou.body.tco).toBeUndefined();
  });

  it('L109C-E02 — « réalisée » datée après aujourd’hui : anomalie précise (justificatif, date) ; correction de la date → disparition et recalcul', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    const { op, component, fileId } = await depense(c, v, { status: 'REALIZED', cents: 20_000, date: '2027-02-01', realized: '2027-02-01' });
    const t = (await getTco(c, v.id)).body.tco;
    expect(ouverts(t)).toEqual(['STATUS_CONTRADICTIONS']);
    const d = diag(t, 'STATUS_CONTRADICTIONS');
    expect(d).toMatchObject({ nature: 'ANOMALY', count: 1, traced: true, action: { kind: 'OPEN_DOCUMENT' } });
    expect(d.sources[0]).toMatchObject({ lineId: `c:${component}`, fileId, operationId: Number(op), visible: true });
    expect(d.sources[0].detail).toMatch(/« réalisée » mais datée du 01\/02\/2027/);
    expect(t.diagnostics.reviewLineIds).toEqual([`c:${component}`]);
    // Correction de la date (source) : le diagnostic disparaît, le coût est recalculé.
    await sql`UPDATE business_operations SET realized_date = '2026-09-01' WHERE id = ${op}`;
    await sql`UPDATE business_operation_financial_components SET economic_date = '2026-09-01' WHERE id = ${component}`;
    const u = (await getTco(c, v.id)).body.tco;
    expect(diag(u, 'STATUS_CONTRADICTIONS')).toBeUndefined();
    expect(u.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents + 20_000);
    expect(ouverts(u)).toEqual([]);
    expect(await cartes(c)).toBe(0);
  });

  it('L109C-E03 — justificatif sans montant : lecture en cours = état discret ; échec réel → « Montant à confirmer » ciblé ; BO : mêmes diagnostics', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    const f = await k.document(c, v.id, [], { type: 'MAINTENANCE_INVOICE', title: 'Facture garage', amountCents: null, date: '2026-06-01' });
    const enCours = (await getTco(c, v.id)).body.tco;
    expect(ouverts(enCours)).toEqual([]);
    expect(diag(enCours, 'AMOUNTS_RECOVERY_PENDING')).toMatchObject({ status: 'IN_PROGRESS', count: 1, sources: [expect.objectContaining({ fileId: f })] });
    expect(enCours.status).toBe('INCOMPLETE');
    // Échec réel de la récupération (contrôle réel, relance T1 sans montant).
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db')]);
    const check = getCheck('COH-TCO-AMOUNT-RECOVERY')!;
    const ctx = { sql: pgClient, now: new Date(), today: RECETTE_TODAY, mode: 'CORRECTIVE' as const, correlationId: 'e2e:l109c' };
    const passer = async () => controlObjects({ ctx, check, accountId: c.id, ids: [f], trigger: 'MANUAL', campaignId: null, stillEligible: async () => ({ eligible: true, reason: '' }) });
    await passer();
    await sql`UPDATE ai_job_queue SET status = 'DONE' WHERE treatment = 'T1' AND target_id = ${String(f)} AND status IN ('PENDING', 'RUNNING')`;
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED', amount_cents = NULL WHERE id = ${f}`;
    await passer();
    const echec = (await getTco(c, v.id)).body.tco;
    expect(ouverts(echec)).toEqual(['AMOUNTS_UNKNOWN']);
    expect(diag(echec, 'AMOUNTS_UNKNOWN')).toMatchObject({ nature: 'COVERAGE', count: 1, title: 'Montant à confirmer', amountCents: null, sources: [expect.objectContaining({ fileId: f, detail: 'Montant introuvable' })] });
    expect(echec.summary.cumulativeCostCents).toBe(30_000);
    expect(await cartes(c)).toBe(0);
    // BO : même calcul, mêmes codes.
    const svc = await import('@/services/business-operations/tco/service');
    const { computeTcoDiagnostics } = await import('@/services/business-operations/tco/diagnostics');
    const bo = computeTcoDiagnostics(await svc.readAssetTco(c.id, v.id));
    expect(bo.items.map((x) => x.code)).toEqual(echec.diagnostics.items.map((x: { code: string }) => x.code));
  });
});
