/**
 * Lot 115F (Trello #791) — fiabilisation de l'arbitrage d'attributs d'un
 * événement de référence, sur PostgreSQL 16 réel, par les chemins de
 * PRODUCTION : persistance T1 des candidats, reconsolidation T3, cartes
 * « À traiter » (`syncOperationCards`), phase d'arbitrage T3 du passage
 * (`runAttributeArbitrationPhase`), contrôle de cohérence
 * `COH-OPS-ATTRIBUTE-CONFLICTS`. L'IA est SIMULÉE par le port du décideur
 * (jamais d'appel à un fournisseur).
 *
 *   L115F-E01  E03 + E01 — deux dates de réalisation à 7 jours d'écart sur un
 *              événement qui a DÉJÀ un élément d'Agenda daté : la carte
 *              « Arbitrer » est posée (avant : la seule présence de l'élément
 *              la supprimait) et le contrôle de cohérence la réclame ; dès
 *              qu'une carte de date de l'Agenda EFFECTIVEMENT actionnable
 *              couvre les mêmes valeurs, plus de doublon
 *   L115F-E02  E02 — cinq valeurs contradictoires : la couverture des preuves
 *              n'est pas prouvée → demande close INCOMPLETE, AUCUN appel à
 *              l'IA, aucune valeur écrite, carte posée ; rejeu stable
 *   L115F-E03  E09 — décision reçue puis application VÉRIFIÉE ; panne entre
 *              les deux : reprise idempotente au passage suivant ; valeur
 *              protégée par l'utilisateur : application en ÉCHEC tracée,
 *              jamais « appliquée »
 *   L115F-E04  E07 + E08 — vingt rejeux identiques : aucun nouvel examen ;
 *              pièce plus AUTORITAIRE : un examen de plus, une seule fois ;
 *              « document étranger » : doute de rattachement ouvert au
 *              journal, candidat remis en consolidation, AUCUN détachement
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { runCoherenceFor, proofOf } from '../coherence-run';
import { RECETTE_TODAY, cand, cible, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

scenario('L115F', 'Événements de référence — arbitrage d’attributs : détection exhaustive, couverture des preuves, application vérifiée (#791)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const etat = { available: false, answer: (_: Json): unknown => null, calls: 0 };
  beforeAll(async () => {
    const dec = await import('@/services/business-operations/consolidation/attribute-arbitration/decider');
    dec.__setArbitrationDeciderForTests({
      capability: async () => (etat.available
        ? { available: true, version: 'e2e-bloc-38', reason: 'AVAILABLE' }
        : { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'BRANCH_MISSING' }),
      decide: async (call) => { etat.calls++; return { output: etat.answer(call.input as unknown as Json), traceId: `trace-${etat.calls}` }; },
    });
    await import('@/services/business-operations/consolidation/queue');
  });
  afterEach(() => { etat.available = false; etat.answer = () => null; etat.calls = 0; });
  afterAll(async () => {
    (await import('@/services/business-operations/consolidation/attribute-arbitration/decider')).__setArbitrationDeciderForTests(null);
  });

  const prov = async (opId: number) => (await sql<{ p: Json }[]>`SELECT attribute_provenance AS p FROM business_operations WHERE id = ${opId}`)[0].p;
  const op = async (opId: number) => (await sql<Json[]>`SELECT provider, realized_date::text AS realized_date FROM business_operations WHERE id = ${opId}`)[0];
  const histo = async (opId: number) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE operation_id = ${opId}`)[0].n;
  const cartes = (compte: AccountRow) => sql<Json[]>`
    SELECT id, public_id, target_type, target_id, relation_key, question, proposals_json AS proposals, trigger_context
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-ATTRIBUTE' AND resolved_at IS NULL ORDER BY id`;
  const arbitrages = (compte: AccountRow) => sql<Json[]>`
    SELECT id, field, role, status, outcome, retained_value, value_before, value_after, applied_at, ai_calls, attempts, reason,
           validation, evidence, evidence_key, application_state, application_attempts, application_error
      FROM business_operation_attribute_arbitrations WHERE account_id = ${compte.id} ORDER BY id`;
  const doutes = (compte: AccountRow) => sql<Json[]>`
    SELECT id, operation_id, kind, status, file_id, candidate_key, basis, signals
      FROM business_operation_identity_reviews WHERE account_id = ${compte.id} ORDER BY id`;
  const reconsolider = async (compte: AccountRow, opId: number) =>
    (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte.id, [opId], { today: RECETTE_TODAY });
  const phase = async (compte: AccountRow) =>
    (await import('@/services/business-operations/consolidation/attribute-arbitration/review')).runAttributeArbitrationPhase(compte.id, {});
  const titre = async (fileId: number) => (await sql<{ t: string }[]>`SELECT COALESCE(retained_title, original_filename) AS t FROM asset_files WHERE id = ${fileId}`)[0].t;

  /** Rattache d'autres documents à l'événement (rattachement historique, sans IA), puis reconsolide (cartes comprises). */
  async function rattacher(compte: AccountRow, opId: number, assetId: number, autres: Array<ReturnType<typeof cand>>): Promise<number[]> {
    const fichiers: number[] = [];
    for (const a of autres) fichiers.push(await k.document(compte, assetId, [a]));
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo, s) => {
      for (const f of fichiers) {
        const [c] = await sql<{ id: number; candidate_key: string }[]>`SELECT id, candidate_key FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
        const version = `c${c.id}|a${assetId}|t`;
        const sid = await repo.addSource(opId, {
          kind: 'DOCUMENT', entityKey: f, version, role: 'INVOICE' as never, locator: { candidateKey: c.candidate_key }, authority: 'DOCUMENT',
          confidence: 'certain', matchMethod: 'M1', matchReason: 'E2E_L115F',
        }, 'T3_MATCH_AND_ENRICH');
        await repo.refreshSourceVersion(sid, version);
        await s.tx.execute((await import('drizzle-orm')).sql`
          UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now(), t3_outcome = 'MATCH_AND_ENRICH', t3_reason = 'MATCH_M1',
                 t3_operation_id = ${opId} WHERE id = ${c.id}`);
      }
    });
    await reconsolider(compte, opId);
    return fichiers;
  }

  async function evenement(compte: AccountRow, assetId: number, premier: ReturnType<typeof cand>, autres: Array<ReturnType<typeof cand>>) {
    const f0 = await k.document(compte, assetId, [premier]);
    await k.passer(compte);
    const [o] = await k.actives(compte);
    const fichiers = [f0, ...await rattacher(compte, o.id, assetId, autres)];
    for (const [i, f] of fichiers.entries()) await sql`UPDATE asset_files SET retained_title = ${`Facture chauffe-eau ${i + 1}`} WHERE id = ${f}`;
    return { opId: o.id as number, fichiers };
  }

  const facture = (assetId: number, over: Parameters<typeof cand>[0] = {}) => cand({
    typeHint: 'INTERVENTION', summary: 'Remplacement du chauffe-eau', provider: 'Plomberie Durand', sourceRoleHint: 'INVOICE',
    targetHints: [cible(assetId)], businessReferences: [ref('INVOICE', 'F-118')], temporalHints: { realizedDate: '2026-03-12' }, ...over,
  });

  /** Élément d'Agenda rattaché à l'événement de référence par le GRAPHE N↔N, porteur (ou non) d'un fait. */
  async function rattacherAgenda(compte: AccountRow, opId: number, o: { date: string | null; fait: string | null }): Promise<number> {
    const item = await make.agendaItem(compte, { title: 'Remplacement du chauffe-eau', startDate: o.date ?? undefined });
    // La colonne historique suffit : le déclencheur du lot 114O crée le lien N↔N. Seul le FAIT porté est posé ici
    // (T4 le pose par le service de regroupement en production).
    await sql`UPDATE agenda_items SET business_operation_id = ${opId} WHERE id = ${item.id}`;
    await sql`
      UPDATE business_operation_agenda_links SET fact_key = ${o.fait}
       WHERE account_id = ${compte.id} AND operation_id = ${opId} AND agenda_item_id = ${item.id} AND state = 'ACTIVE'`;
    return item.id;
  }

  // ── E01 : la carte n'est plus masquée par l'Agenda (E03), et l'écart de 7 jours est vu (E01) ──
  it('L115F-E01 — deux dates de réalisation à 7 jours : carte posée malgré un élément d’Agenda daté ; déduplication seulement sur une carte de date ACTIONNABLE', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId } = await evenement(compte, maison.id, facture(maison.id), [facture(maison.id, { temporalHints: { realizedDate: '2026-03-19' } })]);

    // E01 : l'écart est DANS la fenêtre de la transaction (7 jours) — avant le lot 115, rien n'était même relevé.
    const p0 = await prov(opId);
    expect(p0.conflicts).toEqual([expect.objectContaining({
      field: 'realizedDate', role: 'REALIZATION', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE',
    })]);
    expect(p0.conflicts[0].values.map((v: Json) => v.value).sort()).toEqual(['2026-03-12', '2026-03-19']);
    expect(await cartes(compte)).toHaveLength(1);

    // E03 : un élément d'Agenda DATÉ et porteur du fait est rattaché. La carte de date de l'Agenda (83A) n'existe
    // pas pour lui (il a une date) : la contradiction doit RESTER visible.
    await rattacherAgenda(compte, opId, { date: '2026-03-12', fait: 'INTERVENTION' });
    await reconsolider(compte, opId);
    const [carte] = await cartes(compte);
    expect(carte).toMatchObject({ target_type: 'DOCUMENT', relation_key: `operationAttribute:${opId}:realizedDate:REALIZATION` });
    expect(carte.question).toBe('Ces documents indiquent des dates de réalisation différentes pour la même intervention : laquelle est la bonne ?');
    expect(carte.trigger_context.optionCount).toBe(2);
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ IDENTITY_ATTRIBUTE_CONFLICT: 1 });

    // Le contrôle de cohérence voit la même chose : la ligne n'est plus exclue par la présence d'un élément d'Agenda.
    await sql`DELETE FROM to_process_action_events WHERE action_id IN (SELECT id FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-ATTRIBUTE')`;
    await sql`DELETE FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-ATTRIBUTE'`;
    const avant = await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN', today: RECETTE_TODAY });
    expect(avant.results['COH-OPS-ATTRIBUTE-CONFLICTS']).toMatchObject({ WOULD_REPAIR: 1 });
    expect(await proofOf(sql, compte.id, 'COH-OPS-ATTRIBUTE-CONFLICTS', opId)).toMatchObject({
      last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'ATTRIBUTE_CONFLICT_ARBITRATION_MISSING' }),
    });

    // Déduplication : une carte de date de l'Agenda EFFECTIVEMENT actionnable (élément sans date, porteur d'un fait,
    // deux valeurs proposées) prend le sujet en charge — plus de doublon.
    const sansDate = await rattacherAgenda(compte, opId, { date: null, fait: 'INTERVENTION' });
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    const pose = await upsertAction({
      accountId: compte.id, targetType: 'AGENDA_ITEM', targetId: sansDate, fieldKey: 'date', actionKind: 'ARBITRATE',
      ruleCode: 'DATA-AGENDA-DATE', question: 'Les documents donnent plusieurs dates pour « Remplacement du chauffe-eau » : laquelle est la bonne ?',
      proposals: [{ value: '2026-03-12', label: '12/03/2026', confidence: 0.5 }, { value: '2026-03-19', label: '19/03/2026', confidence: 0.5 }],
    });
    expect(pose.status).not.toBe('SKIPPED');
    await reconsolider(compte, opId);
    expect(await cartes(compte)).toEqual([]);
    // Et le contrôle de cohérence ne la réclame plus : l'événement sort de son périmètre (même règle des deux côtés).
    const apresDedup = await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN', today: RECETTE_TODAY });
    expect(apresDedup.results['COH-OPS-ATTRIBUTE-CONFLICTS']).toBeUndefined();

    // La carte d'Agenda répondue (fermée) ne masque plus rien : la contradiction revient à l'arbitrage d'attribut.
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'USER_ARBITRATED' WHERE account_id = ${compte.id} AND rule_code = 'DATA-AGENDA-DATE'`;
    await reconsolider(compte, opId);
    expect(await cartes(compte)).toHaveLength(1);
  });

  // ── E02 : aucun verdict sur des preuves incomplètes ──────────────────────
  it('L115F-E02 — cinq valeurs contradictoires : demande close INCOMPLETE sans aucun appel à l’IA, rien d’écrit, carte posée', async () => {
    etat.available = true;
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const noms = ['Plomberie Durand', 'Chauffage Martin', 'Sanitaire Leroy', 'Thermique Ouest', 'Chauffagiste Dubois'];
    const { opId } = await evenement(compte, maison.id, facture(maison.id, { provider: noms[0] }),
      noms.slice(1).map((n) => facture(maison.id, { provider: n })));

    // Cinq valeurs réellement différentes du MÊME rôle : la demande est posée, sans appel.
    const p0 = await prov(opId);
    expect(p0.conflicts).toEqual([expect.objectContaining({ field: 'provider', role: 'SUPPLIER', qualification: 'REAL_CONFLICT_UNRESOLVED' })]);
    expect(p0.conflicts[0].values).toHaveLength(5);
    expect(await arbitrages(compte)).toEqual([expect.objectContaining({ status: 'PENDING', ai_calls: 0 })]);
    expect(etat.calls).toBe(0);

    // Le passage T3 constate que la couverture n'est pas prouvée (4 valeurs transmissibles sur 5) : AUCUN appel.
    const res = await phase(compte);
    expect(res).toMatchObject({ processed: 1, aiCalls: 0, operations: [opId], outcomes: { INCOMPLETE: 1 }, applied: 0 });
    expect(etat.calls).toBe(0);
    const [a] = await arbitrages(compte);
    expect(a).toMatchObject({ status: 'INCOMPLETE', outcome: null, retained_value: null, ai_calls: 0, application_state: null });
    expect(a.reason).toBe('CONTEXT_INCOMPLETE:VALUES_DROPPED');
    expect(a.validation).toMatchObject({ complete: false, missing: 'VALUES_DROPPED' });
    expect(a.evidence_key).toMatch(/^l115:/);

    // Le diagnostic est MAINTENU, aucune valeur n'est écrite, et la carte est posée (l'utilisateur tranche).
    expect((await op(opId)).provider).toBe(noms[0]);
    expect((await prov(opId)).conflicts).toEqual([expect.objectContaining({ qualification: 'REAL_CONFLICT_UNRESOLVED' })]);
    const [carte] = await cartes(compte);
    expect(carte.trigger_context.optionCount).toBe(5);
    expect(carte.trigger_context.options).toHaveLength(5);
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ IDENTITY_ATTRIBUTE_CONFLICT: 1 });
    // Diagnostic BO : l'état est explicite, et « décidé » n'est pas présenté.
    const diag = await (await import('@/services/business-operations/diagnostics/attribute-conflicts-read')).readConflictDiagnostic({ accountId: compte.id });
    expect(diag.conflicts[0].t3).toMatchObject({ status: 'INCOMPLETE', label: 'Preuves non couvertes en entier : aucun arbitrage (le diagnostic reste ouvert)', applied: false, applicationLabel: null });

    // Rejeu : rien de nouveau, aucun appel, aucune seconde demande.
    const fige = JSON.stringify(await prov(opId));
    await reconsolider(compte, opId);
    expect(await phase(compte)).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(await arbitrages(compte)).toHaveLength(1);
    expect(JSON.stringify(await prov(opId))).toBe(fige);
    expect(etat.calls).toBe(0);
  });

  // ── E03 : « décidé » n'est pas « appliqué » ──────────────────────────────
  it('L115F-E03 — application VÉRIFIÉE, reprise après panne, échec tracé quand la valeur est protégée', async () => {
    etat.available = true;
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId, fichiers } = await evenement(compte, maison.id, facture(maison.id), [facture(maison.id, { provider: 'Chauffage Martin' })]);
    const t2 = await titre(fichiers[1]);
    etat.answer = (input) => {
      const v = input.values.find((x: Json) => x.value === 'Chauffage Martin');
      return {
        task: 'ATTRIBUTE_ARBITRATION', outcome: 'RESOLVED', retainedValue: v.ref, foreignDocument: null, confidence: 'certain',
        evidence: [{ document: v.documents[0], excerpt: t2 }], reason: 'La seconde facture fait foi.',
      };
    };
    const res = await phase(compte);
    expect(res).toMatchObject({ processed: 1, aiCalls: 1, applied: 1 });
    expect(res.applyFailed).toBeUndefined();
    expect((await op(opId)).provider).toBe('Chauffage Martin');
    const [a] = await arbitrages(compte);
    expect(a).toMatchObject({ status: 'DECIDED', outcome: 'RESOLVED', application_state: 'APPLIED', application_attempts: 1, application_error: null });
    expect(a.applied_at).not.toBeNull();
    expect(a.value_before).toBe('Plomberie Durand');
    expect(a.value_after).toBe('Chauffage Martin');

    // PANNE entre la décision et son effet : la décision est reçue, l'application n'a jamais été vérifiée.
    await sql`UPDATE business_operation_attribute_arbitrations SET application_state = 'RECEIVED', applied_at = NULL, value_after = NULL WHERE id = ${a.id}`;
    await sql`UPDATE business_operations SET provider = 'Plomberie Durand' WHERE id = ${opId}`;
    const reprise = await phase(compte);
    expect(reprise).toMatchObject({ resumed: 1, aiCalls: 0, applied: 1, operations: [opId] });
    expect(etat.calls).toBe(1); // aucun appel de plus : la reprise ne redemande rien à l'IA
    expect((await op(opId)).provider).toBe('Chauffage Martin');
    const [b] = await arbitrages(compte);
    expect(b).toMatchObject({ application_state: 'APPLIED', application_attempts: 2 });
    expect(b.applied_at).not.toBeNull();

    // Rejeu : plus rien à reprendre (idempotence).
    const rejeu = await phase(compte);
    expect(rejeu).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(rejeu.resumed).toBeUndefined();

    // Valeur PROTÉGÉE par l'utilisateur : l'application est en échec, tracée, et jamais présentée comme faite.
    const compte2 = await make.account({ plan: 'premium' });
    const maison2 = await make.asset(compte2, { category: 'IMMOBILIER', name: 'Maison' });
    const ev2 = await evenement(compte2, maison2.id, facture(maison2.id, { temporalHints: { realizedDate: '2026-03-12' } }),
      [facture(maison2.id, { temporalHints: { realizedDate: '2026-03-19' } })]);
    const t3 = await titre(ev2.fichiers[0]);
    etat.answer = (input) => {
      const v = input.values.find((x: Json) => x.value === '2026-03-12');
      return {
        task: 'ATTRIBUTE_ARBITRATION', outcome: 'RESOLVED', retainedValue: v.ref, foreignDocument: null, confidence: 'certain',
        evidence: [{ document: v.documents[0], excerpt: t3 }], reason: 'La première facture fait foi.',
      };
    };
    // Une saisie non gérée par T3 (formulaire de sinistre) interdit la réécriture de la date.
    await sql`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority, confidence, active)
      VALUES (${compte2.id}, ${ev2.opId}, 'CLAIM_FORM', ${`forme-${ev2.opId}`}, 'USER', 'certain', true)`;
    const r2 = await phase(compte2);
    expect(r2).toMatchObject({ processed: 1, aiCalls: 1, applied: 0, applyFailed: 1 });
    const [c] = await arbitrages(compte2);
    expect(c).toMatchObject({ status: 'DECIDED', outcome: 'RESOLVED', application_state: 'APPLY_FAILED', application_error: 'PROTECTED_OR_UNMANAGED_VALUE' });
    expect(c.applied_at).toBeNull();
    expect(c.validation).toMatchObject({ applied: false, notApplied: 'PROTECTED_OR_UNMANAGED_VALUE' });
  });

  // ── E04 : périmètre matériel des preuves, et erreur de lien ──────────────
  it('L115F-E04 — rejeux identiques sans nouvel examen, pièce plus autoritaire réexaminée une fois, « document étranger » rendu au moteur de réparation', async () => {
    etat.available = true;
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId, fichiers } = await evenement(compte, maison.id, facture(maison.id), [facture(maison.id, { provider: 'Chauffage Martin' })]);
    const t2 = await titre(fichiers[1]);
    etat.answer = () => ({
      task: 'ATTRIBUTE_ARBITRATION', outcome: 'DISTINCT_FACTS', retainedValue: null, foreignDocument: null, confidence: 'certain',
      evidence: [{ document: 'D2', excerpt: t2 }], reason: 'Deux prestations distinctes.',
    });
    expect(await phase(compte)).toMatchObject({ processed: 1, aiCalls: 1, outcomes: { DECIDED_DISTINCT_FACTS: 1 } });
    const [a0] = await arbitrages(compte);
    expect(a0.evidence_key).toMatch(/^l115:/);
    expect((await prov(opId)).conflicts).toEqual([]);

    // E07 : vingt rejeux de la consolidation (scans identiques) — aucun examen de plus, aucun appel.
    for (let i = 0; i < 20; i++) await reconsolider(compte, opId);
    expect(await arbitrages(compte)).toHaveLength(1);
    expect(await phase(compte)).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(etat.calls).toBe(1);
    expect((await prov(opId)).conflicts).toEqual([]);

    // E07 : une pièce plus AUTORITAIRE (le même document requalifié « contrat ») change le périmètre MATÉRIEL des
    // preuves sans changer la chaîne des valeurs : le verdict ne couvre plus la ligne, un examen est redemandé — UNE fois.
    await sql`
      UPDATE document_operation_candidates SET payload = jsonb_set(payload, '{sourceRoleHint}', '"CONTRACT_DOCUMENT"')
       WHERE account_id = ${compte.id} AND file_id = ${fichiers[1]} AND status = 'ACTIVE'`;
    await reconsolider(compte, opId);
    const apres = await arbitrages(compte);
    expect(apres).toHaveLength(1);
    expect(apres[0]).toMatchObject({ status: 'PENDING' });
    expect(apres[0].evidence_key).not.toBe(a0.evidence_key);
    expect((await prov(opId)).conflicts).toEqual([expect.objectContaining({ qualification: 'REAL_CONFLICT_UNRESOLVED' })]);
    const h = await histo(opId);
    await reconsolider(compte, opId);
    expect(await arbitrages(compte)).toHaveLength(1);
    expect(await histo(opId)).toBe(h);

    // E08 : T3 désigne le second document comme ÉTRANGER, preuve citée dans CE document.
    etat.answer = () => ({
      task: 'ATTRIBUTE_ARBITRATION', outcome: 'LINK_ERROR', retainedValue: null, foreignDocument: 'D2', confidence: 'certain',
      evidence: [{ document: 'D2', excerpt: t2 }], reason: 'Ce document ne concerne pas cet événement.',
    });
    const res = await phase(compte);
    expect(res).toMatchObject({ processed: 1, aiCalls: 1 });
    expect(res.outcomes).toMatchObject({ DECIDED_LINK_ERROR: 1, LINK_DOUBT_OPENED: 1 });
    // Un doute de rattachement est OUVERT au journal, borné au compte, avec ses signaux.
    const [doute, ...trop] = await doutes(compte);
    expect(trop).toEqual([]);
    expect(doute).toMatchObject({ operation_id: String(opId), kind: 'SUSPECT', status: 'OPEN', file_id: fichiers[1], basis: 'T3_ATTRIBUTE_ARBITRATION' });
    expect(doute.signals).toEqual(expect.arrayContaining(['T3_LINK_ERROR', 'FIELD:provider']));
    // Le candidat est remis en consolidation : c'est le réexamen EXISTANT qui tranchera.
    expect(await sql`SELECT 1 FROM document_operation_candidates WHERE file_id = ${fichiers[1]} AND status = 'ACTIVE' AND t3_pending`).toHaveLength(1);
    // AUCUN détachement : la source reste active, la valeur en place est inchangée, et la ligne devient « rattachement douteux ».
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_entity_key = ${String(fichiers[1])}`).toHaveLength(1);
    expect((await op(opId)).provider).toBe('Plomberie Durand');
    expect((await prov(opId)).conflicts).toEqual([expect.objectContaining({ qualification: 'SOURCE_LINK_ERROR_SUSPECTED' })]);
    expect(await cartes(compte)).toEqual([]);
    // Rejeu : le doute n'est pas dupliqué.
    await reconsolider(compte, opId);
    expect(await doutes(compte)).toHaveLength(1);
  });
});
