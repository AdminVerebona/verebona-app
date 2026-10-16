/**
 * Lot 57B — ticket P0 « T3 — Corriger les À traiter non résolus et fiabiliser
 * les logs » (compte 13, job 1751) : tests obligatoires TC01 à TC16
 * (`T3-P0-TC01`…), sur PostgreSQL réel.
 *
 * Le compte 13 de préproduction n'est pas accessible : ses cas sont REPRODUITS
 * (facture de fournisseur sans bien identifiable par règles structurées,
 * contrat de gardiennage, taxe foncière, entretiens, DATA-CONTRACT-END dont la
 * date est dans la connaissance T1, job documentaire bloqué, résolveur en
 * échec) sur une connaissance T1 PERSISTÉE (extraction, faits, unités
 * source) — l'état réel des documents d'un compte après T1. Aucune règle
 * propre à un fournisseur : le modèle T3 est SIMULÉ de façon générique
 * (`modele`) — il ne retient un bien que sur les signaux fournis par le
 * serveur, comme le prompt maître (D2, D3) le lui demande.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Entree = Record<string, unknown> & { actionId: number; actionEffect: string; reasonCode?: string };

/**
 * Modèle T3 simulé, GÉNÉRIQUE : candidat doté d'une preuve serveur
 * (historique fournisseur) → certain 0,92 ; candidat seulement indiqué
 * (équipement, vocabulaire) → probable 0,7 ; sinon rien.
 */
function modele(input: { prompt: string }): unknown {
  const matches: Array<Record<string, unknown>> = [];
  const ligne = /Candidats : (\[.*\])\s*$/m.exec(input.prompt)?.[1] ?? '[]';
  for (const c of JSON.parse(ligne) as Array<{ candidateId: number; description: string }>) {
    const d = c.description;
    if (/historique fournisseur/.test(d)) matches.push({ candidateId: c.candidateId, score: 0.92, confidence: 'certain', reason: 'historique fournisseur fourni par le serveur' });
    else if (/équipement du bien évoqué|vocabulaire commun/.test(d)) matches.push({ candidateId: c.candidateId, score: 0.7, confidence: 'probable', reason: 'indice de contexte' });
  }
  return { task: 'LINK_AMBIGUITY', matches, documentScope: 'SINGLE' };
}

