/**
 * Lot 14 (volet B, 2e passe) — statut des échéances et cartes « À traiter »,
 * sur PostgreSQL réel (CDC 15 T4-10, T4-12 à T4-14, D-15).
 *
 *  · document analysé (T1 → preuves) puis réconciliation locale du bien :
 *    preuve certaine → « réalisé » ; preuve probable → carte AGENDA-DONE
 *    (idempotente), résolue puis annulée ; autre occurrence → rien ;
 *    élément manuel → rien ; AI_T4_EFFECTS retiré au lot 16b-2 (une valeur
 *    encore posée est sans effet) ;
 *  · carte AGENDA-NOT-DONE : ouverte (lecture mascotte), remplace la carte
 *    de l'autre verdict, résolue en « annulé » — jamais écrite seule ;
 *  · requires_qualification écrit depuis la classification T4 ;
 *  · D-15 : vente / sinistre → carte ASSET-STATUS, résolution, annulation,
 *    valeur forgée refusée.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import type { AgendaDecision } from '@/services/ai/agenda';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/coherence/impact-propagation.service', async (orig) => ({
  ...(await orig<object>()), emitAgendaItemCreated: async () => {},
}));

const trace = {
  traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'],
};
const fait = (assetId: number, value: string, confidence: 'certain' | 'probable'): ProjectedFact => ({
  canonicalKey: 'lastRevision', rawKey: 'Date d’intervention', label: null, subject: null, attribute: null,
  rawValue: value, value, valueType: 'date', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence, evidence: { excerpt: `Entretien effectué le ${value}`, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
});
const echeance = (fileId: number, date: string, over: Partial<AgendaDecision> = {}): AgendaDecision => ({
  action: 'create', title: 'Entretien annuel', date, category: 'action', confidence: 'certain',
  reasonCode: 'E2E', deterministic: true, sourceFileId: fileId, originFieldKey: 'maintenanceDueDate', ...over,
});

scenario('T4-L14-STATUT', 'Statut des échéances et cartes « À traiter »', ({ sql, make }) => {
  const env = { ...process.env };
  let persist: typeof import('@/services/agenda/agenda-persistence').persistAgendaDecisions;
  let persistProjectedFacts: typeof import('@/services/ai/source-analysis/steps/persist-evidence.step').persistProjectedFacts;
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let cards: typeof import('@/services/to-process/agenda-status-cards');
  let resolve: typeof import('@/services/to-process/resolve-action.service');
  let write: typeof import('@/services/agenda/AgendaWriteService');

  beforeAll(async () => {
    ({ persistAgendaDecisions: persist } = await import('@/services/agenda/agenda-persistence'));
    ({ persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step'));
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    cards = await import('@/services/to-process/agenda-status-cards');
    resolve = await import('@/services/to-process/resolve-action.service');
    write = await import('@/services/agenda/AgendaWriteService');
  });
  afterEach(() => {
    for (const k of ['AI_T4_EFFECTS']) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  });

  /** Bien + échéance T4 (document A), puis rapport d'entretien (document B) analysé et réconcilié. */
  const preuveArrivee = async (o: { date: string; proof: string; confidence: 'certain' | 'probable'; manuel?: boolean }) => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE' });
    const docA = await make.assetFile(compte, { assetId: bien.id });
    let itemId: number;
    if (o.manuel) {
      itemId = (await write.createAgendaItem({
        title: 'Entretien annuel', startDate: o.date, assetIds: [bien.id], originFieldKey: 'maintenanceDueDate', homeCategory: 'action',
      }, compte.id, compte.ownerUserId)).id;
    } else {
      await persist([echeance(docA.id, o.date)], compte.id, bien.id);
      [{ id: itemId }] = await sql<{ id: number }[]>`
        SELECT i.id FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id WHERE l.asset_id = ${bien.id}`;
    }
    const docB = await make.assetFile(compte, { assetId: bien.id });
    const analyser = async () => {
      await persistProjectedFacts({
        input: { sourceType: 'file', sourceIds: [docB.id], accountId: compte.id, userId: compte.ownerUserId, mimeTypes: [], displayNames: [] },
        leadSourceId: docB.id, trace, analysisRunId: 1, documentType: 'RAPPORT_ENTRETIEN', documentDate: o.proof,
        facts: [fait(bien.id, o.proof, o.confidence)],
      });
      await reconcileAsset({ accountId: compte.id, userId: compte.ownerUserId, assetId: bien.id, triggeredBy: 'document_analyzed', sourceFileId: docB.id });
    };
    await analyser();
    return { compte, bien, itemId, docB, analyser };
  };
  const statut = async (id: number) => (await sql<{ s: string | null }[]>`SELECT manual_status AS s FROM agenda_items WHERE id = ${id}`)[0].s;
  const cartes = async (accountId: number, targetId: number, targetType = 'AGENDA_ITEM') => sql<{
    public_id: string; rule_code: string; resolved_at: Date | null; resolution_reason: string | null;
  }[]>`SELECT public_id, rule_code, resolved_at, resolution_reason FROM to_process_actions
       WHERE account_id = ${accountId} AND target_type = ${targetType} AND target_id = ${targetId} ORDER BY id`;

  it('preuve certaine dans la fenêtre (enabled) → « réalisé », trace IA, lien document ↔ échéance', async () => {
    const { compte, itemId, docB } = await preuveArrivee({ date: '2027-03-10', proof: '2027-03-08', confidence: 'certain' });
    expect(await statut(itemId)).toBe('realise');
    const [ev] = await sql<{ d: { origin: string } }[]>`
      SELECT detail_json AS d FROM agenda_occurrence_events WHERE agenda_item_id = ${itemId} AND event_type = 'STATUS_AUTO_COMPLETED'`;
    expect(ev.d.origin).toBe('AI');
    const [lien] = await sql`SELECT 1 FROM agenda_file_links WHERE agenda_item_id = ${itemId} AND asset_file_id = ${docB.id}`;
    expect(lien).toBeDefined();
    expect(await cartes(compte.id, itemId)).toHaveLength(0);
  });

  it('preuve probable → carte AGENDA-DONE idempotente ; résolue « réalisé » (USER) puis annulée', async () => {
    const { compte, itemId, analyser } = await preuveArrivee({ date: '2027-03-10', proof: '2027-03-08', confidence: 'probable' });
    expect(await statut(itemId)).toBeNull();
    await analyser();
    const actives = (await cartes(compte.id, itemId)).filter((c) => !c.resolved_at);
    expect(actives.map((c) => c.rule_code)).toEqual(['AGENDA-DONE']);

    const r = await resolve.resolveArbitration(compte.id, actives[0].public_id, 'realise', { userId: compte.ownerUserId });
    expect(r).toMatchObject({ ok: true, previousValue: null });
    expect(await statut(itemId)).toBe('realise');
    const [ev] = await sql<{ d: { origin: string } }[]>`
      SELECT detail_json AS d FROM agenda_occurrence_events WHERE agenda_item_id = ${itemId} AND event_type = 'STATUS_CHANGED'`;
    expect(ev.d.origin).toBe('USER');

    expect(await resolve.undoArbitration(compte.id, actives[0].public_id, null)).toMatchObject({ ok: true });
    expect(await statut(itemId)).toBeNull();
    expect((await cartes(compte.id, itemId)).filter((c) => !c.resolved_at)).toHaveLength(1);
  });

  it('autre occurrence (hors fenêtre), élément manuel : rien ; variable retirée encore posée : sans effet', async () => {
    const loin = await preuveArrivee({ date: '2027-03-10', proof: '2025-01-05', confidence: 'certain' });
    expect(await statut(loin.itemId)).toBeNull();
    expect(await cartes(loin.compte.id, loin.itemId)).toHaveLength(0);

    const manuel = await preuveArrivee({ date: '2027-03-10', proof: '2027-03-08', confidence: 'certain', manuel: true });
    expect(await statut(manuel.itemId)).toBeNull();
    expect(await cartes(manuel.compte.id, manuel.itemId)).toHaveLength(0);

    process.env.AI_T4_EFFECTS = 'legacy';
    const reste = await preuveArrivee({ date: '2027-03-10', proof: '2027-03-08', confidence: 'certain' });
    expect(await statut(reste.itemId)).toBe('realise');
  });

  it('AGENDA-NOT-DONE : ouverte (lecture mascotte), remplace l’autre verdict, résolue « annulé » par l’utilisateur', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await persist([echeance(doc.id, '2027-06-01')], compte.id, bien.id);
    const [{ id: itemId }] = await sql<{ id: number }[]>`
      SELECT i.id FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id WHERE l.asset_id = ${bien.id}`;

    expect((await cards.proposeAgendaStatus({ accountId: compte.id, itemId, kind: 'propose_done', sourceFileId: doc.id })).status).toBe('CREATED');
    expect((await cards.proposeAgendaStatus({ accountId: compte.id, itemId, kind: 'propose_not_done', sourceFileId: doc.id })).status).toBe('CREATED');
    expect((await cards.proposeAgendaStatus({ accountId: compte.id, itemId, kind: 'propose_not_done', sourceFileId: doc.id })).status).toBe('UPDATED');
    const toutes = await cartes(compte.id, itemId);
    expect(toutes.filter((c) => !c.resolved_at).map((c) => c.rule_code)).toEqual(['AGENDA-NOT-DONE']);
    expect(toutes.find((c) => c.rule_code === 'AGENDA-DONE')?.resolution_reason).toBe('OBSOLETE');
    expect(await statut(itemId)).toBeNull();

    const ouvertes = await cards.listOpenNotDoneProposals(compte.id, { assetIds: [bien.id] });
    expect(ouvertes).toEqual([expect.objectContaining({ agendaItemId: itemId, sourceFileId: doc.id, title: 'Entretien annuel' })]);

    const carte = toutes.find((c) => c.rule_code === 'AGENDA-NOT-DONE')!;
    expect(await resolve.resolveArbitration(compte.id, carte.public_id, 'not_completed')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resolve.resolveArbitration(compte.id, carte.public_id, 'annule')).toMatchObject({ ok: true });
    expect(await statut(itemId)).toBe('annule');
    expect(await cards.listOpenNotDoneProposals(compte.id)).toHaveLength(0);
  });

  it('requires_qualification écrit depuis la classification T4 (variable retirée encore posée : sans effet)', async () => {
    const decision = (fileId: number) => echeance(fileId, '2027-05-01', {
      originFieldKey: undefined, title: 'Rendez-vous garage',
      classification: { category: 'unknown', confidence: 'ambiguous', source: 'model', requiresQualification: true } as never,
    });
    for (const [mode, attendu] of [['enabled', true], ['legacy', true]] as const) {
      process.env.AI_T4_EFFECTS = mode;
      const compte = await make.account();
      const bien = await make.asset(compte);
      const doc = await make.assetFile(compte, { assetId: bien.id });
      await persist([decision(doc.id)], compte.id, bien.id);
      const [r] = await sql<{ q: boolean }[]>`
        SELECT i.requires_qualification AS q FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id WHERE l.asset_id = ${bien.id}`;
      expect(r.q, mode).toBe(attendu);
    }
  });

  it('D-15 / PO-Q11 : vente → carte ASSET-STATUS (VENDU, TRANSMIS — liste officielle 0278), résolution, annulation, valeur refusée', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const vente = echeance(doc.id, '2026-02-01', { title: 'Vente du véhicule', category: 'information', originFieldKey: undefined });
    await persist([{ ...vente, businessType: 'sale', nature: 'HISTORICAL' } as AgendaDecision], compte.id, bien.id);
    const [carte] = (await cartes(compte.id, bien.id, 'ASSET')).filter((c) => !c.resolved_at);
    expect(carte.rule_code).toBe('ASSET-STATUS');
    const [{ p }] = await sql<{ p: Array<{ value: string }> }[]>`SELECT proposals_json AS p FROM to_process_actions WHERE public_id = ${carte.public_id}`;
    // Lot 32 (PO-Q11) : contrainte 0278 = liste officielle — VENDU admis.
    expect(p.map((x) => x.value)).toEqual(['VENDU', 'TRANSMIS', 'EN_SERVICE']);
    const [{ s: avant }] = await sql<{ s: string }[]>`SELECT status AS s FROM assets WHERE id = ${bien.id}`;
    expect(avant).toBe('EN_SERVICE');

    expect(await resolve.resolveArbitration(compte.id, carte.public_id, 'ARCHIVED')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    // Ancienne valeur hors liste officielle : refus propre, rien d'écrit.
    expect(await resolve.resolveArbitration(compte.id, carte.public_id, 'EN_PANNE')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resolve.resolveArbitration(compte.id, carte.public_id, 'VENDU')).toMatchObject({ ok: true, previousValue: 'EN_SERVICE' });
    expect((await sql<{ s: string }[]>`SELECT status AS s FROM assets WHERE id = ${bien.id}`)[0].s).toBe('VENDU');
    expect(await resolve.undoArbitration(compte.id, carte.public_id, 'EN_SERVICE')).toMatchObject({ ok: true });
    expect((await sql<{ s: string }[]>`SELECT status AS s FROM assets WHERE id = ${bien.id}`)[0].s).toBe('EN_SERVICE');

    // Un autre compte ne peut pas résoudre la carte.
    const autre = await make.account();
    expect(await resolve.resolveArbitration(autre.id, carte.public_id, 'TRANSMIS')).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  it('D-15 / PO-Q11 : sinistre → aucune carte de statut (liste officielle sans « en réparation » ni « détruit »)', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const sinistre = { ...echeance(doc.id, '2026-02-01', { title: 'Sinistre', category: 'information', originFieldKey: undefined }), businessType: 'claim', nature: 'HISTORICAL' } as AgendaDecision;
    await persist([sinistre], compte.id, bien.id);
    expect(await cartes(compte.id, bien.id, 'ASSET')).toHaveLength(0);
    expect((await sql<{ s: string }[]>`SELECT status AS s FROM assets WHERE id = ${bien.id}`)[0].s).toBe('EN_SERVICE');
  });
});
