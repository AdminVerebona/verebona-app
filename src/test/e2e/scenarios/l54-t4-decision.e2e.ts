/**
 * Lot 54 — ticket « T4 : rendre l'IA décisionnaire de l'existence et de la
 * récurrence d'un événement Agenda », sur PostgreSQL réel. Modèle SIMULÉ
 * (rejeu, aucun appel réseau) derrière la passerelle réelle : contrat
 * d'entrée t4_input_v2 construit et validé, contrat de sortie t4_output_v2,
 * traces en base.
 *
 *  · T4-V2-01 Homiris mensuel : reject / reject → 0 événement, 0 prévision, 0 carte ;
 *  · T4-V2-02/03 prise d'effet, fin d'engagement : accept, occurrence unique ;
 *  · T4-V2-04 entretien annuel : accept / accept → série ;
 *  · T4-V2-05 événement valide, fausse récurrence : accept / reject → l'événement seul ;
 *  · T4-V2-06 historique régulier : HISTORICAL_PATTERN transmis, aucune série sans acceptation ;
 *  · T4-V2-07 modèle indisponible : aucune création, aucune récurrence, erreur BO ;
 *  · T4-V2-08 réanalyse rejetée : ancien automatique retiré, modifié / confirmé conservé ;
 *  · T4-V2-09 compatibilité : brouillon depuis le texte de référence v2 → contexte
 *    structuré v2 sans {{TASK}} ; version Legacy (t4_output_v1) réactivable et exécutée.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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

type Json = Record<string, any>;
const TODAY = '2026-10-14';

/** Sortie T4 v2 enregistrée (modèle simulé). */
const t4 = (o: {
  agenda: 'accept' | 'reject' | 'abstain'; recurrence: 'accept' | 'reject' | 'abstain' | 'not_applicable';
  category?: 'action' | 'information'; promptIncludes?: string; repeat?: boolean;
}): RecordedOutput => ({
  operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT', ...(o.promptIncludes ? { promptIncludes: o.promptIncludes } : {}),
  ...(o.repeat ? { repeat: true } : {}),
  output: {
    task: 'CLASSIFY_EVENT', agendaDecision: o.agenda, recurrenceDecision: o.recurrence,
    homeCategory: o.agenda === 'accept' ? o.category ?? 'action' : 'unknown', businessType: null,
    confidence: o.agenda === 'abstain' ? 'ambiguous' : 'certain', reason: 'décision simulée (e2e)',
    recurrenceReason: o.recurrence === 'not_applicable' ? null : 'motif simulé (e2e)',
  },
});

const homiris = (date = '2027-01-31') => ({
  title: 'Abonnement Homiris', date, confidence: 'certain', documentType: 'FACTURE', mayCreateAgenda: true,
  excerpt: 'Facture Homiris — abonnement télésurveillance mensuel — période du 01/01/2027 au 31/01/2027',
  recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'monthly', interval: 1, excerpt: 'abonnement télésurveillance mensuel' },
});

