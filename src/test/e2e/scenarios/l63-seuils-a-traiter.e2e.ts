/**
 * Lot 63 — décision PO du 16/10 (point 2) : seuils de la pertinence
 * « À traiter » réglables dans BO › Configuration IA › Réglages, sur
 * PostgreSQL 16 réel : vrai stockage des réglages (`verebona_assistant_settings`,
 * journal admin), vraie configuration effective (`t4AssessmentConfig`), vrai
 * balayage documentaire, vraie mémoire de décision (`document_rule_evaluations`).
 * T4 SIMULÉ (générique, comme L61-ATR) : aucune démarche restante.
 *
 *  L63-SEUIL-E2E-01  réglage BO → configuration effective (référence, seuils)
 *  L63-SEUIL-E2E-02  horizon modifié : décision différée invalidée, question posée, seuils tracés
 *  L63-SEUIL-E2E-03  retour aux valeurs par défaut : référence du lot 61, décision différée rétablie
 *  L63-SEUIL-E2E-04  décision IA mémorisée : horizon → pas de rappel T4 ; délai de réévaluation → T4 rappelé
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

const jour = (decalage: number) => {
  const iso = new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);
  const [y, m, j] = iso.split('-');
  return { iso, slash: `${j}/${m}/${y}` };
};
const PASSE = jour(-40);
const LOIN = jour(500);

/** T4 simulé générique : aucune démarche restante (sortie `t4_output_v3`). */
function t4Simule(): unknown {
  return {
    task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null,
    confidence: 'certain', reason: 'simulé', recurrenceReason: null,
    intervention: { needed: 'no', kind: null, action: null, justification: 'aucune démarche restante (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false },
  };
}

const CLES = ['to_process_future_horizon_days', 'to_process_historical_years', 'to_process_defer_uncertain_days', 'to_process_defer_undated_days', 'to_process_defer_title_only_days'];

scenario('L63-SEUIL', 'À traiter : seuils de pertinence réglables dans le BO (L63-SEUIL-E2E-01 à 04)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  const S = () => import('@/services/verebona-assistant/config/assistant-settings');
  const ev = () => import('@/services/to-process/document-field-evidence');
  let adminId = 0;

  /** Réglage modifié depuis le BO (même chemin que l'écran « Réglages ») ; cache de configuration vidé. */
  const regler = async (key: string, value: number) => {
    const r = await (await S()).updateAssistantSetting({ key, value, adminId });
    (await ev()).__setT4AssessmentConfigForTests(null);
    return r;
  };
  const reinitialiser = async () => {
    await sql`DELETE FROM verebona_assistant_settings WHERE key = ANY(${CLES})`;
    await sql`UPDATE verebona_cache_versions SET version = version + 1 WHERE scope = 'assistant-settings'`;
    await (await S()).refreshAssistantSettings(true);
    (await ev()).__setT4AssessmentConfigForTests(null);
  };

  beforeAll(async () => {
    setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule);
    (await S()).setAssistantSettingsStoreForTests((await S()).dbAssistantSettingsStore);
    adminId = (await make.user({ role: 'ADMIN' })).id;
    await reinitialiser();
  });
  afterEach(async () => { await reinitialiser(); });
  afterAll(async () => {
    setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null);
    await reinitialiser();
    (await S()).setAssistantSettingsStoreForTests(null);
  });

  const doc = async (compte: Compte, p: { title: string; facts?: Array<{ raw: string; value: string; excerpt: string }>; units?: Array<{ label: string; value: string }> }) => {
    const f = await make.assetFile(compte, { assetId: null });
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${f.id}, ${p.title}, 'SERVICE_CONTRACT', NULL, 0) RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = 'SERVICE_CONTRACT', analysis_state = 'ANALYZED', original_filename = 'Contrat.pdf' WHERE id = ${f.id}`;
    for (const x of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, normalized_value, confidence, excerpt)
                VALUES (${compte.id}, ${f.id}, ${id}, ${x.raw}, ${x.value}, NULL, 'probable', ${x.excerpt})`;
    }
    let n = 0;
    for (const u of p.units ?? []) {
      n += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, label, value_text, coverage_status)
                VALUES (${compte.id}, ${f.id}, ${id}, ${`u${n}`}, 'LABEL_VALUE', ${n}, ${u.label}, ${u.value}, 'COVERED')`;
    }
    return f.id;
  };
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  const aReevaluer = async (compte: Compte) => (await import('@/services/to-process/document-rule-bridge')).documentsToReevaluate(compte.id);
  const diag = async (fileId: number) => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = 'DATA-CONTRACT-END' ORDER BY id`;
  const ouvertes = async (fileId: number) => sql<Array<{ id: number; kind: string }>>`
    SELECT id, action_kind AS kind FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId}
       AND field_key = 'contractEndDate' AND resolved_at IS NULL`;
  const appelsT4 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't4_classify_event').length;

  it('L63-SEUIL-E2E-01 — réglage modifié dans le BO : journalisé, configuration effective mise à jour (référence et seuils)', async () => {
    const e = await ev();
    const avant = await e.t4AssessmentConfig();
    expect(avant.thresholds).toEqual({ futureHorizonDays: 120, historicalYears: 5, deferUncertainDays: 30, deferUndatedDays: 90, deferTitleOnlyDays: 180 });
    expect(avant.ref).toBe(avant.aiRef);
    expect(avant.ref).not.toContain('seuils');
    expect(await regler('to_process_future_horizon_days', 600)).toMatchObject({ status: 'APPLIED', before: 120, after: 600 });
    const apres = await e.t4AssessmentConfig();
    expect(apres.thresholds?.futureHorizonDays).toBe(600);
    expect(apres.ref).toBe(`${avant.ref}|seuils:h=600`);
    const [journal] = await sql<Array<{ new_value: any }>>`
      SELECT new_value FROM admin_audit_log WHERE action_type = 'ASSISTANT_SETTING_UPDATE' ORDER BY id DESC LIMIT 1`;
    expect(journal.new_value).toMatchObject({ key: 'to_process_future_horizon_days', value: 600 });
    await expect((await S()).updateAssistantSetting({ key: 'to_process_future_horizon_days', value: 2000, adminId })).rejects.toMatchObject({ code: 'INVALID_VALUE' });
  });

  it('L63-SEUIL-E2E-02 / 03 — horizon : échéance à +500 j différée (120 j), question posée avec 600 j (décision invalidée, seuils tracés), différée de nouveau au retour au défaut', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', units: [{ label: 'Date de fin de contrat', value: LOIN.slash }] });
    const replay = await rejouer([]);
    await balayage(compte);
    const d0 = (await diag(f)).at(-1)!;
    expect(d0).toMatchObject({ outcome: 'DEFER', pertinence: 'FUTURE_DEFERRABLE', pertinence_reason: 'future_beyond_120d' });
    expect(d0.config_ref).not.toContain('seuils');
    expect(d0.decision_contract.thresholds).toMatchObject({ futureHorizonDays: 120 });
    expect(new Date(d0.reevaluate_at).toISOString().slice(0, 10)).toBe(jour(500 - 120).iso);
    expect(await aReevaluer(compte)).not.toContain(f);

    await regler('to_process_future_horizon_days', 600);
    expect(await aReevaluer(compte)).toContain(f);
    await balayage(compte);
    const d1 = (await diag(f)).at(-1)!;
    expect(d1).toMatchObject({ outcome: 'CREATE_ACTION', pertinence: 'FUTURE_SOON', pertinence_reason: 'future_within_600d' });
    expect(d1.config_ref).toMatch(/\|seuils:h=600$/);
    expect(d1.decision_contract.thresholds).toEqual({ futureHorizonDays: 600, historicalYears: 5, deferUncertainDays: 30, deferUndatedDays: 90, deferTitleOnlyDays: 180 });
    expect(await ouvertes(f)).toHaveLength(1);
    expect(appelsT4(replay)).toBe(0);

    // Retour à la valeur par défaut (120) : référence du lot 61, la question redevient différée.
    await regler('to_process_future_horizon_days', 120);
    await balayage(compte);
    const d2 = (await diag(f)).at(-1)!;
    expect(d2).toMatchObject({ outcome: 'DEFER', pertinence: 'FUTURE_DEFERRABLE', config_ref: d0.config_ref });
    expect(await ouvertes(f)).toHaveLength(0);
  });

  it('L63-SEUIL-E2E-04 — décision T4 mémorisée : un horizon modifié ne rappelle pas T4 ; un délai de réévaluation modifié la fait réévaluer', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location', facts: [{ raw: 'finContrat', value: PASSE.slash, excerpt: 'Le contrat a pris fin sans reconduction.' }] });
    const replay = await rejouer([]);
    await balayage(compte);
    expect(appelsT4(replay)).toBe(1);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'NO_ACTION_NEEDED' });
    expect(await aReevaluer(compte)).not.toContain(f);

    await regler('to_process_future_horizon_days', 200);
    expect(await aReevaluer(compte)).toContain(f);
    await balayage(compte);
    expect(appelsT4(replay)).toBe(1);
    const d1 = (await diag(f)).at(-1)!;
    expect(d1).toMatchObject({ outcome: 'NO_ACTION', pertinence_reason: 'remembered_decision' });
    expect(d1.config_ref).toMatch(/\|seuils:h=200$/);
    expect(await aReevaluer(compte)).not.toContain(f);

    await regler('to_process_defer_uncertain_days', 45);
    expect(await aReevaluer(compte)).toContain(f);
    await balayage(compte);
    expect(appelsT4(replay)).toBe(2);
    const d2 = (await diag(f)).at(-1)!;
    expect(d2.config_ref).toMatch(/\|seuils:h=200,i=45$/);
    expect(d2.decision_contract.thresholds).toMatchObject({ futureHorizonDays: 200, deferUncertainDays: 45 });
  });
});
