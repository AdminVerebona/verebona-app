/**
 * Lot 49B sur base réelle — deux tickets T3 :
 *
 *   · « T3 — Réexaminer systématiquement les À traiter ouverts à chaque
 *     exécution » : tests obligatoires 1 à 9 (`T3OA-01` à `T3OA-09`), plus
 *     pagination (§14) et plafond de coût des réarbitrages ;
 *   · « T3 : exploiter la couche exhaustive T1 (document_source_units) dans
 *     la réconciliation » : critères AC1 à AC8 (`T3SU-AC1` à `T3SU-AC8`).
 *
 * Chaîne de production : `analyzeFileSources` (sortie T1 rejouée) → couche A
 * persistée → file T3 vidée par l'exécutant de production ; phase « open
 * actions » (`reconcileOpenToProcessActions`) et réconciliation du compte
 * (`reconcileAccount`) ; balayage `sweepDocumentsWithoutPrimary`. Les appels
 * modèle sont COMPTÉS par opération sur la passerelle rejouée.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
/** Lectures du fichier original : jamais par T3 (AC1, « ne pas relire le fichier »). */
const lectures = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => { lectures.n++; return null; },
}));

type Compte = { id: number; ownerUserId: number };
type Eval = Record<string, unknown> & { result: string; aiCalled: boolean };
type Entree = Record<string, unknown> & { actionId: number; actionEffect: string };

