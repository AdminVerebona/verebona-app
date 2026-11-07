/**
 * Lot 113S — Trello #716 « À traiter — Faire formuler les arbitrages métier
 * par T3/T4, sans questions génériques imposées par le code », sur
 * PostgreSQL réel (base dédiée), modèle IA SIMULÉ (sorties rejouées).
 *
 *   S1  rattachement (revue T3, ARBITRATE) : question fournie et valide →
 *       enregistrée et AFFICHÉE mot pour mot, provenance AI tracée ;
 *   S2  question absente, contrat inactif (avant le bloc 24) : formulation
 *       113L, provenance CODE, aucune anomalie ;
 *   S3  question invalide (trop longue, hors options, bien d'un AUTRE compte,
 *       autre bien du compte, « opération », e-mail) : repli tracé, motif ;
 *       contrat actif → anomalie Supervision ; jamais présentée comme IA ;
 *   S4  carte existante (formulation d'avant) : la question de T3 la remplace —
 *       MÊME carte, même cycle, QUESTION_UPDATED, aucun doublon ; rejoué : rien ;
 *   S5  carte close (« Garder ») : aucune réouverture malgré une question nouvelle ;
 *   S6  cartes système / données simples : texte du catalogue inchangé, aucune
 *       provenance, aucun appel ;
 *   S7  OPERATION-MATCH (M3) : question de T3 sur le candidat désigné, affichée
 *       sans recomposition ; question refusée → question binaire d'avant ;
 *   S8  AGENDA-PROJECTION-MATCH : abstention T4 avec question → carte ouverte
 *       requalifiée (même carte) ; question refusée → rien ne change.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import type { AccountRow } from '../factories';
import type { RecordedOutput } from '../replay-gateway';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
/** Blocs du guide collés (marqueurs dans la version active) — simulés : le code ne modifie jamais un prompt. */
const marqueurs = { revue: true, question: false };
vi.mock('@/services/ai/reconciliation/document-asset/attachment-review/contract', async (o) => ({
  ...(await o<object>()), attachmentReviewContractActive: async () => marqueurs.revue,
}));
vi.mock('@/services/to-process/ai-user-question', async (o) => ({
  ...(await o<object>()), questionContractActive: async () => marqueurs.question,
}));

type Json = Record<string, any>;
const ADRESSE_MAISON = { address1: '12 rue des Lilas', postalCode: '69003', city: 'Lyon' };
const ADRESSE_STUDIO = { address1: '4 avenue des Tilleuls', postalCode: '69006', city: 'Lyon' };
const Q_IA = 'Cet avis de taxe foncière désigne le bien imposé « Studio » : faut-il le rattacher à « Studio » plutôt qu’à « Maison » ?';
const REPLI_113L = 'Ce document est rattaché à « Maison » mais l’analyse indique qu’il concerne « Studio ». Quel bien garder ?';

