/**
 * Lot 106A — ticket P1 « Agenda — doublons DPE non autoréparés » (cas Maison,
 * 22/12/2020 : « Contrôle réalisé — Maison », « DPE réalisé — DPE », « DPE
 * réalisé — Maison ») — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : analyse par le point d'entrée unique
 * (`analyzeFileSources`, sortie T1 rejouée), files durables T3 / T4 vidées par
 * l'exécutant de production, persistance T4 (`persistAgendaDecisions`),
 * contrôle de cohérence par l'orchestrateur (campagne bornée aux comptes du
 * scénario). Aucun appel IA réel (T4 simulé du harnais : accepte).
 *
 *   L106A-E2E-01  reproduction du STOCK (sorties exactes de l'ancienne persistance) → campagne : une ligne « DPE réalisé — Maison »,
 *                 deux preuves, statut par preuve ; journal 0591 / 1000 avant-après ; 2e campagne et réanalyses T1/T3/T4 : rien ne change
 *   L106A-E2E-02  prévention : dossier puis compromis, et l'ordre inverse → même résultat (un DPE, deux preuves, aucun « Contrôle réalisé »,
 *                 échéance 2030 distincte) ; campagne sans changement
 *   L106A-E2E-03  événement de fiche préexistant puis T4, et T4 puis événement de fiche → contrôle : même résultat
 *   L106A-E2E-04  choix de l'utilisateur : élément modifié / statut posé → jamais absorbé ni réécrit (il devient le canonique)
 *   L106A-E2E-05  même date, même dossier, deux diagnostics distincts (DPE + électricité) ; deux n° ADEME → aucune fusion
 *   L106A-E2E-06  identité incertaine (aucune référence stable) → aucune fusion, file durable T4, constat qualifié
 *   L106A-E2E-07  compte non éligible : exclu de la campagne (motif visible), rien n'est écrit
 *   L106A-E2E-08  échec transitoire (trace 0223 indisponible) → rien d'écrit, reprise → réparé ; deux exécutions concurrentes → une seule consolidation
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { agenda, analyserDocument, sortieT1, useTargetState } from '../chain';
import { runCoherenceFor } from '../coherence-run';
import type { AgendaDecision } from '@/services/ai/agenda/types';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const CHECK = 'COH-AGENDA-EQUIVALENT-REPRESENTATIONS';
const ADEME = '2069V2010945W';
const DATE = '2020-12-22';

scenario('L106A', 'Agenda — représentations équivalentes d’un même DPE (toutes origines)', ({ sql, make, useRecordings }) => {
  useTargetState();

  // ── Sources (mêmes champs que l'export du 25/10 : #309 dossier, #316 compromis) ──
  const dossier = (assetId: number, o: { ademe?: string; electrique?: boolean } = {}) => sortieT1({
    title: 'Dossier de diagnostic technique', date: DATE, documentTypeCode: 'DIAGNOSTIC', canonicalType: 'DIAGNOSTIC', rubricCode: 'REGULATORY_DIAGNOSTICS',
    assets: [{ id: assetId, label: 'Maison' }],
    facts: [
      { canonicalKey: 'dpeDate', value: DATE, valueType: 'date', excerpt: 'DPE établi le 22/12/2020', assetId, subject: 'DPE', semanticEvent: { type: 'dpe', nature: 'HISTORICAL' } },
      o.electrique
        ? { canonicalKey: 'diagnosticDate', value: DATE, valueType: 'date', excerpt: 'Diagnostic électricité réalisé le 22/12/2020', assetId, subject: 'Installation électrique', semanticEvent: { type: 'inspection', nature: 'HISTORICAL' } }
        : { canonicalKey: 'diagnosticDate', value: DATE, valueType: 'date', excerpt: 'Date du dossier : 22/12/2020', assetId, semanticEvent: { type: 'inspection', nature: 'HISTORICAL' } },
      { canonicalKey: 'dpeAdemeNumber', value: o.ademe ?? ADEME, valueType: 'string', excerpt: `N° ADEME : ${o.ademe ?? ADEME}`, assetId },
      { canonicalKey: 'dpeExpiryDate', value: '2030-12-21', valueType: 'date', excerpt: 'Valable jusqu’au 21/12/2030', assetId, semanticEvent: { type: 'dpe', nature: 'DEADLINE' } },
    ],
  });
  const compromis = (assetId: number, o: { ademe?: string | null } = {}) => sortieT1({
    title: 'Compromis de vente', date: '2021-03-04', documentTypeCode: 'COMPROMIS_VENTE', canonicalType: 'COMPROMIS_VENTE', rubricCode: 'PROPERTY_MANAGEMENT',
    assets: [{ id: assetId, label: 'Maison' }],
    facts: [
      { canonicalKey: 'dpeDate', value: DATE, valueType: 'date', excerpt: 'DPE réalisé le 22/12/2020', assetId, semanticEvent: { type: 'dpe', nature: 'HISTORICAL' } },
      ...(o.ademe === null ? [] : [{ canonicalKey: 'dpeAdemeNumber', value: o.ademe ?? ADEME, valueType: 'string' as const, excerpt: `numéro ADEME ${o.ademe ?? ADEME}`, assetId }]),
    ],
  });

  async function contexte(plan: 'premium' | null = 'premium') {
    const compte = await make.account({ plan });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f309 = await make.assetFile(compte, { assetId: maison.id });
    const f316 = await make.assetFile(compte, { assetId: maison.id });
    const analyser = (fileId: number, output: Record<string, unknown>) =>
      analyserDocument(sql, useRecordings, { accountId: compte.id, userId: compte.ownerUserId, fileId, linkedAssetId: maison.id, output });
    return { compte, maison, f309: f309.id, f316: f316.id, analyser };
  }

  /**
   * STOCK : décisions EXACTES de l'ancienne chaîne T4 (fait de plus de cinq ans → `propose` DATE_OUT_OF_RANGE, AVANT tout
   * rapprochement et tout droit de création), persistées par la primitive de production — mêmes origines, clés, liens et sources
   * que la reproduction pas à pas faite avec le code de la base lot105bis (voir docs/exploitation/recette-106a-agenda-doublons-dpe.md).
   */
  async function stockAncien(c: Awaited<ReturnType<typeof contexte>>) {
    await sql`DELETE FROM agenda_items WHERE account_id = ${c.compte.id} AND start_date = ${DATE}`;
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    const d = (fileId: number, title: string, o: Partial<AgendaDecision>): AgendaDecision => ({
      action: 'propose', reasonCode: 'DATE_OUT_OF_RANGE', title, date: DATE, category: 'information', confidence: 'certain', deterministic: true,
      sourceFileId: fileId, nature: 'HISTORICAL', target: { type: 'ASSET', id: c.maison.id }, sources: [{ fileId, role: 'SOURCE' }], ...o,
    });
    await persistAgendaDecisions([
      d(c.f309, 'DPE réalisé — DPE', { originFieldKey: 'dpeDate', businessType: 'dpe', occurrenceIndex: 'single', mayCreateAgenda: true }),
      d(c.f309, 'Contrôle réalisé — Maison', { businessType: 'inspection', occurrenceIndex: DATE, mayCreateAgenda: true }),
    ], c.compte.id, c.maison.id, { sourceFileId: c.f309, analysisComplete: false });
    await persistAgendaDecisions([
      d(c.f316, 'DPE réalisé — Maison', { originFieldKey: 'dpeDate', businessType: 'dpe', occurrenceIndex: 'single', mayCreateAgenda: false }),
    ], c.compte.id, c.maison.id, { sourceFileId: c.f316, analysisComplete: false });
    const ev = await faits(c.maison.id);
    expect(ev.map((e) => e.title).sort()).toEqual(['Contrôle réalisé — Maison', 'DPE réalisé — DPE', 'DPE réalisé — Maison']);
    return ev;
  }

  const faits = async (assetId: number) => (await agenda(sql, assetId)).filter((e) => e.date === DATE);
  const lignes = async (accountId: number) => sql<Json[]>`
    SELECT i.id, i.title, i.origin_type, i.origin_field_key, i.business_type, i.manual_status, i.completion_proof_file_id, i.is_automatic_modified
      FROM agenda_items i WHERE i.account_id = ${accountId} AND i.start_date = ${DATE} ORDER BY i.id`;
  const echeances = async (assetId: number) => (await agenda(sql, assetId)).filter((e) => e.nature === 'DEADLINE').map((e) => [e.date, e.businessType]);
  const journal = (accountId: number) => sql<Json[]>`
    SELECT kind, origin, operation_id, principal_item_id, absorbed_item_id, reason FROM agenda_intervention_consolidations WHERE account_id = ${accountId} ORDER BY id`;
  const decisions = (accountId: number) => sql<Json[]>`
    SELECT verdict, reason, canonical_item_id, absorbed_item_ids, member_item_ids, before_state, after_state, evidence FROM agenda_equivalence_decisions
     WHERE account_id = ${accountId} ORDER BY id`;
  const instantane = async (accountId: number) => JSON.stringify({
    items: await sql`SELECT id, title, start_date::text, manual_status, completion_proof_file_id, business_type FROM agenda_items WHERE account_id = ${accountId} ORDER BY id`,
    links: await sql`SELECT l.agenda_item_id, l.asset_file_id FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${accountId} ORDER BY 1, 2`,
    journal: await journal(accountId),
  });

  it('L106A-E2E-01 — stock du ticket (3 lignes) → campagne : UNE ligne « DPE réalisé — Maison », deux preuves, sans statut (#715), journal avant / après ; convergence', async () => {
    const c = await contexte();
    await c.analyser(c.f309, dossier(c.maison.id));
    await c.analyser(c.f316, compromis(c.maison.id));
    const [dpe309, generique, dpe316] = await stockAncien(c);
    const avant = await lignes(c.compte.id);
    expect(avant.map((x) => [x.origin_type, x.origin_field_key, x.business_type])).toEqual([
      ['asset_field', 'dpeDate', 'dpe'], ['qualified_document', null, 'inspection'], ['asset_field', 'dpeDate', 'dpe']]);

    const r1 = await runCoherenceFor(sql, [c.compte.id]);
    expect(r1.status).toBe('COMPLETE');
    expect(r1.results[CHECK]).toEqual({ REPAIRED: 1 });
    const apres = await faits(c.maison.id);
    expect(apres).toHaveLength(1);
    expect(apres[0]).toMatchObject({ id: dpe309.id, title: 'DPE réalisé — Maison', businessType: 'dpe', nature: 'HISTORICAL' });
    expect(apres[0].sources).toEqual([c.f309, c.f316]);
    // #715 : plus de statut d'événement — aucune preuve de réalisation n'est plus reportée sur l'occurrence.
    const [canon] = await lignes(c.compte.id);
    expect(canon.completion_proof_file_id).toBeNull();
    expect(canon.manual_status).toBeNull();
    // Échéance de validité 2030 : distincte, jamais confondue avec la réalisation 2020.
    expect(await echeances(c.maison.id)).toEqual([['2030-12-21', 'dpe']]);
    // Journal 0591 (origine COHERENCE, sans Opération, restaurable) et décision 1000 avant / après.
    expect(await journal(c.compte.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ABSORB', origin: 'COHERENCE', operation_id: null, principal_item_id: dpe309.id, absorbed_item_id: generique.id }),
      expect.objectContaining({ kind: 'ABSORB', origin: 'COHERENCE', operation_id: null, principal_item_id: dpe309.id, absorbed_item_id: dpe316.id }),
      expect.objectContaining({ kind: 'RETITLE', origin: 'COHERENCE', principal_item_id: dpe309.id }),
    ]));
    const [dec] = await decisions(c.compte.id);
    expect(dec).toMatchObject({ verdict: 'CONSOLIDATED', reason: 'SAME_STABLE_REFERENCE', canonical_item_id: dpe309.id });
    expect([...dec.absorbed_item_ids].sort()).toEqual([generique.id, dpe316.id].sort());
    expect(dec.before_state.items).toHaveLength(3);
    expect(dec.after_state.items).toEqual([expect.objectContaining({ id: dpe309.id, title: 'DPE réalisé — Maison' })]);
    expect(dec.evidence.references).toEqual([ADEME]);
    expect((await sql`SELECT agenda_item_id, reason FROM agenda_item_removals WHERE account_id = ${c.compte.id} ORDER BY agenda_item_id`).map((x) => x.reason))
      .toEqual(['EQUIVALENT_REPRESENTATION', 'EQUIVALENT_REPRESENTATION']);
    // Documents intacts.
    expect((await sql`SELECT id FROM asset_files WHERE account_id = ${c.compte.id} AND deleted_at IS NULL ORDER BY id`).map((x) => x.id)).toEqual([c.f309, c.f316]);

    // Convergence : deuxième campagne, puis réanalyses T1 → T3 → T4 des deux documents : rien ne change.
    const fige = await instantane(c.compte.id);
    const r2 = await runCoherenceFor(sql, [c.compte.id]);
    expect(r2.results[CHECK] ?? {}).not.toHaveProperty('REPAIRED');
    expect(await instantane(c.compte.id)).toBe(fige);
    await c.analyser(c.f309, dossier(c.maison.id));
    await c.analyser(c.f316, compromis(c.maison.id));
    expect((await faits(c.maison.id)).map((e) => [e.id, e.title])).toEqual([[dpe309.id, 'DPE réalisé — Maison']]);
    await runCoherenceFor(sql, [c.compte.id]);
    expect((await faits(c.maison.id)).map((e) => e.id)).toEqual([dpe309.id]);
    expect((await decisions(c.compte.id)).filter((d) => d.verdict === 'CONSOLIDATED')).toHaveLength(1);
  });

  it('L106A-E2E-02 — prévention : dossier puis compromis, et l’ordre inverse → un DPE, deux preuves, aucun « Contrôle réalisé » générique, échéance 2030 distincte', async () => {
    const resultats: Json[] = [];
    for (const ordre of ['dossier-puis-compromis', 'compromis-puis-dossier']) {
      const c = await contexte();
      if (ordre === 'dossier-puis-compromis') { await c.analyser(c.f309, dossier(c.maison.id)); await c.analyser(c.f316, compromis(c.maison.id)); }
      else { await c.analyser(c.f316, compromis(c.maison.id)); await c.analyser(c.f309, dossier(c.maison.id)); }
      await runCoherenceFor(sql, [c.compte.id]);
      const ev = await faits(c.maison.id);
      expect(ev, ordre).toHaveLength(1);
      expect(ev[0].businessType).toBe('dpe');
      expect(ev[0].title.startsWith('DPE réalisé')).toBe(true);
      expect(ev[0].sources, ordre).toEqual([c.f309, c.f316]);
      expect(await echeances(c.maison.id)).toEqual([['2030-12-21', 'dpe']]);
      // Aucune carte « Ajouter à l'agenda ? » restée ouverte pour le DPE déjà présent.
      expect(await sql`SELECT id FROM to_process_actions WHERE account_id = ${c.compte.id} AND rule_code = 'AGENDA-PROPOSAL' AND resolved_at IS NULL`).toEqual([]);
      const fige = await instantane(c.compte.id);
      await runCoherenceFor(sql, [c.compte.id]);
      expect(await instantane(c.compte.id), ordre).toBe(fige);
      resultats.push({ n: ev.length, type: ev[0].businessType, sources: ev[0].sources.length, echeances: await echeances(c.maison.id) });
    }
    expect(resultats[0]).toEqual(resultats[1]);
  });

  it('L106A-E2E-03 — événement de fiche (asset_field) préexistant puis T4, et l’ordre inverse → contrôle : même résultat', async () => {
    const fiche = async (c: Awaited<ReturnType<typeof contexte>>) => {
      await sql`UPDATE assets SET key_characteristics = (coalesce(key_characteristics::jsonb, '{}'::jsonb) || ${JSON.stringify({ dpeDate: DATE, dpeAdemeNumber: ADEME })}::jsonb)::text WHERE id = ${c.maison.id}`;
      const [i] = await sql<{ id: number }[]>`
        INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_field_key, event_nature, business_type, home_category)
        VALUES (${c.compte.id}, 'DPE réalisé — DPE', ${DATE}, true, 'asset_field', 'dpeDate', 'HISTORICAL', 'dpe', 'information') RETURNING id`;
      await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${i.id}, ${c.maison.id})`;
      return i.id;
    };
    // a) fiche puis T4 : T4 rapproche (doublon certain) et y rattache ses preuves.
    const a = await contexte();
    const ficheA = await fiche(a);
    await a.analyser(a.f309, dossier(a.maison.id));
    await a.analyser(a.f316, compromis(a.maison.id));
    await runCoherenceFor(sql, [a.compte.id]);
    const evA = await faits(a.maison.id);
    expect(evA.map((e) => [e.id, e.businessType])).toEqual([[ficheA, 'dpe']]);
    expect(evA[0].sources).toEqual([a.f309, a.f316]);
    // b) T4 puis fiche (événement de fiche ajouté après) → contrôle : consolidé.
    const b = await contexte();
    await b.analyser(b.f309, dossier(b.maison.id));
    await b.analyser(b.f316, compromis(b.maison.id));
    await fiche(b);
    expect(await faits(b.maison.id)).toHaveLength(2);
    await runCoherenceFor(sql, [b.compte.id]);
    const evB = await faits(b.maison.id);
    expect(evB).toHaveLength(1);
    expect(evB[0].businessType).toBe('dpe');
    expect(evB[0].sources).toEqual([b.f309, b.f316]);
    expect(await echeances(a.maison.id)).toEqual(await echeances(b.maison.id));
  });

  it('L106A-E2E-04 — élément modifié ou statut posé par l’utilisateur : jamais absorbé ni réécrit ; il devient l’élément conservé', async () => {
    const c = await contexte();
    await c.analyser(c.f309, dossier(c.maison.id));
    await c.analyser(c.f316, compromis(c.maison.id));
    const [dpe309, generique, dpe316] = await stockAncien(c);
    // L'utilisateur a modifié la ligne du compromis (intitulé personnel) ; il avait posé « Réalisé » sur celle du dossier
    // (#715 : statut migré par 1526 en « modifié par l'utilisateur », trace historique STATUS_CHANGED conservée).
    await sql`UPDATE agenda_items SET title = 'Mon DPE (vente)', is_automatic_modified = true WHERE id = ${dpe316.id}`;
    await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${dpe309.id}`;
    await sql`INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES (${dpe309.id}, ${c.compte.id}, 'STATUS_CHANGED', '{"manualStatus":"realise"}'::jsonb)`;
    await runCoherenceFor(sql, [c.compte.id]);
    const l = await lignes(c.compte.id);
    // Les deux choix de l'utilisateur restent tels quels ; seul le générique automatique intact est absorbé.
    expect(l.map((x) => [x.id, x.title, x.manual_status])).toEqual([[dpe309.id, 'DPE réalisé — DPE', null], [dpe316.id, 'Mon DPE (vente)', null]]);
    expect((await journal(c.compte.id)).filter((j) => j.kind === 'ABSORB').map((j) => j.absorbed_item_id)).toEqual([generique.id]);
    const [dec] = await decisions(c.compte.id);
    expect(dec).toMatchObject({ verdict: 'CONSOLIDATED', canonical_item_id: dpe309.id });
    expect(dec.evidence.kept).toEqual(expect.arrayContaining([{ id: dpe316.id, why: 'PROTECTED_USER' }]));
    const fige = await instantane(c.compte.id);
    await runCoherenceFor(sql, [c.compte.id]);
    expect(await instantane(c.compte.id)).toBe(fige);
  });

  it('L106A-E2E-05 — faits distincts : DPE et diagnostic électrique du même dossier, même date ; deux DPE de n° ADEME différents → aucune fusion', async () => {
    const c = await contexte();
    await c.analyser(c.f309, dossier(c.maison.id, { electrique: true }));
    const ev = await faits(c.maison.id);
    expect(ev.map((e) => e.businessType).sort()).toEqual(['dpe', 'inspection']);
    expect(ev.find((e) => e.businessType === 'inspection')!.title).toBe('Contrôle réalisé — Installation électrique');
    await runCoherenceFor(sql, [c.compte.id]);
    expect((await faits(c.maison.id)).map((e) => e.id).sort()).toEqual(ev.map((e) => e.id).sort());
    expect((await journal(c.compte.id)).filter((j) => j.kind === 'ABSORB')).toEqual([]);

    const d = await contexte();
    await d.analyser(d.f309, dossier(d.maison.id));
    await sql`DELETE FROM agenda_items WHERE account_id = ${d.compte.id} AND business_type = 'inspection'`;
    // Second DPE, autre n° ADEME, même jour (fiche) : deux faits distincts.
    await d.analyser(d.f316, compromis(d.maison.id, { ademe: '2169V9999999Z' }));
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions([{
      action: 'propose', reasonCode: 'DATE_OUT_OF_RANGE', title: 'DPE réalisé — Maison', date: DATE, category: 'information', confidence: 'certain', deterministic: true,
      sourceFileId: d.f316, originFieldKey: 'dpeDate', businessType: 'dpe', nature: 'HISTORICAL', target: { type: 'ASSET', id: d.maison.id }, occurrenceIndex: 'single',
      sources: [{ fileId: d.f316, role: 'SOURCE' }],
    }], d.compte.id, d.maison.id, { sourceFileId: d.f316 });
    const deux = await faits(d.maison.id);
    expect(deux).toHaveLength(2);
    await runCoherenceFor(sql, [d.compte.id]);
    expect((await faits(d.maison.id)).map((e) => e.id).sort()).toEqual(deux.map((e) => e.id).sort());
    expect((await journal(d.compte.id)).filter((j) => j.kind === 'ABSORB')).toEqual([]);
  });

  it('L106A-E2E-06 — identité incertaine (aucune référence stable) : aucune fusion, groupe en file durable T4, constat qualifié', async () => {
    const c = await contexte();
    await c.analyser(c.f309, sortieT1({
      title: 'Attestation', date: '2021-01-10', documentTypeCode: 'DPE', canonicalType: 'DPE', rubricCode: 'REGULATORY_DIAGNOSTICS', assets: [{ id: c.maison.id, label: 'Maison' }],
      facts: [{ canonicalKey: 'dpeDate', value: DATE, valueType: 'date', excerpt: 'DPE du 22/12/2020', assetId: c.maison.id, semanticEvent: { type: 'dpe', nature: 'HISTORICAL' } }],
    }));
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions([{
      action: 'propose', reasonCode: 'DATE_OUT_OF_RANGE', title: 'DPE réalisé — Maison', date: DATE, category: 'information', confidence: 'certain', deterministic: true,
      sourceFileId: c.f316, originFieldKey: 'dpeDate', businessType: 'dpe', nature: 'HISTORICAL', target: { type: 'ASSET', id: c.maison.id }, occurrenceIndex: 'single',
      sources: [{ fileId: c.f316, role: 'SOURCE' }],
    }], c.compte.id, c.maison.id, { sourceFileId: c.f316 });
    const avant = await faits(c.maison.id);
    expect(avant).toHaveLength(2);
    const r = await runCoherenceFor(sql, [c.compte.id]);
    expect(r.results[CHECK]).toEqual({ FINDING: 1 });
    expect((await faits(c.maison.id)).map((e) => e.id).sort()).toEqual(avant.map((e) => e.id).sort());
    const file = await decisions(c.compte.id);
    expect(file).toEqual([expect.objectContaining({ verdict: 'T4_UNAVAILABLE', reason: 'NO_STABLE_REFERENCE' })]);
    expect([...file[0].member_item_ids].sort()).toEqual(avant.map((e) => e.id).sort());
    // Relance : même empreinte → aucune nouvelle ligne de file, aucune écriture.
    await runCoherenceFor(sql, [c.compte.id]);
    expect(await decisions(c.compte.id)).toHaveLength(1);
  });

  it('L106A-E2E-07 — compte non éligible (suspendu) : exclu de la campagne avec son motif, rien n’est écrit', async () => {
    const c = await contexte();
    await c.analyser(c.f309, dossier(c.maison.id));
    await c.analyser(c.f316, compromis(c.maison.id));
    await stockAncien(c);
    // Compte suspendu (règle 82A) : exclu de toute exécution, même en constat.
    await sql`UPDATE accounts SET is_active = false WHERE id = ${c.compte.id}`;
    const { coherenceAccountEligibility } = await import('@/services/coherence/eligibility');
    expect(await coherenceAccountEligibility(c.compte.id)).toEqual({ eligible: false, reason: 'ACCOUNT_SUSPENDED' });
    const orch = await import('@/services/coherence/orchestrator');
    const r = await runCoherenceFor(sql, [c.compte.id]);
    const camp = await orch.getCampaign(r.campaignId);
    expect(camp).toMatchObject({ accounts: { visited: 0, skipped: { ACCOUNT_SUSPENDED: 1 } } });
    expect(await faits(c.maison.id)).toHaveLength(3);
    expect(await decisions(c.compte.id)).toEqual([]);
  });

  it('L106A-E2E-09 — représentation rattachée à un événement de référence : jamais fusionnée par le code ; décision T4 ciblée (orchestration existante), sans capacité → file durable, aucune fusion', async () => {
    const c = await contexte();
    await c.analyser(c.f309, dossier(c.maison.id));
    await c.analyser(c.f316, compromis(c.maison.id));
    const [dpe309, generique, dpe316] = await stockAncien(c);
    const [{ id: op }] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, status, type_code, realized_date) VALUES (${c.compte.id}, 'REALIZED', 'INTERVENTION', ${DATE}) RETURNING id`;
    await sql`INSERT INTO business_operation_asset_links (operation_id, asset_id, account_id, authority, active) VALUES (${op}, ${c.maison.id}, ${c.compte.id}, 'INFERENCE', true)`;
    await sql`UPDATE agenda_items SET business_operation_id = ${op} WHERE id = ${dpe316.id}`;
    const r = await runCoherenceFor(sql, [c.compte.id]);
    expect(Object.keys(r.results[CHECK] ?? {})).not.toContain('REPAIRED');
    expect((await faits(c.maison.id)).map((e) => e.id).sort()).toEqual([dpe309.id, generique.id, dpe316.id].sort());
    expect((await journal(c.compte.id)).filter((j) => j.kind === 'ABSORB' && j.origin === 'COHERENCE')).toEqual([]);
    const file = await decisions(c.compte.id);
    expect(file).toEqual([expect.objectContaining({ verdict: expect.stringMatching(/^T4_(PENDING|UNAVAILABLE)$/), reason: 'OPERATION_REPRESENTATION_T4' })]);
    expect(file[0].evidence.operationIds.map(Number)).toEqual([Number(op)]);
    // Relance : même empreinte → aucune nouvelle ligne, aucune écriture.
    await runCoherenceFor(sql, [c.compte.id]);
    expect(await decisions(c.compte.id)).toHaveLength(1);
  });

  it('L106A-E2E-08 — échec transitoire puis reprise ; exécutions concurrentes → une seule consolidation, aucune erreur', async () => {
    const c = await contexte();
    await c.analyser(c.f309, dossier(c.maison.id));
    await c.analyser(c.f316, compromis(c.maison.id));
    await stockAncien(c);
    const trace = await import('@/services/agenda/agenda-removal-trace');
    const { applyAssetEquivalence } = await import('@/services/agenda/equivalence/store');
    // Trace 0223 « indisponible » : le retrait est refusé → transaction annulée, rien n'est écrit (aucun retrait sans trace).
    trace.__resetAgendaRemovalTraceForTests(false);
    await expect(applyAssetEquivalence(sql, c.compte.id, c.maison.id, { correlationId: 'e2e:l106a:echec' })).rejects.toThrow(/retrait tracé/);
    trace.__resetAgendaRemovalTraceForTests(null);
    expect(await faits(c.maison.id)).toHaveLength(3);
    expect(await journal(c.compte.id)).toEqual([]);
    expect(await decisions(c.compte.id)).toEqual([]);
    // Deux exécutions concurrentes (événement + campagne) : verrou du compte, la seconde ne trouve plus rien.
    const [x, y] = await Promise.all([
      applyAssetEquivalence(sql, c.compte.id, c.maison.id, { correlationId: 'e2e:l106a:a' }),
      applyAssetEquivalence(sql, c.compte.id, c.maison.id, { correlationId: 'e2e:l106a:b' }),
    ]);
    expect([x.applied.length, y.applied.length].sort()).toEqual([0, 1]);
    expect(await faits(c.maison.id)).toHaveLength(1);
    expect((await decisions(c.compte.id)).filter((d) => d.verdict === 'CONSOLIDATED')).toHaveLength(1);
    // Le contrôle ciblé suivant constate la cohérence.
    const r = await runCoherenceFor(sql, [c.compte.id]);
    expect(r.results[CHECK] ?? {}).not.toHaveProperty('REPAIRED');
  });
});
