/**
 * Lot 99D — ticket « [P1] Agenda — Corriger la détection abusive de fin de
 * récurrence à partir des clauses de résiliation », sur PostgreSQL réel
 * (L99D-E2E). Chaîne complète : faits T1 PERSISTÉS → candidats (même
 * constructeur que l'analyse et le rattachement) → exécutant T4 de
 * production (modèle SIMULÉ, rejeu) → persistance → Agenda (lecture de
 * l'écran). Puis reprise des données de l'ancienne règle par le contrôle de
 * cohérence COH-AGENDA-RECURRENCE-END (même orchestrateur que la tâche
 * planifiée), sans nouvel envoi de document.
 *
 *  · E2E-01 contrat actif reconductible, « résiliation possible avec préavis » → prévision présente dans l'Agenda ;
 *  · E2E-02 même document réanalysé : résiliation EFFECTIVE au 31/12 de l'an dernier → prévision postérieure retirée,
 *           arrêt tracé (raison, date d'effet, source) ; occurrence réelle passée conservée ;
 *  · E2E-03 non-renouvellement confirmé à une échéance future → occurrences jusqu'à la date d'effet, rien après ;
 *  · E2E-04 reprise : prévision annulée sans trace par l'ancienne règle → rétablie (FORECAST_RESTORED) ;
 *           prévision jamais générée → document remis dans la file T4, occurrence créée ; annulation de
 *           l'utilisateur et fin confirmée respectées ; aucune occurrence passée réelle touchée.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { runCoherenceFor, proofOf } from '../coherence-run';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const Y = Number(TODAY.slice(0, 4));
/** 31/12 de l'année précédente (passée) et de l'année courante (à venir ou aujourd'hui). */
const FIN_AN_DERNIER = `${Y - 1}-12-31`;
const FIN_CETTE_ANNEE = `${Y}-12-31`;
const fr = (iso: string) => iso.split('-').reverse().join('/');

const t4 = (recurrence: 'accept' | 'not_applicable' = 'accept'): RecordedOutput => ({
  operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT', repeat: true,
  output: {
    task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: recurrence, homeCategory: 'action', businessType: null,
    confidence: 'certain', reason: 'décision simulée (e2e)', recurrenceReason: recurrence === 'accept' ? 'récurrence énoncée (e2e)' : null,
  },
});

