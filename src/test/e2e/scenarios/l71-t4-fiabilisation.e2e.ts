/**
 * Lot 71E — ticket « BUG P1 — T4 v2/v3 : fiabiliser les décisions Agenda,
 * sécuriser les réanalyses et corriger les écarts résiduels », sur
 * PostgreSQL réel. Modèle SIMULÉ (rejeu, aucun appel réseau) derrière la
 * passerelle réelle ; exécutant T4 et persistance de production.
 *
 * Tableau §3 du ticket :
 *  · T4-FIX-01 ancienne échéance + panne T4            → échéance conservée ;
 *  · T4-FIX-02 ancienne échéance + abstain             → échéance conservée ;
 *  · T4-FIX-03 ancienne échéance + reject explicite    → retrait si automatique et non protégée ;
 *  · T4-FIX-04 candidats acceptés et indécis           → mise à jour des premiers, préservation des seconds ;
 *  · T4-FIX-05 échec de persistance partiel            → aucun retrait destructeur ;
 *  · T4-FIX-06 événement lié à plusieurs sources       → aucun retrait s'il reste justifié ;
 *  · T4-FIX-07 T4 modifie le businessType              → valeur finale correcte, sans doublon ;
 *  · T4-FIX-08 doublon exact, ancienne catégorie       → catégorie corrigée, même identifiant ;
 *  · T4-FIX-09 événement modifié par l'utilisateur     → aucune modification automatique ;
 *  · T4-FIX-10 version historique v1 réactivée         → aucune acceptation automatique implicite ;
 *  · T4-FIX-11 échec de tous les modèles               → trace BO, reprise maîtrisée par la file, aucune perte ;
 *  · T4-FIX-12 réanalyse répétée, mêmes décisions      → résultat idempotent.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// T4-FIX-05 : écriture simulée en échec pour UN titre (toutes les autres passent).
vi.mock('@/services/agenda/agenda-write-primitive', async (orig) => {
  const m = await orig<typeof import('@/services/agenda/agenda-write-primitive')>();
  return {
    ...m,
    upsertAgendaItem: async (...a: Parameters<typeof m.upsertAgendaItem>) => {
      const echec = (globalThis as { __l71EchecEcriture?: string }).__l71EchecEcriture;
      if (echec && a[0].title === echec) throw new Error('écriture simulée en échec (e2e)');
      return m.upsertAgendaItem(...a);
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

/** Candidat ponctuel (sans champ d'origine) d'une source autoritaire. */
const cand = (title: string, date: string, extra: Record<string, unknown> = {}) => ({
  title, date, confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true,
  excerpt: `${title} — le ${date.split('-').reverse().join('/')}`, ...extra,
});