scenario('L113S', 'À traiter : questions d’arbitrage formulées par T3 / T4, contrôlées par le code', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  afterEach(() => { marqueurs.revue = true; marqueurs.question = false; });

  const revue = (o: Json, extra: Json = {}): RecordedOutput => ({
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', repeat: true,
    output: { task: 'LINK_AMBIGUITY', matches: [], documentScope: 'SINGLE', attachmentReview: o, ...extra },
  });
  const analyser = async (compte: AccountRow, fileId: number, out: Json, recordings: RecordedOutput[]) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}), analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: out }, ...recordings]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l113s' });
    await drainQueues();
    return replay;
  };
  const taxe = () => sortieT1({
    title: 'Avis de taxe foncière', date: '2026-09-01', documentTypeCode: 'PROPERTY_TAX', rubricCode: 'TAXES', supplier: 'Impôts',
    assets: [], facts: [], texte: ['Désignation du bien imposé :', '4 avenue des Tilleuls 69006 Lyon', 'Propriétaire : M. Démo'],
  });
  const arbitrage = (studioId: number, userQuestion?: unknown) => revue({
    decision: 'ARBITRATE', concernedAssetIds: [studioId], citedIndexIds: [1],
    reason: 'Le bien imposé désigné par l’avis est le studio.', ...(userQuestion !== undefined ? { userQuestion } : {}),
  }, { matches: [{ candidateId: studioId, score: 0.92, confidence: 'certain', reason: 'bien imposé' }] });
  const cartes = (fileId: number, regle = 'LINK-ASSET-CONFLICT') => sql<Json[]>`
    SELECT id, public_id::text AS public_id, resolved_at IS NULL AS active, question, question_source, cycle_number
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = ${regle} ORDER BY id`;
  const evenements = (actionId: number) => sql<Json[]>`
    SELECT event, previous_value, new_value, details FROM to_process_action_events WHERE action_id = ${actionId} AND event = 'QUESTION_UPDATED' ORDER BY id`;
  const anomalies = async (compte: AccountRow) => (await sql<{ f: string }[]>`
    SELECT fingerprint AS f FROM admin_anomalies WHERE account_id = ${compte.id} AND fingerprint LIKE ${'ai:to-process-ai-question:%'}`).map((x) => x.f);
  const page = async (compte: AccountRow) => (await import('@/services/to-process/to-process-query.service')).getToProcessPage(compte.id, {});
  const conflit = async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: ADRESSE_STUDIO });
    return { compte, maison, studio };
  };

  it('S1 — question de T3 fournie et valide : enregistrée, provenance AI, affichée mot pour mot', async () => {
    marqueurs.question = true;
    const { compte, maison, studio } = await conflit();
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, taxe(), [arbitrage(studio.id, Q_IA)]);
    const [c] = await cartes(doc.id);
    expect(c).toMatchObject({ active: true, question: Q_IA, question_source: { origin: 'AI', rule: 'LINK-ASSET-CONFLICT', treatment: 'T3', operation: 't3_link_ambiguity', contract: 't3-user-question-v1', contractActive: true } });
    expect(c.question_source.promptVersion).toBeTruthy();
    const vue = (await page(compte)).actions.find((a) => a.publicId === c.public_id)!;
    expect(vue.question).toBe(Q_IA);
    expect(vue.proposals.map((p) => p.value)).toEqual([`MOVE:${studio.id}`, 'IGNORE', 'KEEP']);
    expect(await anomalies(compte)).toEqual([]);
    const t = (await sql<{ r: Json }[]>`SELECT attachment_review AS r FROM document_asset_resolutions WHERE file_id = ${doc.id}`)[0].r;
    expect(t.question).toMatchObject({ origin: 'AI', contractActive: true });
  });

  it('S2 — question absente, contrat inactif : formulation d’avant, provenance CODE, aucune anomalie', async () => {
    const { compte, maison, studio } = await conflit();
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, taxe(), [arbitrage(studio.id)]);
    const [c] = await cartes(doc.id);
    expect(c).toMatchObject({ active: true, question: REPLI_113L, question_source: { origin: 'CODE', fallback: 'AI_QUESTION_ABSENT', rejection: null, contractActive: false } });
    expect((await page(compte)).actions.find((a) => a.publicId === c.public_id)!.question).toBe(REPLI_113L);
    expect(await anomalies(compte)).toEqual([]);
  });

  it('S3 — question invalide (longueur, hors options, autre compte, autre bien, « opération », e-mail) : repli tracé ; contrat actif → Supervision', async () => {
    marqueurs.question = true;
    const { compte, maison, studio } = await conflit();
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Villeurbanne' });
    const autre = await make.account();
    await make.asset(autre, { category: 'IMMOBILIER', name: 'Chalet Megève' });
    const cas: Array<[unknown, string]> = [
      [`Cet avis ${'très '.repeat(60)}détaillé concerne-t-il « Studio » ?`, 'TOO_LONG'],
      ['Cet avis concerne-t-il plutôt « Garage Dupont » que « Maison » ?', 'UNKNOWN_REFERENCE'],
      ['Cet avis concerne-t-il « Chalet Megève » plutôt que « Maison » ?', 'UNKNOWN_REFERENCE'],
      ['Cet avis concerne-t-il le bien Appartement Villeurbanne plutôt que « Maison » ?', 'FOREIGN_LABEL'],
      ['Cet avis relève-t-il de la même opération que « Studio » ?', 'FORBIDDEN_TERM'],
      ['L’avis envoyé à demo@example.com concerne-t-il « Studio » ?', 'SENSITIVE_DATA'],
    ];
    for (const [q, code] of cas) {
      const doc = await make.assetFile(compte, { assetId: maison.id });
      await analyser(compte, doc.id, taxe(), [arbitrage(studio.id, q)]);
      const [c] = await cartes(doc.id);
      expect(c, code).toMatchObject({ active: true, question: REPLI_113L, question_source: { origin: 'CODE', fallback: 'AI_QUESTION_REJECTED', rejection: code } });
      expect((await page(compte)).actions.find((a) => a.publicId === c.public_id)!.question).toBe(REPLI_113L);
    }
    const f = await anomalies(compte);
    expect(f.length).toBeGreaterThanOrEqual(cas.length - 1);
    expect(f.some((x) => x.includes('too_long'))).toBe(true);
  });

  it('S4 — carte existante : la question de T3 remplace l’ancien libellé, même carte, même cycle, tracé ; rejoué : rien', async () => {
    const { compte, maison, studio } = await conflit();
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, taxe(), [arbitrage(studio.id)]);
    const [avant] = await cartes(doc.id);
    expect(avant.question).toBe(REPLI_113L);
    marqueurs.question = true;
    const { reviewDocumentAttachment } = await import('@/services/ai/reconciliation/document-asset/attachment-review/service');
    await rejouer([arbitrage(studio.id, Q_IA)]);
    await reviewDocumentAttachment({ accountId: compte.id, fileId: doc.id, finalAttempt: true, forced: true, triggerCode: 'manual' });
    const toutes = await cartes(doc.id);
    expect(toutes).toHaveLength(1);
    expect(toutes[0]).toMatchObject({ id: avant.id, active: true, question: Q_IA, cycle_number: avant.cycle_number, question_source: { origin: 'AI' } });
    const ev = await evenements(avant.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ previous_value: { question: REPLI_113L }, new_value: { question: Q_IA, source: { origin: 'AI' } }, details: { ruleCode: 'LINK-ASSET-CONFLICT', origin: 'AI' } });
    await rejouer([arbitrage(studio.id, Q_IA)]);
    await reviewDocumentAttachment({ accountId: compte.id, fileId: doc.id, finalAttempt: true, forced: true, triggerCode: 'manual' });
    expect(await cartes(doc.id)).toHaveLength(1);
    expect(await evenements(avant.id)).toHaveLength(1);
  });

  it('S5 — carte close par l’utilisateur (« Garder ») : jamais rouverte par une question nouvelle', async () => {
    marqueurs.question = true;
    const { compte, maison, studio } = await conflit();
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, taxe(), [arbitrage(studio.id, Q_IA)]);
    const [c] = await cartes(doc.id);
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect((await resolveArbitration(compte.id, c.public_id, 'KEEP', { userId: compte.ownerUserId })).ok).toBe(true);
    await analyser(compte, doc.id, taxe(), [arbitrage(studio.id, 'Cet avis de taxe foncière concerne-t-il vraiment « Studio » plutôt que « Maison » ?')]);
    const toutes = await cartes(doc.id);
    expect(toutes).toHaveLength(1);
    expect(toutes[0]).toMatchObject({ active: false, question: Q_IA });
  });

  it('S6 — cartes système et données simples : texte du catalogue, aucune provenance ; question historique inchangée', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    const r1 = await upsertAction({ accountId: compte.id, targetType: 'DOCUMENT', targetId: doc.id, fieldKey: 'documentTypeCode', actionKind: 'COMPLETE', ruleCode: 'DOC-TYP' });
    const r2 = await upsertAction({ accountId: compte.id, targetType: 'DOCUMENT', targetId: doc.id, fieldKey: 'documentTypeCode', actionKind: 'COMPLETE', ruleCode: 'DOC-TYP' });
    expect(r1.status).toBe('CREATED');
    expect(r2).toMatchObject({ status: 'UPDATED', actionId: r1.actionId });
    const [c] = await cartes(doc.id, 'DOC-TYP');
    expect(c).toMatchObject({ question: 'Quel est le type de ce document ?', question_source: null });
    expect(await evenements(c.id)).toEqual([]);
    // Producteur historique sans provenance (reprise) : le texte existant n'est pas écrasé par le catalogue.
    await sql`UPDATE to_process_actions SET question = 'Quel est le type exact de ce document ?' WHERE id = ${c.id}`;
    await upsertAction({ accountId: compte.id, targetType: 'DOCUMENT', targetId: doc.id, fieldKey: 'documentTypeCode', actionKind: 'COMPLETE', ruleCode: 'DOC-TYP' });
    expect((await cartes(doc.id, 'DOC-TYP'))[0].question).toBe('Quel est le type exact de ce document ?');
  });

  // ── OPERATION-MATCH (M3) ────────────────────────────────────────────────
  const AUJOURDHUI = '2026-10-12';
  const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
  beforeAll(async () => { await import('@/services/business-operations/consolidation/queue'); });
  afterEach(async () => {
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
  });
  const cand = (over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate => ({
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement des plaquettes de frein', sourceRoleHint: 'INVOICE', provider: 'Garage Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  });
  const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });
  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[], titre: string, date: string) {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_date = ${date} WHERE id = ${f.id}`;
    const extractionId = (await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`)[0].id;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId: f.id, extractionId, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map() });
    });
    return f.id;
  }
  const m3 = (o: Json): RecordedOutput => ({
    operationCode: 't3_operation_match', task: 'OPERATION_MATCH', repeat: true,
    output: { task: 'OPERATION_MATCH', decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', concordantSignals: ['même garage'], contradictions: [], reason: 'enregistré', resolution: 'ARBITRATE', ...o },
  });
  const devisPuisFacture = async (compte: AccountRow, bienId: number) => {
    await document(compte, bienId, [cand({ sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(bienId)], temporalHints: { plannedDate: '2026-06-03' }, businessReferences: [{ kind: 'QUOTE', value: 'DV-77' }] })], 'Devis freinage', '2026-06-01');
    await (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, operationMatch: false });
    const [op] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL ORDER BY id`;
    const facture = await document(compte, bienId, [cand({ targetHints: [cible(bienId)], temporalHints: { realizedDate: '2026-06-05' } })], 'Facture freinage', '2026-06-05');
    return { op, facture };
  };

  it('S7 — OPERATION-MATCH : question de T3 sur le candidat désigné, affichée sans recomposition ; refusée → question binaire d’avant', async () => {
    marqueurs.question = true;
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const { op, facture } = await devisPuisFacture(compte, clio.id);
    const q = 'Cette facture du même garage concerne-t-elle la réparation des freins prévue par « Devis freinage » ?';
    await rejouer([m3({ questionCandidateId: op.id, userQuestion: q })]);
    await (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI });
    const [c] = await cartes(facture, 'OPERATION-MATCH');
    expect(c).toMatchObject({ active: true, question: q, question_source: { origin: 'AI', operation: 't3_operation_match' } });
    const vue = (await page(compte)).actions.find((a) => a.publicId === c.public_id)!;
    expect(vue.question).toBe(q);
    expect(vue.choiceMode).toBe('BINARY');
    expect(vue.proposals.map((p) => p.label)).toEqual(['Oui', 'Non']);

    // Question refusée (« opération ») sur un autre document : formulation binaire d'avant, tracée.
    const compte2 = await make.account();
    const clio2 = await make.asset(compte2, { category: 'VEHICULE', name: 'Clio' });
    const x = await devisPuisFacture(compte2, clio2.id);
    await rejouer([m3({ questionCandidateId: x.op.id, userQuestion: 'Cette facture relève-t-elle de la même opération que « Devis freinage » ?' })]);
    await (await consolidator()).consolidateAccountOperations(compte2.id, { today: AUJOURDHUI });
    const [c2] = await cartes(x.facture, 'OPERATION-MATCH');
    expect(c2.question).toBe('Ce document concerne-t-il la même intervention que le document suivant ?');
    expect(c2.question_source).toMatchObject({ origin: 'CODE', rejection: 'FORBIDDEN_TERM' });
    expect((await page(compte2)).actions.find((a) => a.publicId === c2.public_id)!.question).toBe('Ce document concerne-t-il la même intervention que le document suivant ?');
  });

  it('S8 — AGENDA-PROJECTION-MATCH : abstention T4 avec question → même carte requalifiée ; question refusée → rien ne change', async () => {
    marqueurs.question = true;
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { syncAgendaProjectionCards, requalifyAgendaProjectionQuestions } = await import('@/services/to-process/agenda-projection-cards');
    const operationId = 990001;
    const besoin = {
      operationId, key: 'INTERVENTION', assetId: maison.id, fileIds: [],
      desired: { title: 'Entretien de la chaudière', date: '2026-03-12', typeCode: 'INTERVENTION' },
      candidates: [{ itemId: 501, title: 'Entretien chaudière', date: '2026-03-10', reason: 'type compatible' }],
    };
    await syncAgendaProjectionCards(compte.id, [besoin], []);
    const carte = async () => (await sql<Json[]>`SELECT id, question, question_source, cycle_number FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'AGENDA-PROJECTION-MATCH' AND resolved_at IS NULL`);
    const [avant] = await carte();
    expect(avant.question_source).toMatchObject({ origin: 'CODE', fallback: 'AI_NOT_CALLED' });
    const journal = async (q: string) => sql`
      INSERT INTO operation_semantic_reevaluations (account_id, scope, operation_id, trigger_kind, status, reason, decider_version, ai_output, before_state, ai_calls, ai_trace_id, decided_at)
      VALUES (${compte.id}, 'T4', ${operationId}, 'PROJECTION', 'ABSTAINED', 'contexte insuffisant', 'v-t4-9',
              ${JSON.stringify({ task: 'AGENDA_REPRESENTATION', outcome: 'ABSTAIN', occurrences: [], restorations: [], reason: 'r', userQuestion: q })}::jsonb,
              ${JSON.stringify({ items: [{ id: 501 }], restorable: [] })}::jsonb, 1, 'trace-t4', now())`;
    await journal('L’entretien noté en mars dans votre agenda, « Entretien chaudière », est-il celui de la facture ?');
    expect(await requalifyAgendaProjectionQuestions(compte.id, operationId)).toBe(1);
    const [apres] = await carte();
    expect(apres).toMatchObject({ id: avant.id, cycle_number: avant.cycle_number, question: 'L’entretien noté en mars dans votre agenda, « Entretien chaudière », est-il celui de la facture ?', question_source: { origin: 'AI', treatment: 'T4', promptVersion: 'v-t4-9', traceId: 'trace-t4' } });
    expect(await evenements(avant.id)).toHaveLength(1);
    // Rejoué : aucune écriture. Nouvelle projection : la question de T4 est conservée (même source).
    expect(await requalifyAgendaProjectionQuestions(compte.id, operationId)).toBe(0);
    await syncAgendaProjectionCards(compte.id, [besoin], [operationId]);
    expect((await carte())[0]).toMatchObject({ id: avant.id, question_source: { origin: 'AI' } });
    // Question refusée (référence opaque « A1 » hors libellés) : la carte ouverte ne change pas.
    await journal('L’élément « A1 » est-il le même que l’entretien de la facture ?');
    expect(await requalifyAgendaProjectionQuestions(compte.id, operationId)).toBe(0);
    expect((await carte())[0].question).toBe(apres.question);
  });
});
