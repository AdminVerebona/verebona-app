/**
 * Lot 75F — ticket « [P1] T4 — Corriger les derniers risques de modification
 * et suppression injustifiées des échéances » (corrections A à D), sur
 * PostgreSQL réel. Modèle SIMULÉ (rejeu, aucun appel réseau) derrière la
 * passerelle réelle ; exécutant T4, file et persistance de production.
 *
 * Tableau §3 du ticket :
 *  · T4-RES-01 prévision marquée « réalisé », puis fin de récurrence        → statut conservé ;
 *  · T4-RES-02 prévision marquée « annulé » par l'utilisateur               → statut (et date) conservés ;
 *  · T4-RES-03 prévision confirmée par l'utilisateur, puis réanalyse        → confirmation et date conservées ;
 *              + gardes SQL de confirmForecast / retireForecast (indépendantes du moteur) ;
 *  · T4-RES-04 prévision automatique intacte, fin de récurrence explicite   → retrait légitime toujours possible ;
 *  · T4-RES-05 deux échéances historiques sans clé, même date, titres ≠     → aucun rapprochement erroné ;
 *  · T4-RES-06 rejet explicite avec plusieurs correspondances possibles     → aucun retrait arbitraire ;
 *  · T4-RES-07 reclassement fiable d'une ancienne échéance                  → même identifiant, type corrigé ;
 *  · T4-RES-08 date ambiguë + ancienne échéance + analyse complète          → ancienne échéance conservée ;
 *  · T4-RES-09 candidats acceptés et date ambiguë dans la même source       → écritures valides, aucun retrait global ;
 *  · T4-RES-10 date ensuite résolue                                         → synchronisation normale, sans doublon ;
 *  · T4-RES-11 échec SQL pendant un retrait                                 → travail incomplet, reprise prévue ; reprise sans doublon ;
 *  · T4-RES-12 réanalyse vide avec retrait techniquement impossible         → travail non déclaré réussi ;
 *  · T4-RES-13 événement justifié par plusieurs documents                   → aucun retrait tant qu'une autre source le justifie.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/coherence/impact-propagation.service', async (orig) => ({
  ...(await orig<object>()), emitAgendaItemCreated: async () => {},
}));
// T4-RES-11 : échec SQL simulé PENDANT le retrait tracé (DELETE + journal).
vi.mock('@/services/agenda/agenda-removal-trace', async (orig) => {
  const m = await orig<typeof import('@/services/agenda/agenda-removal-trace')>();
  return {
    ...m,
    removeAgendaItemsTraced: async (...a: Parameters<typeof m.removeAgendaItemsTraced>) => {
      if ((globalThis as { __l75EchecRetrait?: boolean }).__l75EchecRetrait) throw new Error('could not serialize access (échec SQL simulé, e2e)');
      return m.removeAgendaItemsTraced(...a);
    },
  };
});

type Json = Record<string, any>;
const TODAY = '2026-10-19';

/** Sortie T4 v2 enregistrée (modèle simulé), routée par le titre du candidat. */
const t4 = (o: {
  agenda: 'accept' | 'reject' | 'abstain'; recurrence?: 'accept' | 'reject' | 'abstain' | 'not_applicable';
  category?: 'action' | 'information'; businessType?: string | null; pour?: string; repeat?: boolean;
}): RecordedOutput => ({
  operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT', ...(o.pour ? { promptIncludes: o.pour } : {}),
  ...(o.repeat ? { repeat: true } : {}),
  output: {
    task: 'CLASSIFY_EVENT', agendaDecision: o.agenda, recurrenceDecision: o.recurrence ?? 'not_applicable',
    homeCategory: o.agenda === 'accept' ? o.category ?? 'action' : 'unknown',
    businessType: o.agenda === 'accept' ? o.businessType ?? null : null,
    confidence: o.agenda === 'abstain' ? 'ambiguous' : 'certain', reason: 'décision simulée (e2e)',
    recurrenceReason: (o.recurrence ?? 'not_applicable') === 'not_applicable' ? null : 'motif simulé (e2e)',
  },
});
/** Arbitrage TEMPORAL_AMBIGUITY simulé : abstention, ou choix du candidat n° `choix` (dates triées). */
const temporel = (choix: number | null): RecordedOutput => ({
  operationCode: 't4_temporal_ambiguity', task: 'TEMPORAL_AMBIGUITY',
  output: choix === null
    ? { task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', candidateId: null, confidence: 'ambiguous', reason: 'lecture impossible à trancher (e2e)' }
    : { task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: choix, confidence: 'probable', reason: 'document français (e2e)' },
});

/** Candidat ponctuel (sans champ d'origine) d'une source autoritaire. */
const cand = (title: string, date: string, extra: Record<string, unknown> = {}) => ({
  title, date, confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true,
  excerpt: `${title} — le ${date.split('-').reverse().join('/')}`, ...extra,
});

scenario('L75F-T4-RES', 'T4 : choix utilisateur, rapprochements historiques, ambiguïtés temporelles et échecs de retrait (PG16)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T4'], t4Responder: null });
  const rejouer = useRecordings;

  let runT4Job: typeof import('@/services/ai/agenda').runT4Job;
  let processCands: typeof import('@/services/ai/agenda/agenda-intelligence.service').processAgendaCandidates;
  let persistence: typeof import('@/services/agenda/agenda-persistence');
  let parseRecurrenceFr: typeof import('@/services/ai/agenda/rules/recurrence').parseRecurrenceFr;

  beforeAll(async () => {
    ({ runT4Job } = await import('@/services/ai/agenda'));
    ({ processAgendaCandidates: processCands } = await import('@/services/ai/agenda/agenda-intelligence.service'));
    persistence = await import('@/services/agenda/agenda-persistence');
    ({ parseRecurrenceFr } = await import('@/services/ai/agenda/rules/recurrence'));
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
  });
  beforeEach(async () => (await import('@/services/ai/agenda/agenda-intelligence.service')).__resetTemporalCacheForTests());
  afterEach(async () => {
    delete (globalThis as { __l75EchecRetrait?: boolean }).__l75EchecRetrait;
    (await import('@/services/agenda/agenda-removal-trace')).__resetAgendaRemovalTraceForTests(null);
  });
  afterAll(() => { delete (globalThis as { __l75EchecRetrait?: boolean }).__l75EchecRetrait; });

  /** Travail T4 du flux documentaire automatique (même exécutant que la production). Rend l'erreur éventuelle. */
  async function job(compte: { id: number; ownerUserId: number }, assetId: number, fileId: number, candidates: unknown[], complete = true) {
    try {
      const r = await runT4Job({ id: 1, attempts: 1, accountId: compte.id, payload: { assetId, userId: compte.ownerUserId, leadSourceId: fileId, candidates, analysisComplete: complete } } as never,
        { assertActive: async () => {} } as never,
        {
          loadExisting: persistence.loadExistingAgendaItems, persist: persistence.persistAgendaDecisions,
          process: (i) => processCands({ ...i, today: TODAY }), savePayload: async () => true,
        });
      dernierResultat = r ?? null;
      return null;
    } catch (e) {
      dernierResultat = null;
      return e as Error;
    }
  }
  let dernierResultat: unknown = null;

  const items = (assetId: number) => sql<{
    id: number; d: string; title: string; cat: string | null; bt: string | null; nature: string | null; modified: boolean;
    fk: string | null; status: string | null; mode: string | null; initial: string | null;
  }[]>`
    SELECT i.id, i.start_date::text AS d, i.title, i.home_category AS cat, i.business_type AS bt,
           i.occurrence_nature AS nature, i.is_automatic_modified AS modified, i.functional_key AS fk,
           i.manual_status AS status, i.confirmation_mode AS mode, i.forecast_initial_date::text AS initial
      FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${assetId} ORDER BY i.start_date, i.id`;
  const retraits = async (accountId: number) => (await sql<{ id: number }[]>`
    SELECT agenda_item_id AS id FROM agenda_item_removals WHERE account_id = ${accountId} ORDER BY agenda_item_id`).map((r) => Number(r.id));

  async function contexte() {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    return { compte, bien, doc };
  }
  async function historique(c: Awaited<ReturnType<typeof contexte>>, candidats: Array<Record<string, unknown> & { title: string }>, recurrence = false) {
    await rejouer(candidats.map((x) => t4({ agenda: 'accept', pour: x.title, ...(recurrence ? { recurrence: 'accept' as const } : {}) })));
    expect(await job(c.compte, c.bien.id, c.doc.id, candidats)).toBeNull();
    return items(c.bien.id);
  }
  /** Échéance automatique HISTORIQUE (antérieure à la clé fonctionnelle 0223) de la source. */
  async function ancienne(c: Awaited<ReturnType<typeof contexte>>, title: string, date: string, extra: { originFieldKey?: string; businessType?: string } = {}) {
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const r = await upsertAgendaItem({
      accountId: c.compte.id, assetId: c.bien.id, origin: 'AUTOMATIC', title, date, category: 'action',
      originFieldKey: extra.originFieldKey ?? null, businessType: extra.businessType ?? null,
      sources: [{ fileId: c.doc.id, role: 'SOURCE' }], details: { requiresQualification: false },
    });
    await sql`UPDATE agenda_items SET functional_key = NULL WHERE id = ${r.id}`;
    return r.id;
  }

  // ── A — choix utilisateur sur les prévisions ─────────────────────────────
  const chaudiere = (date: string, excerpt = 'Entretien chaudière à réaliser tous les 12 mois') =>
    ({ title: 'Entretien chaudière', date, confidence: 'certain', excerpt, documentType: 'RAPPORT_ENTRETIEN', recurrence: parseRecurrenceFr(excerpt) });
  const finDeRecurrence = () => chaudiere('2026-11-15', 'Entretien chaudière tous les 12 mois — contrat résilié, dernière échéance');

  async function serie(c: Awaited<ReturnType<typeof contexte>>) {
    const l = await historique(c, [chaudiere('2026-11-15')], true);
    expect(l.map((x) => [x.d, x.nature])).toEqual([['2026-11-15', 'CONFIRMED'], ['2027-11-15', 'FORECAST']]);
    return l[1];
  }

  it('T4-RES-01 — prévision marquée « réalisé » par l’utilisateur, puis fin de récurrence : statut conservé', async () => {
    const c = await contexte();
    const prevision = await serie(c);
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    await updateManualStatus(prevision.id, 'realise', c.compte.id);
    const avant = await items(c.bien.id);
    await rejouer([t4({ agenda: 'accept', recurrence: 'accept' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [finDeRecurrence()])).toBeNull();
    const apres = await items(c.bien.id);
    expect(apres).toEqual(avant);
    expect(apres.find((x) => x.id === prevision.id)).toMatchObject({ status: 'realise', d: '2027-11-15' });
  });

  it('T4-RES-02 — prévision marquée « annulé » par l’utilisateur : statut et date conservés (aucune confirmation déplaçant la date)', async () => {
    const c = await contexte();
    // Prévision liée à un champ d'origine : une date lue à deux jours est une confirmation CERTAINE (rapprochement 1 bis).
    const excerpt = 'Entretien chaudière à réaliser tous les 12 mois';
    const base = { ...chaudiere('2026-11-15', excerpt), originFieldKey: 'boilerServiceDueDate' };
    await rejouer([t4({ agenda: 'accept', recurrence: 'accept' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [base])).toBeNull();
    const prevision = (await items(c.bien.id)).find((x) => x.nature === 'FORECAST')!;
    expect(prevision).toBeDefined();
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    await updateManualStatus(prevision.id, 'annule', c.compte.id);
    const avant = await items(c.bien.id);
    // Nouveau document : la date de l'occurrence est lue au 17/11/2027.
    const doc2 = await make.assetFile(c.compte, { assetId: c.bien.id });
    await rejouer([t4({ agenda: 'accept' })]);
    expect(await job(c.compte, c.bien.id, doc2.id, [{ ...cand('Entretien chaudière', '2027-11-17'), originFieldKey: 'boilerServiceDueDate', excerpt: 'Entretien prévu le 17/11/2027' }])).toBeNull();
    const p = (await items(c.bien.id)).find((x) => x.id === prevision.id)!;
    expect(p).toMatchObject({ status: 'annule', d: '2027-11-15', nature: 'FORECAST', mode: null });
    expect((await items(c.bien.id)).filter((x) => avant.some((y) => y.id === x.id))).toEqual(avant);
  });

  it('T4-RES-03 — prévision confirmée par l’utilisateur, puis réanalyse : confirmation et date conservées ; gardes SQL de confirmation et de retrait', async () => {
    const c = await contexte();
    const prevision = await serie(c);
    const { confirmForecastOccurrence } = await import('@/services/agenda/AgendaWriteService');
    await confirmForecastOccurrence(prevision.id, c.compte.id, c.compte.ownerUserId);
    const avant = await items(c.bien.id);
    expect(avant.find((x) => x.id === prevision.id)).toMatchObject({ nature: 'CONFIRMED', mode: 'USER' });
    await rejouer([t4({ agenda: 'accept', recurrence: 'accept' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [chaudiere('2026-11-15')])).toBeNull();
    await rejouer([t4({ agenda: 'accept', recurrence: 'accept' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [finDeRecurrence()])).toBeNull();
    expect(await items(c.bien.id)).toEqual(avant);

    // Gardes SQL ATOMIQUES, indépendantes des vérifications en mémoire du moteur :
    // décisions forgées directement sur des éléments protégés.
    const c2 = await contexte();
    const p2 = await serie(c2);
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    await updateManualStatus(p2.id, 'realise', c2.compte.id);
    // Statut utilisateur seul (sans is_automatic_modified) ou confirmation utilisateur seule.
    const p3 = (await serie(await contexte()));
    await sql`UPDATE agenda_items SET confirmation_mode = 'USER' WHERE id = ${p3.id}`;
    const [{ account_id: compte3 }] = await sql<{ account_id: number }[]>`SELECT account_id FROM agenda_items WHERE id = ${p3.id}`;
    const etat = async (id: number) => (await sql<Json[]>`
      SELECT start_date::text AS d, manual_status AS status, occurrence_nature AS nature, confirmation_mode AS mode, updated_at FROM agenda_items WHERE id = ${id}`)[0];
    const e2 = await etat(p2.id);
    const e3 = await etat(p3.id);
    const forge = (id: number, action: 'confirm_forecast' | 'retire_forecast') => ({
      action, title: 'Entretien chaudière', date: '2027-11-20', category: 'action', confidence: 'certain',
      reasonCode: action === 'confirm_forecast' ? 'FORECAST_CONFIRMED_DATE_ADJUSTED' : 'RECURRENCE_ENDED', existingItemId: id, deterministic: true,
    }) as never;
    for (const action of ['confirm_forecast', 'retire_forecast'] as const) {
      expect((await persistence.persistAgendaDecisions([forge(p2.id, action)], c2.compte.id, c2.bien.id)).writeFailures).toBe(0);
      expect((await persistence.persistAgendaDecisions([forge(p3.id, action)], compte3, 0)).writeFailures).toBe(0);
    }
    expect(await etat(p2.id)).toEqual(e2);
    expect(await etat(p3.id)).toEqual(e3);
  });

  it('T4-RES-04 — prévision automatique intacte, fin de récurrence explicite : retrait légitime (annulée)', async () => {
    const c = await contexte();
    const prevision = await serie(c);
    await rejouer([t4({ agenda: 'accept', recurrence: 'accept' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [finDeRecurrence()])).toBeNull();
    expect((await items(c.bien.id)).find((x) => x.id === prevision.id)).toMatchObject({ status: 'annule', d: '2027-11-15' });
  });

  // ── B — rapprochement des échéances historiques sans clé ─────────────────
  it('T4-RES-05 — deux échéances historiques sans clé, même date, titres différents : aucun rapprochement erroné (adoption, rejet)', async () => {
    const c = await contexte();
    const ramonage = await ancienne(c, 'Ramonage cheminée', '2027-03-01');
    const revision = await ancienne(c, 'Révision chaudière gaz', '2027-03-01');
    const avant = await items(c.bien.id);
    // Rejet explicite de la révision, à côté d'une abstention (aucun retrait global).
    await rejouer([t4({ agenda: 'reject', pour: 'Révision' }), t4({ agenda: 'abstain', pour: 'Taxe' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [cand('Révision chaudière gaz', '2027-03-01'), cand('Taxe foncière', '2027-10-15')])).toBeNull();
    // Seule la révision (même date ET même intitulé) est retirée ; le ramonage est intact.
    expect((await items(c.bien.id)).map((x) => x.id)).toEqual([ramonage]);
    expect(await retraits(c.compte.id)).toEqual([revision]);
    expect((await items(c.bien.id))[0]).toEqual(avant.find((x) => x.id === ramonage));

    // Nouvelle échéance acceptée à la même date : créée, l'ancienne n'est ni adoptée ni réécrite.
    const c2 = await contexte();
    const r2 = await ancienne(c2, 'Ramonage cheminée', '2027-03-01');
    const avant2 = await items(c2.bien.id);
    await rejouer([t4({ agenda: 'accept', pour: 'Vidange' }), t4({ agenda: 'abstain', pour: 'Taxe' })]);
    expect(await job(c2.compte, c2.bien.id, c2.doc.id, [cand('Vidange fosse septique', '2027-03-01'), cand('Taxe foncière', '2027-10-15')])).toBeNull();
    const apres2 = await items(c2.bien.id);
    expect(apres2.find((x) => x.id === r2)).toEqual(avant2[0]);
    expect(apres2.map((x) => x.title).sort()).toEqual(['Ramonage cheminée', 'Vidange fosse septique']);
  });

  it('T4-RES-06 — rejet explicite avec plusieurs correspondances possibles : aucun retrait arbitraire (clés de même famille, doublons sans clé)', async () => {
    // Deux échéances de même date, même source, sans champ d'origine : clés `k` et `k#2`.
    const c = await contexte();
    const avant = await historique(c, [cand('Ramonage cheminée', '2027-03-01'), cand('Révision chaudière gaz', '2027-03-01')]);
    expect(avant).toHaveLength(2);
    const ramonage = avant.find((x) => x.title === 'Ramonage cheminée')!;
    const revision = avant.find((x) => x.title === 'Révision chaudière gaz')!;
    // Rejet de la RÉVISION (sa clé de base est celle du ramonage, créé en premier).
    await rejouer([t4({ agenda: 'reject', pour: 'Révision' }), t4({ agenda: 'abstain', pour: 'Taxe' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [cand('Révision chaudière gaz', '2027-03-01'), cand('Taxe foncière', '2027-10-15')])).toBeNull();
    expect((await items(c.bien.id)).map((x) => x.id)).toEqual([ramonage.id]);
    expect(await retraits(c.compte.id)).toEqual([revision.id]);

    // Deux anciennes échéances indiscernables (même date, même intitulé, sans clé) : aucune n'est retirée.
    const c2 = await contexte();
    const a = await ancienne(c2, 'Ramonage cheminée', '2027-03-01');
    const b = await ancienne(c2, 'Ramonage cheminée', '2027-03-01');
    await rejouer([t4({ agenda: 'reject', pour: 'Ramonage' }), t4({ agenda: 'abstain', pour: 'Taxe' })]);
    expect(await job(c2.compte, c2.bien.id, c2.doc.id, [cand('Ramonage cheminée', '2027-03-01'), cand('Taxe foncière', '2027-10-15')])).toBeNull();
    expect((await items(c2.bien.id)).map((x) => x.id)).toEqual([a, b]);
    expect(await retraits(c2.compte.id)).toEqual([]);
  });

  it('T4-RES-07 — reclassement fiable d’une ancienne échéance : même identifiant, type corrigé, clé posée, aucun doublon', async () => {
    const c = await contexte();
    const id = await ancienne(c, 'Fin du contrat Alpha', '2027-03-01', { originFieldKey: 'contractEndDate', businessType: 'contract' });
    await rejouer([t4({ agenda: 'accept', businessType: 'insurance' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [cand('Fin du contrat Alpha', '2027-03-01', { originFieldKey: 'contractEndDate', businessType: 'contract' })])).toBeNull();
    const l = await items(c.bien.id);
    expect(l.map((x) => [x.id, x.bt, x.d])).toEqual([[id, 'insurance', '2027-03-01']]);
    expect(await retraits(c.compte.id)).toEqual([]);
  });

  // ── C — ambiguïté temporelle ─────────────────────────────────────────────
  /** « 04/03/2027 » : lu 4 mars (lecture française, sans ambiguïté), puis 3 avril (mm/jj) à la réanalyse. */
  const alphaFr = cand('Échéance contrat Alpha', '2027-03-04', { excerpt: 'Échéance contrat Alpha le 04/03/2027' });
  const alphaAmbigu = cand('Échéance contrat Alpha', '2027-04-03', { excerpt: 'Échéance contrat Alpha le 04/03/2027' });

  it('T4-RES-08 — date ambiguë + ancienne échéance + analyse complète : ancienne échéance conservée, carte AGENDA-PROPOSAL', async () => {
    const c = await contexte();
    const avant = await historique(c, [alphaFr]);
    expect(avant.map((x) => x.d)).toEqual(['2027-03-04']);
    await rejouer([temporel(null)]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [alphaAmbigu])).toBeNull();
    expect(await items(c.bien.id)).toEqual(avant);
    expect(await retraits(c.compte.id)).toEqual([]);
    const cartes = await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${c.compte.id} AND rule_code = 'AGENDA-PROPOSAL' AND resolved_at IS NULL`;
    expect(cartes).toHaveLength(1);
    expect(dernierResultat).toMatchObject({ detail: { removalOutcome: 'BLOCKED', temporalAmbiguities: 1 } });
  });

  it('T4-RES-09/10 — candidats acceptés et date ambiguë : écritures valides, aucun retrait global ; date résolue : synchronisation normale, sans doublon', async () => {
    const c = await contexte();
    const avant = await historique(c, [alphaFr, cand('Échéance contrat Bêta', '2027-05-01')]);
    // Réanalyse complète : Alpha ambiguë, Bêta n'est plus produite, Delta nouvelle.
    await rejouer([temporel(null), t4({ agenda: 'accept', pour: 'Delta' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [alphaAmbigu, cand('Échéance contrat Delta', '2027-06-01')])).toBeNull();
    const l = await items(c.bien.id);
    expect(l.map((x) => x.title)).toEqual(['Échéance contrat Alpha', 'Échéance contrat Bêta', 'Échéance contrat Delta']);
    expect(l.filter((x) => avant.some((y) => y.id === x.id))).toEqual(avant);
    expect(await retraits(c.compte.id)).toEqual([]);

    // T4-RES-10 : la date est tranchée (4 mars) — rapprochement normal, Bêta retirée, aucun doublon.
    await (await import('@/services/ai/agenda/agenda-intelligence.service')).__resetTemporalCacheForTests();
    await rejouer([temporel(1), t4({ agenda: 'accept', pour: 'Alpha' }), t4({ agenda: 'accept', pour: 'Delta' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [alphaAmbigu, cand('Échéance contrat Delta', '2027-06-01')])).toBeNull();
    const fin = await items(c.bien.id);
    expect(fin.map((x) => [x.title, x.d])).toEqual([['Échéance contrat Alpha', '2027-03-04'], ['Échéance contrat Delta', '2027-06-01']]);
    expect(fin[0].id).toBe(avant[0].id);
    expect(await retraits(c.compte.id)).toEqual([avant[1].id]);
  });

  // ── D — échecs de retrait remontés à la file ─────────────────────────────
  it('T4-RES-11 — échec SQL pendant un retrait : travail incomplet, reprise prévue par la file ; reprise sans doublon, retrait effectué', async () => {
    const { enqueueT4Candidates } = await import('@/services/ai/agenda');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const b = cand('Échéance contrat Bêta', '2027-04-01');
    const avant = await historique(c, [a, b]);
    const n = cand('Échéance contrat Epsilon', '2027-07-01');

    const id = (await enqueueT4Candidates({ accountId: c.compte.id, userId: c.compte.ownerUserId, assetId: c.bien.id, leadSourceId: c.doc.id, candidates: [a, n] as never, analysisComplete: true }))!;
    const seul = async () => {
      await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE treatment = 'T4' AND status = 'PENDING' AND id <> ${id}`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${id} AND status = 'PENDING'`;
    };
    const lire = async () => (await sql<{ status: string; attempts: number; last_error: string | null; later: boolean; detail: Json | null }[]>`
      SELECT status, attempts, last_error, available_at > now() AS later, business_result_detail AS detail FROM ai_job_queue WHERE id = ${id}`)[0];

    // Passage 1 : écritures valides appliquées (Epsilon créée), retrait de Bêta en échec SQL.
    await seul();
    await rejouer([t4({ agenda: 'accept', pour: 'Alpha' }), t4({ agenda: 'accept', pour: 'Epsilon' })]);
    (globalThis as { __l75EchecRetrait?: boolean }).__l75EchecRetrait = true;
    expect(await runOne('T4')).toBe(true);
    delete (globalThis as { __l75EchecRetrait?: boolean }).__l75EchecRetrait;
    let j = await lire();
    expect(j).toMatchObject({ status: 'PENDING', attempts: 1, later: true });
    // Motif précis visible au BO (File IA › dernière erreur).
    expect(j.last_error).toMatch(/T4_SYNC_FAILED/);
    expect(j.last_error).toMatch(/REMOVAL_FAILED/);
    const apres1 = await items(c.bien.id);
    expect(apres1.map((x) => x.title)).toEqual(['Échéance contrat Alpha', 'Échéance contrat Bêta', 'Échéance contrat Epsilon']);
    expect(await retraits(c.compte.id)).toEqual([]);

    // Passage 2 (reprise) : décisions réutilisées, aucune création en double, Bêta retirée.
    await seul();
    const replay = await rejouer([]);
    expect(await runOne('T4')).toBe(true);
    j = await lire();
    expect(j.status).toBe('DONE');
    expect(replay.calls).toHaveLength(0);
    expect(j.detail).toMatchObject({ removalOutcome: 'REMOVED', removed: 1 });
    const apres2 = await items(c.bien.id);
    expect(apres2.map((x) => x.id)).toEqual([avant[0].id, apres1[2].id]);
    expect(await retraits(c.compte.id)).toEqual([avant[1].id]);
  });

  it('T4-RES-12 — réanalyse vide avec retrait techniquement impossible (journal des retraits indisponible) : travail NON déclaré réussi', async () => {
    const c = await contexte();
    const avant = await historique(c, [cand('Échéance contrat Alpha', '2027-03-01')]);
    const { __resetAgendaRemovalTraceForTests } = await import('@/services/agenda/agenda-removal-trace');
    __resetAgendaRemovalTraceForTests(false);
    const err = await job(c.compte, c.bien.id, c.doc.id, []);
    expect(err?.message).toMatch(/T4_SYNC_FAILED/);
    expect(err?.message).toMatch(/TRACE_UNAVAILABLE/);
    expect(await items(c.bien.id)).toEqual(avant);
    // Échec SQL pendant le retrait d'une réanalyse vide : idem.
    __resetAgendaRemovalTraceForTests(null);
    (globalThis as { __l75EchecRetrait?: boolean }).__l75EchecRetrait = true;
    expect((await job(c.compte, c.bien.id, c.doc.id, []))?.message).toMatch(/T4_SYNC_FAILED/);
    delete (globalThis as { __l75EchecRetrait?: boolean }).__l75EchecRetrait;
    expect(await items(c.bien.id)).toEqual(avant);
    // Prérequis rétablis : la synchronisation aboutit.
    expect(await job(c.compte, c.bien.id, c.doc.id, [])).toBeNull();
    expect(await items(c.bien.id)).toEqual([]);
    expect(dernierResultat).toMatchObject({ detail: { removalOutcome: 'REMOVED', removed: 1 } });
  });

  it('T4-RES-13 — événement justifié par plusieurs documents : aucun retrait tant qu’une autre source le justifie (et ce n’est pas un échec)', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const [evt] = await historique(c, [a]);
    const docB = await make.assetFile(c.compte, { assetId: c.bien.id });
    await rejouer([t4({ agenda: 'accept' })]);
    expect(await job(c.compte, c.bien.id, docB.id, [a])).toBeNull();
    expect(await job(c.compte, c.bien.id, c.doc.id, [])).toBeNull();
    expect((await items(c.bien.id)).map((x) => x.id)).toEqual([evt.id]);
    expect(await retraits(c.compte.id)).toEqual([]);
  });
});