scenario('L49B', 'T3 : À traiter ouverts réexaminés à chaque passage ; couche exhaustive T1 exploitée', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABSTENTION: RecordedOutput = {
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true,
  };
  /** Réparation ciblée T1 sans résultat (unités ciblées : leur texte reste conservé, non structuré). */
  const REPARATION_VIDE: RecordedOutput = {
    operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', promptIncludes: '[page:1:', repeat: true,
    output: { task: 'ANALYZE_DOCUMENT', document: {}, entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false }, tables: [], facts: [], hasExploitableContent: true },
  };

  const analyser = async (compte: Compte, fileId: number, output: Record<string, unknown>, extra: RecordedOutput[] = []) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    // Enregistrements CIBLÉS (réparation : `promptIncludes`) avant la sortie principale.
    const replay = await rejouer([
      ...extra.filter((r) => r.promptIncludes), { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output }, ...extra.filter((r) => !r.promptIncludes),
    ]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l49b' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  const sortie = (p: {
    title?: string; texte?: string[]; facts?: FaitT1[]; tables?: unknown[]; extraFacts?: unknown[];
    assets?: Array<{ id: number; label: string; confidence?: 'certain' | 'probable'; score?: number }>;
  }) => {
    const out = sortieT1({
      title: p.title ?? 'Facture d’intervention', date: '2026-09-14', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS',
      assets: (p.assets ?? []).map((a) => ({ id: a.id, label: a.label })), facts: p.facts ?? [], texte: p.texte, multiAsset: false,
    });
    const ents = (out.entities as { assets: Array<Record<string, unknown>> }).assets;
    (p.assets ?? []).forEach((a, i) => { ents[i].confidence = a.confidence ?? 'certain'; ents[i].score = a.score ?? 0.97; });
    if (p.tables) out.tables = p.tables;
    if (p.extraFacts) out.facts = [...(out.facts as unknown[]), ...p.extraFacts];
    return out;
  };
  const fait = (canonicalKey: string, value: string, excerpt = `${canonicalKey} : ${value}`): FaitT1 => ({
    canonicalKey, value, valueType: 'string', excerpt, assetId: null,
  });
  const tableau = (lignes: Array<[string, string]>, over: Record<string, unknown> = {}) => ({
    title: 'Détail de l’intervention', pageStart: 1, columns: [{ header: 'Rubrique' }, { header: 'Valeur' }],
    rows: lignes.map(([a, b]) => ({ cells: [{ column: 0, value: a }, { column: 1, value: b }] })), ...over,
  });

  const colonne = async (fileId: number) => (await sql<{ asset_id: number | null }[]>`SELECT asset_id FROM asset_files WHERE id = ${fileId}`)[0].asset_id;
  const resolution = async (fileId: number) => (await sql<{
    status: string; method: string | null; reason_code: string | null; runs: number; context_fingerprint: string | null;
    knowledge_revision: string | null; e: Eval | null;
  }[]>`
    SELECT status, method, reason_code, runs, context_fingerprint, knowledge_revision, last_evaluation AS e
      FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0];
  const cartes = async (fileId: number) => (await sql<{ id: number; active: boolean; kind: string; reason: string | null; proposals: unknown }[]>`
    SELECT id, resolved_at IS NULL AS active, action_kind AS kind, resolution_reason AS reason, proposals_json AS proposals
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET' ORDER BY id`)
    .map((a) => ({ ...a, proposals: ((typeof a.proposals === 'string' ? JSON.parse(a.proposals) : a.proposals) ?? []) as Array<{ value: unknown }> }));
  const ouvertes = async (fileId: number) => (await cartes(fileId)).filter((c) => c.active);
  const appels = (replay: { calls: Array<{ operationCode?: string }> }, op: string) => replay.calls.filter((c) => c.operationCode === op).length;
  const balayer = async (compte: Compte) => {
    const { sweepDocumentsWithoutPrimary } = await import('@/services/ai/reconciliation/document-asset/queue');
    return sweepDocumentsWithoutPrimary({ accountId: compte.id, triggerCode: 'schedule_hourly' });
  };
  /** Phase « open actions » d'un passage T3 planifié. */
  const passage = async (compte: Compte) => {
    const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    return reconcileOpenToProcessActions(compte.id, { triggerCode: 'schedule_hourly' });
  };
  const entree = (r: { entries: unknown[] }, actionId: number) => (r.entries as unknown as Entree[]).find((e) => e.actionId === actionId);
  /**
   * Contexte FIGÉ : la résolution porte l'empreinte du contexte ACTUEL et la
   * révision courante — exactement l'état « rien n'a changé depuis le passage
   * précédent » (l'ancien moteur confirmait sans réessayer).
   */
  const figer = async (compte: Compte, fileId: number) => {
    const [{ readAttachmentState }, { computeDocumentAssetContext }, { getResolution }, { getAccountKnowledgeRevision }, { MatchingIndexCache }] = await Promise.all([
      import('@/services/ai/reconciliation/document-asset/attachment-state'),
      import('@/services/ai/reconciliation/document-asset/context'),
      import('@/services/ai/reconciliation/document-asset/resolution.repository'),
      import('@/services/ai/reconciliation/continuous/knowledge-revision'),
      import('@/services/ai/reconciliation/document-asset/matching-index'),
    ]);
    const state = await readAttachmentState(compte.id, fileId);
    const ctx = await computeDocumentAssetContext({
      accountId: compte.id, fileId, state, resolution: await getResolution(fileId), index: await new MatchingIndexCache().get(compte.id),
    });
    await sql`UPDATE document_asset_resolutions SET context_fingerprint = ${ctx.fingerprint},
                knowledge_revision = ${await getAccountKnowledgeRevision(compte.id)} WHERE file_id = ${fileId}`;
    return ctx.fingerprint;
  };
  const ADRESSE = { address1: '12 rue Victor Hugo', postalCode: '69003', city: 'Lyon' };
  const maison = (compte: Compte, name: string, kc?: Record<string, unknown>) => make.asset(compte, { category: 'IMMOBILIER', name, keyCharacteristics: kc });
  const sousType = (assetId: number, subtype: string) => sql`UPDATE assets SET subtype = ${subtype} WHERE id = ${assetId}`;

  it('migration 0328 : idempotente (deux passes), journal de connaissance alimenté par la couche exhaustive T1', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      const texte = await readFile(join(process.cwd(), 'src/db/migrations', '0328_t3_source_units_knowledge.sql'), 'utf-8');
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    const { getAccountKnowledgeRevision } = await import('@/services/ai/reconciliation/continuous/knowledge-revision');
    const avant = await getAccountKnowledgeRevision(compte.id);
    await sql`INSERT INTO document_source_units (account_id, file_id, source_unit_id, kind, ordinal, coverage_status, content_text)
              VALUES (${compte.id}, ${doc.id}, 'page:1:block:1', 'TEXT_BLOCK', 0, 'UNRESOLVED', 'Texte')`;
    expect(await getAccountKnowledgeRevision(compte.id)).toBeGreaterThan(avant);
  });

  // ══ Ticket « À traiter ouverts réexaminés à chaque passage » ═════════════

  it('T3OA-01 / T3OA-04 — NO_CANDIDATE, données strictement identiques : Candidate Builder et déterministe réexécutés à CHAQUE passage, jamais CONFIRMED_NO_CHANGE ; empreinte identique mais réévaluation effectuée', async () => {
    const compte = await make.account();
    await maison(compte, 'Appartement de Lyon');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture fibre internet' }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    const [carte] = await ouvertes(doc.id);
    const empreinte = await figer(compte, doc.id);
    const avant = await resolution(doc.id);
    // Lot 57B (ticket P0, défaut B) : aucun candidat STRUCTURÉ → recherche sémantique IA à chaque
    // passage (tentative réelle) ; le modèle s'abstient → toujours NO_CANDIDATE.
    const replay = await rejouer([T3_ABSTENTION]);

    for (const n of [1, 2]) {
      const r = await passage(compte);
      expect(entree(r, carte.id), `passage ${n}`).toMatchObject({
        ruleCode: 'LINK-ASSET', targetType: 'DOCUMENT', targetId: doc.id, resolver: 'T3_DOCUMENT_ASSET',
        previousResolution: 'NO_CANDIDATE', newResolution: 'NO_CANDIDATE', candidateCount: 0,
        deterministicAttempted: true, aiCalled: true, actionEffect: 'STILL_OPEN', fingerprint: empreinte, fingerprintChanged: false,
      });
      const apres = await resolution(doc.id);
      expect(apres.e).toMatchObject({ result: 'NO_CANDIDATE', reevaluated: true, fingerprintChanged: false, openActionId: carte.id, reprocessReason: 'OPEN_ACTION' });
      expect(apres.e!.result).not.toBe('CONFIRMED_NO_CHANGE');
      // Nouvelle tentative RÉELLE (décision réécrite) : le compteur d'évaluations avance.
      expect(apres.runs).toBe(avant.runs + n);
    }
    expect(appels(replay, 't3_link_ambiguity')).toBe(2);
    expect(await ouvertes(doc.id)).toHaveLength(1);
  });

  it('T3OA-02 / T3OA-06 — ABSTAINED, données identiques : nouvel arbitrage T3 (IA rappelée), toujours ambigu → carte maintenue, sans doublon, propositions actualisées', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({
      assets: [{ id: a.id, label: 'Maison A', confidence: 'probable', score: 0.6 }, { id: b.id, label: 'Maison B', confidence: 'probable', score: 0.6 }],
    }), [T3_ABSTENTION]);
    expect(await resolution(doc.id)).toMatchObject({ status: 'ABSTAINED' });
    const [carte] = await ouvertes(doc.id);
    await figer(compte, doc.id);
    const replay = await rejouer([T3_ABSTENTION]);
    const r = await passage(compte);
    expect(entree(r, carte.id)).toMatchObject({
      previousResolution: 'ABSTAINED', newResolution: 'ABSTAINED', aiCalled: true, deterministicAttempted: true, candidateCount: 2,
      actionEffect: 'STILL_OPEN', fingerprintChanged: false,
    });
    expect(appels(replay, 't3_link_ambiguity')).toBe(1);
    expect((await resolution(doc.id)).e).toMatchObject({ result: 'ABSTAINED', aiCalled: true, reevaluated: true });
    const act = await ouvertes(doc.id);
    expect(act).toHaveLength(1);
    expect(act[0].id).toBe(carte.id);
    expect(act[0].proposals.map((p) => p.value).sort()).toEqual([a.id, b.id].sort());
  });

  it('T3OA-03 — document évident (« Facture travaux Maison de Valence »), carte ouverte, AUCUNE modification préalable : relu depuis les données persistées → résolu → carte fermée', async () => {
    const compte = await make.account();
    const m1 = await maison(compte, 'Maison 1');
    await maison(compte, 'Studio');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture travaux Maison de Valence' }));
    const [carte] = await ouvertes(doc.id);
    // Le bien porte déjà ce nom ; la décision ouverte a été évaluée sur ce contexte même.
    await sql`UPDATE assets SET name = 'Maison de Valence' WHERE id = ${m1.id}`;
    await figer(compte, doc.id);
    // Le balayage seul ne le reprend pas (rien n'a changé) : voie canonique = « open actions ».
    expect(await balayer(compte)).toBe(0);
    const replay = await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, carte.id)).toMatchObject({ newResolution: 'RESOLVED', aiCalled: false, actionEffect: 'CLOSED', fingerprintChanged: false });
    expect(await colonne(doc.id)).toBe(m1.id);
    expect(await ouvertes(doc.id)).toEqual([]);
    expect(appels(replay, 't1_analyze_document') + appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(r.byEffect.CLOSED).toBeGreaterThanOrEqual(1);
  });

  it('T3OA-05 — déterministe : immatriculation exacte → résolution déterministe, IA = false, carte fermée', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture garage', facts: [fait('registrationNumber', 'AB-123-CD', 'Immatriculation AB-123-CD')] }));
    const [carte] = await ouvertes(doc.id);
    await sql`UPDATE assets SET registration_number = 'AB-123-CD' WHERE id = ${polo.id}`;
    await figer(compte, doc.id);
    const replay = await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, carte.id)).toMatchObject({ newResolution: 'RESOLVED', aiCalled: false, deterministicAttempted: true, actionEffect: 'CLOSED' });
    expect((await resolution(doc.id)).e).toMatchObject({ result: 'RESOLVED_DETERMINISTICALLY', aiCalled: false });
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await colonne(doc.id)).toBe(polo.id);
  });

  it('T3OA-07 — toutes les actions ouvertes examinées, chacune dans le rapport du cycle ; règles T4 en SKIPPED_NOT_T3 ; cible supprimée → SUPERSEDED ; aucune ligne ignorée', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const parti = await make.asset(compte, { category: 'VEHICULE', name: 'Ancienne' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Ticket de caisse' }));
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${v.id}, 'Autoradio') RETURNING id`;
    const agenda = await make.agendaItem(compte, { title: 'Révision', assetIds: [v.id] });
    const ligne = async (rule: string, targetType: string, targetId: number, key: { field?: string; relation?: string }) => (await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, relation_key, action_kind, rule_code, question)
      VALUES (${compte.id}, ${targetType}, ${targetId}, ${key.field ?? null}, ${key.relation ?? null}, 'ARBITRATE', ${rule}, 'Question e2e') RETURNING id`)[0].id;
    const ids = {
      agenda: await ligne('AGENDA-DUPLICATE', 'AGENDA_ITEM', agenda.id, { relation: 'duplicate' }),
      statut: await ligne('ASSET-STATUS', 'ASSET', v.id, { field: 'status' }),
      donnee: await ligne('DATA-REGISTRATION', 'ASSET', v.id, { field: 'registrationNumber' }),
      entite: await ligne('ENTITY-FIELD', 'EQUIPMENT', eq, { field: 'brand' }),
      disparu: await ligne('DATA-ACQUISITION-PRICE', 'ASSET', parti.id, { field: 'purchasePrice' }),
    };
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${parti.id}`;
    const [carte] = await ouvertes(doc.id);
    const [{ n: total }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL`;
    const r = await passage(compte);
    expect(r.examined).toBe(total);
    for (const id of [...Object.values(ids), carte.id]) expect(entree(r, id), `action ${id}`).toBeDefined();
    expect(entree(r, ids.agenda)).toMatchObject({ ruleCode: 'AGENDA-DUPLICATE', actionEffect: 'SKIPPED_NOT_T3', aiCalled: false });
    expect(entree(r, ids.statut)).toMatchObject({ ruleCode: 'ASSET-STATUS', actionEffect: 'SKIPPED_NOT_T3' });
    expect(entree(r, ids.donnee)).toMatchObject({ resolver: 'T3_ASSET', actionEffect: 'STILL_OPEN' });
    expect(entree(r, ids.entite)).toMatchObject({ resolver: 'T3_ENTITY', deterministicAttempted: true });
    expect(entree(r, ids.disparu)).toMatchObject({ actionEffect: 'SUPERSEDED', newResolution: 'TARGET_DELETED' });
    expect(entree(r, carte.id)).toMatchObject({ resolver: 'T3_DOCUMENT_ASSET', deterministicAttempted: true });
    expect(Object.values(r.byEffect).reduce((s, n) => s + n, 0)).toBe(r.examined);
    // T4 jamais détourné vers le modèle T3 (lot 57B : seule la carte LINK-ASSET sans candidat
    // structuré donne lieu à la recherche sémantique).
    expect((r.entries as unknown as Entree[]).filter((e) => e.aiCalled).map((e) => e.ruleCode)).toEqual(['LINK-ASSET']);
    expect(r.aiCalls).toBe(1);
  });

  it('T3OA-08 — décision utilisateur : carte résolue manuellement avant le cycle → aucune nouvelle tentative, aucune modification', async () => {
    const compte = await make.account();
    await maison(compte, 'Appartement de Lyon');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture fibre internet' }));
    const [carte] = await ouvertes(doc.id);
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'USER_DISMISSED' WHERE id = ${carte.id}`;
    const avant = await resolution(doc.id);
    const r = await passage(compte);
    expect(entree(r, carte.id)).toBeUndefined();
    const apres = await resolution(doc.id);
    expect(apres.runs).toBe(avant.runs);
    expect(apres.e).toEqual(avant.e);
    expect(await ouvertes(doc.id)).toEqual([]);
  });

  it('T3OA-09 — pas de double exécution : carte ouverte ET document repris par le balayage dans le même cycle → un seul travail DOCUMENT_ASSET actif ; la phase s’efface', async () => {
    const compte = await make.account();
    await maison(compte, 'Studio');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Taxe foncière Maison de Valence' }));
    const [carte] = await ouvertes(doc.id);
    await maison(compte, 'Maison de Valence');
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const run = await reconcileAccount(compte.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
    const travaux = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ${String(doc.id)}
         AND status IN ('PENDING', 'RUNNING')`;
    expect(travaux[0].n).toBe(1);
    expect(run.openActions && entree(run.openActions, carte.id)).toMatchObject({ actionEffect: 'STILL_OPEN', note: 'job_pending', aiCalled: false });
    await drainQueues();
    expect(await ouvertes(doc.id)).toEqual([]);
  });

  it('pagination (§14) : plus de 200 lignes ouvertes → plusieurs pages, chacune examinée une fois (jamais les mêmes 200)', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const agenda = await make.agendaItem(compte, { title: 'Révision', assetIds: [v.id] });
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
              SELECT ${compte.id}, 'AGENDA_ITEM', ${agenda.id}, 'proposal-' || g, 'ARBITRATE', 'AGENDA-PROPOSAL', 'Question e2e' FROM generate_series(1, 230) g`;
    const r = await passage(compte);
    expect(r.examined).toBe(230);
    expect(r.pages).toBe(2);
    expect(new Set((r.entries as unknown as Entree[]).map((e) => e.actionId)).size).toBe(230);
  });

  it('plafond de coût (lot 42) — RÉVISÉ lot 54A (écart 1) : l’ancienne variable de plafond est ignorée, le réarbitrage a lieu (jamais AI_DEFERRED)', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({
      assets: [{ id: a.id, label: 'Maison A', confidence: 'probable', score: 0.6 }, { id: b.id, label: 'Maison B', confidence: 'probable', score: 0.6 }],
    }), [T3_ABSTENTION]);
    const [carte] = await ouvertes(doc.id);
    await figer(compte, doc.id);
    process.env.T3_OPEN_ACTION_AI_MAX_PER_PASS = '0';
    process.env.T3_OPEN_ACTION_AI_MAX_PER_DAY = '0';
    try {
      const replay = await rejouer([T3_ABSTENTION]);
      const r = await passage(compte);
      expect(entree(r, carte.id)).toMatchObject({ actionEffect: 'STILL_OPEN', aiCalled: true, evaluationMode: 'AI_REEVALUATION', resolutionAttempted: true });
      expect(r.aiDeferred).toBe(0);
      expect(appels(replay, 't3_link_ambiguity')).toBe(1);
      expect((await resolution(doc.id)).e).toMatchObject({ result: 'ABSTAINED', reevaluated: true, aiCalled: true });
      expect(await ouvertes(doc.id)).toHaveLength(1);
    } finally {
      delete process.env.T3_OPEN_ACTION_AI_MAX_PER_PASS;
      delete process.env.T3_OPEN_ACTION_AI_MAX_PER_DAY;
    }
  });

  // ══ Ticket « couche exhaustive T1 (document_source_units) » ═══════════════

  it('T3SU-AC1 — information non structurée (tableau, hors transcription) à J, bien créé à J+30 : SOURCE_UNITS utilisé, rattachement automatique, sans T1 ni lecture du fichier', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture d’intervention', tables: [tableau([['Lieu d’intervention', '12 rue Victor Hugo 69003 Lyon']])] }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    const [unite] = await sql<{ id: string; status: string }[]>`
      SELECT source_unit_id AS id, coverage_status AS status FROM document_source_units WHERE file_id = ${doc.id} AND kind = 'TABLE_ROW'`;
    expect(unite).toBeDefined();
    lectures.n = 0;
    const m = await maison(compte, 'Maison Victor Hugo', ADRESSE);
    const replay = await rejouer([]);
    const { reconcileOpenKnowledge } = await import('@/services/ai/reconciliation/continuous/open-knowledge.service');
    const ok = await reconcileOpenKnowledge(compte.id, { triggerCode: 'asset_created' });
    expect(ok.targeted).toMatchObject({ documents: 1 });
    await drainQueues();
    expect(await colonne(doc.id)).toBe(m.id);
    const r = await resolution(doc.id);
    expect(r).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC' });
    expect(r.e).toMatchObject({ result: 'RESOLVED_DETERMINISTICALLY', aiCalled: false, matchedSourceUnitIds: [unite.id] });
    expect(r.e!.documentSources).toEqual(expect.arrayContaining(['EXTRACTION', 'SOURCE_UNITS']));
    expect(appels(replay, 't1_analyze_document') + appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(lectures.n).toBe(0);
  });

  it('T3SU-AC2 — équipement créé plus tard avec le n° de série lu dans une unité source : T3 retrouve la correspondance', async () => {
    const compte = await make.account();
    await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Entretien annuel', tables: [tableau([['N° de série', 'SN-778899']])] }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${b.id}, 'Chaudière') RETURNING id`;
    await sql`INSERT INTO equipment_cil_specs (equipment_id, serial_number) VALUES (${eq}, 'SN-778899')`;
    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(await colonne(doc.id)).toBe(b.id);
    expect((await resolution(doc.id)).e).toMatchObject({ aiCalled: false, documentSources: expect.arrayContaining(['SOURCE_UNITS']) });
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
  });

  it('T3SU-AC3 — fait rejeté à J (document_unresolved_facts) devenu interprétable : source T3, aucune perte de l’information initiale', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    const invalide = {
      canonicalKey: null, rawKey: 'Immatriculation', label: null, subject: null, attribute: null, rawValue: 'EF-456-GH', normalizedValue: 'EF-456-GH',
      valueType: 'string', target: { type: 'BATIMENT', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Immatriculation : EF-456-GH', page: 1 },
    };
    await analyser(compte, doc.id, sortie({ title: 'Procès-verbal de contrôle', extraFacts: [invalide] }));
    const [rec] = await sql<{ status: string; raw_value: string }[]>`
      SELECT status, raw_value FROM document_unresolved_facts WHERE file_id = ${doc.id} AND reason = 'INVALID_SCHEMA'`;
    expect(rec).toMatchObject({ status: 'UNRESOLVED', raw_value: 'EF-456-GH' });
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Clio', registrationNumber: 'EF-456-GH' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const choix: RecordedOutput = {
      operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', repeat: true,
      output: { task: 'LINK_AMBIGUITY', matches: [{ candidateId: v.id, score: 0.95, confidence: 'certain', reason: 'immatriculation lue' }] },
    };
    await rejouer([choix]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    const r = await resolution(doc.id);
    // Charge brute mal formée : indice de contexte (jamais une preuve déterministe), le modèle tranche.
    expect(r.e!.documentSources).toEqual(expect.arrayContaining(['UNRESOLVED_FACTS']));
    expect((r.e!.candidateSources as Record<string, string[]>)[String(v.id)]).toContain('CONTEXTUAL_MATCH');
    expect(r.e).toMatchObject({ aiCalled: true });
    // Aucune perte : l'élément d'origine reste conservé tel quel.
    expect((await sql`SELECT 1 FROM document_unresolved_facts WHERE file_id = ${doc.id} AND raw_value = 'EF-456-GH'`)).toHaveLength(1);
  });

  it('T3SU-AC4 — unité UNCERTAIN correspondant partiellement à deux biens : jamais de rattachement forcé → modèle T3 puis « À traiter »', async () => {
    const compte = await make.account();
    const v = await maison(compte, 'Maison de Valence');
    const bg = await maison(compte, 'Maison de Bourg');
    await sousType(v.id, 'Maison'); await sousType(bg.id, 'Maison');
    const doc = await make.assetFile(compte, { assetId: null });
    const replay = await analyser(compte, doc.id, sortie({
      title: 'Devis de toiture',
      tables: [tableau([['Chantier', 'Maison de Valence ou Maison de Bourg']], { uncertain: true, uncertaintyNote: 'colonnes ambiguës' })],
    }), [REPARATION_VIDE, T3_ABSTENTION]);
    expect(await colonne(doc.id)).toBeNull();
    const r = await resolution(doc.id);
    expect(r.status).toBe('ABSTAINED');
    expect(r.e!.result).not.toBe('RESOLVED_DETERMINISTICALLY');
    expect(appels(replay, 't3_link_ambiguity')).toBe(1);
    const [carte] = await ouvertes(doc.id);
    expect(carte.kind).toBe('ARBITRATE');
  });

  it('T3SU-AC5 / T3SU-AC6 — modification sans rapport : aucun appel modèle ; deux balayages sans changement : même empreinte, aucune nouvelle résolution, aucun appel', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({
      tables: [tableau([['Référence', 'CHANTIER-2026-77']])],
      assets: [{ id: a.id, label: 'Maison A', confidence: 'probable', score: 0.6 }, { id: b.id, label: 'Maison B', confidence: 'probable', score: 0.6 }],
    }), [T3_ABSTENTION]);
    const avant = await resolution(doc.id);
    expect(avant.status).toBe('ABSTAINED');
    // AC5 : équipement sans rapport créé.
    await sql`INSERT INTO equipments (asset_id, name) VALUES (${a.id}, 'Portail motorisé')`;
    const replay = await rejouer([T3_ABSTENTION]);
    const { reconcileOpenKnowledge } = await import('@/services/ai/reconciliation/continuous/open-knowledge.service');
    const ok = await reconcileOpenKnowledge(compte.id, { triggerCode: 'equipment_created' });
    expect(ok.targeted).toMatchObject({ documents: 0 });
    await drainQueues();
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    // AC6 : deux balayages successifs, aucune nouvelle résolution.
    expect(await balayer(compte)).toBe(0);
    expect(await balayer(compte)).toBe(0);
    await drainQueues();
    const apres = await resolution(doc.id);
    expect(apres.context_fingerprint).toBe(avant.context_fingerprint);
    expect(apres.runs).toBe(avant.runs);
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
  });

  it('T3SU-AC7 — rattachement choisi par l’utilisateur : jamais écrasé, même si une unité source désigne un autre bien', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Contrat d’entretien', tables: [tableau([['Lieu', '12 rue Victor Hugo 69003 Lyon']])] }));
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: polo.id }, role: 'PRIMARY', origin: 'USER' });
    await maison(compte, 'Maison Victor Hugo', ADRESSE);
    expect(await balayer(compte)).toBe(0);
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    expect(await resolveDocumentAsset({ accountId: compte.id, fileId: doc.id })).toMatchObject({ outcome: 'SUPERSEDED', status: 'USER_DECIDED', aiCalled: false });
    const liens = await sql<{ asset_id: number; origin: string }[]>`
      SELECT asset_id, origin FROM document_asset_links WHERE file_id = ${doc.id} AND status = 'ACTIVE' AND link_role = 'PRIMARY'`;
    expect(liens).toEqual([{ asset_id: polo.id, origin: 'USER' }]);
  });

  it('T3SU-AC8 — information au-delà du 200 000e caractère, persistée dans document_source_units : utilisée par T3', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const doc = await make.assetFile(compte, { assetId: null });
    const remplissage = Array.from({ length: 2_800 }, (_, i) => `Article ${i} du règlement de copropriété, disposition générale sans objet particulier.`);
    expect(remplissage.join('\n').length).toBeGreaterThan(200_000);
    await analyser(compte, doc.id, sortie({ title: 'Règlement de copropriété', texte: [...remplissage, 'Adresse de l’immeuble : 12 rue Victor Hugo 69003 Lyon'] }), [REPARATION_VIDE]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT length(full_text)::int AS n FROM document_extractions WHERE file_id = ${doc.id}`;
    expect(n).toBeGreaterThan(200_000);
    const m = await maison(compte, 'Maison Victor Hugo', ADRESSE);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(await colonne(doc.id)).toBe(m.id);
    expect((await resolution(doc.id)).e).toMatchObject({ result: 'RESOLVED_DETERMINISTICALLY', documentSources: expect.arrayContaining(['SOURCE_UNITS']) });
  });
});
