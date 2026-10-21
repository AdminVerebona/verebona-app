/**
 * Lot 75I — ticket « [P1] À traiter — Corriger les écarts résiduels de
 * pertinence, fiabiliser le balayage et finaliser la recette T4 », sur
 * PostgreSQL 16 réel (migration 0560 appliquée par le bootstrap).
 *
 * Vérifie les données RÉELLEMENT persistées : valeurs retenues, cartes
 * actives et fermées (événements d'audit), décisions tracées
 * (`document_rule_evaluations`, passages durables `to_process_evaluation_passages`),
 * bilan des balayages (`to_process_scan_runs`). Dates RELATIVES au jour
 * d'exécution. T4 (CLASSIFY_EVENT, `t4_output_v3`) est SIMULÉ de façon
 * générique : une obligation n'est reconnue que si une CLAUSE transmise la
 * prouve (restitution) ; aucune règle propre à un contrat ni aux pneus.
 *
 *  L75I-A-E*  obligation d'une échéance connue (découplée de la complétion)
 *  L75I-B-E*  statut et détail fidèles des balayages
 *  L75I-C-E*  révision de connaissance fondée sur le contenu
 *  L75I-D-E*  contrat T4 incompatible : aucune question par défaut
 *  L75I-E-E*  traçabilité durable, fermetures atomiques et tracées
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

const jour = (decalage: number) => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);
const PASSE = jour(-40);
const CLAUSE = 'À la fin du contrat, le locataire doit restituer le matériel loué dans un délai de 30 jours, à défaut de quoi il sera facturé.';

let t4Mode: 'clauses' | 'failure' = 'clauses';
const demandes: Array<Record<string, any>> = [];
/** T4 simulé générique : une obligation n'existe que si une clause transmise la prouve (restitution citée). */
function t4Simule(input: { prompt: string }): unknown {
  if (t4Mode === 'failure') throw Object.assign(new Error('T4 indisponible (e2e)'), { code: 'PROVIDER_UNAVAILABLE' });
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any> } : {};
  const demande = ctx.event_context?.toProcessAssessment as { situation: string; knownDate?: string; clauses?: string[] } | undefined;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (!demande) return { ...base, intervention: null };
  demandes.push(demande);
  const aucune = { needed: 'no', kind: null, action: null, justification: 'aucune démarche restante (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
  const clause = (demande.clauses ?? []).find((c) => /restitu/i.test(c));
  if (demande.knownDate && clause) {
    return { ...base, homeCategory: 'action', intervention: {
      needed: 'yes', kind: 'RETURN_OR_RESTITUTE', action: 'Restituer le matériel loué', justification: 'Restitution prévue après la fin du contrat (simulé).',
      consequence: 'Matériel facturé', evidence: clause, timing: 'NOW', actBy: null, dataNeeded: false } };
  }
  if (demande.situation === 'UNDATED') {
    return { ...base, homeCategory: 'action', intervention: { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat', justification: 'contrat en cours (simulé)',
      consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true } };
  }
  return { ...base, intervention: aucune };
}