scenario('L71-T4-FIX', 'T4 v2/v3 : décisions fiabilisées, réanalyses sécurisées (PG16)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T4'], t4Responder: null });
  /** Sorties rejouées (alias utilisable dans les fonctions d'aide). */
  const rejouer = useRecordings;

  let runT4Job: typeof import('@/services/ai/agenda').runT4Job;
  let processCands: typeof import('@/services/ai/agenda/agenda-intelligence.service').processAgendaCandidates;
  let persistence: typeof import('@/services/agenda/agenda-persistence');

  beforeAll(async () => {
    ({ runT4Job } = await import('@/services/ai/agenda'));
    ({ processAgendaCandidates: processCands } = await import('@/services/ai/agenda/agenda-intelligence.service'));
    persistence = await import('@/services/agenda/agenda-persistence');
    // Aucune version BO de T4 : le texte de référence du dépôt s'exécute.
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
  });
  afterAll(() => { delete (globalThis as { __l71EchecEcriture?: string }).__l71EchecEcriture; });

  /**
   * Travail T4 du flux documentaire automatique (même exécutant que la
   * production). Rend l'erreur éventuelle (reprise demandée à la file).
   */
  async function job(compte: { id: number; ownerUserId: number }, assetId: number, fileId: number, candidates: unknown[], complete = true) {
    try {
      await runT4Job({ id: 1, attempts: 1, accountId: compte.id, payload: { assetId, userId: compte.ownerUserId, leadSourceId: fileId, candidates, analysisComplete: complete } } as never,
        { assertActive: async () => {} } as never,
        {
          loadExisting: persistence.loadExistingAgendaItems, persist: persistence.persistAgendaDecisions,
          process: (i) => processCands({ ...i, today: TODAY }),
        });
      return null;
    } catch (e) {
      return e as Error;
    }
  }
  const items = (assetId: number) => sql<{ id: number; d: string; title: string; cat: string | null; bt: string | null; nature: string | null; modified: boolean; fk: string | null }[]>`
    SELECT i.id, i.start_date::text AS d, i.title, i.home_category AS cat, i.business_type AS bt,
           i.occurrence_nature AS nature, i.is_automatic_modified AS modified, i.functional_key AS fk
      FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${assetId} ORDER BY i.start_date, i.id`;
  const decisionsBo = (accountId: number) => sql<{ status: string; d: Json | null; error: string | null }[]>`
    SELECT status, metadata->'t4Decision' AS d, error_code AS error FROM ai_usage_event
     WHERE account_id = ${accountId} AND operation_code = 't4_classify_event' ORDER BY id`;

  async function contexte() {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    return { compte, bien, doc };
  }
  /** Première analyse : les candidats sont acceptés (échéances automatiques préexistantes). */
  async function historique(c: Awaited<ReturnType<typeof contexte>>, candidats: Array<ReturnType<typeof cand>>) {
    await rejouer(candidats.map((x) => t4({ agenda: 'accept', pour: x.title })));
    expect(await job(c.compte, c.bien.id, c.doc.id, candidats)).toBeNull();
    const avant = await items(c.bien.id);
    expect(avant).toHaveLength(candidats.length);
    return avant;
  }

  it('T4-FIX-01 — ancienne échéance + panne T4 : échéance conservée, aucune création, travail NON réussi', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const avant = await historique(c, [a]);
    await useRecordings([]); // tous les modèles échouent
    const err = await job(c.compte, c.bien.id, c.doc.id, [a]);
    expect(await items(c.bien.id)).toEqual(avant);
    // Échec technique : le travail n'est pas « réussi » (reprise par la file).
    expect(err?.message).toMatch(/T4_INCOMPLETE/);
  });

  it('T4-FIX-02 — ancienne échéance + abstain : échéance conservée', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const avant = await historique(c, [a]);
    await useRecordings([t4({ agenda: 'abstain' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    expect(await items(c.bien.id)).toEqual(avant);
    expect((await decisionsBo(c.compte.id)).at(-1)!.d).toMatchObject({ verdict: 'ABSTAINED' });
  });

  it('T4-FIX-03 — ancienne échéance + reject explicite : retrait si automatique et non protégée, y compris à côté d’un candidat indécis', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const b = cand('Échéance contrat Bêta', '2027-04-01');
    const g = cand('Échéance contrat Gamma', '2027-05-01');
    const avant = await historique(c, [a, b, g]);
    // Bêta modifiée par l'utilisateur : protégée.
    await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${avant[1].id}`;
    await useRecordings([t4({ agenda: 'reject', pour: 'Alpha' }), t4({ agenda: 'reject', pour: 'Bêta' }), t4({ agenda: 'abstain', pour: 'Gamma' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a, b, g])).toBeNull();
    // Alpha (rejetée, automatique intacte) retirée par un retrait CIBLÉ ; Bêta protégée ; Gamma (abstention) conservée.
    expect((await items(c.bien.id)).map((x) => x.id)).toEqual([avant[1].id, avant[2].id]);
    const [trace] = await sql<{ reason: string; n: number }[]>`
      SELECT reason, count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${c.compte.id} GROUP BY reason`;
    expect(trace).toMatchObject({ n: 1 });
  });

  it('T4-FIX-04 — source avec candidats acceptés et indécis : mise à jour des premiers, préservation des seconds', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const b = cand('Échéance contrat Bêta', '2027-04-01');
    const avant = await historique(c, [a, b]);
    const n = cand('Échéance contrat Delta', '2027-06-01');
    await useRecordings([
      t4({ agenda: 'accept', pour: 'Alpha', category: 'information' }), t4({ agenda: 'abstain', pour: 'Bêta' }),
      t4({ agenda: 'accept', pour: 'Delta' }),
    ]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a, b, n])).toBeNull();
    const apres = await items(c.bien.id);
    expect(apres.map((x) => [x.id === avant[0].id || x.id === avant[1].id ? 'ancien' : 'nouveau', x.title, x.cat])).toEqual([
      ['ancien', 'Échéance contrat Alpha', 'information'], // catégorie corrigée (doublon exact, même identifiant)
      ['ancien', 'Échéance contrat Bêta', 'action'], // abstention : conservée, intacte
      ['nouveau', 'Échéance contrat Delta', 'action'],
    ]);
  });

  it('T4-FIX-05 — échec de persistance partiel : aucun retrait destructeur', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const b = cand('Échéance contrat Bêta', '2027-04-01');
    const avant = await historique(c, [a, b]);
    // Réanalyse complète : Bêta n'est plus produite, et l'écriture de la nouvelle échéance échoue.
    const n = cand('Échéance contrat Epsilon', '2027-07-01');
    await useRecordings([t4({ agenda: 'accept', pour: 'Alpha' }), t4({ agenda: 'accept', pour: 'Epsilon' })]);
    (globalThis as { __l71EchecEcriture?: string }).__l71EchecEcriture = 'Échéance contrat Epsilon';
    try {
      const err = await job(c.compte, c.bien.id, c.doc.id, [a, n]);
      expect(err?.message).toMatch(/T4_PERSIST_PARTIAL/);
    } finally {
      delete (globalThis as { __l71EchecEcriture?: string }).__l71EchecEcriture;
    }
    expect((await items(c.bien.id)).map((x) => x.id)).toEqual(avant.map((x) => x.id));
  });

  it('T4-FIX-06 — événement lié à plusieurs sources : aucun retrait tant qu’une autre source le justifie', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const [evt] = await historique(c, [a]);
    // Une seconde source annonce la même échéance : doublon exact consolidé.
    const docB = await make.assetFile(c.compte, { assetId: c.bien.id });
    await useRecordings([t4({ agenda: 'accept' })]);
    expect(await job(c.compte, c.bien.id, docB.id, [a])).toBeNull();
    expect((await items(c.bien.id)).map((x) => x.id)).toEqual([evt.id]);
    // Réanalyse de la première source : rejet explicite, puis disparition du candidat.
    await useRecordings([t4({ agenda: 'reject' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    expect(await job(c.compte, c.bien.id, c.doc.id, [])).toBeNull();
    expect((await items(c.bien.id)).map((x) => x.id)).toEqual([evt.id]);

    // Variante : l'autre source est un lien SOURCE de l'événement (service de liaison).
    const c2 = await contexte();
    const [evt2] = await historique(c2, [a]);
    const docC = await make.assetFile(c2.compte, { assetId: c2.bien.id });
    await sql`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type, source_role) VALUES (${evt2.id}, ${docC.id}, 'linked', 'SOURCE')`;
    expect(await job(c2.compte, c2.bien.id, c2.doc.id, [])).toBeNull();
    expect((await items(c2.bien.id)).map((x) => x.id)).toEqual([evt2.id]);
  });

  it('T4-FIX-07 — T4 modifie le businessType : valeur décidée persistée et tracée ; reclassement sans doublon ni suppression', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01', { businessType: 'contract' });
    await useRecordings([t4({ agenda: 'accept', businessType: 'insurance' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    const [e] = await items(c.bien.id);
    expect(e.bt).toBe('insurance');
    expect((await decisionsBo(c.compte.id)).at(-1)!.d).toMatchObject({ businessType: 'insurance' });
    // Réanalyse : T4 reclasse (garantie) — même identifiant, une seule ligne.
    await useRecordings([t4({ agenda: 'accept', businessType: 'warranty' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    const apres = await items(c.bien.id);
    expect(apres.map((x) => [x.id, x.bt])).toEqual([[e.id, 'warranty']]);
    expect(apres[0].fk).not.toBe(e.fk);
    // Retour au type du candidat : toujours le même identifiant.
    await useRecordings([t4({ agenda: 'accept', businessType: 'contract' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    expect((await items(c.bien.id)).map((x) => [x.id, x.bt])).toEqual([[e.id, 'contract']]);
    // null explicite de T4 : type du candidat conservé, signalé dans la trace (jamais en silence).
    await useRecordings([t4({ agenda: 'accept', businessType: null })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    expect((await decisionsBo(c.compte.id)).at(-1)!.d).toMatchObject({ businessType: 'contract', businessTypeSource: 'CANDIDATE', warnings: expect.arrayContaining(['T4_BUSINESS_TYPE_NULL']) });
  });

  it('T4-FIX-08 — doublon exact, ancienne catégorie erronée : catégorie corrigée, même identifiant, titre et date intacts', async () => {
    const c = await contexte();
    const a = cand('Fin du contrat Alpha', '2027-03-01', { originFieldKey: 'contractEndDate' });
    const [e] = await historique(c, [a]);
    expect(e.cat).toBe('action');
    await useRecordings([t4({ agenda: 'accept', category: 'information' })]);
    // Même champ d'origine et même date (doublon exact), intitulé lu différemment : titre NON réécrit.
    expect(await job(c.compte, c.bien.id, c.doc.id, [{ ...a, title: 'Fin de contrat Alpha (avenant)' }])).toBeNull();
    expect(await items(c.bien.id)).toEqual([{ ...e, cat: 'information' }]);
  });

  it('T4-FIX-09 — événement modifié par l’utilisateur : aucune modification automatique (catégorie, type, retrait)', async () => {
    const c = await contexte();
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const [e] = await historique(c, [a]);
    await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${e.id}`;
    await useRecordings([t4({ agenda: 'accept', category: 'information', businessType: 'warranty' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    await useRecordings([t4({ agenda: 'reject' })]);
    expect(await job(c.compte, c.bien.id, c.doc.id, [a])).toBeNull();
    expect(await items(c.bien.id)).toEqual([{ ...e, modified: true }]);
  });

  it('T4-FIX-11 — échec de tous les modèles : trace BO, reprise par la file (temporisation, idempotence), aucune perte', async () => {
    const { enqueueT4Candidates } = await import('@/services/ai/agenda');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const c = await contexte();
    const x = cand('Échéance contrat Alpha', '2027-03-01');
    const y = cand('Échéance contrat Bêta', '2027-04-01');
    const avant = await historique(c, [x, y]);

    const enfile = async () => {
      const id = await enqueueT4Candidates({ accountId: c.compte.id, userId: c.compte.ownerUserId, assetId: c.bien.id, leadSourceId: c.doc.id, candidates: [x, y] as never, analysisComplete: true });
      expect(id).not.toBeNull();
      return id!;
    };
    const seul = async (id: number) => {
      await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE treatment = 'T4' AND status = 'PENDING' AND id <> ${id}`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${id} AND status = 'PENDING'`;
    };
    const lire = async (id: number) => (await sql<{ status: string; attempts: number; last_error: string | null; payload: Json; later: boolean; business_result: string | null; detail: Json | null }[]>`
      SELECT status, attempts, last_error, payload, available_at > now() AS later, business_result, business_result_detail AS detail FROM ai_job_queue WHERE id = ${id}`)[0];

    // Passage 1 : Alpha décidée, Bêta en panne (aucun enregistrement pour elle).
    const id = await enfile();
    await seul(id);
    await useRecordings([t4({ agenda: 'accept', pour: 'Alpha' })]);
    expect(await runOne('T4')).toBe(true);
    let j = await lire(id);
    expect(j).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(j.last_error).toMatch(/T4_INCOMPLETE/);
    expect(j.later).toBe(true); // temporisation (backoff)
    expect(j.payload.t4Resolved).toMatchObject({ forJob: id });
    expect(Object.keys(j.payload.t4Resolved.decisions)).toHaveLength(1);
    // Aucune perte.
    expect((await items(c.bien.id)).map((i) => i.id)).toEqual(avant.map((i) => i.id));
    // Trace BO exploitable de l'échec complet (exécution en erreur, décision TECHNICAL_FAILURE, sans contenu brut).
    const echecs = (await decisionsBo(c.compte.id)).filter((r) => r.d?.verdict === 'TECHNICAL_FAILURE');
    expect(echecs).toHaveLength(1);
    expect(echecs[0].status).toBe('error');
    expect(JSON.stringify(echecs[0].d)).not.toContain('Bêta —');

    // Passage 2 (reprise) : seule Bêta est redemandée au modèle ; Alpha réutilise sa décision appliquée.
    await seul(id);
    const replay = await useRecordings([t4({ agenda: 'accept', pour: 'Bêta' })]);
    expect(await runOne('T4')).toBe(true);
    j = await lire(id);
    expect(j.status).toBe('DONE');
    expect(replay.calls).toHaveLength(1);
    expect(j.detail).toMatchObject({ technicalFailures: 0, reused: 1 });
    expect((await items(c.bien.id)).map((i) => i.id)).toEqual(avant.map((i) => i.id));
  });

  it('T4-FIX-12 — réanalyse répétée avec les mêmes décisions : résultat idempotent (récurrence comprise)', async () => {
    const { parseRecurrenceFr } = await import('@/services/ai/agenda/rules/recurrence');
    const c = await contexte();
    const excerpt = 'Entretien chaudière à réaliser tous les 12 mois';
    const e = { title: 'Entretien chaudière', date: '2026-11-15', confidence: 'certain', excerpt, documentType: 'RAPPORT_ENTRETIEN', recurrence: parseRecurrenceFr(excerpt) };
    const a = cand('Échéance contrat Alpha', '2027-03-01');
    const lot = () => rejouer([t4({ agenda: 'accept', recurrence: 'accept', pour: 'chaudière' }), t4({ agenda: 'accept', pour: 'Alpha' })]);
    await lot();
    expect(await job(c.compte, c.bien.id, c.doc.id, [e, a])).toBeNull();
    const premier = await items(c.bien.id);
    expect(premier.map((x) => [x.d, x.nature])).toEqual([['2026-11-15', 'CONFIRMED'], ['2027-03-01', 'CONFIRMED'], ['2027-11-15', 'FORECAST']]);
    const evts = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_occurrence_events WHERE account_id = ${c.compte.id}`)[0].n;
    const n1 = await evts();
    for (let i = 0; i < 2; i++) {
      await lot();
      expect(await job(c.compte, c.bien.id, c.doc.id, [e, a])).toBeNull();
    }
    expect(await items(c.bien.id)).toEqual(premier);
    expect(await evts()).toBe(n1);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${c.compte.id}`)[0].n).toBe(0);
  });
});

scenario('L71-T4-FIX-V1', 'T4 : version historique t4_output_v1 réactivée — aucune acceptation implicite (PG16)', ({ sql, make, useRecordings }) => {
  const lire = async (rel: string) => (await import('node:fs/promises')).readFile((await import('node:path')).join(process.cwd(), rel), 'utf8');

  beforeAll(async () => {
    // Même mise en place que T4-V2-09 (version BO lue en base).
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const legacy = await lire('src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt');
    await sql`INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at, first_activated_at, execution_mode)
      VALUES ('local', 'T4', 't4_master_v1', 1, 'ACTIVE', ${legacy}, 'x', 'initial_file', now(), now(), 'LEGACY_TEMPLATE')`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
  });
  afterAll(async () => {
    await sql`DELETE FROM ai_master_prompt_test_runs`;
    await sql`DELETE FROM ai_master_prompt_activations`;
    await sql`DELETE FROM ai_master_prompt_versions`;
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
  });

  it('T4-FIX-10 — version Legacy (t4_output_v1) active : aucune création automatique, aucune série, ancienne échéance conservée, trace ABSTAINED', async () => {
    const { runT4Job } = await import('@/services/ai/agenda');
    const { processAgendaCandidates } = await import('@/services/ai/agenda/agenda-intelligence.service');
    const persistence = await import('@/services/agenda/agenda-persistence');
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    // Échéance automatique préexistante (créée par une version v2/v3 antérieure).
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const pre = await upsertAgendaItem({
      accountId: compte.id, assetId: bien.id, origin: 'AUTOMATIC', title: 'Échéance contrat Alpha', date: '2027-03-01', category: 'action',
      sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: '2027-03-01', details: { requiresQualification: false },
    });
    const v1 = { operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT', repeat: true, output: { task: 'CLASSIFY_EVENT', homeCategory: 'action', confidence: 'certain', reason: 'v1' } };
    await useRecordings([v1]);
    const cands = [
      { title: 'Échéance contrat Alpha', date: '2027-03-01', confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true, excerpt: 'Alpha' },
      { title: 'Abonnement Homiris', date: '2027-01-31', confidence: 'certain', documentType: 'FACTURE', mayCreateAgenda: true, excerpt: 'Homiris mensuel',
        recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'monthly', interval: 1, excerpt: 'mensuel' } },
    ];
    await runT4Job({ id: 1, attempts: 1, accountId: compte.id, payload: { assetId: bien.id, userId: compte.ownerUserId, leadSourceId: doc.id, candidates: cands, analysisComplete: true } } as never,
      { assertActive: async () => {} } as never,
      { loadExisting: persistence.loadExistingAgendaItems, persist: persistence.persistAgendaDecisions, process: (i) => processAgendaCandidates({ ...i, today: TODAY }) });
    const l = await sql<{ id: number }[]>`SELECT i.id FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id WHERE l.asset_id = ${bien.id}`;
    expect(l.map((x) => x.id)).toEqual([pre.id]);
    const bo = await sql<{ d: Json | null }[]>`SELECT metadata->'t4Decision' AS d FROM ai_usage_event WHERE account_id = ${compte.id} AND operation_code = 't4_classify_event' ORDER BY id`;
    expect(bo.map((x) => x.d?.verdict)).toEqual(['ABSTAINED', 'ABSTAINED']);
    expect(bo[0].d).toMatchObject({ outcome: 'model_v1', agendaDecision: 'abstain', warnings: expect.arrayContaining(['T4_OUTPUT_V1_NO_AGENDA_DECISION']) });
  });
});
