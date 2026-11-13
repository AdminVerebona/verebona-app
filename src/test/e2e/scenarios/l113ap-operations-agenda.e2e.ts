/**
 * Lot 113AP (Trello #744, CDC Opérations / Agenda V2.0) — SOCLE : invariants
 * de l'Agenda général déjà tenus par le code (garde de non-régression pour la
 * refonte) et inventaire de migration en lecture seule. PostgreSQL 16 réel ;
 * Agenda et Timeline lus par leurs VRAIES routes (seule la session est
 * simulée) ; rattachements par le service unique de regroupement.
 *
 *   L113AP-E01  T-C1 : un événement d'une Opération (rattaché, non référence) reste un objet Agenda à SA date, une seule fois
 *   L113AP-E02  T-C3 : échéance future (2030) d'une Opération présentée en 2020 jamais masquée (« À venir ») ; dates jamais réécrites
 *   L113AP-E03  T-C6 : Timeline — aucune perte : regroupée (entrées + éléments dépliés) = détaillée, à leurs dates réelles
 *   L113AP-E04  T-G1 : inventaire par compte — ancien PRINCIPAL, techniques présumés, refus, liens, Opérations sans événement
 *   L113AP-E05  T-G1 : inventaire isolé par compte et strictement en lecture seule (aucune ligne modifiée)
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

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
const grouping = () => import('@/services/business-operations/grouping/service');

scenario('L113AP', 'Opérations / Agenda CDC V2.0 — socle : Agenda unique, Timeline sans perte, inventaire de migration', ({ sql, make }) => {
  async function compteEtBien(): Promise<{ compte: AccountRow & { owner: { id: number } }; bien: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${bien.id}`;
    return { compte, bien };
  }
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  async function operation(compte: AccountRow, type: string | null, dates: { realized?: string } = {}): Promise<number> {
    const [o] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, realized_date)
      VALUES (${compte.id}, ${type}, 'REALIZED', ${dates.realized ?? null}) RETURNING id::int`;
    return o.id;
  }
  async function element(compte: AccountRow, title: string, date: string | null, assetIds: number[]): Promise<number> {
    return (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds })).id;
  }
  async function rattacher(compte: AccountRow, operationId: number, itemId: number, principal = false, origin: 'T4' | 'USER' = 'T4'): Promise<void> {
    const g = await grouping();
    await g.withGroupingWrite(compte.id, (ctx) => principal
      ? g.designatePrincipal(ctx, { operationId, itemId, origin, reasonCode: 'L113AP_E2E' })
      : g.attachAgendaItem(ctx, { operationId, itemId, role: 'RELATED', origin, reasonCode: 'L113AP_E2E' }));
  }
  async function agenda(qs: string): Promise<Json[]> {
    const route = await import('@/app/api/agenda/route');
    const r = await route.GET(new NextRequest(`http://x/api/agenda${qs}`));
    expect(r.status).toBe(200);
    return (await r.json()).items as Json[];
  }
  async function timeline(assetId: number, mode: 'grouped' | 'detailed'): Promise<Json[]> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const out: Json[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 100; n++) {
      const r = await route.GET(new NextRequest(`http://x/api/assets/${assetId}/overview?section=timeline&mode=${mode}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
        { params: Promise.resolve({ id: String(assetId) }) });
      expect(r.status).toBe(200);
      const b = await r.json();
      out.push(...b.timeline);
      cursor = b.timelinePage.nextCursor;
      if (!cursor) return out;
    }
    throw new Error('pagination sans fin');
  }

  it('L113AP-E01 — événement d’une Opération : visible dans l’Agenda à sa date propre, une seule fois', async () => {
    const { compte, bien } = await compteEtBien();
    const op = await operation(compte, 'INTERVENTION', { realized: '2024-03-01' });
    const ref = await element(compte, 'Remplacement chaudière', '2024-03-01', [bien.id]);
    const etape = await element(compte, 'Visite de contrôle', '2024-09-15', [bien.id]);
    const seul = await element(compte, 'Ramonage', '2024-11-02', [bien.id]);
    await rattacher(compte, op, ref, true);
    await rattacher(compte, op, etape);
    asUser(compte);
    const items = await agenda('?period=all');
    const par = new Map(items.map((i) => [Number(i.id), i]));
    expect(items.filter((i) => [ref, etape, seul].includes(Number(i.id)))).toHaveLength(3);
    expect(par.get(ref)?.startDate).toBe('2024-03-01');
    expect(par.get(etape)?.startDate).toBe('2024-09-15');
    expect(par.get(seul)?.startDate).toBe('2024-11-02');
    // Aucun objet Agenda supplémentaire « pour l’Opération » (pas de faux événement).
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`;
    expect(items).toHaveLength(n);
    // Filtre par bien : mêmes objets.
    expect((await agenda(`?period=all&assetIds=${bien.id}`)).map((i) => Number(i.id)).sort()).toEqual([ref, etape, seul].sort());
  });

  it('L113AP-E02 — échéance 2030 d’une Opération présentée en 2020 : jamais masquée, dates intactes', async () => {
    const { compte, bien } = await compteEtBien();
    const op = await operation(compte, 'OTHER', { realized: '2020-06-10' });
    const dpe = await element(compte, 'Diagnostic de performance énergétique', '2020-06-10', [bien.id]);
    const expiration = await element(compte, 'Fin de validité du DPE', '2030-06-09', [bien.id]);
    await rattacher(compte, op, dpe, true);
    await rattacher(compte, op, expiration);
    asUser(compte);
    const avenir = (await agenda('?period=upcoming')).map((i) => Number(i.id));
    expect(avenir).toContain(expiration);
    expect(avenir).not.toContain(dpe);
    const passe = (await agenda('?period=past')).map((i) => Number(i.id));
    expect(passe).toContain(dpe);
    expect(passe).not.toContain(expiration);
    const annee = (await agenda('?year=2030')).map((i) => Number(i.id));
    expect(annee).toEqual([expiration]);
    const [x] = await sql<{ d: string }[]>`SELECT start_date::text AS d FROM agenda_items WHERE id = ${expiration}`;
    expect(x.d).toBe('2030-06-09');
  });

  it('L113AP-E03 — Timeline : aucune perte entre regroupée et détaillée, événements à leurs dates réelles', async () => {
    const { compte, bien } = await compteEtBien();
    const op = await operation(compte, 'INTERVENTION');
    const ref = await element(compte, 'Travaux toiture', '2023-05-02', [bien.id]);
    const ids = [ref];
    for (const [t, d] of [['Devis toiture', '2023-01-10'], ['Garantie décennale — fin', '2033-05-01'], ['Réception', null]] as const) {
      const id = await element(compte, t, d, [bien.id]);
      ids.push(id);
      await rattacher(compte, op, id);
    }
    await rattacher(compte, op, ref, true);
    const autre = await operation(compte, 'CONTRACT');
    const sansRef = await element(compte, 'Contrat entretien', '2024-02-01', [bien.id]);
    await rattacher(compte, autre, sansRef);
    ids.push(sansRef, await element(compte, 'Événement seul', '2022-01-01', [bien.id]));
    asUser(compte);
    const detail = await timeline(bien.id, 'detailed');
    expect(detail.map((e) => Number(e.id)).sort()).toEqual([...ids].sort());
    const regroupee = await timeline(bien.id, 'grouped');
    const vus = regroupee.flatMap((e) => [Number(e.id), ...((e.members ?? []) as Json[]).map((m) => Number(m.id))]);
    expect(vus.sort()).toEqual([...ids].sort());
    expect(new Set(vus).size).toBe(vus.length);
    const dates = new Map(detail.map((e) => [Number(e.id), e.effectiveDate]));
    for (const e of regroupee) for (const m of (e.members ?? []) as Json[]) expect(m.effectiveDate).toBe(dates.get(Number(m.id)));
  });

  async function jeuInventaire(compte: AccountRow & { owner: { id: number } }, bien: AssetRow) {
    // 1. ACQUISITION : référence désignée par l'utilisateur + étape.
    const acq = await operation(compte, 'ACQUISITION', { realized: '2021-04-01' });
    const achat = await element(compte, 'Achat', '2021-04-01', [bien.id]);
    const etape = await element(compte, 'Signature compromis', '2021-02-01', [bien.id]);
    await rattacher(compte, acq, achat, true, 'USER');
    await rattacher(compte, acq, etape);
    // 2. Opération sans événement (non datée).
    await operation(compte, null);
    // 3. INTERVENTION : référence projetée par T4, non touchée (présumée technique) ; lien document seulement propagé.
    const inter = await operation(compte, 'INTERVENTION');
    const proj = await element(compte, 'Intervention plomberie', '2025-01-15', [bien.id]);
    await rattacher(compte, inter, proj, true);
    await sql`UPDATE agenda_items SET projection_origin = 'OPERATION', is_automatic = true, is_automatic_modified = false WHERE id = ${proj}`;
    const f = await make.assetFile(compte, { assetId: bien.id, name: 'facture.pdf' });
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${proj}, ${f.id}, ARRAY['OPERATION_PRINCIPAL']::text[])
              ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE SET provenances = EXCLUDED.provenances`;
    // 4. FINANCING : retrait mémorisé de l'événement de référence.
    const fin = await operation(compte, 'FINANCING');
    await sql`INSERT INTO business_operation_match_decisions (account_id, source_kind, source_entity_key, candidate_operation_id, decision, origin, reason_code)
              VALUES (${compte.id}, 'PRINCIPAL', 'agenda:0', ${fin}, 'REJECTED', 'USER_ARBITRATION', 'L113AP_E2E')`;
    return { acq, inter, fin, proj };
  }

  it('L113AP-E04 — inventaire d’un compte : ancien PRINCIPAL, techniques présumés, refus, liens, Opérations sans événement', async () => {
    const { compte, bien } = await compteEtBien();
    await jeuInventaire(compte, bien);
    const { simulateAccountInventory, inventoryFindings } = await import('@/services/business-operations/migration-744/inventory');
    const r = await simulateAccountInventory(compte.id);
    expect(r.operations).toMatchObject({ actives: 4, type_null: 1, acquisition: 1, intervention: 1, financing: 1, other: 0, invalidees: 0, fusionnees: 0 });
    expect(r.operationsSansEvenement).toMatchObject({ sans_evenement: 2, sans_principal: 2 });
    expect(r.principal).toMatchObject({ principal: 2, principal_user: 1, principal_projete: 1, principal_presume_technique: 1, related: 1, principal_non_date: 0 });
    expect(r.evenements).toMatchObject({ rattaches: 3, projetes_t4: 1, techniques_presumes: 1, non_projetes: 2 });
    expect(r.evenementsOrphelins).toMatchObject({ intercompte: 0, operation_absente: 0, operation_inactive: 0 });
    expect(r.liens).toMatchObject({ liens_doc_propages_principal: 1, liens_doc_uniquement_principal: 1 });
    expect(r.decisions).toMatchObject({ principal_retire: 1, refus: 1 });
    const codes = inventoryFindings(r).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['USER_PRINCIPAL', 'PRINCIPAL_REFUSALS', 'PRINCIPAL_ONLY_DOC_LINKS', 'PRESUMED_TECHNICAL_PRINCIPAL', 'OPERATION_WITHOUT_EVENT']));
    expect(codes).not.toContain('CROSS_ACCOUNT_EVENT');
  });

  it('L113AP-E05 — inventaire isolé par compte et en lecture seule', async () => {
    const a = await compteEtBien();
    const b = await compteEtBien();
    await jeuInventaire(a.compte, a.bien);
    const { simulateAccountInventory } = await import('@/services/business-operations/migration-744/inventory');
    const empreinte = async () => (await sql<{ e: string }[]>`
      SELECT md5(coalesce(string_agg(x, ',' ORDER BY x), '')) AS e FROM (
        SELECT 'i' || id || ':' || coalesce(business_operation_id::text, '') || ':' || coalesce(operation_role, '') || ':' || updated_at::text AS x FROM agenda_items WHERE account_id = ${a.compte.id}
        UNION ALL SELECT 'o' || id || ':' || version || ':' || updated_at::text FROM business_operations WHERE account_id = ${a.compte.id}
        UNION ALL SELECT 'd' || id || ':' || decision || ':' || active FROM business_operation_match_decisions WHERE account_id = ${a.compte.id}) t`)[0].e;
    const avant = await empreinte();
    const rb = await simulateAccountInventory(b.compte.id);
    expect(rb.operations).toMatchObject({ actives: 0 });
    expect(rb.principal).toMatchObject({ principal: 0 });
    expect(rb.decisions).toMatchObject({ refus: 0 });
    await simulateAccountInventory(a.compte.id);
    expect(await empreinte()).toBe(avant);
  });
});