scenario('L99D-E2E', 'Agenda : une clause de résiliation n’arrête plus une récurrence ; reprise des séries arrêtées à tort (PG16)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T4'], t4Responder: null });

  let runT4Job: typeof import('@/services/ai/agenda').runT4Job;
  let processCands: typeof import('@/services/ai/agenda/agenda-intelligence.service').processAgendaCandidates;
  let persistence: typeof import('@/services/agenda/agenda-persistence');
  let knowledge: typeof import('@/services/ai/knowledge/document-knowledge.service');

  beforeAll(async () => {
    ({ runT4Job } = await import('@/services/ai/agenda'));
    ({ processAgendaCandidates: processCands } = await import('@/services/ai/agenda/agenda-intelligence.service'));
    persistence = await import('@/services/agenda/agenda-persistence');
    knowledge = await import('@/services/ai/knowledge/document-knowledge.service');
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    await useRecordings([t4()]);
  });

  async function contexte() {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    return { compte, bien, doc };
  }
  type Ctx = Awaited<ReturnType<typeof contexte>>;

  /** Faits T1 PERSISTÉS du document (représentation remplacée : nouvelle analyse). */
  async function faits(c: Ctx, liste: Array<{ key: string; value: string; excerpt: string; confidence?: string }>) {
    await sql`DELETE FROM document_extractions WHERE file_id = ${c.doc.id}`;
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${c.compte.id}, ${c.doc.id}, 'Contrat', 'CONTRAT_ASSURANCE', NULL, 0) RETURNING id`;
    for (const f of liste) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, value_json, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${c.compte.id}, ${c.doc.id}, ${id}, ${f.key}, ${f.value}, to_jsonb(${f.value}::text), ${f.value}, ${f.confidence ?? 'certain'}, ${f.excerpt}, ${f.key})`;
    }
  }

  /** Candidats reconstruits depuis les faits persistés (même constructeur que l'analyse). */
  async function candidats(c: Ctx) {
    const k = (await knowledge.getDocumentKnowledge(c.compte.id, c.doc.id))!;
    return knowledge.lateLinkAgendaCandidates({ knowledge: k, fileId: c.doc.id, assetId: c.bien.id, allowReassign: false, today: TODAY });
  }

  /** Travail T4 du flux documentaire (exécutant de production). */
  async function job(c: Ctx) {
    await runT4Job({ id: 1, attempts: 1, accountId: c.compte.id, payload: { assetId: c.bien.id, userId: c.compte.ownerUserId, leadSourceId: c.doc.id, candidates: await candidats(c), analysisComplete: true } } as never,
      { assertActive: async () => {} } as never,
      {
        loadExisting: persistence.loadExistingAgendaItems, persist: persistence.persistAgendaDecisions,
        process: (i) => processCands({ ...i, today: TODAY }), savePayload: async () => true,
      });
  }

  const items = (c: Ctx) => sql<{ id: number; d: string; nature: string; status: string | null; sk: string | null; rec: Json | null }[]>`
    SELECT i.id, i.start_date::text AS d, i.occurrence_nature AS nature, i.manual_status AS status, i.series_key AS sk, i.recurrence_json AS rec
      FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${c.bien.id} ORDER BY i.start_date, i.id`;
  const evenements = (id: number) => sql<{ type: string; detail: Json }[]>`
    SELECT event_type AS type, detail_json AS detail FROM agenda_occurrence_events WHERE agenda_item_id = ${id} ORDER BY id`;
  /** Ce que l'écran Agenda affiche (annulés exclus). */
  const agenda = async (c: Ctx) => {
    const { getAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    return (await getAgendaItems({ accountId: c.compte.id, assetIds: [c.bien.id], period: 'all' }))
      .map((x) => String((x as { startDate?: string | null }).startDate ?? '').slice(0, 10)).sort();
  };

  const annuelActif = (base: string) => [{
    key: 'insuranceExpiry', value: base,
    excerpt: `Échéance annuelle le ${fr(base)}. Contrat reconduit tacitement chaque année, résiliation possible avec deux mois de préavis.`,
  }];

  it('E2E-01 — contrat actif, « résiliation possible avec deux mois de préavis » : la prochaine échéance est dans l’Agenda', async () => {
    const c = await contexte();
    await faits(c, annuelActif(FIN_AN_DERNIER));
    const cs = await candidats(c);
    expect(cs[0].recurrence).toMatchObject({ frequency: 'yearly', interval: 1 });
    expect(cs[0].recurrence!.end).toBeUndefined();
    await job(c);
    const l = await items(c);
    expect(l.map((x) => [x.d, x.nature, x.status])).toEqual([[FIN_AN_DERNIER, 'CONFIRMED', null], [FIN_CETTE_ANNEE, 'FORECAST', null]]);
    expect(l[1].rec).not.toHaveProperty('end');
    expect(await agenda(c)).toEqual([FIN_AN_DERNIER, FIN_CETTE_ANNEE]);
  });

  it('E2E-02 — résiliation EFFECTIVE au 31/12 de l’an dernier : aucune occurrence postérieure, arrêt tracé, passé conservé', async () => {
    const c = await contexte();
    await faits(c, annuelActif(FIN_AN_DERNIER));
    await job(c);
    const [passe, prevision] = await items(c);
    // Réanalyse : le document dit désormais que le contrat a été résilié.
    await faits(c, [...annuelActif(FIN_AN_DERNIER), {
      key: 'contractNote', value: `Le contrat a été résilié avec effet au ${fr(FIN_AN_DERNIER)}.`, excerpt: `Le contrat a été résilié avec effet au ${fr(FIN_AN_DERNIER)}.`,
    }]);
    await job(c);
    const l = await items(c);
    expect(l.find((x) => x.id === passe.id)).toMatchObject({ d: FIN_AN_DERNIER, nature: 'CONFIRMED', status: null });
    expect(l.find((x) => x.id === prevision.id)).toMatchObject({ d: FIN_CETTE_ANNEE, nature: 'FORECAST', status: 'annule' });
    expect(l.filter((x) => x.d > FIN_AN_DERNIER && x.status === null)).toEqual([]);
    const ev = (await evenements(prevision.id)).find((e) => e.type === 'FORECAST_RETIRED')!;
    expect(ev.detail).toMatchObject({
      reasonCode: 'RECURRENCE_ENDED', bound: FIN_AN_DERNIER, sourceFileId: c.doc.id,
      end: { status: 'CONFIRMED', reason: 'TERMINATION_EFFECTIVE', effectiveDate: FIN_AN_DERNIER, source: { kind: 'T1_FACT', fieldKey: 'contractNote' } },
    });
    expect(await agenda(c)).toEqual([FIN_AN_DERNIER]);
  });

  it('E2E-03 — non-renouvellement confirmé à une échéance future : occurrences jusqu’à la date d’effet, rien après', async () => {
    const c = await contexte();
    const effet = `${Y + 1}-03-31`;
    await faits(c, [
      { key: 'contractNote', value: 'Le contrat ne sera pas renouvelé à son échéance.', excerpt: 'Le contrat ne sera pas renouvelé à son échéance.' },
      { key: 'contractEndDate', value: effet, excerpt: `Date de fin du contrat : ${fr(effet)}` },
      { key: 'insuranceExpiry', value: `${Y}-12-15`, excerpt: `Prélèvement mensuel du 15/01/${Y} au 15/12/${Y + 1}.` },
    ]);
    await job(c);
    const l = await items(c);
    const prev = l.filter((x) => x.nature === 'FORECAST').map((x) => x.d);
    expect(prev.at(-1)).toBe(`${Y + 1}-03-15`);
    expect(l.every((x) => x.d <= effet)).toBe(true);
    expect(l.find((x) => x.nature === 'FORECAST')!.rec).toMatchObject({ end: { status: 'CONFIRMED', reason: 'NO_RENEWAL', effectiveDate: effet } });
  });

  it('E2E-04 — reprise COH-AGENDA-RECURRENCE-END : prévisions arrêtées par l’ancienne règle rétablies ou régénérées, sans nouvel envoi', async () => {
    // A : prévision annulée SANS TRACE (ce que faisait l'ancien retrait « mot-clé »).
    const a = await contexte();
    await faits(a, annuelActif(FIN_AN_DERNIER));
    await job(a);
    const [passeA, prevA] = await items(a);
    await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${prevA.id}`;
    // B : prévision JAMAIS générée (l'ancien `ended` vidait le calcul).
    const b = await contexte();
    await faits(b, annuelActif(FIN_AN_DERNIER));
    await job(b);
    const [passeB, prevB] = await items(b);
    await sql`DELETE FROM agenda_items WHERE id = ${prevB.id}`;
    // C : annulation par l'UTILISATEUR — respectée.
    const c = await contexte();
    await faits(c, annuelActif(FIN_AN_DERNIER));
    await job(c);
    const [, prevC] = await items(c);
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    await updateManualStatus(prevC.id, 'annule', c.compte.id);
    // D : fin CONFIRMÉE (résiliation effective) — le retrait tracé reste acquis.
    const d = await contexte();
    await faits(d, annuelActif(FIN_AN_DERNIER));
    await job(d);
    await faits(d, [...annuelActif(FIN_AN_DERNIER), { key: 'contractNote', value: 'x', excerpt: `Le contrat a été résilié le ${fr(FIN_AN_DERNIER)}.` }]);
    await job(d);
    const [, prevD] = await items(d);
    expect(prevD.status).toBe('annule');

    const passes = async () => (await sql<Json[]>`
      SELECT id, start_date::text AS d, manual_status, occurrence_nature, updated_at FROM agenda_items
       WHERE account_id = ANY(${[a.compte.id, b.compte.id, c.compte.id, d.compte.id]}::int[]) AND occurrence_nature = 'CONFIRMED' ORDER BY id`);
    const avant = await passes();

    // Constat à blanc, puis réparation.
    const blanc = await runCoherenceFor(sql, [a.compte.id, b.compte.id, c.compte.id, d.compte.id], { mode: 'DRY_RUN', today: TODAY });
    expect(blanc.results['COH-AGENDA-RECURRENCE-END']).toMatchObject({ WOULD_REPAIR: 2 });
    expect((await proofOf(sql, a.compte.id, 'COH-AGENDA-RECURRENCE-END', a.doc.id))?.finding).toMatchObject({ anomaly: 'RECURRENCE_FORECAST_WRONGLY_RETIRED' });
    expect((await proofOf(sql, b.compte.id, 'COH-AGENDA-RECURRENCE-END', b.doc.id))?.finding).toMatchObject({ anomaly: 'RECURRENCE_OCCURRENCE_MISSING' });
    await runCoherenceFor(sql, [a.compte.id, b.compte.id, c.compte.id, d.compte.id], { today: TODAY });

    // A : rétablie, tracée ; B : file T4 du document ; C, D : intactes.
    expect((await items(a)).find((x) => x.id === prevA.id)).toMatchObject({ status: null, nature: 'FORECAST', d: FIN_CETTE_ANNEE });
    expect((await evenements(prevA.id)).map((e) => e.type)).toContain('FORECAST_RESTORED');
    expect((await evenements(prevA.id)).find((e) => e.type === 'FORECAST_RESTORED')!.detail).toMatchObject({ reason: 'LEGACY_KEYWORD_END_REVERSED', sourceFileId: a.doc.id });
    expect((await proofOf(sql, a.compte.id, 'COH-AGENDA-RECURRENCE-END', a.doc.id))?.last_result).toBe('REPAIRED');
    expect((await items(c)).find((x) => x.id === prevC.id)!.status).toBe('annule');
    expect((await items(d)).find((x) => x.id === prevD.id)!.status).toBe('annule');
    const [file] = await sql<{ id: number; payload: Json }[]>`
      SELECT id, payload FROM ai_job_queue WHERE treatment = 'T4' AND account_id = ${b.compte.id} AND status = 'PENDING' ORDER BY id DESC LIMIT 1`;
    expect(file).toBeDefined();
    expect(file.payload).toMatchObject({ leadSourceId: b.doc.id, assetId: b.bien.id });
    expect(file.payload).not.toHaveProperty('analysisComplete');

    // La file T4 régénère l'occurrence manquante (exécutant de production).
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE treatment = 'T4' AND status = 'PENDING' AND id <> ${file.id}`;
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${file.id}`;
    expect(await runOne('T4')).toBe(true);
    const lb = await items(b);
    expect(lb.map((x) => [x.d, x.nature, x.status])).toEqual([[FIN_AN_DERNIER, 'CONFIRMED', null], [FIN_CETTE_ANNEE, 'FORECAST', null]]);
    expect(lb[0].id).toBe(passeB.id);

    // Aucune occurrence passée réelle supprimée ni modifiée.
    expect(await passes()).toEqual(avant);
    expect((await items(a)).find((x) => x.id === passeA.id)).toMatchObject({ d: FIN_AN_DERNIER, nature: 'CONFIRMED', status: null });

    // Recontrôle : plus rien à reprendre (convergence).
    await runCoherenceFor(sql, [a.compte.id, b.compte.id], { mode: 'DRY_RUN', today: TODAY });
    expect((await proofOf(sql, a.compte.id, 'COH-AGENDA-RECURRENCE-END', a.doc.id))?.last_result).toBe('CONSISTENT');
    expect((await proofOf(sql, b.compte.id, 'COH-AGENDA-RECURRENCE-END', b.doc.id))?.last_result).toMatch(/CONSISTENT|REPAIRED/);
  });
});
