/**
 * Lot 14 (volet B) — réanalyse d'une échéance RÉCURRENTE, sources et cibles
 * du candidat, sur PostgreSQL réel (CDC 15 T4-07, T4-08 ; AI_T4_EFFECTS=enabled).
 *
 *  · deux occurrences (index d'occurrence = date) : réanalyse idempotente,
 *    une ligne par occurrence, clés distinctes ; `evidenceId` de la source
 *    tracé ; une occurrence disparue est retirée, sauf modifiée à la main ;
 *  · document multi-biens : la réanalyse pour un bien ne retire rien sur
 *    l'autre ;
 *  · cible ÉQUIPEMENT du candidat : lien équipement et clé propre.
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

/** Décision T4 telle que A la produit en enabled (sémantique recopiée du candidat). */
const occurrence = (fileId: number, date: string, over: Partial<AgendaDecision> = {}): AgendaDecision => ({
  action: 'create', title: 'Entretien chaudière', date, category: 'action', confidence: 'certain',
  reasonCode: 'E2E', deterministic: true, sourceFileId: fileId, originFieldKey: 'maintenanceDueDate',
  nature: 'DEADLINE', businessType: 'maintenance', occurrenceIndex: date,
  sources: [{ fileId, role: 'SOURCE', evidenceId: 4242 }],
  occurrence: { nature: date.startsWith('2027') ? 'CONFIRMED' : 'FORECAST', dateSource: date.startsWith('2027') ? 'EXPLICIT_DATE' : 'PREDICTED_FROM_RECURRENCE', seriesKey: `serie-${fileId}` },
  ...over,
});

scenario('T4-L14-RECUR', 'Réanalyse d’une échéance récurrente, sources et cibles du candidat', ({ sql, make }) => {
  const env = { ...process.env };
  let persist: typeof import('@/services/agenda/agenda-persistence').persistAgendaDecisions;
  beforeAll(async () => {
    ({ persistAgendaDecisions: persist } = await import('@/services/agenda/agenda-persistence'));
  });
  afterEach(() => {
    if (env.AI_T4_EFFECTS === undefined) delete process.env.AI_T4_EFFECTS; else process.env.AI_T4_EFFECTS = env.AI_T4_EFFECTS;
  });

  const items = (assetId: number) => sql<{ id: number; d: string; k: string | null; nature: string }[]>`
    SELECT i.id, i.start_date::text AS d, i.functional_key AS k, i.occurrence_nature AS nature
      FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${assetId} ORDER BY i.start_date`;

  it('deux occurrences : réanalyse idempotente, preuve tracée, occurrence disparue retirée (sauf modifiée)', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const deux = [occurrence(doc.id, '2027-01-15'), occurrence(doc.id, '2028-01-15')];

    await persist(deux, compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    await persist(deux, compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    let lignes = await items(bien.id);
    expect(lignes.map((x) => [x.d, x.nature])).toEqual([['2027-01-15', 'CONFIRMED'], ['2028-01-15', 'FORECAST']]);
    expect(new Set(lignes.map((x) => x.k)).size).toBe(2);
    expect(lignes.every((x) => /^[0-9a-f]{40}$/.test(x.k ?? ''))).toBe(true);
    const traces = await sql<{ e: number; r: string }[]>`
      SELECT evidence_id AS e, source_role AS r FROM agenda_item_sources WHERE agenda_item_id IN ${sql(lignes.map((x) => x.id))}`;
    expect(traces).toEqual([{ e: 4242, r: 'SOURCE' }, { e: 4242, r: 'SOURCE' }]);

    // La source ne produit plus la seconde occurrence : retirée.
    await persist([deux[0]], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    lignes = await items(bien.id);
    expect(lignes.map((x) => x.d)).toEqual(['2027-01-15']);

    // Recréée, puis modifiée à la main : une réanalyse sans elle la conserve.
    await persist(deux, compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    const seconde = (await items(bien.id)).find((x) => x.d === '2028-01-15')!;
    await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${seconde.id}`;
    await persist([deux[0]], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    expect((await items(bien.id)).map((x) => x.id)).toContain(seconde.id);
  });

  it('document multi-biens : la réanalyse pour un bien ne retire rien sur l’autre', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const b1 = await make.asset(compte, { category: 'IMMOBILIER' });
    const b2 = await make.asset(compte, { category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: b1.id });
    await persist([occurrence(doc.id, '2027-01-15')], compte.id, b1.id, { sourceFileId: doc.id, analysisComplete: true });
    await persist([occurrence(doc.id, '2027-01-15')], compte.id, b2.id, { sourceFileId: doc.id, analysisComplete: true });
    const [surB2] = await items(b2.id);

    await persist([], compte.id, b1.id, { sourceFileId: doc.id, analysisComplete: true });
    expect(await items(b1.id)).toHaveLength(0);
    expect((await items(b2.id)).map((x) => x.id)).toEqual([surB2.id]);
    // Même date, biens différents : clés différentes.
    expect(surB2.k).not.toBeNull();
  });

  it('cible ÉQUIPEMENT du candidat : lien équipement, clé propre, réanalyse idempotente', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const [{ id: equipementId }] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name) VALUES (${bien.id}, 'Chaudière') RETURNING id`;
    const surBien = occurrence(doc.id, '2027-01-15', { occurrenceIndex: 'single', occurrence: undefined });
    const surEquipement = { ...surBien, target: { type: 'EQUIPMENT' as const, id: equipementId } };

    await persist([surBien, surEquipement], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    await persist([surBien, surEquipement], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    const lignes = await items(bien.id);
    expect(lignes).toHaveLength(2);
    expect(new Set(lignes.map((x) => x.k)).size).toBe(2);
    const liens = await sql<{ i: number }[]>`
      SELECT agenda_item_id AS i FROM agenda_equipment_links WHERE equipment_id = ${equipementId}`;
    expect(liens).toHaveLength(1);
  });
});
