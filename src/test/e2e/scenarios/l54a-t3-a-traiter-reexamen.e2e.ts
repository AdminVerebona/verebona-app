/**
 * Lot 54A — ticket « [P1] T3 — Achever le réexamen systématique de tous les
 * À traiter ouverts » : écarts 1 à 6 (`T3-OPEN-E01` à `T3-OPEN-E06`) et tests
 * obligatoires TC1 à TC12, sur PostgreSQL réel.
 *
 * Chaîne de production : `analyzeFileSources` (sortie T1 rejouée) → couche
 * persistée → file T3 vidée ; phase « open actions »
 * (`reconcileOpenToProcessActions`) et passage global (`reconcileAccount`).
 * Appels modèle COMPTÉS par opération sur la passerelle rejouée.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Entree = Record<string, unknown> & { actionId: number; actionEffect: string };

scenario('L54A-OPEN', 'T3 : réexamen RÉEL de tous les À traiter ouverts (écarts 1 à 6, TC1 à TC12)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABSTENTION: RecordedOutput = {
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true,
  };
  const analyser = async (compte: Compte, fileId: number, output: Record<string, unknown>, extra: RecordedOutput[] = []) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output }, ...extra]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l54a' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const ambigu = (a: { id: number }, b: { id: number }) => {
    const out = sortieT1({
      title: 'Facture d’intervention', date: '2026-09-14', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS',
      assets: [{ id: a.id, label: 'Maison A' }, { id: b.id, label: 'Maison B' }], facts: [], multiAsset: false,
    });
    for (const e of (out.entities as { assets: Array<Record<string, unknown>> }).assets) { e.confidence = 'probable'; e.score = 0.6; }
    return out;
  };
  const passage = async (compte: Compte, deps?: Record<string, unknown>) => {
    const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    if (!deps) return reconcileOpenToProcessActions(compte.id, { triggerCode: 'schedule_hourly' });
    const r = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    const e = await import('@/services/ai/reconciliation/entity-reconciliation');
    const c = await import('@/services/to-process/document-asset-conflict');
    const l = await import('@/services/ai/reconciliation/continuous/document-element-link');
    return reconcileOpenToProcessActions(compte.id, {
      triggerCode: 'schedule_hourly',
      deps: {
        resolveDocumentAsset: r.resolveDocumentAsset,
        reconcileEntity: async (p: { accountId: number; target: { type: 'EQUIPMENT' | 'ROOM'; id: number } }) => e.reconcileEntity({ accountId: p.accountId, target: p.target, triggeredBy: 'manual' }),
        closeObsoleteAssetConflicts: c.closeObsoleteAssetConflicts,
        resolveElementLink: l.resolveDocumentElementLink,
        ...deps,
      } as never,
    });
  };
  const entree = (r: { entries: unknown[] }, actionId: number) => (r.entries as unknown as Entree[]).find((e) => e.actionId === actionId);
  const appels = (replay: { calls: Array<{ operationCode?: string }> }, op: string) => replay.calls.filter((c) => c.operationCode === op).length;
  const carteLinkAsset = async (fileId: number) => (await sql<{ id: number }[]>`
    SELECT id FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL`)[0];
  /** Contexte FIGÉ (rien n'a changé depuis le passage précédent). */
  const figer = async (compte: Compte, fileId: number) => {
    const [{ readAttachmentState }, { computeDocumentAssetContext }, { getResolution }, { getAccountKnowledgeRevision }, { MatchingIndexCache }] = await Promise.all([
      import('@/services/ai/reconciliation/document-asset/attachment-state'),
      import('@/services/ai/reconciliation/document-asset/context'),
      import('@/services/ai/reconciliation/document-asset/resolution.repository'),
      import('@/services/ai/reconciliation/continuous/knowledge-revision'),
      import('@/services/ai/reconciliation/document-asset/matching-index'),
    ]);
    const ctx = await computeDocumentAssetContext({
      accountId: compte.id, fileId, state: await readAttachmentState(compte.id, fileId), resolution: await getResolution(fileId),
      index: await new MatchingIndexCache().get(compte.id),
    });
    await sql`UPDATE document_asset_resolutions SET context_fingerprint = ${ctx.fingerprint},
                knowledge_revision = ${await getAccountKnowledgeRevision(compte.id)} WHERE file_id = ${fileId}`;
  };
  const maison = (compte: Compte, name: string) => make.asset(compte, { category: 'IMMOBILIER', name });
  const carte = async (compte: Compte, rule: string, targetType: string, targetId: number, over: { relation?: string; field?: string; ctx?: unknown } = {}) =>
    (await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, relation_key, action_kind, rule_code, question, trigger_context)
      VALUES (${compte.id}, ${targetType}, ${targetId}, ${over.field ?? null}, ${over.relation ?? null}, 'ARBITRATE', ${rule}, 'Question e2e',
              ${over.ctx ? JSON.stringify(over.ctx) : null}::jsonb) RETURNING id`)[0].id;
  const equipement = async (assetId: number, name: string, serial?: string) => {
    const [{ id }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`;
    if (serial) await sql`INSERT INTO equipment_cil_specs (equipment_id, serial_number) VALUES (${id}, ${serial})`;
    return id;
  };
  const journal = async (accountId: number) => sql<Array<Record<string, unknown>>>`
    SELECT * FROM t3_open_action_evaluations WHERE account_id = ${accountId} ORDER BY id`;

  // ══ Écart 1 — plus de quota T3 interne ═══════════════════════════════════

  it('T3-OPEN-E01 / TC1 — ABSTAINED LINK-ASSET, même contexte : Candidate Builder, déterministe ET IA rejoués à chaque passage (jamais AI_DEFERRED)', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, ambigu(a, b), [T3_ABSTENTION]);
    const { id: c } = await carteLinkAsset(doc.id);
    for (const n of [1, 2]) {
      await figer(compte, doc.id);
      const replay = await rejouer([T3_ABSTENTION]);
      const r = await passage(compte);
      expect(entree(r, c), `passage ${n}`).toMatchObject({
        previousResolution: 'ABSTAINED', candidateCount: 2, deterministicAttempted: true, aiCalled: true,
        examined: true, resolutionAttempted: true, evaluationMode: 'AI_REEVALUATION', actionEffect: 'STILL_OPEN',
      });
      expect(String(entree(r, c)!.note ?? '')).not.toMatch(/ai_deferred/);
      expect(appels(replay, 't3_link_ambiguity')).toBe(1);
      expect(r.aiDeferred).toBe(0);
    }
  });

  it('T3-OPEN-E01 / TC2 — 25 LINK-ASSET ambigus : examinés 25, réellement retentés 25, 25 arbitrages IA (pas d’arrêt à 10)', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const docs: number[] = [];
    for (let i = 0; i < 25; i++) {
      const d = await make.assetFile(compte, { assetId: null });
      await analyser(compte, d.id, ambigu(a, b), [T3_ABSTENTION]);
      docs.push(d.id);
    }
    for (const d of docs) await figer(compte, d);
    const replay = await rejouer([T3_ABSTENTION]);
    const r = await passage(compte);
    const liens = (r.entries as unknown as Entree[]).filter((e) => e.ruleCode === 'LINK-ASSET');
    expect(liens).toHaveLength(25);
    expect(liens.every((e) => e.resolutionAttempted === true && e.aiCalled === true)).toBe(true);
    expect(r.resolutionAttempted).toBeGreaterThanOrEqual(25);
    expect(appels(replay, 't3_link_ambiguity')).toBe(25);
  }, 240_000);

  // ══ Écart 2 — LINK-ELT reconstruit ses candidats ═════════════════════════

  it('T3-OPEN-E02 / TC3 — LINK-ELT : équipement identifiable créé à J+1 → candidats reconstruits, relation appliquée, carte fermée (sans toucher la carte)', async () => {
    const compte = await make.account();
    const bien = await maison(compte, 'Maison Lyon');
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET retained_title = 'Entretien annuel Vitodens 200' WHERE id = ${doc.id}`;
    const r1 = await equipement(bien.id, 'Radiateur salon');
    const r2 = await equipement(bien.id, 'Radiateur chambre');
    const c = await carte(compte, 'LINK-ELT', 'DOCUMENT', doc.id, { relation: 'elementId', ctx: { fileId: doc.id, candidates: [r1, r2] } });
    // J+1 : l'équipement identifiable apparaît.
    const vito = await equipement(bien.id, 'Vitodens 200');
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({
      resolver: 'T3_EQUIPMENT_LINK', actionEffect: 'CLOSED', newResolution: 'APPLIED', aiCalled: false,
      resolutionAttempted: true, evaluationMode: 'FULL_REEVALUATION', deterministicAttempted: true,
    });
    expect((await sql`SELECT equipment_id FROM asset_files WHERE id = ${doc.id}`)[0].equipment_id).toBe(vito);
    expect((await sql`SELECT resolved_at IS NOT NULL AS closed FROM to_process_actions WHERE id = ${c}`)[0].closed).toBe(true);
  });

  it('T3-OPEN-E02 / TC4 — LINK-ELT : anciennes propositions A/B fausses, C seul correct (n° de série lu dans une unité source) → C trouvé', async () => {
    const compte = await make.account();
    const bien = await maison(compte, 'Maison Nantes');
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture intervention' WHERE id = ${doc.id}`;
    const a = await equipement(bien.id, 'Chaudière garage');
    const b = await equipement(bien.id, 'Chaudière cuisine');
    const cId = await equipement(bien.id, 'Pompe à chaleur', 'PAC-778899');
    await sql`INSERT INTO document_source_units (account_id, file_id, source_unit_id, kind, ordinal, coverage_status, content_text)
              VALUES (${compte.id}, ${doc.id}, 'page:1:block:1', 'TEXT_BLOCK', 0, 'UNRESOLVED', 'Appareil : n° de série PAC 778899, contrôle annuel')`;
    const c = await carte(compte, 'LINK-ELT', 'DOCUMENT', doc.id, { relation: 'elementId', ctx: { fileId: doc.id, candidates: [a, b] } });
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ actionEffect: 'CLOSED', newResolution: 'APPLIED', resolutionAttempted: true });
    expect((await sql`SELECT equipment_id FROM asset_files WHERE id = ${doc.id}`)[0].equipment_id).toBe(cId);
  });

  it('T3-OPEN-E02 — LINK-ELT toujours ambigu : arbitrage T3 demandé, propositions reconstruites (nouveaux candidats), document déjà rattaché → carte sans objet', async () => {
    const compte = await make.account();
    const bien = await maison(compte, 'Maison Brest');
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture radiateur', description = 'Remplacement radiateur' WHERE id = ${doc.id}`;
    const ancien = await equipement(bien.id, 'Ballon');
    const c = await carte(compte, 'LINK-ELT', 'DOCUMENT', doc.id, { relation: 'elementId', ctx: { fileId: doc.id, candidates: [ancien] } });
    const n1 = await equipement(bien.id, 'Radiateur salon');
    const n2 = await equipement(bien.id, 'Radiateur chambre');
    let arbitrages = 0;
    const r = await passage(compte, { resolveElementLink: async (p: never) => {
      const l = await import('@/services/ai/reconciliation/continuous/document-element-link');
      return l.resolveDocumentElementLink({ ...(p as object), deps: { arbitrate: async () => { arbitrages++; return { equipmentId: null }; } } } as never);
    } });
    expect(arbitrages).toBe(1);
    expect(entree(r, c)).toMatchObject({ actionEffect: 'UPDATED', aiCalled: true, evaluationMode: 'AI_REEVALUATION', resolutionAttempted: true });
    const [{ ctx }] = await sql<{ ctx: { candidates: number[] } }[]>`SELECT trigger_context AS ctx FROM to_process_actions WHERE id = ${c}`;
    expect(ctx.candidates.sort()).toEqual([n1, n2].sort());
    // Rattachement posé entre-temps (utilisateur) : jamais réécrit, carte sans objet.
    await sql`UPDATE asset_files SET equipment_id = ${n1} WHERE id = ${doc.id}`;
    const r2 = await passage(compte);
    expect(entree(r2, c)).toMatchObject({ actionEffect: 'SUPERSEDED', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false });
    expect((await sql`SELECT equipment_id FROM asset_files WHERE id = ${doc.id}`)[0].equipment_id).toBe(n1);
  });

  // ══ Écart 3 — T3_OPERATIONS relance la consolidation ═════════════════════

  it('T3-OPEN-E03 / TC5 / TC6 — OPERATION-MATCH et OPERATION-AMOUNT : consolidation relancée UNE fois, cartes relues (CLOSED / UPDATED)', async () => {
    const compte = await make.account();
    const bien = await maison(compte, 'Maison Ops');
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const match = await carte(compte, 'OPERATION-MATCH', 'DOCUMENT', doc.id, { relation: 'operationMatch:k1', ctx: { kind: 'operation_match', candidateKey: 'k1', operationIds: [] } });
    const montant = await carte(compte, 'OPERATION-AMOUNT', 'DOCUMENT', doc.id, { relation: 'operationAmount:77:abc', ctx: { kind: 'operation_amount', operationId: 77 } });
    const appelsConso: Array<{ fileIds: number[]; operationIds: number[] }> = [];
    const r = await passage(compte, {
      consolidateOperations: async (_a: number, p: { fileIds: number[]; operationIds: number[] }) => {
        appelsConso.push(p);
        // La consolidation repart des données actuelles : une carte se ferme, l'autre change.
        await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'OBSOLETE' WHERE id = ${match}`;
        await sql`UPDATE to_process_actions SET proposals_json = '[{"value":1,"label":"x"}]'::jsonb WHERE id = ${montant}`;
        return { changes: 2, aiCalls: 0 };
      },
    });
    expect(appelsConso).toEqual([{ fileIds: [doc.id], operationIds: [77] }]);
    expect(r.operationsConsolidations).toBe(1);
    expect(entree(r, match)).toMatchObject({ resolver: 'T3_OPERATIONS', actionEffect: 'CLOSED', resolutionAttempted: true, evaluationMode: 'DETERMINISTIC_REEVALUATION' });
    expect(entree(r, montant)).toMatchObject({ resolver: 'T3_OPERATIONS', actionEffect: 'UPDATED', resolutionAttempted: true });
    expect(entree(r, montant)!.note).not.toBe('operations_consolidation');
  });

  it('T3-OPEN-E03 — consolidation RÉELLE (code de production) relancée sans erreur ; travail Opérations vivant → aucune seconde consolidation', async () => {
    const compte = await make.account();
    const bien = await maison(compte, 'Maison Ops 2');
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const c = await carte(compte, 'OPERATION-MATCH', 'DOCUMENT', doc.id, { relation: 'operationMatch:k2', ctx: { kind: 'operation_match', candidateKey: 'k2', operationIds: [] } });
    const r = await passage(compte);
    expect(r.operationsConsolidations).toBe(1);
    expect(entree(r, c)).toMatchObject({ resolutionAttempted: true, evaluationMode: 'DETERMINISTIC_REEVALUATION' });
    expect(['CLOSED', 'UPDATED', 'STILL_OPEN']).toContain(entree(r, c)!.actionEffect);
    // TC12 (Opérations) : un passage Opérations du compte déjà vivant porte la carte.
    await sql`UPDATE to_process_actions SET resolved_at = NULL, resolution_reason = NULL WHERE id = ${c}`;
    await sql`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload)
              VALUES ('T3', ${compte.id}, 'business_operations', ${String(compte.id)}, ${`e2e-ops-${compte.id}`}, 'automatic', 'source_analyzed', '{}'::jsonb)`;
    let n = 0;
    const r2 = await passage(compte, { consolidateOperations: async () => { n++; return { changes: 0, aiCalls: 0 }; } });
    expect(n).toBe(0);
    expect(entree(r2, c)).toMatchObject({ actionEffect: 'STILL_OPEN', evaluationMode: 'SUPERSEDED', resolutionAttempted: false });
    expect(String(entree(r2, c)!.note)).toMatch(/^operations_job_pending:/);
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE account_id = ${compte.id} AND target_type = 'business_operations'`;
  });

  // ══ Écart 4 — examined ≠ resolutionAttempted ══════════════════════════════

  it('T3-OPEN-E04 / TC9 — règle T4 (AGENDA-DUPLICATE) : SKIPPED_NOT_T3, NOT_T3, aiCalled = false, resolutionAttempted = false', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const agenda = await make.agendaItem(compte, { title: 'Révision', assetIds: [v.id] });
    const c = await carte(compte, 'AGENDA-DUPLICATE', 'AGENDA_ITEM', agenda.id, { relation: 'duplicate' });
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({
      actionEffect: 'SKIPPED_NOT_T3', evaluationMode: 'NOT_T3', examined: true, resolutionAttempted: false, aiCalled: false,
    });
    expect(r.byEvaluationMode.NOT_T3).toBe(1);
    expect(r.resolutionAttempted).toBe(0);
  });

  // ══ Écart 5 — passage GLOBAL du compte ════════════════════════════════════

  it('T3-OPEN-E05 / TC7 / TC8 — passage global : bien DATA-* hors périmètre incrémental ajouté et réconcilié ; 2 cartes d’une même entité → 1 réconciliation', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    // Bien « non modifié » : passage récent réussi, hors périmètre incrémental.
    const donnee = await carte(compte, 'DATA-REGISTRATION', 'ASSET', v.id, { field: 'registrationNumber' });
    const eq = await equipement(v.id, 'Autoradio');
    const e1 = await carte(compte, 'ENTITY-FIELD', 'EQUIPMENT', eq, { field: 'brand' });
    const e2 = await carte(compte, 'ENTITY-FIELD', 'EQUIPMENT', eq, { field: 'model' });
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const run = await reconcileAccount(compte.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
    const oa = run.openActions!;
    expect(run.details.map((d) => d.objectId)).toContain(v.id);
    expect(entree(oa, donnee)).toMatchObject({ resolver: 'T3_ASSET', resolutionAttempted: true, evaluationMode: 'DETERMINISTIC_REEVALUATION' });
    expect(entree(oa, e1)).toMatchObject({ resolver: 'T3_ENTITY', resolutionAttempted: true });
    expect(entree(oa, e2)).toMatchObject({ resolver: 'T3_ENTITY', resolutionAttempted: true });
    // Journal rattaché au passage du compte.
    const j = await journal(compte.id);
    expect(j.filter((x) => Number(x.account_run_id) === run.runId).length).toBe(oa.examined);
    // Une seule réconciliation pour l'entité (dédoublonnage du passage).
    let reconciliations = 0;
    const ent = await import('@/services/ai/reconciliation/entity-reconciliation');
    await passage(compte, { reconcileEntity: async (p: { accountId: number; target: { type: 'EQUIPMENT' | 'ROOM'; id: number } }) => {
      reconciliations++; return ent.reconcileEntity({ accountId: p.accountId, target: p.target, triggeredBy: 'manual' });
    } });
    expect(reconciliations).toBe(1);
  });

  // ══ Écart 6 — journal durable ═════════════════════════════════════════════

  it('T3-OPEN-E06 / TC10 — 750 cartes : examined 750, résumé borné à 500, journal durable de 750 évaluations', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const agenda = await make.agendaItem(compte, { title: 'Révision', assetIds: [v.id] });
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
              SELECT ${compte.id}, 'AGENDA_ITEM', ${agenda.id}, 'proposal-' || g, 'ARBITRATE', 'AGENDA-PROPOSAL', 'Question e2e' FROM generate_series(1, 750) g`;
    const r = await passage(compte);
    expect(r.examined).toBe(750);
    expect(r.entries).toHaveLength(500);
    expect(r.omittedEntries).toBe(250);
    expect(r.journaled).toBe(750);
    const j = await journal(compte.id);
    expect(j).toHaveLength(750);
    expect(new Set(j.map((x) => Number(x.action_id))).size).toBe(750);
    expect(j[0]).toMatchObject({ rule_code: 'AGENDA-PROPOSAL', evaluation_mode: 'NOT_T3', resolution_attempted: false, action_effect: 'SKIPPED_NOT_T3' });
  }, 120_000);

  it('T3-OPEN-E06 / TC11 — décision utilisateur avant le passage : aucune évaluation, aucune écriture, rien au journal', async () => {
    const compte = await make.account();
    const bien = await maison(compte, 'Maison Tours');
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const eq = await equipement(bien.id, 'Vitodens 200');
    await sql`UPDATE asset_files SET retained_title = 'Entretien Vitodens 200' WHERE id = ${doc.id}`;
    const c = await carte(compte, 'LINK-ELT', 'DOCUMENT', doc.id, { relation: 'elementId', ctx: { fileId: doc.id, candidates: [eq] } });
    await sql`UPDATE to_process_actions SET resolved_at = now() - interval '1 hour', resolution_reason = 'NOT_APPLICABLE' WHERE id = ${c}`;
    const r = await passage(compte);
    expect(entree(r, c)).toBeUndefined();
    expect((await sql`SELECT equipment_id FROM asset_files WHERE id = ${doc.id}`)[0].equipment_id).toBeNull();
    expect((await journal(compte.id)).filter((x) => Number(x.action_id) === c)).toHaveLength(0);
  });

  it('T3-OPEN-E06 / TC12 — carte portée par un sous-job DOCUMENT_ASSET vivant : une seule résolution réelle (la phase s’efface, tracée SUPERSEDED)', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, ambigu(a, b), [T3_ABSTENTION]);
    const { id: c } = await carteLinkAsset(doc.id);
    await sql`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload)
              VALUES ('T3', ${compte.id}, 'document', ${String(doc.id)}, ${`e2e-doc-${doc.id}`}, 'automatic', 'source_analyzed', '{}'::jsonb)`;
    const replay = await rejouer([T3_ABSTENTION]);
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ note: 'job_pending', aiCalled: false, resolutionAttempted: false, evaluationMode: 'SUPERSEDED' });
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    const [ligne] = (await journal(compte.id)).filter((x) => Number(x.action_id) === c);
    expect(ligne).toMatchObject({ evaluation_mode: 'SUPERSEDED', resolution_attempted: false, note: 'job_pending' });
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE dedupe_key = ${`e2e-doc-${doc.id}`}`;
  });
});
