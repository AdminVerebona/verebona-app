/**
 * Lot 114 (Trello #750, issues B et C ; diagnostic #751) — arbitrage des
 * contradictions RÉELLES d'attributs d'un événement de référence, sur
 * PostgreSQL 16 réel, par les chemins de PRODUCTION : persistance T1 des
 * candidats, reconsolidation T3, cartes « À traiter » (`syncOperationCards`),
 * résolution et annulation réelles (`resolveArbitration`, `undoArbitration`),
 * phase d'arbitrage T3 du passage (`runAttributeArbitrationPhase`). L'IA est
 * SIMULÉE par le port du décideur (jamais d'appel Gemini).
 *
 *   L114T-E2E-01  issue C — sans bloc 38 : conflit réel de prestataire → UNE carte (toutes les valeurs, valeur en place
 *                 marquée, jamais écrasée avant la réponse) ; réponse → valeur écrite, décision durable, alerte levée ;
 *                 rejeux sans réouverture ni écriture ; troisième valeur nouvelle → réouverture motivée, valeur de
 *                 l'utilisateur intacte ; annulation → état d'avant
 *   L114T-E2E-02  issue B — bloc 38 actif : demande sans appel, carte différée ; T3 retient une valeur sur preuve citée →
 *                 valeur écrite, avant / après tracé, aucune carte, alerte levée ; constat déjà examiné jamais renvoyé
 *   L114T-E2E-03  issue B — indécidable → carte ; sortie invalide (extrait inventé) → abstention, rien d'écrit, carte ;
 *                 panne IA → nouvel essai borné, rien d'écrit, aucune modification spéculative
 *   L114T-E2E-04  faits distincts établis par T3 → plus un conflit, aucune carte ; isolation des comptes
 *   L114T-E2E-05  reprise du stock : contradiction réelle d'avant le lot 114 (aucune carte) → COH-OPS-ATTRIBUTE-CONFLICTS
 *                 (version 2) la détecte et pose la carte par reconsolidation ciblée, sans IA, sans valeur écrite ; idempotent
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { runCoherenceFor, proofOf } from '../coherence-run';
import { RECETTE_TODAY, cand, cible, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

scenario('L114T', 'Opérations — arbitrage des contradictions réelles d’attributs : carte « Arbitrer » et arbitrage T3 (#750)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const etat = { available: false, answer: (_: Json): unknown => null, calls: 0, fail: false };
  beforeAll(async () => {
    const dec = await import('@/services/business-operations/consolidation/attribute-arbitration/decider');
    dec.__setArbitrationDeciderForTests({
      capability: async () => (etat.available ? { available: true, version: 'e2e-bloc-38', reason: 'AVAILABLE' } : { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'BRANCH_MISSING' }),
      decide: async (call) => {
        etat.calls++;
        if (etat.fail) throw new Error('E2E_AI_DOWN');
        return { output: etat.answer(call.input as unknown as Json), traceId: `trace-${etat.calls}` };
      },
    });
    await import('@/services/business-operations/consolidation/queue');
  });
  afterEach(() => { etat.available = false; etat.answer = () => null; etat.calls = 0; etat.fail = false; });
  afterAll(async () => {
    (await import('@/services/business-operations/consolidation/attribute-arbitration/decider')).__setArbitrationDeciderForTests(null);
  });

  const prov = async (opId: number) => (await sql<{ p: Json }[]>`SELECT attribute_provenance AS p FROM business_operations WHERE id = ${opId}`)[0].p;
  const histo = async (opId: number) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE operation_id = ${opId}`)[0].n;
  const op = async (opId: number) => (await sql<Json[]>`SELECT provider, realized_date::text AS realized_date FROM business_operations WHERE id = ${opId}`)[0];
  const cartes = (compte: AccountRow, ouvertes = true) => sql<Json[]>`
    SELECT id, public_id, target_id, relation_key, question, proposals_json AS proposals, trigger_context, resolved_at, resolution_reason, cycle_number
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-ATTRIBUTE'
       AND ${ouvertes ? sql`resolved_at IS NULL` : sql`TRUE`} ORDER BY id`;
  const arbitrages = (compte: AccountRow) => sql<Json[]>`
    SELECT id, field, role, status, outcome, retained_value, value_before, value_after, applied_at, ai_calls, attempts, retry_at, reason, validation, evidence
      FROM business_operation_attribute_arbitrations WHERE account_id = ${compte.id} ORDER BY id`;
  const reconsolider = async (compte: AccountRow, opId: number) =>
    (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte.id, [opId], { today: RECETTE_TODAY });
  const phase = async (compte: AccountRow) =>
    (await import('@/services/business-operations/consolidation/attribute-arbitration/review')).runAttributeArbitrationPhase(compte.id, {});
  const repondre = async (compte: AccountRow, publicId: string, value: string) =>
    (await import('@/services/to-process/resolve-action.service')).resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });

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
          confidence: 'certain', matchMethod: 'M1', matchReason: 'E2E_L114T',
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
    // Titres retenus des documents : seul texte citable de ces pièces de test (aucune transcription).
    for (const [i, f] of fichiers.entries()) await sql`UPDATE asset_files SET retained_title = ${i === 0 ? 'Facture chauffe-eau' : `Facture rectificative chauffe-eau ${i}`} WHERE id = ${f}`;
    return { opId: o.id as number, fichiers };
  }
  const facture = (assetId: number, over: Parameters<typeof cand>[0] = {}) => cand({
    typeHint: 'INTERVENTION', summary: 'Remplacement du chauffe-eau', provider: 'Plomberie Durand', sourceRoleHint: 'INVOICE',
    targetHints: [cible(assetId)], businessReferences: [ref('INVOICE', 'F-118')], temporalHints: { realizedDate: '2024-01-10' }, ...over,
  });
  const titre = async (fileId: number) => (await sql<{ t: string }[]>`SELECT COALESCE(retained_title, original_filename) AS t FROM asset_files WHERE id = ${fileId}`)[0].t;

  // ── E01 ──────────────────────────────────────────────────────────────────
  it('L114T-E2E-01 — issue C : une carte, réponse durable, rejeux sans réouverture, valeur nouvelle = réouverture motivée, annulation', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId, fichiers } = await evenement(compte, maison.id, facture(maison.id), [facture(maison.id, { provider: 'Chauffage Martin' })]);

    // Contradiction réelle : même référence, deux prestataires. Aucun arbitrage T3 (bloc 38 absent) : carte directe.
    const p = await prov(opId);
    expect(p.conflicts).toEqual([expect.objectContaining({ field: 'provider', role: 'SUPPLIER', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE' })]);
    expect(await arbitrages(compte)).toEqual([]);
    expect(etat.calls).toBe(0);
    expect((await op(opId)).provider).toBe('Plomberie Durand'); // valeur en place jamais écrasée avant la réponse
    const [carte, ...trop] = await cartes(compte);
    expect(trop).toEqual([]);
    expect(carte).toMatchObject({
      target_id: fichiers[1], relation_key: `operationAttribute:${opId}:provider:SUPPLIER`,
      question: 'Ces documents indiquent des prestataires différents pour la même intervention : lequel est le bon ?',
    });
    expect(carte.question).not.toMatch(/op[ée]ration/i);
    expect(carte.proposals).toHaveLength(2);
    expect(carte.proposals.at(-1)).toMatchObject({ isCurrentValue: true });
    expect(carte.proposals.at(-1).label).toMatch(/^Plomberie Durand/);
    const martin = carte.proposals[0].value as string;
    expect(carte.proposals[0].label).toMatch(/^Chauffage Martin/);
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ IDENTITY_ATTRIBUTE_CONFLICT: 1 });

    // Diagnostic BO #12 (#751) : la ligne active cite SA carte « À traiter » ouverte ; un arbitrage ouvert compté.
    const diag = async (c: AccountRow, scope: 'alerting' | 'all' = 'alerting') =>
      (await import('@/services/business-operations/diagnostics/attribute-conflicts-read')).readConflictDiagnostic({ accountId: c.id, scope });
    const d0 = await diag(compte);
    expect(d0.conflicts).toEqual([expect.objectContaining({
      operationId: opId, lineState: 'ACTIVE', arbitration: { actionId: Number(carte.id), state: 'OPEN' }, t3: null,
      appliedAction: expect.objectContaining({ kind: 'USER_ARBITRATION_OPEN' }),
    })]);
    expect(d0.counters).toMatchObject({ activeConflicts: 1, openArbitrations: 1 });

    // Requête forgée : refusée, rien d'écrit.
    expect(await repondre(compte, carte.public_id, 'ATTRIBUTE:valeur inventee')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect((await op(opId)).provider).toBe('Plomberie Durand');

    // Réponse : valeur écrite, décision durable (source explicite), contradiction tranchée, alerte levée.
    const r = await repondre(compte, carte.public_id, martin);
    expect(r).toMatchObject({ ok: true });
    expect((await op(opId)).provider).toBe('Chauffage Martin');
    const apres = await prov(opId);
    expect(apres.conflicts).toEqual([]);
    expect(apres.divergences).toEqual(expect.arrayContaining([expect.objectContaining({
      field: 'provider', qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'USER_ARBITRATED', protection: 'USER',
      resolution: expect.objectContaining({ by: 'USER', value: 'Chauffage Martin' }),
    })]));
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'USER_ARBITRATION' AND locator->>'decision' = 'ATTRIBUTE'`).toHaveLength(1);
    expect(await cartes(compte)).toEqual([]);
    expect((await cartes(compte, false))[0]).toMatchObject({ resolution_reason: 'USER_ARBITRATED' });
    expect(await k.anomaliesDures(compte.id)).not.toHaveProperty('IDENTITY_ATTRIBUTE_CONFLICT');
    // Diagnostic : plus de ligne d'alerte ; la ligne tranchée reste consultable avec sa carte traitée et sa raison.
    expect((await diag(compte)).conflicts).toEqual([]);
    const d1 = (await diag(compte, 'all')).conflicts.find((e) => e.attribute.key === 'provider')!;
    expect(d1).toMatchObject({
      lineState: 'RESOLVED', qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'USER_ARBITRATED', persistedValue: 'Chauffage Martin', protection: 'USER',
      arbitration: { actionId: Number(carte.id), state: 'RESOLVED' }, appliedAction: expect.objectContaining({ kind: 'USER_DECISION' }),
    });
    expect(d1.reason).toMatch(/tranchée par l’utilisateur/);

    // AC13 : rejeux identiques — aucune réouverture, aucune carte, aucune écriture.
    const h = await histo(opId);
    const fige = JSON.stringify(await prov(opId));
    for (let i = 0; i < 3; i++) await reconsolider(compte, opId);
    expect(JSON.stringify(await prov(opId))).toBe(fige);
    expect(await histo(opId)).toBe(h);
    expect(await cartes(compte)).toEqual([]);
    expect((await op(opId)).provider).toBe('Chauffage Martin');

    // Nouvelle preuve contradictoire (troisième valeur) : réouverture MOTIVÉE ; la valeur de l'utilisateur reste (AC12).
    await rattacher(compte, opId, maison.id, [facture(maison.id, { provider: 'Sanitaire Leroy' })]);
    const rouvert = await prov(opId);
    expect(rouvert.conflicts).toEqual([expect.objectContaining({ field: 'provider', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'NEW_EVIDENCE_AFTER_DECISION', protection: 'USER' })]);
    expect((await op(opId)).provider).toBe('Chauffage Martin');
    const [carte2, ...trop2] = await cartes(compte);
    expect(trop2).toEqual([]);
    expect(carte2.proposals).toHaveLength(3);
    expect(carte2.proposals.at(-1)).toMatchObject({ isCurrentValue: true });
    expect(carte2.proposals.at(-1).label).toMatch(/^Chauffage Martin/);
    expect(await arbitrages(compte)).toEqual([]); // valeur protégée par l'utilisateur : jamais renvoyée à T3

    // Annulation de la nouvelle réponse : la décision précédente de l'utilisateur est retirée avec elle, la carte rouvre.
    const leroy = carte2.proposals.find((x: Json) => /^Sanitaire Leroy/.test(x.label)).value as string;
    const r2 = await repondre(compte, carte2.public_id, leroy);
    expect(r2).toMatchObject({ ok: true });
    expect((await op(opId)).provider).toBe('Sanitaire Leroy');
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'USER_ARBITRATION' AND locator->>'decision' = 'ATTRIBUTE'`).toHaveLength(1);
    const { undoArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await undoArbitration(compte.id, carte2.public_id, r2.previousValue)).toMatchObject({ ok: true });
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'USER_ARBITRATION' AND locator->>'decision' = 'ATTRIBUTE'`).toHaveLength(0);
    expect((await prov(opId)).conflicts).toEqual([expect.objectContaining({ field: 'provider', qualification: 'REAL_CONFLICT_UNRESOLVED' })]);
    expect(await cartes(compte)).toHaveLength(1);
  });

  // ── E02 ──────────────────────────────────────────────────────────────────
  it('L114T-E2E-02 — issue B : demande sans appel, carte différée, valeur retenue sur preuve citée, avant / après, jamais renvoyé', async () => {
    etat.available = true;
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId, fichiers } = await evenement(compte, maison.id, facture(maison.id, { temporalHints: { realizedDate: '2023-02-01' } }),
      [facture(maison.id, { temporalHints: { realizedDate: '2025-02-01' } })]);

    // Demande posée par la consolidation, SANS appel ; carte différée ; la ligne dit « examen T3 attendu ».
    expect(etat.calls).toBe(0);
    expect(await arbitrages(compte)).toEqual([expect.objectContaining({ field: 'realizedDate', role: 'REALIZATION', status: 'PENDING', ai_calls: 0 })]);
    expect((await prov(opId)).conflicts).toEqual([expect.objectContaining({ field: 'realizedDate', qualification: 'REAL_CONFLICT_UNRESOLVED', t3: expect.objectContaining({ outcome: 'PENDING' }) })]);
    expect(await cartes(compte)).toEqual([]);
    const avant = (await op(opId)).realized_date;
    // Rejeu de la consolidation : toujours une seule demande.
    await reconsolider(compte, opId);
    expect(await arbitrages(compte)).toHaveLength(1);

    // T3 retient la valeur qui N'EST PAS en place, preuve citée DANS le document qui la porte (son titre, texte fourni).
    const retenue = avant === '2025-02-01' ? '2023-02-01' : '2025-02-01';
    const porteur = retenue === '2023-02-01' ? fichiers[0] : fichiers[1];
    const t2 = await titre(porteur);
    let recu: Json | null = null;
    etat.answer = (input) => {
      recu = input;
      const v = input.values.find((x: Json) => x.value === retenue);
      return { task: 'ATTRIBUTE_ARBITRATION', outcome: 'RESOLVED', retainedValue: v.ref, foreignDocument: null, confidence: 'certain', evidence: [{ document: v.documents[0], excerpt: t2 }], reason: 'Le second document fait foi.' };
    };
    const res = await phase(compte);
    expect(res).toMatchObject({ processed: 1, aiCalls: 1, operations: [opId], outcomes: { DECIDED_RESOLVED: 1 }, applied: 1 });
    // Monde fermé : aucune donnée d'un autre compte, aucune référence interne.
    expect(recu).toMatchObject({ contractVersion: 't3-attribute-arbitration-v1', task: 'ATTRIBUTE_ARBITRATION', attribute: { field: 'realizedDate', role: 'REALIZATION' } });
    expect(JSON.stringify(recu)).not.toMatch(/"fileIds"|"sourceIds"|"accountId"/);
    expect((await op(opId)).realized_date).toBe(retenue);
    const [a] = await arbitrages(compte);
    expect(a).toMatchObject({ status: 'DECIDED', outcome: 'RESOLVED', retained_value: retenue, value_before: avant, value_after: retenue, ai_calls: 1 });
    expect(a.applied_at).not.toBeNull();
    expect(a.evidence).toEqual([expect.objectContaining({ fileId: porteur, excerpt: t2 })]);
    const apres = await prov(opId);
    expect(apres.conflicts).toEqual([]);
    expect(apres.divergences).toEqual(expect.arrayContaining([expect.objectContaining({
      field: 'realizedDate', qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'T3_ARBITRATED', resolution: expect.objectContaining({ by: 'T3', value: retenue, reviewId: Number(a.id) }),
    })]));
    expect(await cartes(compte)).toEqual([]);
    expect(await k.anomaliesDures(compte.id)).not.toHaveProperty('IDENTITY_ATTRIBUTE_CONFLICT');
    // Diagnostic BO #12 (#751, AC05) : arbitrage T3 appliqué — avant / après, preuve, traitement, horodatage, version du prompt.
    const { readConflictDiagnostic } = await import('@/services/business-operations/diagnostics/attribute-conflicts-read');
    const ligne = (await readConflictDiagnostic({ accountId: compte.id, scope: 'all' })).conflicts.find((e) => e.attribute.key === 'realizedDate')!;
    expect(ligne).toMatchObject({
      lineState: 'RESOLVED', reasonCode: 'T3_ARBITRATED', persistedValue: retenue, appliedAction: expect.objectContaining({ kind: 'T3_ARBITRATION' }),
      t3: expect.objectContaining({ reviewId: Number(a.id), status: 'DECIDED', outcome: 'RESOLVED', valueBefore: avant, valueAfter: retenue, applied: true, promptVersion: 'e2e-bloc-38', traceId: 'trace-1' }),
    });
    expect(ligne.t3!.evidence).toEqual([{ fileId: porteur, excerpt: t2 }]);
    expect(ligne.t3!.decidedAt).not.toBeNull();
    expect(ligne.appliedAction.detail).toContain(`${avant} → ${retenue}`);

    // Constat déjà examiné : jamais renvoyé à l'IA, ni au passage suivant ni après reconsolidation.
    const h = await histo(opId);
    await reconsolider(compte, opId);
    expect(await phase(compte)).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(etat.calls).toBe(1);
    expect(await arbitrages(compte)).toHaveLength(1);
    expect(await histo(opId)).toBe(h);
  });

  // ── E03 ──────────────────────────────────────────────────────────────────
  it('L114T-E2E-03 — issue B : indécidable → carte ; extrait inventé → abstention ; panne IA → nouvel essai borné, rien d’écrit', async () => {
    etat.available = true;
    const scenarioDe = async (reponse: (i: Json, titres: string[]) => unknown, panne = false) => {
      const compte = await make.account({ plan: 'premium' });
      const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
      const { opId, fichiers } = await evenement(compte, maison.id, facture(maison.id), [facture(maison.id, { provider: 'Chauffage Martin' })]);
      expect(await cartes(compte)).toEqual([]);
      const titres = [await titre(fichiers[0]), await titre(fichiers[1])];
      etat.fail = panne;
      etat.answer = (i) => reponse(i, titres);
      const res = await phase(compte);
      etat.fail = false;
      return { compte, opId, res };
    };

    // Indécidable (certain) : contradiction réelle confirmée, à l'utilisateur.
    const u = await scenarioDe((i, t) => ({
      task: 'ATTRIBUTE_ARBITRATION', outcome: 'UNDECIDABLE', retainedValue: null, foreignDocument: null, confidence: 'certain',
      evidence: [{ document: 'D1', excerpt: t[0] }], reason: `Preuves de même autorité (${i.values.length} valeurs).`,
    }));
    expect(u.res.outcomes).toEqual({ DECIDED_UNDECIDABLE: 1 });
    expect((await op(u.opId)).provider).toBe('Plomberie Durand');
    expect((await prov(u.opId)).conflicts).toEqual([expect.objectContaining({ qualification: 'REAL_CONFLICT_UNRESOLVED', t3: expect.objectContaining({ outcome: 'UNDECIDABLE' }) })]);
    expect(await cartes(u.compte)).toHaveLength(1);

    // Extrait inventé : sortie refusée en bloc — vaut abstention, rien d'écrit, la question va à l'utilisateur.
    const x = await scenarioDe((i) => ({
      task: 'ATTRIBUTE_ARBITRATION', outcome: 'RESOLVED', retainedValue: i.values[0].ref, foreignDocument: null, confidence: 'certain',
      evidence: [{ document: i.values[0].documents[0], excerpt: 'annule et remplace la facture précédente' }], reason: 'Rectificative.',
    }));
    expect(x.res.outcomes).toEqual({ REJECTED: 1 });
    const [rej] = await arbitrages(x.compte);
    expect(rej).toMatchObject({ status: 'REJECTED', reason: 'INVALID_DECISION:EXCERPT_NOT_FOUND', retained_value: null });
    expect(rej.validation).toMatchObject({ valid: false });
    expect((await op(x.opId)).provider).toBe('Plomberie Durand');
    expect(await cartes(x.compte)).toHaveLength(1);

    // Panne IA : distincte de l'absence de preuve — nouvel essai programmé, aucune valeur modifiée, pas de faux succès.
    const f = await scenarioDe(() => null, true);
    expect(f.res.outcomes).toEqual({ AI_FAILED: 1 });
    const [ko] = await arbitrages(f.compte);
    expect(ko).toMatchObject({ status: 'AI_FAILED', attempts: 1, ai_calls: 1, retained_value: null });
    expect(ko.retry_at).not.toBeNull();
    expect((await op(f.opId)).provider).toBe('Plomberie Durand');
    // Tant que le nouvel essai est attendu : pas de carte prématurée ; aucun appel avant l'échéance.
    expect(await cartes(f.compte)).toEqual([]);
    expect(await phase(f.compte)).toMatchObject({ processed: 0, aiCalls: 0 });
  });

  // ── E04 ──────────────────────────────────────────────────────────────────
  it('L114T-E2E-04 — faits distincts établis par T3 : plus un conflit, aucune carte ; isolation des comptes', async () => {
    etat.available = true;
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const maisonA = await make.asset(a, { category: 'IMMOBILIER', name: 'Maison A' });
    const maisonB = await make.asset(b, { category: 'IMMOBILIER', name: 'Maison B' });
    const evA = await evenement(a, maisonA.id, facture(maisonA.id), [facture(maisonA.id, { provider: 'Chauffage Martin' })]);
    const evB = await evenement(b, maisonB.id, facture(maisonB.id), [facture(maisonB.id, { provider: 'Chauffage Martin' })]);
    const t = await titre(evA.fichiers[1]);
    etat.answer = () => ({
      task: 'ATTRIBUTE_ARBITRATION', outcome: 'DISTINCT_FACTS', retainedValue: null, foreignDocument: null, confidence: 'certain',
      evidence: [{ document: 'D2', excerpt: t }], reason: 'Deux prestations distinctes.',
    });
    // Le passage du compte A ne traite QUE le compte A.
    const res = await phase(a);
    expect(res).toMatchObject({ processed: 1, aiCalls: 1, operations: [evA.opId], outcomes: { DECIDED_DISTINCT_FACTS: 1 } });
    const pa = await prov(evA.opId);
    expect(pa.conflicts).toEqual([]);
    expect(pa.divergences).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'provider', qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'T3_DISTINCT_FACTS' })]));
    expect((await op(evA.opId)).provider).toBe('Plomberie Durand');
    expect(await cartes(a)).toEqual([]);
    expect(await k.anomaliesDures(a.id)).not.toHaveProperty('IDENTITY_ATTRIBUTE_CONFLICT');
    // Compte B intact : demande toujours en attente, aucune décision recopiée.
    expect(await arbitrages(b)).toEqual([expect.objectContaining({ status: 'PENDING', ai_calls: 0 })]);
    expect((await prov(evB.opId)).conflicts).toHaveLength(1);
  });

  // ── E05 ──────────────────────────────────────────────────────────────────
  it('L114T-E2E-05 — reprise du stock : contradiction réelle sans carte → carte posée par COH-OPS-ATTRIBUTE-CONFLICTS, sans IA, idempotent', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId } = await evenement(compte, maison.id, facture(maison.id), [facture(maison.id, { provider: 'Chauffage Martin' })]);
    // Les AUTRES contrôles de la campagne (projection Agenda…) sont d'abord stabilisés : l'état comparé ensuite ne
    // peut changer que par COH-OPS-ATTRIBUTE-CONFLICTS.
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(await sql`SELECT id FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = 'COH-OPS-ATTRIBUTE-CONFLICTS'`).toHaveLength(0);
    // Stock d'avant le lot 114 : la contradiction réelle est qualifiée, mais aucune carte n'a jamais existé.
    await sql`DELETE FROM to_process_action_events WHERE action_id IN (SELECT id FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-ATTRIBUTE')`;
    await sql`DELETE FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-ATTRIBUTE'`;
    expect(await cartes(compte)).toEqual([]);
    const avant = await op(opId);
    const h = await histo(opId);

    // Simulation : anomalie vue, rien d'écrit.
    await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN', today: RECETTE_TODAY });
    expect(await proofOf(sql, compte.id, 'COH-OPS-ATTRIBUTE-CONFLICTS', opId)).toMatchObject({
      last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'ATTRIBUTE_CONFLICT_ARBITRATION_MISSING' }),
    });
    expect(await cartes(compte)).toEqual([]);

    // Réparation : reconsolidation ciblée — la carte est posée ; aucune valeur écrite, aucun appel IA.
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    const reparations = await sql<Json[]>`SELECT outcome, result FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = 'COH-OPS-ATTRIBUTE-CONFLICTS' ORDER BY id`;
    expect(reparations).toHaveLength(1);
    expect(reparations[0].outcome).toBe('REPAIRED');
    expect(reparations[0].result).toMatchObject({ arbitration: { cards: 1, t3Requested: 0 } });
    expect(await cartes(compte)).toHaveLength(1);
    expect(await op(opId)).toEqual(avant);
    expect(await histo(opId)).toBe(h);
    expect(etat.calls).toBe(0);

    // Rejeu : plus rien à reprendre.
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(await sql`SELECT id FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = 'COH-OPS-ATTRIBUTE-CONFLICTS'`).toHaveLength(1);
    expect(await cartes(compte)).toHaveLength(1);
  });
});