scenario('L54-T4', 'T4 décisionnaire de l’existence et de la récurrence d’un événement Agenda (PG16)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T4'], t4Responder: null });

  let runT4Job: typeof import('@/services/ai/agenda').runT4Job;
  let processCands: typeof import('@/services/ai/agenda/agenda-intelligence.service').processAgendaCandidates;
  let persistence: typeof import('@/services/agenda/agenda-persistence');

  beforeAll(async () => {
    ({ runT4Job } = await import('@/services/ai/agenda'));
    ({ processAgendaCandidates: processCands } = await import('@/services/ai/agenda/agenda-intelligence.service'));
    persistence = await import('@/services/agenda/agenda-persistence');
    // Aucune version BO de T4 : le texte de référence du dépôt (v2) s'exécute.
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
  });

  /** Travail T4 du flux documentaire automatique (même exécutant que la production). */
  async function job(compte: { id: number; ownerUserId: number }, assetId: number, fileId: number, candidates: unknown[]) {
    await runT4Job({ id: 1, accountId: compte.id, payload: { assetId, userId: compte.ownerUserId, leadSourceId: fileId, candidates, analysisComplete: true } } as never,
      { assertActive: async () => {} } as never,
      {
        loadExisting: persistence.loadExistingAgendaItems, persist: persistence.persistAgendaDecisions,
        process: (i) => processCands({ ...i, today: TODAY }),
      });
  }
  const items = (assetId: number) => sql<{ id: number; d: string; title: string; nature: string | null; auto: boolean }[]>`
    SELECT i.id, i.start_date::text AS d, i.title, i.occurrence_nature AS nature, i.is_automatic AS auto
      FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${assetId} ORDER BY i.start_date, i.id`;
  const cartes = (accountId: number) => sql<{ id: number }[]>`
    SELECT id FROM to_process_actions WHERE account_id = ${accountId} AND rule_code = 'AGENDA-PROPOSAL'`;
  /** Décisions T4 tracées sur les exécutions IA (BO › Exécutions IA). */
  const decisionsBo = (accountId: number) => sql<{ status: string; d: Json | null; error: string | null }[]>`
    SELECT status, metadata->'t4Decision' AS d, error_code AS error FROM ai_usage_event
     WHERE account_id = ${accountId} AND operation_code = 't4_classify_event' ORDER BY id`;

  async function contexte() {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    return { compte, bien, doc };
  }

  it('T4-V2-01 — Homiris mensuel : reject / reject → 0 événement, 0 prévision mensuelle, 0 carte, décision tracée au BO', async () => {
    const replay = await useRecordings([t4({ agenda: 'reject', recurrence: 'reject' })]);
    const { compte, bien, doc } = await contexte();
    await job(compte, bien.id, doc.id, [homiris()]);
    expect(await items(bien.id)).toEqual([]);
    expect(await cartes(compte.id)).toEqual([]);
    // Contexte t4_input_v2 : candidat de récurrence EXPLICIT_SOURCE et type documentaire transmis.
    const prompt = replay.calls.at(-1)!.prompt;
    expect(prompt).toContain('"recurrenceCandidate":{');
    expect(prompt).toContain('"mode":"EXPLICIT_SOURCE"');
    expect(prompt).toContain('"document_type":{"code":"FACTURE"');
    const [bo] = await decisionsBo(compte.id);
    expect(bo).toMatchObject({ status: 'success', d: { verdict: 'EVENT_REJECTED', agendaDecision: 'reject', recurrenceDecision: 'reject', recurrenceCandidate: { mode: 'EXPLICIT_SOURCE', frequency: 'monthly' } } });
    // Aucun contenu documentaire brut dans la trace (pas d'extrait).
    expect(JSON.stringify(bo.d)).not.toContain('Facture Homiris');
  });

  it('T4-V2-02 / T4-V2-03 — prise d’effet et fin d’engagement : accept, information, occurrence unique', async () => {
    await useRecordings([
      t4({ agenda: 'accept', recurrence: 'not_applicable', category: 'information', promptIncludes: 'Prise d' }),
      t4({ agenda: 'accept', recurrence: 'not_applicable', category: 'information', promptIncludes: 'Fin d' }),
    ]);
    const { compte, bien, doc } = await contexte();
    await job(compte, bien.id, doc.id, [
      { title: 'Prise d’effet du contrat', date: '2026-11-05', confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true, excerpt: 'Prise d’effet le 05/11/2026' },
      { title: 'Fin d’engagement', date: '2027-11-04', confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true, excerpt: 'Fin d’engagement le 04/11/2027' },
    ]);
    expect((await items(bien.id)).map((x) => [x.d, x.title])).toEqual([['2026-11-05', 'Prise d’effet du contrat'], ['2027-11-04', 'Fin d’engagement']]);
    expect((await decisionsBo(compte.id)).map((x) => x.d?.verdict)).toEqual(['ACCEPTED', 'ACCEPTED']);
  });

  it('T4-V2-04 — entretien annuel « tous les 12 mois » : accept / accept → occurrence + prévision', async () => {
    await useRecordings([t4({ agenda: 'accept', recurrence: 'accept' })]);
    const { compte, bien, doc } = await contexte();
    const { parseRecurrenceFr } = await import('@/services/ai/agenda/rules/recurrence');
    const excerpt = 'Entretien chaudière à réaliser tous les 12 mois';
    await job(compte, bien.id, doc.id, [{ title: 'Entretien chaudière', date: '2026-11-15', confidence: 'certain', excerpt, documentType: 'RAPPORT_ENTRETIEN', recurrence: parseRecurrenceFr(excerpt) }]);
    const l = await items(bien.id);
    expect(l.map((x) => [x.d, x.nature])).toEqual([['2026-11-15', 'CONFIRMED'], ['2027-11-15', 'FORECAST']]);
  });

  it('T4-V2-05 — événement ponctuel valide + facturation mensuelle : accept / reject → l’événement seul', async () => {
    await useRecordings([t4({ agenda: 'accept', recurrence: 'reject', category: 'information' })]);
    const { compte, bien, doc } = await contexte();
    await job(compte, bien.id, doc.id, [{ ...homiris('2027-11-04'), title: 'Fin d’engagement Homiris', documentType: 'CONTRAT_ASSURANCE' }]);
    expect((await items(bien.id)).map((x) => [x.d, x.nature])).toEqual([['2027-11-04', 'CONFIRMED']]);
    expect((await decisionsBo(compte.id))[0].d).toMatchObject({ verdict: 'RECURRENCE_REJECTED', agendaDecision: 'accept', recurrenceDecision: 'reject' });
  });

  it('T4-V2-06 — historique régulier : HISTORICAL_PATTERN envoyé à T4, aucune série tant que T4 ne l’accepte pas', async () => {
    const replay = await useRecordings([t4({ agenda: 'accept', recurrence: 'abstain', category: 'information' }), t4({ agenda: 'accept', recurrence: 'accept', category: 'action' })]);
    const { compte, bien, doc } = await contexte();
    for (const d of ['2023-11-10', '2024-11-12', '2025-11-11']) await make.agendaItem(compte, { title: 'Ramonage', startDate: d, assetIds: [bien.id] });
    const cand = { title: 'Ramonage', date: '2026-11-10', confidence: 'certain', documentType: 'FACTURE', mayCreateAgenda: true, excerpt: 'Ramonage du 10/11/2026' };
    await job(compte, bien.id, doc.id, [cand]);
    expect(replay.calls.at(-1)!.prompt).toContain('"mode":"HISTORICAL_PATTERN"');
    expect(replay.calls.at(-1)!.prompt).toContain('"history":["2023-11-10","2024-11-12","2025-11-11","2026-11-10"]');
    expect((await items(bien.id)).filter((x) => x.nature === 'FORECAST')).toEqual([]);
    // Nouvelle analyse : T4 accepte → la série est créée.
    await job(compte, bien.id, doc.id, [cand]);
    expect((await items(bien.id)).filter((x) => x.nature === 'FORECAST').map((x) => x.d)).toEqual(['2027-11-10']);
  });

  it('T4-V2-07 — modèle indisponible : aucune création, aucune récurrence, erreur technique visible au BO', async () => {
    await useRecordings([]); // aucune sortie : le rejeu échoue comme un modèle indisponible
    const { compte, bien, doc } = await contexte();
    await job(compte, bien.id, doc.id, [homiris()]);
    expect(await items(bien.id)).toEqual([]);
    expect(await cartes(compte.id)).toEqual([]);
    const bo = await decisionsBo(compte.id);
    expect(bo.length).toBeGreaterThan(0);
    expect(bo.every((x) => x.status !== 'success')).toBe(true);
    expect(bo[0].error).toBeTruthy();
  });

  it('T4-V2-08 — réanalyse rejetée : ancien automatique retiré ; modifié ou confirmé par l’utilisateur conservé', async () => {
    // Historique : l'ancienne analyse avait créé l'échéance et sa prévision mensuelle.
    await useRecordings([t4({ agenda: 'accept', recurrence: 'accept' }), t4({ agenda: 'reject', recurrence: 'reject' })]);
    const { compte, bien, doc } = await contexte();
    await job(compte, bien.id, doc.id, [homiris()]);
    const avant = await items(bien.id);
    expect(avant.map((x) => x.nature)).toEqual(['CONFIRMED', 'FORECAST']);
    // L'utilisateur modifie la prévision.
    await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${avant[1].id}`;
    await job(compte, bien.id, doc.id, [homiris()]);
    expect((await items(bien.id)).map((x) => x.id)).toEqual([avant[1].id]);

    // Variante : élément CONFIRMÉ par l'utilisateur (statut manuel) → conservé.
    await useRecordings([t4({ agenda: 'accept', recurrence: 'not_applicable' }), t4({ agenda: 'reject', recurrence: 'not_applicable' })]);
    const c2 = await contexte();
    const ponctuel = { ...homiris(), recurrence: undefined };
    await job(c2.compte, c2.bien.id, c2.doc.id, [ponctuel]);
    const [e] = await items(c2.bien.id);
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${e.id}`;
    await job(c2.compte, c2.bien.id, c2.doc.id, [ponctuel]);
    expect((await items(c2.bien.id)).map((x) => x.id)).toEqual([e.id]);
  });
});