scenario('L75I-ATP', 'À traiter : obligations des échéances connues, balayage fidèle, traçabilité durable (lot 75I)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  beforeAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule); });
  afterAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null); });
  afterEach(async () => {
    t4Mode = 'clauses';
    demandes.length = 0;
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
  });

  const doc = async (compte: Compte, p: {
    title: string; type?: string;
    facts?: Array<{ key?: string | null; raw?: string; label?: string; value: string; norm?: string | null; confidence?: string; excerpt?: string }>;
    units?: Array<{ kind: string; label?: string | null; value?: string | null; text?: string | null; coverage?: string }>;
    endDate?: { value: string; user?: boolean };
  }) => {
    // Document rattaché à un bien : seule la règle étudiée est en jeu (pas de question de rattachement).
    const bien = await make.asset(compte);
    const f = await make.assetFile(compte, { assetId: bien.id });
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${f.id}, ${p.title}, ${p.type ?? 'SERVICE_CONTRACT'}, NULL, 0) RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${p.type ?? 'SERVICE_CONTRACT'}, analysis_state = 'ANALYZED', original_filename = 'Contrat.pdf' WHERE id = ${f.id}`;
    for (const x of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${f.id}, ${id}, ${x.raw ?? x.key ?? 'fait'}, ${x.label ?? null}, ${x.value}, ${x.norm === undefined ? x.value : x.norm},
                        ${x.confidence ?? 'certain'}, ${x.excerpt ?? `${x.label ?? x.key ?? 'fait'} : ${x.value}`}, ${x.key ?? null})`;
    }
    let n = 0;
    for (const u of p.units ?? []) {
      n += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, label, value_text, coverage_status)
                VALUES (${compte.id}, ${f.id}, ${id}, ${`u${n}`}, ${u.kind}, ${n}, ${u.text ?? null}, ${u.label ?? null}, ${u.value ?? null}, ${u.coverage ?? 'COVERED'})`;
    }
    if (p.endDate) {
      await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
                VALUES (${compte.id}, ${f.id}, 'contractEndDate', ${p.endDate.value}, ${p.endDate.user ? 'USER' : 'RECONCILIATION'}, ${p.endDate.user === true})`;
    }
    return f.id;
  };
  /** Contrat à échéance passée connue + clause de restitution AILLEURS que dans l'extrait de la date. */
  const contratRestitution = (compte: Compte, endDate = true) => doc(compte, {
    title: 'Contrat de location — box',
    facts: [
      { key: 'contractEndDate', label: 'Date de fin', value: PASSE, excerpt: `Date de fin du contrat : ${PASSE}` },
      { raw: 'conditionsRestitution', label: 'Restitution', value: CLAUSE, norm: null, excerpt: CLAUSE },
    ],
    ...(endDate ? { endDate: { value: PASSE } } : {}),
  });
  const carte = async (compte: Compte, targetId: number, p: { kind?: string; field?: string } = {}) => (await sql<{ id: number }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
    VALUES (${compte.id}, 'DOCUMENT', ${targetId}, ${p.field ?? 'contractEndDate'}, ${p.kind ?? 'COMPLETE'}, 'DATA-CONTRACT-END', 'Quelle est la date de fin ?') RETURNING id`)[0].id;
  const cartes = async (fileId: number, key = 'contractEndDate') => sql<Array<{ id: number; kind: string; open: boolean; reason: string | null; rule: string; question: string }>>`
    SELECT id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason, rule_code AS rule, question
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND field_key = ${key} ORDER BY id`;
  const ouvertes = async (fileId: number, key = 'contractEndDate') => (await cartes(fileId, key)).filter((c) => c.open);
  const valeur = async (fileId: number) => (await sql<Array<{ v: string | null; u: boolean }>>`
    SELECT value_text AS v, user_validated AS u FROM document_field_values WHERE file_id = ${fileId} AND field_key = 'contractEndDate'`)[0] ?? null;
  const diag = async (fileId: number) => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = 'DATA-CONTRACT-END' ORDER BY id`;
  const evenements = async (actionId: number) => sql<Array<{ event: string; details: any }>>`SELECT event, details FROM to_process_action_events WHERE action_id = ${actionId} ORDER BY id`;
  const appelsT4 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't4_classify_event');
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  const aReevaluer = async (compte: Compte) => (await import('@/services/to-process/document-rule-bridge')).documentsToReevaluate(compte.id);
  const KEY_IV = 'intervention:contractEndDate';

  // ══════════════════════════════════════════════════════════════════════
  // A — obligation évaluée même quand la date est connue
  // ══════════════════════════════════════════════════════════════════════

  it('L75I-A-E1 — TEST OBLIGATOIRE : date passée certaine enregistrée + restitution encore applicable → aucune question sur la date, carte de restitution présente', async () => {
    const compte = await make.account();
    const autre = await make.account();
    const f = await contratRestitution(compte);
    const question = await carte(compte, f);
    const g = await contratRestitution(autre);
    const replay = await rejouer([]);
    await balayage(compte);
    // Question de complétion devenue inutile : fermée, tracée.
    expect(await ouvertes(f)).toEqual([]);
    expect((await evenements(question)).at(-1)).toMatchObject({ event: 'OBSOLETE', details: { reason: 'COMPLETED_ELSEWHERE' } });
    // Obligation réelle : UNE carte d'intervention décrivant la restitution (jamais une question de date).
    const iv = await ouvertes(f, KEY_IV);
    expect(iv).toHaveLength(1);
    expect(iv[0]).toMatchObject({ rule: 'DOC-INTERVENTION', kind: 'ARBITRATE' });
    expect(iv[0].question).toMatch(/Restituer/);
    // Donnée conservée, T4 a reçu la date connue ET la clause (hors extrait de la date).
    expect(await valeur(f)).toMatchObject({ v: PASSE });
    expect(appelsT4(replay)).toHaveLength(1);
    expect(demandes[0]).toMatchObject({ situation: 'PAST_DEADLINE', knownDate: PASSE });
    expect(demandes[0].clauses.join(' ')).toContain('restituer le matériel');
    const d = (await diag(f)).at(-1)!;
    expect(d).toMatchObject({ situation: 'KNOWN_DEADLINE', pertinence: 'ACTION_REQUIRED', outcome: 'CREATE_ACTION', engine_version: 'l76-2' });
    expect(d.action_ids.closed).toEqual([question]);
    expect(d.action_ids.intervention).toEqual([iv[0].id]);
    // Isolation : l'autre compte n'est pas touché.
    expect(await cartes(g, KEY_IV)).toEqual([]);

    // Balayages répétés : idempotents, aucune nouvelle carte, aucun nouvel appel T4 (mémoire).
    const replay2 = await rejouer([]);
    await balayage(compte);
    await balayage(compte);
    expect(await cartes(f, KEY_IV)).toHaveLength(1);
    expect(await ouvertes(f)).toEqual([]);
    expect(appelsT4(replay2)).toHaveLength(0);
  });

  it('L75I-A-E1 — date connue SANS carte préalable : le balayage reprend le document (obligation jamais évaluée) puis ne le reprend plus', async () => {
    const compte = await make.account();
    const f = await contratRestitution(compte);
    expect(await aReevaluer(compte)).toContain(f);
    await balayage(compte);
    expect(await ouvertes(f, KEY_IV)).toHaveLength(1);
    expect(await ouvertes(f)).toEqual([]);
    // Carte d'intervention active : reprise pour suivi, sans appel T4 (décision mémorisée).
    const replay = await rejouer([]);
    await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(0);
  });

  it('L75I-A-E2 — date T1 fiable : écriture confirmée, question de complétion fermée ; aucune clause d’obligation : aucune carte, aucun appel T4', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'contractEndDate', label: 'Date de fin', value: PASSE }] });
    const question = await carte(compte, f);
    const replay = await rejouer([]);
    const { syncDocumentRulesFromAnalysis } = await import('@/services/to-process/document-rule-bridge');
    const r = await syncDocumentRulesFromAnalysis({
      accountId: compte.id, fileId: f, runRef: 'l75i:a2',
      observations: { facts: [{ canonicalKey: 'contractEndDate', value: PASSE, confidence: 'certain', excerpt: `Date de fin : ${PASSE}` }], assetCandidates: [], documentAssetId: null },
    });
    expect(r.errorDetails).toEqual([]);
    expect(await valeur(f)).toMatchObject({ v: PASSE, u: false });
    expect((await cartes(f)).find((c) => c.id === question)).toMatchObject({ open: false });
    expect(await cartes(f, KEY_IV)).toEqual([]);
    const d = (await diag(f)).at(-1)!;
    expect(d).toMatchObject({ decision: 'WRITE', outcome: 'AUTO_RESOLVED', situation: 'KNOWN_DEADLINE', pertinence: 'NO_OBLIGATION_EVIDENCE', write_verified: true });
    expect(d.write_result).toMatchObject({ status: 'CONFIRMED' });
    expect(appelsT4(replay)).toHaveLength(0);
    // Connaissance inchangée : plus repris.
    expect(await aReevaluer(compte)).not.toContain(f);
  });

  it('L75I-A-E3 — décision antérieure de l’utilisateur (« C’est fait ») respectée : pas de nouvelle carte, même après un changement sans incidence', async () => {
    const compte = await make.account();
    const f = await contratRestitution(compte);
    await balayage(compte);
    const [iv] = await ouvertes(f, KEY_IV);
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'USER_ARBITRATED' WHERE id = ${iv.id}`;
    await sql`INSERT INTO to_process_action_events (action_id, account_id, event, target_type, target_id, field_key, details)
              VALUES (${iv.id}, ${compte.id}, 'RESOLVED_ARBITRATION', 'DOCUMENT', ${f}, ${KEY_IV}, '{"choice":"DONE"}'::jsonb)`;
    // Fait nouveau sans incidence sur l'obligation : connaissance changée, document repris.
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt)
              SELECT ${compte.id}, ${f}, id, 'reference', 'Référence', 'REF-12345', 'certain', 'Référence : REF-12345' FROM document_extractions WHERE file_id = ${f}`;
    expect(await aReevaluer(compte)).toContain(f);
    await balayage(compte);
    expect(await ouvertes(f, KEY_IV)).toEqual([]);
    expect(await cartes(f, KEY_IV)).toHaveLength(1);
    expect((await diag(f)).at(-1)).toMatchObject({ reason_code: 'USER_DECISION_RESPECTED' });
  });

  it('L75I-A-E4 — valeur de l’utilisateur jamais écrasée ; date passée sans obligation : historique conservé, aucune carte', async () => {
    const compte = await make.account();
    const saisie = jour(-60);
    const f = await doc(compte, { title: 'Contrat de maintenance', facts: [{ key: 'contractEndDate', value: PASSE }, { raw: 'paiement', label: 'Paiement', value: 'Paiement mensuel par prélèvement.', norm: null }],
      endDate: { value: saisie, user: true } });
    await balayage(compte);
    await (await import('@/services/to-process/document-rule-bridge')).syncDocumentRulesFromAnalysis({
      accountId: compte.id, fileId: f, observations: { facts: [{ canonicalKey: 'contractEndDate', value: PASSE, confidence: 'certain' }], assetCandidates: [], documentAssetId: null },
    });
    expect(await valeur(f)).toMatchObject({ v: saisie, u: true });
    expect(await cartes(f, KEY_IV)).toEqual([]);
    expect((await diag(f)).some((d) => d.situation === 'KNOWN_DEADLINE' && d.pertinence === 'NO_ACTION_NEEDED')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════
  // B — statut et détail fidèles des balayages
  // ══════════════════════════════════════════════════════════════════════

  it('L75I-B-E1 — écriture NON CONFIRMÉE : erreur de persistance remontée (compte, document, règle, étape, nature), carte conservée, passage « partial »', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', label: 'Date de fin', value: PASSE }] });
    const question = await carte(compte, f);
    // Panne de persistance réelle : la base réécrit la valeur (relecture ≠ valeur écrite).
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l75i_alterer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.file_id = ${f} THEN NEW.value_text := '1999-01-01'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER l75i_alterer BEFORE INSERT OR UPDATE ON document_field_values FOR EACH ROW EXECUTE FUNCTION l75i_alterer()`);
    try {
      const r = await balayage(compte);
      expect(r.ruleErrors).toEqual(expect.arrayContaining([expect.objectContaining({ fileId: f, ruleCode: 'DATA-CONTRACT-END', step: 'VERIFY', kind: 'PERSISTENCE_FAILED' })]));
      expect((await cartes(f)).find((c) => c.id === question)).toMatchObject({ open: true });
      expect(await valeur(f)).toBeNull();
      const { runToProcessFullScan } = await import('@/services/to-process/to-process-scan.job');
      const scan = (await runToProcessFullScan({ accountId: compte.id, trigger: 'manual' }))!;
      expect(scan.status).toBe('partial');
      expect(scan.failedAccounts).toBe(0);
      const [run] = await sql<Array<Record<string, any>>>`SELECT * FROM to_process_scan_runs WHERE id = ${scan.runId}`;
      expect(run).toMatchObject({ status: 'partial', failed_accounts: 0 });
      expect(run.error_details).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: compte.id, fileId: f, ruleCode: 'DATA-CONTRACT-END', step: 'VERIFY', kind: 'PERSISTENCE_FAILED' })]));
      expect(run.summary.errorsByKind.PERSISTENCE_FAILED).toBeGreaterThanOrEqual(1);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS l75i_alterer ON document_field_values`);
    }
    // Sans erreur : « ok ».
    const sain = await make.account();
    const { runToProcessFullScan, listToProcessScanRuns } = await import('@/services/to-process/to-process-scan.job');
    const ok = (await runToProcessFullScan({ accountId: sain.id, trigger: 'manual' }))!;
    expect(ok).toMatchObject({ status: 'ok', errors: 0 });
    expect((await listToProcessScanRuns(5)).find((x) => x.id === ok.runId)).toMatchObject({ status: 'ok', errorDetails: [] });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C — révision de connaissance fondée sur le contenu
  // ══════════════════════════════════════════════════════════════════════

  it('L75I-C-E1 — clause modifiée SUR PLACE (unité source, extraction) : décision recalculée ; inchangée : aucun appel T4', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location', facts: [{ key: 'contractEndDate', value: PASSE }],
      units: [{ kind: 'TEXT_BLOCK', text: 'Le présent contrat est conclu pour une durée d’un an. Paiement mensuel.' }], endDate: { value: PASSE } });
    const { currentKnowledgeRev } = await import('@/services/to-process/document-field-evidence');
    await balayage(compte);
    expect(await cartes(f, KEY_IV)).toEqual([]);
    const rev0 = await currentKnowledgeRev(compte.id, f);
    expect(await aReevaluer(compte)).not.toContain(f);
    const replay0 = await rejouer([]);
    await balayage(compte);
    expect(appelsT4(replay0)).toHaveLength(0);

    // Modification DIRECTE de la clause (sans insertion, ni suppression, ni asset_files.updated_at).
    const [{ u: avant }] = await sql<Array<{ u: string }>>`SELECT updated_at::text AS u FROM asset_files WHERE id = ${f}`;
    await sql`UPDATE document_source_units SET content_text = ${CLAUSE} WHERE file_id = ${f}`;
    expect((await sql<Array<{ u: string }>>`SELECT updated_at::text AS u FROM asset_files WHERE id = ${f}`)[0].u).toBe(avant);
    expect(await currentKnowledgeRev(compte.id, f)).not.toBe(rev0);
    expect(await aReevaluer(compte)).toContain(f);
    const replay = await rejouer([]);
    await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(1);
    expect(await ouvertes(f, KEY_IV)).toHaveLength(1);

    // Texte intégral de l'extraction corrigé sur place : révision changée aussi.
    const rev1 = await currentKnowledgeRev(compte.id, f);
    await sql`UPDATE document_extractions SET full_text = 'Texte corrigé' WHERE file_id = ${f}`;
    expect(await currentKnowledgeRev(compte.id, f)).not.toBe(rev1);
  });

  // ══════════════════════════════════════════════════════════════════════
  // D — contrat T4 incompatible
  // ══════════════════════════════════════════════════════════════════════

  it('L75I-D-E1 — contrat T4 incompatible : aucune question créée, carte existante conservée, incompatibilité signalée ; réévalué à l’activation d’un contrat compatible', async () => {
    const compte = await make.account();
    const ev = await import('@/services/to-process/document-field-evidence');
    ev.__setT4AssessmentConfigForTests({ ref: 'bo:v2:t4_output_v2', interventionCapable: false });
    const sansCarte = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', value: jour(-60) }] });
    const avecCarte = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', value: jour(-60) }] });
    const c = await carte(compte, avecCarte);
    const replay = await rejouer([]);
    const r = await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(0);
    expect(await cartes(sansCarte)).toEqual([]);
    expect((await cartes(avecCarte)).find((x) => x.id === c)).toMatchObject({ open: true });
    expect((await diag(sansCarte)).at(-1)).toMatchObject({ outcome: 'DEFER', pertinence: 'T4_INCOMPATIBLE', pertinence_reason: expect.stringContaining('t4_contract_incompatible') });
    expect(r.ruleErrors.filter((e) => e.fileId === sansCarte)).toEqual([]);
    expect(await ev.countIncompatibleDecisions()).toBeGreaterThanOrEqual(2);
    // Mémorisé : pas repris tant que la configuration ne change pas…
    expect(await aReevaluer(compte)).not.toContain(sansCarte);
    // …repris dès qu'une configuration compatible est active.
    ev.__setT4AssessmentConfigForTests({ ref: 'bo:v3:t4_output_v3', interventionCapable: true });
    expect(await aReevaluer(compte)).toContain(sansCarte);
  });

  // ══════════════════════════════════════════════════════════════════════
  // E — traçabilité durable, fermetures atomiques et tracées
  // ══════════════════════════════════════════════════════════════════════

  it('L75I-E-E1 — 25 passages identiques : une ligne dédupliquée, aperçu de 20, 25 passages durables consultables au BO', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractStartDate', value: jour(-60) }] });
    await carte(compte, f);
    const { syncDocumentRulesFromState } = await import('@/services/to-process/document-rule-bridge');
    for (let k = 1; k <= 25; k++) await syncDocumentRulesFromState(compte.id, f, { trigger: 'SWEEP', runRef: `p${k}` });
    const lignes = await diag(f);
    const derniere = lignes.at(-1)!;
    expect(derniere.passages).toHaveLength(20);
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM to_process_evaluation_passages WHERE rule_evaluation_id = ${derniere.id}`;
    expect(n).toBe(Number(derniere.seen_count));
    const total = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM to_process_evaluation_passages p JOIN document_rule_evaluations e ON e.id = p.rule_evaluation_id WHERE e.file_id = ${f} AND e.rule_code = 'DATA-CONTRACT-END'`;
    expect(total[0].n).toBe(25);
    const { getT3OpenActionsDiagnostic } = await import('@/services/ai/queue/t3-open-actions-diagnostic');
    const bo = await getT3OpenActionsDiagnostic({ documentId: f, ruleCode: 'DATA-CONTRACT-END' });
    expect(bo.documentRules![0].durablePassages).toMatchObject({ total: Number(derniere.seen_count) });
    expect(bo.documentRules![0].durablePassages!.passages[0]).toMatchObject({ runRef: 'p25', trigger: 'SWEEP' });
  });

  it('L75I-E-E2 — échec de journalisation remonté au diagnostic technique (jamais en console seule) ; décision intacte', async () => {
    const compte = await make.account();
    const f = await contratRestitution(compte);
    await sql.unsafe(`ALTER TABLE document_rule_evaluations ADD CONSTRAINT l75i_refus CHECK (file_id <> ${f}) NOT VALID`);
    try {
      const r = await balayage(compte);
      expect(r.ruleErrors).toEqual(expect.arrayContaining([expect.objectContaining({ fileId: f, step: 'TRACE', kind: 'TRACE_FAILED' })]));
      expect(await ouvertes(f, KEY_IV)).toHaveLength(1);
    } finally {
      await sql.unsafe(`ALTER TABLE document_rule_evaluations DROP CONSTRAINT IF EXISTS l75i_refus`);
    }
  });

  it('L75I-E-E3 — suppression de cible : fermeture ET événement d’audit (TARGET_DELETED) ; fermeture d’intervention tracée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat' });
    const c = await carte(compte, f);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f}`;
    const { closeActionsForDeletedTargets } = await import('@/services/to-process/producers.service');
    expect(await closeActionsForDeletedTargets(compte.id)).toBe(1);
    expect(await evenements(c)).toEqual([expect.objectContaining({ event: 'TARGET_DELETED', details: expect.objectContaining({ reason: 'TARGET_DELETED' }) })]);

    // Obligation devenue sans objet (clause retirée) : carte d'intervention fermée, tracée.
    const g = await contratRestitution(compte);
    await balayage(compte);
    const [iv] = await ouvertes(g, KEY_IV);
    await sql`UPDATE document_facts SET value_text = 'Aucune démarche', excerpt = 'Aucune démarche', status = 'superseded' WHERE file_id = ${g} AND fact_key = 'conditionsRestitution'`;
    await balayage(compte);
    expect(await ouvertes(g, KEY_IV)).toEqual([]);
    expect((await evenements(iv.id)).at(-1)).toMatchObject({ event: 'OBSOLETE', details: { reason: 'NO_ACTION_NEEDED' } });
  });
});
