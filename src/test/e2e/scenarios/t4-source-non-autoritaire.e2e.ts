/**
 * Lot 14 (volet B) — échéance lue dans une source NON AUTORITAIRE
 * (CDC 15 T4-04 ; AI_T4_EFFECTS=enabled), sur PostgreSQL réel.
 *
 *  · devis daté → carte AGENDA-PROPOSAL, AUCUN élément ; réanalyse : même carte ;
 *  · « Oui » → élément créé (origine manuelle), lié au bien et au devis
 *    (source, preuve) ; réanalyse : pas de nouvelle carte ; « Annuler » :
 *    élément retiré, carte rouverte ;
 *  · « Non » → carte close, pas reproposée sans changement ;
 *  · un élément existant de même clé n'est jamais mis à jour par une source
 *    qui n'autorise pas la création.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AgendaDecision } from '@/services/ai/agenda';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/coherence/impact-propagation.service', async (orig) => ({
  ...(await orig<object>()), emitAgendaItemCreated: async () => {},
}));

const devis = (fileId: number, date = '2027-05-12', over: Partial<AgendaDecision> = {}): AgendaDecision => ({
  action: 'propose', title: 'Remplacement de la chaudière', date, category: 'action', confidence: 'certain',
  reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED', deterministic: true, sourceFileId: fileId,
  nature: 'DEADLINE', businessType: 'repair', occurrenceIndex: 'single', mayCreateAgenda: false, documentType: 'DEVIS',
  sources: [{ fileId, role: 'SOURCE', evidenceId: 77 }], ...over,
});

scenario('T4-L14-T404', 'Échéance d’une source non autoritaire : À traiter, pas de création', ({ sql, make }) => {
  const env = { ...process.env };
  let persist: typeof import('@/services/agenda/agenda-persistence').persistAgendaDecisions;
  let resolve: typeof import('@/services/to-process/resolve-action.service');
  beforeAll(async () => {
    ({ persistAgendaDecisions: persist } = await import('@/services/agenda/agenda-persistence'));
    resolve = await import('@/services/to-process/resolve-action.service');
  });
  afterEach(() => {
    if (env.AI_T4_EFFECTS === undefined) delete process.env.AI_T4_EFFECTS; else process.env.AI_T4_EFFECTS = env.AI_T4_EFFECTS;
  });

  const items = (accountId: number) => sql<{ id: number; auto: boolean; origin: string }[]>`
    SELECT id, is_automatic AS auto, origin_type AS origin FROM agenda_items WHERE account_id = ${accountId} ORDER BY id`;
  const cartes = (accountId: number, fileId: number) => sql<{ public_id: string; resolved_at: Date | null; resolution_reason: string | null }[]>`
    SELECT public_id, resolved_at, resolution_reason FROM to_process_actions
     WHERE account_id = ${accountId} AND target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'AGENDA-PROPOSAL' ORDER BY id`;

  it('devis daté : carte, aucun élément ; « Oui » : élément créé et lié ; annulation ; réanalyse sans nouvelle carte', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: bien.id });

    await persist([devis(doc.id)], compte.id, bien.id, { sourceFileId: doc.id });
    await persist([devis(doc.id)], compte.id, bien.id, { sourceFileId: doc.id });
    expect(await items(compte.id)).toHaveLength(0);
    let c = await cartes(compte.id, doc.id);
    expect(c).toHaveLength(1);
    expect(c[0].resolved_at).toBeNull();

    const r = await resolve.resolveArbitration(compte.id, c[0].public_id, 'YES', { userId: compte.ownerUserId });
    expect(r).toMatchObject({ ok: true });
    const [cree] = await items(compte.id);
    expect(cree).toMatchObject({ auto: false, origin: 'manual' });
    const [lien] = await sql`SELECT 1 FROM agenda_asset_links WHERE agenda_item_id = ${cree.id} AND asset_id = ${bien.id}`;
    expect(lien).toBeDefined();
    const [fichier] = await sql`SELECT 1 FROM agenda_file_links WHERE agenda_item_id = ${cree.id} AND asset_file_id = ${doc.id}`;
    expect(fichier).toBeDefined();
    const [trace] = await sql<{ r: string; e: number }[]>`
      SELECT source_role AS r, evidence_id AS e FROM agenda_item_sources WHERE agenda_item_id = ${cree.id}`;
    expect(trace).toEqual({ r: 'SOURCE', e: 77 });
    const [{ n, bt }] = await sql<{ n: string; bt: string }[]>`SELECT event_nature AS n, business_type AS bt FROM agenda_items WHERE id = ${cree.id}`;
    expect([n, bt]).toEqual(['DEADLINE', 'repair']);

    // Réanalyse : l'échéance acceptée n'est pas reproposée, rien n'est dupliqué.
    await persist([devis(doc.id)], compte.id, bien.id, { sourceFileId: doc.id });
    expect(await items(compte.id)).toHaveLength(1);
    expect((await cartes(compte.id, doc.id)).filter((x) => !x.resolved_at)).toHaveLength(0);

    // Annulation : élément retiré, MÊME carte rouverte.
    expect(await resolve.undoArbitration(compte.id, c[0].public_id, null)).toMatchObject({ ok: true });
    expect(await items(compte.id)).toHaveLength(0);
    c = await cartes(compte.id, doc.id);
    expect(c).toHaveLength(1);
    expect(c[0].resolved_at).toBeNull();
  });

  it('« Non » : carte close, pas reproposée sans changement ; une nouvelle date la rouvre', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await persist([devis(doc.id)], compte.id, bien.id, { sourceFileId: doc.id });
    const [c] = await cartes(compte.id, doc.id);
    expect(await resolve.resolveArbitration(compte.id, c.public_id, 'MAYBE')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resolve.resolveArbitration(compte.id, c.public_id, 'NO')).toMatchObject({ ok: true });
    expect((await cartes(compte.id, doc.id))[0].resolution_reason).toBe('NOT_APPLICABLE');

    await persist([devis(doc.id)], compte.id, bien.id, { sourceFileId: doc.id });
    expect((await cartes(compte.id, doc.id)).filter((x) => !x.resolved_at)).toHaveLength(0);
    await persist([devis(doc.id, '2027-06-01')], compte.id, bien.id, { sourceFileId: doc.id });
    expect((await cartes(compte.id, doc.id)).filter((x) => !x.resolved_at)).toHaveLength(1);
    expect(await items(compte.id)).toHaveLength(0);
  });

  it('élément existant de même clé : jamais mis à jour par une source non autoritaire', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    // Élément créé quand la source était autoritaire.
    await persist([devis(doc.id, '2027-05-12', { action: 'create', reasonCode: 'EXPLICIT_DATE_AUTHORIZED_SOURCE', mayCreateAgenda: true })], compte.id, bien.id, { sourceFileId: doc.id });
    const [avant] = await sql<{ id: number; d: string }[]>`SELECT id, start_date::text AS d FROM agenda_items WHERE account_id = ${compte.id}`;
    await persist([devis(doc.id, '2027-07-01', { action: 'create', reasonCode: 'X', mayCreateAgenda: false })], compte.id, bien.id, { sourceFileId: doc.id });
    const [apres] = await sql<{ id: number; d: string }[]>`SELECT id, start_date::text AS d FROM agenda_items WHERE account_id = ${compte.id}`;
    expect(apres).toEqual(avant);

    // Lot 16b-2 : variable retirée encore posée — sans effet (carte, aucune création).
    process.env.AI_T4_EFFECTS = 'legacy';
    const doc2 = await make.assetFile(compte, { assetId: bien.id });
    await persist([devis(doc2.id)], compte.id, bien.id);
    expect(await cartes(compte.id, doc2.id)).toHaveLength(1);
    expect(await sql`SELECT 1 FROM agenda_items WHERE account_id = ${compte.id} AND origin_ref_id = ${doc2.id}`).toHaveLength(0);
  });
});