scenario('L54-T4-BO', 'T4 v2 : brouillon depuis le texte de référence, Legacy réactivable (PG16)', ({ sql, make, useRecordings }) => {
  const lire = async (rel: string) => (await import('node:fs/promises')).readFile((await import('node:path')).join(process.cwd(), rel), 'utf8');
  let svc: typeof import('@/services/ai/master-prompts/master-prompt.service');
  let admin: number;

  beforeAll(async () => {
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    svc = await import('@/services/ai/master-prompts/master-prompt.service');
    admin = (await make.user({ role: 'ADMIN' })).id;
  });
  afterAll(async () => {
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
  });

  it('T4-V2-09 — Actif Legacy : copie Legacy conservée ; texte de référence v2 → STRUCTURED_CONTEXT v2 sans {{TASK}} ; Legacy réactivable et exécuté (t4_output_v1)', async () => {
    const legacy = await lire('src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt');
    const reference = await lire('src/services/ai/prompts/agenda/t4_master_v1.txt');
    await sql`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at, first_activated_at, execution_mode)
      VALUES ('local', 'T4', 't4_master_v1', 1, 'ACTIVE', ${legacy}, 'x', 'initial_file', now(), now(), 'LEGACY_TEMPLATE')`;

    // « Modifier » sur un Actif Legacy : le brouillon reste Legacy (version historique supportée)…
    const copie = await svc.startDraft('T4', admin);
    expect(svc.executionOfVersion(copie)).toMatchObject({ mode: 'LEGACY_TEMPLATE' });
    // … mais repartir du texte de référence v2 initialise le contexte structuré v2.
    const v2 = await svc.saveDraft('T4', copie.id, reference, admin);
    // Lot 61 : le texte de référence sort en `t4_output_v3` (v2 + intervention « À traiter »).
    expect(svc.executionOfVersion(v2)).toEqual({
      mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3',
      allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'],
    });
    const detail = await svc.getPromptDetail('T4');
    expect(detail.draft).toMatchObject({ issues: [], execution: { mode: 'STRUCTURED_CONTEXT', outputContractVersion: 't4_output_v3' } });
    expect(detail.structured?.defaults).toMatchObject({ inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3' });
    // Activable sans {{TASK}} ni emplacement.
    expect(reference).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const act = await svc.activateDraft('T4', copie.id, admin);
    expect(act.activeVersionNumber).toBe(2);

    // Exécution : contexte v2, sortie v2.
    const { invalidateConfigCache } = await import('@/services/ai/config/config-resolver');
    invalidateConfigCache();
    const { decideAgendaEvent } = await import('@/services/ai/agenda/master/classify-event');
    const compte = await make.account();
    await useRecordings([t4({ agenda: 'reject', recurrence: 'not_applicable' })]);
    expect(await decideAgendaEvent({ title: 'X', originType: 'document' }, { accountId: compte.id, date: '2027-01-31' }))
      .toMatchObject({ agendaDecision: 'reject', outcome: 'model_v2' });

    // Réactivation de la version Legacy (v1) : supportée, aucune migration de l'historique.
    const v1 = (await svc.getPromptDetail('T4')).history.find((h) => h.versionNumber === 1)!;
    await svc.reactivateVersion('T4', v1.id, admin);
    invalidateConfigCache();
    const [ligne] = await sql<{ m: string }[]>`SELECT execution_mode AS m FROM ai_master_prompt_versions WHERE treatment = 'T4' AND status = 'ACTIVE'`;
    expect(ligne.m).toBe('LEGACY_TEMPLATE');
    await useRecordings([{ operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT', output: { task: 'CLASSIFY_EVENT', homeCategory: 'action', confidence: 'certain', reason: 'v1' } }]);
    expect(await decideAgendaEvent({ title: 'X', originType: 'document' }, { accountId: compte.id, date: '2027-01-31' }))
      .toMatchObject({ agendaDecision: 'accept', recurrenceDecision: 'not_applicable', outcome: 'model_v1' });
  });
});
