/**
 * Reliquat R5 (CDC 15 §26) — branche TEMPORAL_AMBIGUITY de t4_master, de bout
 * en bout : T1 rejoué → T4 (file durable) → passerelle réelle
 * (`t4_temporal_ambiguity` rejouée) → agenda ou carte AGENDA-PROPOSAL.
 *
 * État : commutateurs cibles (AI_T4_EFFECTS=enabled…), T1 ET T4 en
 * architecture `master` par la version de configuration. Le cas « steps /
 * legacy inchangé » est couvert par `r5-ambiguite-temporelle.test.ts`.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { agenda, analyserDocument, sortieT1, useTargetState, type FaitT1 } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('R5-TEMPORAL', 'Ambiguïté temporelle T4 (enabled / master)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });

  beforeEach(async () => (await import('@/services/ai/agenda/agenda-intelligence.service')).__resetTemporalCacheForTests());

  /** Facture d'entretien : « 03/04/2027 » lu mm/jj (4 mars) par l'extraction. */
  const analyser = async (temporal: Record<string, unknown> | null, existant?: { compte: { id: number; ownerUserId: number }; maison: { id: number }; f: { id: number } }) => {
    const compte = existant?.compte ?? await make.account();
    const maison = existant?.maison ?? await make.asset(compte as never, { category: 'IMMOBILIER', name: 'Maison' });
    const f = existant?.f ?? await make.assetFile(compte as never, { assetId: maison.id });
    const replay = await analyserDocument(sql, useRecordings, {
      accountId: compte.id, userId: compte.ownerUserId, fileId: f.id, linkedAssetId: maison.id,
      output: sortieT1({
        title: 'Facture entretien chaudière', date: '2026-09-03', documentTypeCode: 'MAINTENANCE_INVOICE', amountCents: 18000,
        supplier: 'Chauffage Martin', assets: [{ id: maison.id, label: 'Maison' }],
        facts: [{ canonicalKey: 'maintenanceDueDate', value: '2027-03-04', valueType: 'date', excerpt: 'Prochain entretien conseillé le 03/04/2027',
          assetId: maison.id, semanticEvent: { type: 'maintenance', nature: 'DEADLINE' } }] as FaitT1[],
      }),
      extra: temporal ? [{ operationCode: 't4_temporal_ambiguity', task: 'TEMPORAL_AMBIGUITY', output: temporal }] : [],
    });
    const cartes = await sql<{ public_id: string; proposals_json: Array<{ value: string }>; resolved: boolean; reason: string | null }[]>`
      SELECT public_id, proposals_json, resolved_at IS NOT NULL AS resolved, resolution_reason AS reason FROM to_process_actions
       WHERE account_id = ${compte.id} AND rule_code = 'AGENDA-PROPOSAL'`;
    return { compte, maison, f, replay: replay.replay, cartes };
  };
  const echeances = async (assetId: number) => (await agenda(sql, assetId)).filter((e) => e.nature === 'DEADLINE').map((e) => e.date);

  it('R5 (enabled/master) — candidat certain de la liste : l’échéance prend la date retenue, aucune carte', async () => {
    const { maison, replay, cartes } = await analyser({
      task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 2, confidence: 'probable', reason: 'document français : jour/mois',
    });
    const appel = replay.calls.find((c) => c.task === 'TEMPORAL_AMBIGUITY');
    expect(appel).toBeDefined();
    expect(appel!.prompt).toContain('2027-04-03');
    expect(await echeances(maison.id)).toEqual(['2027-04-03']);
    expect(cartes).toEqual([]);
  });

  it('R5 (enabled/master) — abstention : aucune création, carte AGENDA-PROPOSAL avec les deux dates ; le choix crée l’échéance', async () => {
    const { compte, maison, cartes } = await analyser({
      task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', candidateId: null, confidence: 'ambiguous', reason: 'lecture impossible à trancher',
    });
    expect(await echeances(maison.id)).toEqual([]);
    expect(cartes).toHaveLength(1);
    expect(cartes[0].proposals_json.map((p) => p.value)).toEqual(['YES:2027-03-04', 'YES:2027-04-03']);

    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    // Plusieurs dates possibles : un « YES » nu est refusé.
    expect(await resolveArbitration(compte.id, cartes[0].public_id, 'YES', { userId: compte.ownerUserId })).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resolveArbitration(compte.id, cartes[0].public_id, 'YES:2099-01-01', { userId: compte.ownerUserId })).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resolveArbitration(compte.id, cartes[0].public_id, 'YES:2027-04-03', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    expect(await echeances(maison.id)).toEqual(['2027-04-03']);
  });

  it('R5 (enabled/master) — abstention puis « Non applicable » : carte close, aucune échéance', async () => {
    const { compte, maison, cartes } = await analyser({
      task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', candidateId: null, confidence: 'ambiguous', reason: 'x',
    });
    const { markNotApplicable } = await import('@/services/to-process/resolve-action.service');
    expect(await markNotApplicable(compte.id, cartes[0].public_id, { userId: compte.ownerUserId } as never)).toMatchObject({ ok: true });
    expect(await echeances(maison.id)).toEqual([]);
  });

  it('R5 (enabled/master) — abstention puis réanalyse qui tranche : la carte devient sans objet (OBSOLETE), une seule échéance', async () => {
    const premier = await analyser({ task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', candidateId: null, confidence: 'ambiguous', reason: 'x' });
    expect(premier.cartes.map((c) => c.resolved)).toEqual([false]);
    await (await import('@/services/ai/agenda/agenda-intelligence.service')).__resetTemporalCacheForTests();
    const second = await analyser({ task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 2, confidence: 'probable', reason: 'y' }, premier);
    expect(await echeances(premier.maison.id)).toEqual(['2027-04-03']);
    expect(second.cartes.map((c) => [c.resolved, c.reason])).toEqual([[true, 'OBSOLETE']]);
  });

  it('R5 (enabled/master) — même ambiguïté réanalysée : le modèle n’est pas rappelé (cache)', async () => {
    const premier = await analyser({ task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', candidateId: null, confidence: 'ambiguous', reason: 'x' });
    const second = await analyser(null, premier);
    expect(second.replay.calls.filter((c) => c.task === 'TEMPORAL_AMBIGUITY')).toEqual([]);
    expect(second.cartes.filter((c) => !c.resolved)).toHaveLength(1);
  });

  it('R5 (enabled/master) — sortie hors liste (candidat inconnu) : traitée comme une abstention', async () => {
    const { maison, cartes } = await analyser({
      task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 7, confidence: 'probable', reason: 'invente un candidat',
    });
    expect(await echeances(maison.id)).toEqual([]);
    expect(cartes).toHaveLength(1);
  });
});