scenario('L57B-T3', 'T3 : À traiter non résolus corrigés, journal et diagnostic par carte (TC01 à TC16)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  beforeAll(() => { setDefaultResponder('t3_link_ambiguity', 'LINK_AMBIGUITY', modele); });
  afterAll(() => { setDefaultResponder('t3_link_ambiguity', 'LINK_AMBIGUITY', null); });

  /** Connaissance T1 PERSISTÉE d'un document (jamais le fichier). */
  const connaissance = async (compte: Compte, fileId: number, p: {
    title: string; supplier?: string | null; type?: string; fullText?: string | null;
    facts?: Array<{ key?: string | null; raw?: string; label?: string; value: string; confidence?: string }>;
    units?: Array<{ kind: string; text?: string | null; label?: string | null; value?: string | null; coverage?: string }>;
  }) => {
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, supplier_name, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${fileId}, ${p.title}, ${p.supplier ?? null}, ${p.type ?? 'INVOICE'}, ${p.fullText ?? null}, ${p.fullText?.length ?? 0})
      RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${p.type ?? 'INVOICE'}, analysis_state = 'ANALYZED', original_filename = 'Maison de Lyon.pdf' WHERE id = ${fileId}`;
    for (const f of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${fileId}, ${id}, ${f.raw ?? f.key ?? 'fait'}, ${f.label ?? null}, ${f.value}, ${f.value}, ${f.confidence ?? 'certain'},
                        ${`${f.label ?? f.key ?? 'fait'} : ${f.value}`}, ${f.key ?? null})`;
    }
    let i = 0;
    for (const u of p.units ?? []) {
      i += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, label, value_text, coverage_status)
                VALUES (${compte.id}, ${fileId}, ${id}, ${`u${i}`}, ${u.kind}, ${i}, ${u.text ?? null}, ${u.label ?? null}, ${u.value ?? null}, ${u.coverage ?? 'COVERED'})`;
    }
    return id;
  };
  const carte = async (compte: Compte, rule: string, targetType: string, targetId: number, over: { kind?: string; field?: string | null; relation?: string | null } = {}) =>
    (await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, relation_key, action_kind, rule_code, question)
      VALUES (${compte.id}, ${targetType}, ${targetId}, ${over.field ?? null}, ${over.relation ?? null}, ${over.kind ?? 'COMPLETE'}, ${rule}, 'Question e2e')
      RETURNING id`)[0].id;
  const lienAsset = (compte: Compte, fileId: number) => carte(compte, 'LINK-ASSET', 'DOCUMENT', fileId, { relation: 'assetIds' });
  const finContrat = (compte: Compte, fileId: number) => carte(compte, 'DATA-CONTRACT-END', 'DOCUMENT', fileId, { field: 'contractEndDate' });
  /** Document déjà rattaché d'un fournisseur (historique). */
  const historique = async (compte: Compte, assetId: number, supplier: string) => {
    const f = await make.assetFile(compte, { assetId });
    await sql`INSERT INTO document_extractions (account_id, file_id, title, supplier_name) VALUES (${compte.id}, ${f.id}, ${`Facture ${supplier}`}, ${supplier})`;
  };
  const passage = async (compte: Compte, extra: Record<string, unknown> = {}) => {
    const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    return reconcileOpenToProcessActions(compte.id, { triggerCode: 'schedule_hourly', ...extra });
  };
  const entree = (r: { entries: unknown[] }, actionId: number) => (r.entries as unknown as Entree[]).find((e) => e.actionId === actionId);
  const ouverte = async (actionId: number) => (await sql<{ o: boolean }[]>`SELECT resolved_at IS NULL AS o FROM to_process_actions WHERE id = ${actionId}`)[0].o;
  const colonne = async (fileId: number) => (await sql<{ a: number | null }[]>`SELECT asset_id AS a FROM asset_files WHERE id = ${fileId}`)[0].a;
  const journal = async (accountId: number) => sql<Array<Record<string, unknown>>>`SELECT * FROM t3_open_action_evaluations WHERE account_id = ${accountId} ORDER BY id`;
  const appels = (replay: { calls: Array<{ operationCode?: string; prompt?: string }> }, op = 't3_link_ambiguity') => replay.calls.filter((c) => c.operationCode === op);
  const valeur = async (fileId: number, key: string) => (await sql<{ v: string | null; u: boolean }[]>`
    SELECT value_text AS v, user_validated AS u FROM document_field_values WHERE file_id = ${fileId} AND field_key = ${key}`)[0];
  /** Propositions de la carte ACTIVE du même problème (une carte À compléter devient À arbitrer : remplacée). */
  const propositions = async (actionId: number) => {
    const [a] = await sql<{ p: unknown }[]>`
      SELECT n.proposals_json AS p FROM to_process_actions o
        JOIN to_process_actions n ON n.account_id = o.account_id AND n.target_type = o.target_type AND n.target_id = o.target_id
         AND n.rule_code = o.rule_code AND n.resolved_at IS NULL
       WHERE o.id = ${actionId}`;
    const p = a?.p ?? null;
    return ((typeof p === 'string' ? JSON.parse(p) : p) ?? []) as Array<{ value: unknown; label: string }>;
  };
  const maintenue = ['STILL_OPEN', 'UPDATED', 'SUPERSEDED'];

  it('T3-P0-TC01 — document identifiable (immatriculation lue) : rattachement automatique, carte fermée, SANS appel IA, écriture vérifiée', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { name: 'Clio', registrationNumber: 'AB-123-CD' });
    await make.asset(compte, { name: 'Maison', category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Facture de réparation', supplier: 'Garage Martin', fullText: 'Véhicule immatriculé AB-123-CD — réparation' });
    const c = await lienAsset(compte, doc.id);
    const replay = await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ actionEffect: 'CLOSED', reasonCode: 'RESOLVED', aiCalled: false, writeVerified: true, resolutionAttempted: true });
    expect(appels(replay)).toHaveLength(0);
    expect(await colonne(doc.id)).toBe(v.id);
    expect(await ouverte(c)).toBe(false);
    const [l] = (await journal(compte.id)).filter((x) => Number(x.action_id) === c);
    expect(l).toMatchObject({ reason_code: 'RESOLVED', write_attempted: true, write_verified: true, ai_called: false, trigger_code: 'schedule_hourly', last_step: 'CLOSE' });
    expect(Number(l.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it('T3-P0-TC02 — aucun candidat structuré (facture télécom) : recherche sémantique IA parmi les biens du compte, résolution étayée', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Résidence principale', category: 'IMMOBILIER' });
    await make.asset(compte, { name: 'Clio', registrationNumber: 'ZZ-999-ZZ' });
    await historique(compte, maison.id, 'Orange');
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Facture Livebox', supplier: 'Orange', facts: [{ key: 'totalAmount', value: '42.99' }] });
    const c = await lienAsset(compte, doc.id);
    const replay = await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ actionEffect: 'CLOSED', reasonCode: 'RESOLVED', aiCalled: true, aiStatus: 'OK', writeVerified: true });
    expect(appels(replay)).toHaveLength(1);
    expect(await colonne(doc.id)).toBe(maison.id);
    const [l] = (await journal(compte.id)).filter((x) => Number(x.action_id) === c);
    expect(l).toMatchObject({ ai_operation: 't3_link_ambiguity', ai_status: 'OK', reason_code: 'RESOLVED' });
    expect(l.ai_trace_id).toBeTruthy();
    expect(l.candidate_origins).toMatchObject({ SEMANTIC_SEARCH: 2, SEMANTIC_SUPPLIER_HISTORY: 1 });
    expect(l.knowledge_sources).toMatchObject({ EXTRACTION: 1, FACTS: 1 });
    expect(r.aiCallsByOperation).toEqual({ t3_link_ambiguity: 1 });
  });

  it('T3-P0-TC03 — ambiguïté réelle (même garage pour deux véhicules) : carte maintenue, candidats et justification', async () => {
    const compte = await make.account();
    const a = await make.asset(compte, { name: 'Clio', registrationNumber: 'AA-111-AA' });
    const b = await make.asset(compte, { name: 'Kangoo', registrationNumber: 'BB-222-BB' });
    await historique(compte, a.id, 'Midas');
    await historique(compte, b.id, 'Midas');
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Facture vidange', supplier: 'Midas' });
    const c = await lienAsset(compte, doc.id);
    await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ reasonCode: 'AMBIGUOUS', aiCalled: true });
    expect(maintenue).toContain(entree(r, c)!.actionEffect);
    expect(await colonne(doc.id)).toBeNull();
    expect((await propositions(c)).map((p) => Number(p.value)).sort()).toEqual([a.id, b.id].sort());
    expect(r.keptAmbiguous).toBe(1);
  });

  it('T3-P0-TC04 — contexte inchangé, carte ouverte : nouvelle tentative RÉELLE à chaque passage (IA rappelée)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Maison de Lyon', category: 'IMMOBILIER' });
    await make.asset(compte, { name: 'Clio', registrationNumber: 'CC-333-CC' });
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Avis de taxe foncière', supplier: 'DGFIP', type: 'TAX_NOTICE', facts: [{ label: 'Commune', value: 'Lyon' }] });
    await lienAsset(compte, doc.id);
    for (const n of [1, 2]) {
      const [{ id: c }] = await sql<{ id: number }[]>`
        SELECT id FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${doc.id} AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL`;
      const replay = await rejouer([]);
      const r = await passage(compte);
      expect(entree(r, c), `passage ${n}`).toMatchObject({ resolutionAttempted: true, aiCalled: true, reasonCode: 'INSUFFICIENT_EVIDENCE' });
      expect(appels(replay)).toHaveLength(1);
      // Proposition (bien désigné par le modèle, sans preuve serveur) : arbitrage utilisateur, jamais une écriture.
      expect((await propositions(c)).map((p) => Number(p.value))).toEqual([maison.id]);
      expect(await colonne(doc.id)).toBeNull();
    }
  });

  it('T3-P0-TC05 — job documentaire BLOQUÉ : détecté, repris atomiquement, carte traitée ; job vivant : délégation tracée', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { name: 'Clio', registrationNumber: 'DD-444-DD' });
    const d1 = await make.assetFile(compte, { assetId: null });
    const d2 = await make.assetFile(compte, { assetId: null });
    for (const d of [d1, d2]) await connaissance(compte, d.id, { title: 'Facture', fullText: 'immatriculation DD-444-DD' });
    const c1 = await lienAsset(compte, d1.id);
    const c2 = await lienAsset(compte, d2.id);
    const [{ id: bloque }] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload, status, started_at, lease_expires_at, attempts)
      VALUES ('T3', ${compte.id}, 'document', ${String(d1.id)}, ${`e2e-bloque-${d1.id}`}, 'automatic', 'source_analyzed', '{}'::jsonb, 'RUNNING',
              now() - interval '2 hours', now() - interval '90 minutes', 1) RETURNING id`;
    const [{ id: vivant }] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload)
      VALUES ('T3', ${compte.id}, 'document', ${String(d2.id)}, ${`e2e-vivant-${d2.id}`}, 'automatic', 'source_analyzed', '{}'::jsonb) RETURNING id`;
    await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, c1)).toMatchObject({ actionEffect: 'CLOSED', delegatedJobId: bloque, delegatedJobStatus: 'RUNNING:STALLED_RECOVERED' });
    expect((await sql<{ s: string }[]>`SELECT status AS s FROM ai_job_queue WHERE id = ${bloque}`)[0].s).toBe('CANCELLED');
    expect(await colonne(d1.id)).toBe(v.id);
    expect(entree(r, c2)).toMatchObject({ actionEffect: 'STILL_OPEN', reasonCode: 'JOB_PENDING', delegatedJobId: vivant, delegatedJobStatus: 'PENDING', resolutionAttempted: false });
    expect(r).toMatchObject({ stalledRecovered: 1, delegated: 1 });
    const [l] = (await journal(compte.id)).filter((x) => Number(x.action_id) === c2);
    expect(l).toMatchObject({ reason_code: 'JOB_PENDING', delegated_job_id: vivant, delegated_job_status: 'PENDING' });
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${vivant}`;
  });

  it('T3-P0-TC06 — échec d’un résolveur : autres cartes traitées, statut global DÉGRADÉ, erreur détaillée ; phase en échec : échec technique', async () => {
    const compte = await make.account();
    await make.asset(compte, { name: 'Clio', registrationNumber: 'EE-555-EE' });
    const d1 = await make.assetFile(compte, { assetId: null });
    const d2 = await make.assetFile(compte, { assetId: null });
    for (const d of [d1, d2]) await connaissance(compte, d.id, { title: 'Facture', fullText: 'immatriculation EE-555-EE' });
    const c1 = await lienAsset(compte, d1.id);
    const c2 = await lienAsset(compte, d2.id);
    await rejouer([]);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    const r = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    const run = await reconcileAccount(compte.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' }, {
      reconcile: async () => ({ runId: 0, appliedCount: 0, conflictCount: 0, aiReviewCount: 0 }) as never,
      reconcileOpenKnowledge: async () => ({ documents: { enqueued: 0 }, titles: { updated: 0 } }) as never,
      reconcileOpenActions: (id, o) => reconcileOpenToProcessActions(id, {
        ...o,
        deps: {
          resolveDocumentAsset: async (p) => { if (p.fileId === d1.id) throw new Error('résolveur indisponible (e2e)'); return r.resolveDocumentAsset(p); },
          reconcileEntity: async () => ({ skipped: false }), closeObsoleteAssetConflicts: async () => 0,
        },
      }),
    });
    expect(run).toMatchObject({ status: 'partial', outcome: 'PARTIAL_SUCCESS' });
    expect(run.phases?.OPEN_ACTIONS).toMatchObject({ status: 'PARTIAL', error: '1 carte(s) en erreur' });
    expect(entree(run.openActions!, c1)).toMatchObject({ actionEffect: 'ERROR', reasonCode: 'RESOLVER_FAILED', failedStep: 'RESOLVER' });
    const [l1] = (await journal(compte.id)).filter((x) => Number(x.action_id) === c1);
    expect(l1).toMatchObject({ reason_code: 'RESOLVER_FAILED', last_step: 'KNOWLEDGE', failed_step: 'RESOLVER', account_run_id: run.runId });
    expect(String(l1.note)).toContain('résolveur indisponible');
    expect(entree(run.openActions!, c2)).toMatchObject({ actionEffect: 'CLOSED' });
    const [db] = await sql<Array<{ status: string; outcome: string; phases_json: Record<string, { status: string }> }>>`
      SELECT status, outcome, phases_json FROM account_reconciliation_runs WHERE id = ${run.runId}`;
    expect(db).toMatchObject({ status: 'partial', outcome: 'PARTIAL_SUCCESS' });
    expect(db.phases_json.OPEN_ACTIONS.status).toBe('PARTIAL');
    // Phase obligatoire qui lève : jamais « zéro résultat », échec technique tracé.
    const ko = await reconcileAccount(compte.id, { type: 'scheduled' }, {}, {
      reconcile: async () => ({ runId: 0, appliedCount: 0, conflictCount: 0, aiReviewCount: 0 }) as never,
      reconcileOpenKnowledge: async () => ({ documents: { enqueued: 0 }, titles: { updated: 0 } }) as never,
      reconcileOpenActions: async () => { throw new Error('reconcileOpenToProcessActions en échec (e2e)'); },
    });
    expect(ko).toMatchObject({ outcome: 'TECHNICAL_FAILURE', status: 'partial' });
    expect(ko.phases).toMatchObject({ OPEN_ACTIONS: { status: 'FAILED', error: 'reconcileOpenToProcessActions en échec (e2e)' }, JOURNAL: { status: 'NOT_RUN' } });
  });

  it('T3-P0-TC07 — journal en échec : dégradation visible, écritures métier préservées', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Contrat d’entretien chaudière', type: 'MAINTENANCE_CONTRACT', facts: [{ key: 'contractEndDate', value: '2027-03-31' }] });
    const c = await finContrat(compte, doc.id);
    await sql`ALTER TABLE t3_open_action_evaluations RENAME TO t3_open_action_evaluations_e2e`;
    try {
      const r = await passage(compte);
      expect(r).toMatchObject({ journalStatus: 'FAILED', journaled: null });
      expect(r.journalError).toMatch(/t3_open_action_evaluations/);
      expect(entree(r, c)).toMatchObject({ actionEffect: 'CLOSED' });
      expect(await ouverte(c)).toBe(false);
      expect((await valeur(doc.id, 'contractEndDate')).v).toBe('2027-03-31');
    } finally {
      await sql`ALTER TABLE t3_open_action_evaluations_e2e RENAME TO t3_open_action_evaluations`;
    }
  });

  it('T3-P0-TC08 — DATA-CONTRACT-END, date fiable dans T1 (alias du registre) : champ complété, carte fermée, sans IA', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Contrat de gardiennage de pneus', type: 'SERVICE_CONTRACT', facts: [{ key: null, raw: 'date_fin_contrat', value: '2027-03-31' }] });
    const c = await finContrat(compte, doc.id);
    const replay = await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ resolver: 'T3_DOCUMENT_FIELD', actionEffect: 'CLOSED', reasonCode: 'RESOLVED', aiCalled: false, writeVerified: true });
    expect(replay.calls).toHaveLength(0);
    expect(await valeur(doc.id, 'contractEndDate')).toMatchObject({ v: '2027-03-31', u: false });
    const [l] = (await journal(compte.id)).filter((x) => Number(x.action_id) === c);
    expect(l).toMatchObject({ knowledge_sources: { FACTS: 1 }, write_attempted: true, write_verified: true });
  });

  it('T3-P0-TC09 — information uniquement dans document_source_units : exploitée (texte couvert absent de la transcription ; libellé : valeur)', async () => {
    const compte = await make.account();
    const v = await make.asset(compte, { name: 'Clio', registrationNumber: 'FF-666-FF' });
    const doc = await make.assetFile(compte, { assetId: null });
    // Transcription VIDE : l'unité COUVERTE n'y figure pas (l'ancien filtre la supposait présente).
    await connaissance(compte, doc.id, { title: 'Facture', fullText: null, units: [{ kind: 'TEXT_BLOCK', text: 'Véhicule FF-666-FF entretien' }] });
    const c = await lienAsset(compte, doc.id);
    await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ actionEffect: 'CLOSED', aiCalled: false });
    expect(await colonne(doc.id)).toBe(v.id);
    const contrat = await make.assetFile(compte, { assetId: null });
    // Lot 61 : échéance PROCHE (≤ 120 jours) — une échéance lointaine est différée, sans carte active.
    const proche = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    await connaissance(compte, contrat.id, {
      title: 'Contrat', type: 'SERVICE_CONTRACT', units: [{ kind: 'LABEL_VALUE', label: 'Date de fin de contrat', value: proche.split('-').reverse().join('/') }],
    });
    const c2 = await finContrat(compte, contrat.id);
    const r2 = await passage(compte);
    expect(entree(r2, c2)).toMatchObject({ reasonCode: 'INSUFFICIENT_EVIDENCE' });
    const [l2] = (await journal(compte.id)).filter((x) => Number(x.action_id) === c2);
    expect(l2.knowledge_sources).toEqual({ SOURCE_UNITS: 1 });
    expect(maintenue).toContain(entree(r2, c2)!.actionEffect);
    expect((await propositions(c2)).map((p) => p.value)).toEqual([proche]);
    expect(await valeur(contrat.id, 'contractEndDate')).toBeUndefined();
  });

  it('T3-P0-TC10 — choix utilisateur existant : jamais écrasé (rattachement, date retirée, date saisie)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Résidence', category: 'IMMOBILIER' });
    await historique(compte, maison.id, 'Orange');
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Facture', supplier: 'Orange' });
    await sql`UPDATE asset_files SET user_edited_fields = '{"assetId": true}'::jsonb WHERE id = ${doc.id}`;
    const c = await lienAsset(compte, doc.id);
    const d2 = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, d2.id, { title: 'Contrat', type: 'SERVICE_CONTRACT', facts: [{ key: 'contractEndDate', value: '2027-03-31' }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated) VALUES (${compte.id}, ${d2.id}, 'contractEndDate', NULL, 'USER', true)`;
    const c2 = await finContrat(compte, d2.id);
    const d3 = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, d3.id, { title: 'Contrat', type: 'SERVICE_CONTRACT', facts: [{ key: 'contractEndDate', value: '2027-03-31' }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated) VALUES (${compte.id}, ${d3.id}, 'contractEndDate', '2026-12-31', 'USER', true)`;
    const c3 = await carte(compte, 'DATA-CONTRACT-END', 'DOCUMENT', d3.id, { field: 'contractEndDate', kind: 'ARBITRATE' });
    const replay = await rejouer([]);
    const r = await passage(compte);
    expect(entree(r, c)).toMatchObject({ reasonCode: 'USER_DECISION_PROTECTED', aiCalled: false });
    expect(appels(replay)).toHaveLength(0);
    expect(await colonne(doc.id)).toBeNull();
    expect(entree(r, c2)).toMatchObject({ reasonCode: 'USER_DECISION_PROTECTED', actionEffect: 'STILL_OPEN' });
    expect(await valeur(d2.id, 'contractEndDate')).toMatchObject({ v: null, u: true });
    expect(await valeur(d3.id, 'contractEndDate')).toMatchObject({ v: '2026-12-31', u: true });
    expect(entree(r, c3)?.actionEffect).not.toBe('ERROR');
  });

  it('T3-P0-TC11 — isolation intercomptes : seuls les biens du compte sont présentés au modèle et rattachables', async () => {
    const autre = await make.account();
    const etranger = await make.asset(autre, { name: 'Villa Etrangere', category: 'IMMOBILIER' });
    await historique(autre, etranger.id, 'Orange');
    const compte = await make.account();
    const mien = await make.asset(compte, { name: 'Studio', category: 'IMMOBILIER' });
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Facture', supplier: 'Orange' });
    const c = await lienAsset(compte, doc.id);
    const replay = await rejouer([]);
    const r = await passage(compte);
    const prompts = appels(replay).map((x) => String(x.prompt ?? ''));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Studio');
    expect(prompts[0]).not.toContain('Villa Etrangere');
    expect(prompts[0]).not.toContain('historique fournisseur');
    expect(await colonne(doc.id)).not.toBe(etranger.id);
    expect(entree(r, c)?.actionEffect).not.toBe('CLOSED');
    expect(mien.id).toBeGreaterThan(0);
  });

  it('T3-P0-TC12 / TC14 — plus de 200 cartes (règles T4) : aucune omission, pagination et journal complets, aucun faux traitement T3', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    // Identifiants d'agenda hors de toute base de test : la garde 0373 refuse
    // (à juste titre) une carte visant l'agenda d'un autre compte.
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
              SELECT ${compte.id}, 'AGENDA_ITEM', 2000000000 + g, ${'dup'} || g, 'ARBITRATE', 'AGENDA-DUPLICATE', 'Doublon ?' FROM generate_series(1, 205) g`;
    expect(doc.id).toBeGreaterThan(0);
    const replay = await rejouer([]);
    const r = await passage(compte);
    expect(r).toMatchObject({ examined: 205, pages: 2, openAtStart: 205, journaled: 205, journalStatus: 'OK', resolutionAttempted: 0, aiCalls: 0 });
    expect(r.byReasonCode).toEqual({ NOT_T3: 205 });
    expect(replay.calls).toHaveLength(0);
    expect((await journal(compte.id)).filter((x) => x.reason_code === 'NOT_T3')).toHaveLength(205);
  }, 120_000);

  it('T3-P0-TC13 — déclenchement manuel et planifié : mêmes garanties (phases, issue, journal rattaché au passage)', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Contrat', type: 'SERVICE_CONTRACT', facts: [{ key: 'contractEndDate', value: '2028-01-31' }] });
    await finContrat(compte, doc.id);
    const evenement = await make.agendaItem(compte, { title: 'Révision' });
    await carte(compte, 'AGENDA-DUPLICATE', 'AGENDA_ITEM', evenement.id, { relation: 'x' });
    await rejouer([]);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    for (const trigger of [{ type: 'manual' as const, requestedByUserId: compte.ownerUserId }, { type: 'scheduled' as const }]) {
      const run = await reconcileAccount(compte.id, trigger, { triggerCode: trigger.type === 'manual' ? 'manual' : 'schedule_hourly' });
      expect(run.phases, trigger.type).toMatchObject({
        ASSETS: { status: 'DONE' }, OPEN_KNOWLEDGE: { status: 'DONE' }, OPEN_ACTIONS: { status: 'DONE' }, JOURNAL: { status: 'DONE' },
      });
      expect(['SUCCESS', 'BUSINESS_ABSTENTION']).toContain(run.outcome);
      const lignes = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM t3_open_action_evaluations WHERE account_run_id = ${run.runId}`;
      expect(lignes[0].n).toBe(run.openActions!.examined);
    }
    const diag = await (await import('@/services/ai/queue/t3-open-actions-diagnostic')).getT3OpenActionsDiagnostic({ accountId: compte.id });
    expect(diag.migrations).toMatchObject({ journal0371: true, diagnostic0410: true }); // 58B : + documentRules0418
    expect(diag.runs[0]).toMatchObject({ accountId: compte.id, outcome: expect.any(String), phases: expect.any(Object) });
    expect(diag.runs[0].counters).toMatchObject({ examined: expect.any(Number), resolved: expect.any(Number), journaled: expect.any(Number) });
    expect(diag.cards.length).toBeGreaterThan(0);
    const filtre = await (await import('@/services/ai/queue/t3-open-actions-diagnostic')).getT3OpenActionsDiagnostic({ accountId: compte.id, result: 'NOT_T3' });
    expect(filtre.cards.every((x) => x.reasonCode === 'NOT_T3')).toBe(true);
    expect(filtre.cards.length).toBeGreaterThan(0);
  });

  it('T3-P0-TC15 — rejeu : idempotence, aucun doublon (lien, carte, job)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Résidence', category: 'IMMOBILIER' });
    await historique(compte, maison.id, 'EDF');
    const doc = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, doc.id, { title: 'Facture électricité', supplier: 'EDF' });
    const c = await lienAsset(compte, doc.id);
    await rejouer([]);
    await passage(compte);
    const r2 = await passage(compte);
    expect(entree(r2, c)).toBeUndefined(); // fermée : hors du cycle suivant
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_asset_links WHERE file_id = ${doc.id} AND status = 'ACTIVE'`)[0].n).toBeLessThanOrEqual(1);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE target_id = ${doc.id} AND target_type = 'DOCUMENT' AND resolved_at IS NULL`)[0].n).toBe(0);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM t3_open_action_evaluations WHERE action_id = ${c}`)[0].n).toBe(1);
    expect(await colonne(doc.id)).toBe(maison.id);
  });

  it('T3-P0-TC16 — cas représentatifs du compte 13 (EPS, Orange, taxe foncière, gardiennage, entretiens, Midas) : résolus ou justifiés, sans règle spécifique', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Maison de Lyon', category: 'IMMOBILIER' });
    const voiture = await make.asset(compte, { name: 'Peugeot 308', registrationNumber: 'GG-777-GG' });
    await sql`INSERT INTO equipments (asset_id, name) VALUES (${voiture.id}, 'Pneus hiver')`;
    await historique(compte, maison.id, 'EPS');
    await historique(compte, maison.id, 'Orange');
    await historique(compte, voiture.id, 'Midas');
    await historique(compte, voiture.id, 'Norauto');
    const cas: Record<string, { doc: number; carte: number }> = {};
    const docLien = async (nom: string, p: Parameters<typeof connaissance>[2]) => {
      const d = await make.assetFile(compte, { assetId: null });
      await connaissance(compte, d.id, p);
      cas[nom] = { doc: d.id, carte: await lienAsset(compte, d.id) };
    };
    await docLien('EPS', { title: 'Facture entretien pompe à chaleur', supplier: 'EPS' });
    await docLien('Orange', { title: 'Facture Internet', supplier: 'Orange' });
    await docLien('Taxe foncière', { title: 'Avis de taxe foncière', supplier: 'DGFIP', type: 'TAX_NOTICE', facts: [{ label: 'Commune', value: 'Lyon' }] });
    await docLien('Gardiennage', { title: 'Contrat de gardiennage de pneus', supplier: 'Euromaster', type: 'SERVICE_CONTRACT' });
    await docLien('Entretien', { title: 'Révision des 60 000 km', supplier: 'Norauto' });
    await docLien('Midas', { title: 'Facture plaquettes de frein', supplier: 'Midas' });
    const fin = await finContrat(compte, cas.Gardiennage.doc);
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, normalized_value, confidence, excerpt, canonical_key)
              SELECT ${compte.id}, ${cas.Gardiennage.doc}, id, 'contractEndDate', '2027-10-31', '2027-10-31', 'certain', 'Fin : 31/10/2027', 'contractEndDate'
                FROM document_extractions WHERE file_id = ${cas.Gardiennage.doc}`;
    const replay = await rejouer([]);
    const r = await passage(compte);
    // Résolus automatiquement (preuve serveur : historique fournisseur).
    for (const [nom, bien] of [['EPS', maison.id], ['Orange', maison.id], ['Entretien', voiture.id], ['Midas', voiture.id]] as const) {
      expect(entree(r, cas[nom].carte), nom).toMatchObject({ actionEffect: 'CLOSED', reasonCode: 'RESOLVED', writeVerified: true });
      expect(await colonne(cas[nom].doc), nom).toBe(bien);
    }
    // Restants : justifiés (proposition du bien indiqué, arbitrage utilisateur).
    expect(entree(r, cas['Taxe foncière'].carte)).toMatchObject({ reasonCode: 'INSUFFICIENT_EVIDENCE', aiCalled: true });
    expect((await propositions(cas['Taxe foncière'].carte)).map((p) => Number(p.value))).toEqual([maison.id]);
    expect(entree(r, cas.Gardiennage.carte)).toMatchObject({ reasonCode: 'INSUFFICIENT_EVIDENCE', aiCalled: true });
    expect((await propositions(cas.Gardiennage.carte)).map((p) => Number(p.value))).toEqual([voiture.id]);
    // DATA-CONTRACT-END du contrat de gardiennage : complétée depuis T1.
    expect(entree(r, fin)).toMatchObject({ actionEffect: 'CLOSED', reasonCode: 'RESOLVED' });
    expect((await valeur(cas.Gardiennage.doc, 'contractEndDate')).v).toBe('2027-10-31');
    // Chaque carte a une trace exploitable ; compteurs distincts.
    const j = await journal(compte.id);
    expect(j).toHaveLength(7);
    expect(j.every((x) => x.reason_code !== null && x.last_step !== null)).toBe(true);
    expect(r).toMatchObject({ examined: 7, resolved: 5, keptAmbiguous: 2, errors: 0 });
    expect(r.resolutionAttempted).toBe(7);
    expect(appels(replay)).toHaveLength(6);
  });
});
