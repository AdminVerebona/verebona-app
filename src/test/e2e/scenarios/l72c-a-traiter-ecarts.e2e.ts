/**
 * Lot 72C — ticket « [P1] À traiter — Corriger les écarts résiduels de
 * pertinence, de calcul et de réévaluation » (ATP-FIX-01 à ATP-FIX-19), sur
 * PostgreSQL 16 réel (migrations 0516 et 0517 appliquées par le bootstrap).
 *
 * Vérifie les données RÉELLEMENT persistées : valeurs retenues (nature,
 * provenance), cartes actives et fermées (motif tracé), décisions tracées
 * (`document_rule_evaluations`, `to_process_decisions`), campagne et bilan.
 * Dates RELATIVES au jour d'exécution. T4 (CLASSIFY_EVENT, `t4_output_v3`)
 * est SIMULÉ de façon générique (mode « intervention » / « aucune » / panne) ;
 * aucune règle propre à un fournisseur ni à un contrat dans le code testé.
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
  const d = new Date(Date.now() + decalage * 86_400_000);
  const iso = d.toISOString().slice(0, 10);
  const [y, m, j] = iso.split('-');
  return { iso, slash: `${j}/${m}/${y}` };
};
const PASSE = jour(-40);
const PROCHE = jour(50);
const SIX_ANS = jour(-2200);
const NEUF_ANS = jour(-3300);

let t4Mode: 'needed' | 'none' | 'failure' = 'needed';
/** T4 simulé générique : « needed » → date utile (sans date) / démarche (échéance passée) ; « none » → aucune intervention. */
function t4Simule(input: { prompt: string }): unknown {
  if (t4Mode === 'failure') throw Object.assign(new Error('T4 indisponible (e2e)'), { code: 'PROVIDER_UNAVAILABLE' });
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any> } : {};
  const demande = ctx.event_context?.toProcessAssessment as { situation: string } | undefined;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (!demande) return { ...base, intervention: null };
  const aucune = { needed: 'no', kind: null, action: null, justification: 'aucune démarche restante (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
  if (t4Mode === 'none') return { ...base, intervention: aucune };
  const intervention = demande.situation === 'UNDATED'
    ? { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat', justification: 'contrat en cours (simulé)', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true }
    : aucune;
  return { ...base, homeCategory: intervention.needed === 'yes' ? 'action' : 'information', intervention };
}

scenario('L72C-ATP', 'À traiter : écarts résiduels de pertinence, de calcul et de réévaluation (ATP-FIX-01 à ATP-FIX-19)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  beforeAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule); });
  afterAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null); });
  afterEach(async () => {
    t4Mode = 'needed';
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
  });

  const doc = async (compte: Compte, p: {
    title: string; type?: string; supplier?: string | null; assetId?: number | null;
    facts?: Array<{ key?: string | null; raw?: string; label?: string; value: string; norm?: string | null; confidence?: string; excerpt?: string }>;
    units?: Array<{ kind: string; label?: string | null; value?: string | null; coverage?: string }>;
  }) => {
    const f = await make.assetFile(compte, { assetId: p.assetId ?? null });
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${f.id}, ${p.title}, ${p.type ?? 'SERVICE_CONTRACT'}, NULL, 0) RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${p.type ?? 'SERVICE_CONTRACT'}, analysis_state = 'ANALYZED', original_filename = 'Contrat.pdf',
                     supplier = ${p.supplier ?? null} WHERE id = ${f.id}`;
    for (const x of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${f.id}, ${id}, ${x.raw ?? x.key ?? 'fait'}, ${x.label ?? null}, ${x.value}, ${x.norm === undefined ? x.value : x.norm},
                        ${x.confidence ?? 'certain'}, ${x.excerpt ?? `${x.label ?? x.key ?? 'fait'} : ${x.value}`}, ${x.key ?? null})`;
    }
    let n = 0;
    for (const u of p.units ?? []) {
      n += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, label, value_text, coverage_status)
                VALUES (${compte.id}, ${f.id}, ${id}, ${`u${n}`}, ${u.kind}, ${n}, NULL, ${u.label ?? null}, ${u.value ?? null}, ${u.coverage ?? 'COVERED'})`;
    }
    return f.id;
  };
  const fournisseur = async (compte: Compte, nom = 'ACME') => (await sql<{ id: number }[]>`
    INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name) VALUES (${compte.id}, ${compte.ownerUserId}, ${nom}, ${nom.toLowerCase()}) RETURNING id`)[0].id;
  const carte = async (compte: Compte, targetId: number, p: { kind?: string; field?: string | null; relation?: string | null; rule?: string; type?: string } = {}) =>
    (await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, relation_key, action_kind, rule_code, question)
      VALUES (${compte.id}, ${p.type ?? 'DOCUMENT'}, ${targetId}, ${p.relation ? null : (p.field ?? 'contractEndDate')}, ${p.relation ?? null},
              ${p.kind ?? 'COMPLETE'}, ${p.rule ?? 'DATA-CONTRACT-END'}, 'Question (e2e)')
      RETURNING id`)[0].id;
  const cartes = async (targetId: number, key = 'contractEndDate', type = 'DOCUMENT') => sql<Array<{ id: number; public_id: string; kind: string; open: boolean; reason: string | null; p: unknown }>>`
    SELECT id, public_id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason, proposals_json AS p
      FROM to_process_actions WHERE target_type = ${type} AND target_id = ${targetId} AND COALESCE(field_key, relation_key) = ${key} ORDER BY id`;
  const ouvertes = async (targetId: number, key = 'contractEndDate', type = 'DOCUMENT') => (await cartes(targetId, key, type)).filter((c) => c.open);
  const valeur = async (fileId: number) => (await sql<Array<{ v: string | null; u: boolean; kind: string | null; derivation: any }>>`
    SELECT value_text AS v, user_validated AS u, value_kind AS kind, derivation FROM document_field_values WHERE file_id = ${fileId} AND field_key = 'contractEndDate'`)[0] ?? null;
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  const diag = async (fileId: number, rule = 'DATA-CONTRACT-END') => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = ${rule} ORDER BY id`;
  const decisions = async (accountId: number, type: string, id: number) => sql<Array<Record<string, any>>>`
    SELECT * FROM to_process_decisions WHERE account_id = ${accountId} AND target_type = ${type} AND target_id = ${id} ORDER BY id`;
  const evenements = async (actionId: number) => sql<Array<{ event: string; details: any }>>`SELECT event, details FROM to_process_action_events WHERE action_id = ${actionId} ORDER BY id`;
  const appelsT4 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't4_classify_event');
  const aReevaluer = async (compte: Compte) => (await import('@/services/to-process/document-rule-bridge')).documentsToReevaluate(compte.id);
  const fin = async (debut: string, mois: number, convention?: 'ANNIVERSARY') => (await import('@/services/to-process/document-derivations')).endFromStart(debut, mois, convention);

  // ══════════════════════════════════════════════════════════════════════
  // C1 — calculs déterministes
  // ══════════════════════════════════════════════════════════════════════

  it('ATP-FIX-01 — prêt de 240 mois dont 12 mois de différé : 240 mois écrits (CALCULATED, provenance), jamais 252 ; contrat d’entretien « de date à date »', async () => {
    const compte = await make.account();
    const debut = jour(-500);
    const pret = await doc(compte, { title: 'Offre de prêt', type: 'FINANCING_CONTRACT',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso }, { raw: 'dureePret', label: 'Durée du prêt', value: '240 mois, dont 12 mois de différé', norm: null }] });
    const entretien = await doc(compte, { title: 'Contrat d’entretien', type: 'MAINTENANCE_CONTRACT',
      facts: [{ key: 'contractStartDate', label: 'Date de début', value: debut.iso }, { raw: 'dureeContrat', label: 'Durée du contrat', value: '1 an de date à date', norm: null }] });
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await valeur(pret)).toMatchObject({ v: await fin(debut.iso, 240), kind: 'CALCULATED', u: false,
      derivation: { status: 'CALCULATED_RELIABLE', duration: { months: 240, status: 'TOTAL_WITH_INCLUDED' } } });
    expect((await valeur(pret))!.v).not.toBe(await fin(debut.iso, 252));
    expect(await valeur(entretien)).toMatchObject({ v: await fin(debut.iso, 12, 'ANNIVERSARY'), kind: 'CALCULATED', derivation: { convention: 'ANNIVERSARY' } });
    expect((await diag(pret)).at(-1)).toMatchObject({ outcome: 'AUTO_RESOLVED', decision_kind: 'AUTO_RESOLVED', engine_version: 'l76-2' });
    expect(appelsT4(replay)).toHaveLength(0);
  });

  it('ATP-FIX-01 / C1 — valeur CALCULÉE par l’ancien moteur (252 mois) : recalculée ; valeur de l’utilisateur jamais modifiée', async () => {
    const compte = await make.account();
    const debut = jour(-500);
    const faits = [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso }, { raw: 'dureePret', label: 'Durée du prêt', value: '240 mois, dont 12 mois de différé', norm: null }];
    const ancien = await doc(compte, { title: 'Offre de prêt', type: 'FINANCING_CONTRACT', facts: faits });
    const utilisateur = await doc(compte, { title: 'Offre de prêt', type: 'FINANCING_CONTRACT', facts: faits });
    const faux = await fin(debut.iso, 252);
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated, value_kind, derivation)
              VALUES (${compte.id}, ${ancien}, 'contractEndDate', ${faux}, 'SYSTEM_RULE', false, 'CALCULATED', '{"method":"START_PLUS_DURATION"}'::jsonb),
                     (${compte.id}, ${utilisateur}, 'contractEndDate', ${faux}, 'USER', true, 'EXPLICIT', NULL)`;
    // Décision de l'ancien moteur, connaissance inchangée depuis : seule la version du moteur la remet en cause.
    const { currentKnowledgeRev } = await import('@/services/to-process/document-field-evidence');
    await sql`INSERT INTO document_rule_evaluations (account_id, file_id, rule_code, field_key, trigger_code, engine_version, decision, reason_code, signature, outcome, knowledge_rev)
              VALUES (${compte.id}, ${ancien}, 'DATA-CONTRACT-END', 'contractEndDate', 'SWEEP', 'l61-1', 'NONE', 'CALCULATED_UNCHANGED', 'ancien', 'AUTO_RESOLVED', ${await currentKnowledgeRev(compte.id, ancien)})`;
    expect(await aReevaluer(compte)).toContain(ancien);
    await balayage(compte);
    expect(await valeur(ancien)).toMatchObject({ v: await fin(debut.iso, 240), kind: 'CALCULATED' });
    expect(await valeur(utilisateur)).toMatchObject({ v: faux, u: true });
    // Rejoué : plus rien à revoir (décision confirmée par le moteur courant).
    expect(await aReevaluer(compte)).not.toContain(ancien);
  });

  it('ATP-FIX-02 — contrat de 12 mois renouvelable : aucune durée de 24 mois, aucune écriture ; ancienne valeur calculée retirée', async () => {
    const compte = await make.account();
    const debut = jour(-30);
    const f = await doc(compte, { title: 'Contrat de location de matériel',
      facts: [{ key: 'contractStartDate', label: 'Date de début', value: debut.iso }, { raw: 'dureeContrat', label: 'Durée du contrat', value: '12 mois renouvelables pour 12 mois', norm: null }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated, value_kind)
              VALUES (${compte.id}, ${f}, 'contractEndDate', ${await fin(debut.iso, 24)}, 'SYSTEM_RULE', false, 'CALCULATED')`;
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    const d = (await diag(f)).at(-1)!;
    expect(d.derivation).toMatchObject({ status: 'CALCULATED_PROBABLE', duration: { months: 12, status: 'INITIAL_TERM_RENEWABLE' } });
  });

  it('ATP-FIX-03 — durée composite ambiguë : aucune écriture fiable automatique', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat d’abonnement', type: 'SUBSCRIPTION_CONTRACT',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: jour(-20).iso }, { raw: 'dureeEngagement', label: 'Durée d’engagement', value: '36 ou 48 mois', norm: null }] });
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    expect((await diag(f)).at(-1)!.derivation).toMatchObject({ status: 'AMBIGUOUS', reason: expect.stringContaining('alternative_durations') });
  });

  it('ATP-FIX-04 — date d’édition + durée : aucune date de fin déduite (même sous une clé « début »)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Offre de prêt', type: 'FINANCING_CONTRACT',
      facts: [{ key: 'contractStartDate', label: 'Date d’édition', value: jour(-10).iso }, { raw: 'dureePret', label: 'Durée du prêt', value: '20 ans', norm: null }] });
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    expect((await diag(f)).at(-1)!.derivation).toMatchObject({ status: 'NOT_DERIVABLE', reason: 'start_is_not_effective' });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C2 — ancienneté jamais preuve
  // ══════════════════════════════════════════════════════════════════════

  it('ATP-FIX-05 — contrat signé il y a six ans, reconductible : jamais NO_ACTION (ni sur l’âge, ni sur un « aucune intervention » sans preuve) ; ancien sans signal : différé sans IA', async () => {
    const compte = await make.account();
    const reconductible = await doc(compte, { title: 'Contrat d’entretien annuel', type: 'MAINTENANCE_CONTRACT',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: SIX_ANS.iso },
        { raw: 'conditionsDuree', label: 'Durée', value: 'Le contrat est reconduit tacitement par périodes d’un an.', norm: null }] });
    const ancien = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'documentDate', label: 'Date du document', value: NEUF_ANS.iso }] });
    const c = await carte(compte, ancien);
    t4Mode = 'none';
    const replay = await rejouer([]);
    await balayage(compte);
    const d = (await diag(reconductible)).at(-1)!;
    expect(d.outcome).not.toBe('NO_ACTION');
    expect(d).toMatchObject({ outcome: 'DEFER', pertinence_reason: expect.stringContaining('renewable_contract_requires_evidence'), decision_kind: 'DEFERRED' });
    expect((await diag(ancien)).at(-1)).toMatchObject({ outcome: 'DEFER', pertinence: 'UNDATED_HISTORICAL', ai_operation: null });
    expect(new Date((await diag(ancien)).at(-1)!.reevaluate_at).getTime()).toBeGreaterThan(Date.now());
    // Carte existante du document ancien : retirée (différée), motif tracé — jamais « contrat terminé ».
    expect((await evenements(c)).at(-1)?.details).toMatchObject({ reason: 'DEFERRED', pertinence: 'UNDATED_HISTORICAL' });
    expect(appelsT4(replay)).toHaveLength(1);
  });

  it('ATP-FIX-06 — contrat réellement clos, sans obligation : aucune carte (carte existante fermée), aucun appel IA', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Abonnement', type: 'SUBSCRIPTION_CONTRACT',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: NEUF_ANS.iso },
        { raw: 'statutContrat', label: 'Statut', value: 'Résiliation effective : le contrat a pris fin, dossier soldé.', norm: null }] });
    const c = await carte(compte, f);
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    expect((await cartes(f)).find((x) => x.id === c)).toMatchObject({ open: false, reason: 'OBSOLETE' });
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'CONTRACT_TERMINATED', reason_code: 'NO_ACTION_NEEDED' });
    expect(appelsT4(replay)).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════════
  // C3 — invalidation de la connaissance
  // ══════════════════════════════════════════════════════════════════════

  it('ATP-FIX-07 — fait actif MODIFIÉ sur la même ligne (aucun nouvel identifiant) : décision invalidée et réévaluée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location',
      facts: [{ raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Le contrat a pris fin.' }] });
    t4Mode = 'none';
    const replay = await rejouer([]);
    await balayage(compte);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'NO_ACTION' });
    expect(await aReevaluer(compte)).not.toContain(f);
    const [{ id: avant }] = await sql<{ id: number }[]>`SELECT max(id)::int AS id FROM document_facts WHERE file_id = ${f}`;
    // Clause modifiée sur la ligne existante (ni nouvelle ligne, ni nouvel identifiant).
    await sql`UPDATE document_facts SET excerpt = 'Le contrat est prolongé de six mois par avenant.' WHERE file_id = ${f}`;
    expect((await sql<{ id: number }[]>`SELECT max(id)::int AS id FROM document_facts WHERE file_id = ${f}`)[0].id).toBe(avant);
    expect(await aReevaluer(compte)).toContain(f);
    await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(2);
    // Valeur / confiance modifiées : aussi.
    expect(await aReevaluer(compte)).not.toContain(f);
    await sql`UPDATE document_facts SET confidence = 'conflictual' WHERE file_id = ${f}`;
    expect(await aReevaluer(compte)).toContain(f);
  });

  it('ATP-FIX-08 / ATP-FIX-18 — nouveau document du même contrat : documents dépendants réévalués ; autre contrat du même bien et du même fournisseur : jamais mélangé', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const commun = { supplier: 'Société Exemple', assetId: bien.id };
    const b = await doc(compte, { title: 'Conditions générales', ...commun,
      facts: [{ key: 'contractNumber', value: 'CTR-2019-445566' }, { key: 'documentDate', value: SIX_ANS.iso }] });
    const c = await doc(compte, { title: 'Autre contrat', ...commun,
      facts: [{ key: 'contractNumber', value: 'CTR-2019-999999' }, { key: 'documentDate', value: SIX_ANS.iso }] });
    await balayage(compte);
    expect((await diag(b)).at(-1)).toMatchObject({ outcome: 'DEFER' });
    expect(await aReevaluer(compte)).not.toContain(b);
    // Nouveau document du MÊME contrat (référence exacte, autre écriture), date validée par l'utilisateur.
    const a = await doc(compte, { title: 'Avenant', ...commun, facts: [{ key: 'contractNumber', value: 'ctr 2019 445566' }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated) VALUES (${compte.id}, ${a}, 'contractEndDate', ${PROCHE.iso}, 'USER', true)`;
    const liste = await aReevaluer(compte);
    expect(liste).toContain(b);
    expect(liste).not.toContain(c);
    await balayage(compte);
    expect(await valeur(b)).toMatchObject({ v: PROCHE.iso, u: false, kind: 'EXPLICIT', derivation: { method: 'RELATED_DOCUMENT', documents: [a] } });
    expect(await valeur(c)).toBeNull();
    expect(await cartes(c)).toHaveLength(0);
  });

  it('ATP-FIX-09 — version T4 active MODIFIÉE puis sauvegardée (même numéro) : décision IA invalidée ; décision sans IA intacte', async () => {
    const compte = await make.account();
    const runtime = await import('@/services/ai/master-prompts/master-prompt-runtime');
    const ev = await import('@/services/to-process/document-field-evidence');
    const execution = { mode: 'STRUCTURED_CONTEXT' as const, inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3', allowedTasks: null };
    const poser = (content: string) => {
      runtime.__setActiveMasterPromptsForTests([{ id: 990001, treatment: 'T4', versionNumber: 990, content, execution }]);
      ev.__setT4AssessmentConfigForTests(null);
    };
    poser('Prompt T4 de référence (e2e).');
    const r1 = (await ev.t4AssessmentConfig()).ref;
    expect(r1).toBe('bo:v990:t4_output_v3');
    const ia = await doc(compte, { title: 'Contrat de location', facts: [{ raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Le contrat a pris fin.' }] });
    const sansIa = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'documentDate', value: NEUF_ANS.iso }] });
    t4Mode = 'none';
    const replay = await rejouer([]);
    await balayage(compte);
    expect((await diag(ia)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', config_ref: r1 });
    expect((await diag(sansIa)).at(-1)!.config_ref).toMatch(/^det:/);
    expect(await aReevaluer(compte)).not.toContain(ia);
    // Remise en forme sans incidence : rien n'est invalidé.
    poser('Prompt   T4 de référence (e2e).');
    expect((await ev.t4AssessmentConfig()).ref).toBe(r1);
    // Révision SAUVEGARDÉE de la version active (même numéro, texte changé).
    poser('Prompt T4 de référence (e2e) — révision : préciser les obligations résiduelles.');
    const r2 = (await ev.t4AssessmentConfig()).ref;
    expect(r2).toMatch(/^bo:v990:t4_output_v3#[0-9a-f]{12}$/);
    const liste = await aReevaluer(compte);
    expect(liste).toContain(ia);
    expect(liste).not.toContain(sansIa);
    await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(2);
    expect((await diag(ia)).at(-1)).toMatchObject({ config_ref: r2 });
    // Retour au contenu de référence : référence historique (base mémorisée, 0516).
    poser('Prompt T4 de référence (e2e).');
    expect((await ev.t4AssessmentConfig()).ref).toBe(r1);
  });

  // ══════════════════════════════════════════════════════════════════════
  // C4 — contrôle de pertinence commun (agenda, équipements, fournisseurs)
  // ══════════════════════════════════════════════════════════════════════

  it('ATP-FIX-10 / ATP-FIX-11 — agenda : événement informatif → aucune complétion ; date retrouvée → écrite ; date nécessaire → carte', async () => {
    const compte = await make.account();
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    const source = await doc(compte, { title: 'Contrat', facts: [] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated) VALUES (${compte.id}, ${source}, 'contractEndDate', ${PROCHE.iso}, 'RECONCILIATION', false)`;
    const ins = async (p: { title: string; home?: string | null; origin?: string; auto?: boolean; ref?: number | null; key?: string | null }) => (await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, origin_field_key, home_category)
      VALUES (${compte.id}, ${p.title}, NULL, ${p.auto ?? true}, ${p.origin ?? 'qualified_document'}, ${p.ref ? 'asset_file' : null}, ${p.ref ?? null}, ${p.key ?? null}, ${p.home ?? null})
      RETURNING id`)[0].id;
    const info = await ins({ title: 'Information : changement de tarif', home: 'information' });
    const tache = await ins({ title: 'Appeler le plombier', origin: 'manual', auto: false });
    const retrouvee = await ins({ title: 'Fin de contrat', home: 'action', ref: source, key: 'finContrat' });
    const necessaire = await ins({ title: 'Contrôle technique', home: 'action' });
    const ancienne = await carte(compte, info, { type: 'AGENDA_ITEM', field: 'date', rule: 'DATA-AGENDA-DATE' });
    await produceAgendaActions(compte.id);
    expect(await ouvertes(info, 'date', 'AGENDA_ITEM')).toHaveLength(0);
    expect((await evenements(ancienne)).at(-1)).toMatchObject({ event: 'OBSOLETE', details: { reason: 'INFORMATIONAL_EVENT', outcome: 'NO_ACTION' } });
    // Événement saisi sans catégorie : question conservée (variante prudente, décision PO).
    expect(await ouvertes(tache, 'date', 'AGENDA_ITEM')).toHaveLength(1);
    expect((await sql<{ d: string }[]>`SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM agenda_items WHERE id = ${retrouvee}`)[0].d).toBe(PROCHE.iso);
    expect(await cartes(retrouvee, 'date', 'AGENDA_ITEM')).toHaveLength(0);
    expect(await ouvertes(necessaire, 'date', 'AGENDA_ITEM')).toHaveLength(1);
    // Traces : chaque décision, avec ou sans carte.
    expect((await decisions(compte.id, 'AGENDA_ITEM', info)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'INFORMATIONAL_EVENT', effect: 'CLOSED', decision_kind: 'MISSING_INFO_NOT_REQUIRED' });
    expect((await decisions(compte.id, 'AGENDA_ITEM', tache)).at(-1)).toMatchObject({ outcome: 'CREATE_ACTION', effect: 'CREATED' });
    expect((await decisions(compte.id, 'AGENDA_ITEM', retrouvee)).at(-1)).toMatchObject({ outcome: 'AUTO_RESOLVED', effect: 'WRITTEN' });
    expect((await decisions(compte.id, 'AGENDA_ITEM', necessaire)).at(-1)).toMatchObject({ outcome: 'CREATE_ACTION', effect: 'CREATED' });
    // Rejoué : l'effet devient « carte maintenue » / « aucune » (une ligne), puis plus aucune trace (déduplication).
    await produceAgendaActions(compte.id);
    const n = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_decisions WHERE account_id = ${compte.id}`)[0].n;
    await produceAgendaActions(compte.id);
    await produceAgendaActions(compte.id);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_decisions WHERE account_id = ${compte.id}`)[0].n).toBe(n);
    expect(await ouvertes(necessaire, 'date', 'AGENDA_ITEM')).toHaveLength(1);
  });

  it('C4 — équipements et fournisseurs : rattachement connu résolu, équipement inactif sans carte, confirmation facultative sans proposition jamais demandée', async () => {
    const compte = await make.account();
    const { produceEquipmentActions, produceSupplierActions } = await import('@/services/to-process/producers.service');
    const supprime = await make.asset(compte);
    const vivant = await make.asset(compte);
    const [{ id: piece }] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${vivant.id}, 'Cuisine') RETURNING id`;
    const [{ id: connu }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, substructure_id, name) VALUES (${supprime.id}, ${piece}, 'Lave-vaisselle') RETURNING id`;
    const [{ id: inactif }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, status) VALUES (${supprime.id}, 'Ancienne chaudière', 'TRANSMIS') RETURNING id`;
    const [{ id: orphelin }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${supprime.id}, 'Climatiseur') RETURNING id`;
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${supprime.id}`;
    await produceEquipmentActions(compte.id);
    expect((await sql<{ a: number }[]>`SELECT asset_id AS a FROM equipments WHERE id = ${connu}`)[0].a).toBe(vivant.id);
    expect(await cartes(connu, 'assetId', 'EQUIPMENT')).toHaveLength(0);
    expect(await cartes(inactif, 'assetId', 'EQUIPMENT')).toHaveLength(0);
    expect(await ouvertes(orphelin, 'assetId', 'EQUIPMENT')).toHaveLength(1);
    expect((await decisions(compte.id, 'EQUIPMENT', inactif)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'EQUIPMENT_INACTIVE' });
    const [{ id: sansProposition }] = await sql<{ id: number }[]>`INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, detected_name, current_value) VALUES (${compte.id}, 'identity', 'open', ${await fournisseur(compte)}, 'Fournisseur', 'ACME') RETURNING supplier_id AS id`;
    const [{ id: utile }] = await sql<{ id: number }[]>`INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, detected_name, current_value, detected_value) VALUES (${compte.id}, 'identity', 'open', ${await fournisseur(compte, 'ACME2')}, 'Acme Services', 'ACME', 'Acme Services') RETURNING supplier_id AS id`;
    await produceSupplierActions(compte.id);
    expect(await cartes(sansProposition, 'identity', 'SUPPLIER')).toHaveLength(0);
    expect((await decisions(compte.id, 'SUPPLIER', sansProposition)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'NO_EXPLOITABLE_PROPOSAL' });
    expect(await ouvertes(utile, 'identity', 'SUPPLIER')).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════
  // C5 — « Non applicable »
  // ══════════════════════════════════════════════════════════════════════

  it('ATP-FIX-12 / ATP-FIX-13 — « Non applicable » : aucune réouverture sans preuve nouvelle (ni IA) ; nouvelle obligation prouvée → réévaluation contrôlée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: jour(-60).iso }] });
    const replay = await rejouer([]);
    await balayage(compte);
    const [q] = await ouvertes(f);
    expect(q).toMatchObject({ kind: 'COMPLETE' });
    const { markNotApplicable } = await import('@/services/to-process/resolve-action.service');
    expect(await markNotApplicable(compte.id, q.public_id, { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    expect((await evenements(q.id)).at(-1)).toMatchObject({ event: 'NOT_APPLICABLE', details: { knowledgeRev: expect.any(String) } });
    const appels = appelsT4(replay).length;
    for (let i = 0; i < 3; i += 1) await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    expect(appelsT4(replay)).toHaveLength(appels);
    expect(await aReevaluer(compte)).not.toContain(f);
    // Changement SANS nouveau problème (même question, aucune valeur) : réévalué, jamais rouvert.
    await sql`UPDATE document_facts SET excerpt = 'Date d’effet du contrat : voir conditions particulières.' WHERE file_id = ${f}`;
    expect(await aReevaluer(compte)).toContain(f);
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    expect((await diag(f)).at(-1)).toMatchObject({ reason_code: 'USER_NOT_APPLICABLE_UNCHANGED', decision_kind: 'USER_REFUSED' });
    // Nouvelle information PERTINENTE : une échéance proche lue dans le document → nouveau cycle (décision antérieure conservée).
    await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, label, value_text, coverage_status)
              SELECT ${compte.id}, ${f}, id, 'u-fin', 'LABEL_VALUE', 99, 'Date de fin de contrat', ${PROCHE.slash}, 'COVERED' FROM document_extractions WHERE file_id = ${f}`;
    await balayage(compte);
    const toutes = await cartes(f);
    expect(toutes.find((x) => x.id === q.id)).toMatchObject({ open: false, reason: 'NOT_APPLICABLE' });
    expect(toutes.filter((x) => x.open)).toEqual([expect.objectContaining({ kind: 'ARBITRATE' })]);
    // Aucun cycle fermeture / réouverture : rejoué, la même carte reste.
    const id = toutes.find((x) => x.open)!.id;
    await balayage(compte);
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([id]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Pannes, campagne, diagnostic, T6, rejeu
  // ══════════════════════════════════════════════════════════════════════

  it('ATP-FIX-14 — échec BDD ou IA : aucune fausse fermeture ni écriture, échec tracé (nature TECHNICAL_FAILURE)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Fin du contrat.' }] });
    const c = await carte(compte, f);
    t4Mode = 'failure';
    await balayage(compte);
    expect((await cartes(f)).find((x) => x.id === c)?.open).toBe(true);
    expect(await valeur(f)).toBeNull();
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'KEEP', reason_code: 'KEPT_ON_TECHNICAL_FAILURE', decision_kind: 'TECHNICAL_FAILURE' });
    t4Mode = 'needed';
    await sql`ALTER TABLE document_facts RENAME TO document_facts_e2e72`;
    try {
      await balayage(compte);
    } finally {
      await sql`ALTER TABLE document_facts_e2e72 RENAME TO document_facts`;
    }
    expect((await cartes(f)).find((x) => x.id === c)?.open).toBe(true);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'ERROR', decision_kind: 'TECHNICAL_FAILURE' });
    // Agenda : lecture impossible → bilan en erreur, aucune carte fermée.
    const [{ id: item }] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, is_automatic, origin_type, home_category) VALUES (${compte.id}, 'Révision', true, 'qualified_document', 'action') RETURNING id`;
    const ca = await carte(compte, item, { type: 'AGENDA_ITEM', field: 'date', rule: 'DATA-AGENDA-DATE' });
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await sql`ALTER TABLE to_process_decisions RENAME TO to_process_decisions_e2e72`;
    try {
      // Trace indisponible : jamais bloquante, la décision reste la même.
      await produceAgendaActions(compte.id);
    } finally {
      await sql`ALTER TABLE to_process_decisions_e2e72 RENAME TO to_process_decisions`;
    }
    expect((await cartes(item, 'date', 'AGENDA_ITEM')).find((x) => x.id === ca)?.open).toBe(true);
    await sql`ALTER TABLE agenda_items RENAME TO agenda_items_e2e72`;
    let bilan: Awaited<ReturnType<typeof import('@/services/to-process/producers.service')['produceAccountActions']>>;
    try {
      bilan = await (await import('@/services/to-process/producers.service')).produceAccountActions(compte.id);
    } finally {
      await sql`ALTER TABLE agenda_items_e2e72 RENAME TO agenda_items`;
    }
    expect(bilan.errors.join(' | ')).toMatch(/agenda/);
    expect((await cartes(item, 'date', 'AGENDA_ITEM')).find((x) => x.id === ca)?.open).toBe(true);
  });

  it('ATP-FIX-15 (lot 83E : contrôle de cohérence) — réévaluation rétroactive MULTI-FAMILLES : issue par carte, décisions sans carte reprises, sans doublon ni suppression', async () => {
    const compte = await make.account();
    const ancien = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'documentDate', value: NEUF_ANS.iso }] });
    const cDoc = await carte(compte, ancien);
    const [{ id: info }] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, is_automatic, origin_type, home_category) VALUES (${compte.id}, 'À savoir', true, 'qualified_document', 'information') RETURNING id`;
    const cAgenda = await carte(compte, info, { type: 'AGENDA_ITEM', field: 'date', rule: 'DATA-AGENDA-DATE' });
    const [{ id: revue }] = await sql<{ id: number }[]>`INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, detected_name, current_value) VALUES (${compte.id}, 'identity', 'open', ${await fournisseur(compte)}, 'X', 'ACME') RETURNING supplier_id AS id`;
    const cFour = await carte(compte, revue, { type: 'SUPPLIER', field: 'identity', rule: 'SUPPLIER-IDENTITY', kind: 'ARBITRATE' });
    // Décision SANS carte de l'ancien moteur : « aucune intervention » sur le seul âge.
    const sansCarte = await doc(compte, { title: 'Contrat de maintenance', facts: [{ key: 'documentDate', value: NEUF_ANS.iso }] });
    await sql`INSERT INTO document_rule_evaluations (account_id, file_id, rule_code, field_key, trigger_code, engine_version, decision, reason_code, signature, outcome, pertinence, pertinence_reason, knowledge_rev)
              VALUES (${compte.id}, ${sansCarte}, 'DATA-CONTRACT-END', 'contractEndDate', 'SWEEP', 'l61-1', 'NONE', 'NO_ACTION_NEEDED', 'ancien', 'NO_ACTION', 'UNDATED_HISTORICAL', 'all_document_dates_older_than_5y', 'ancien')`;
    // Lot 83E (C-Q9) : la campagne de pertinence est RETIRÉE — même réévaluation, même code métier,
    // par les contrôles du registre (COH-TODO-RELEVANCE-CARDS, COH-TODO-STALE-DECISIONS, COH-TODO-DOCUMENT-FIELDS).
    const { runCoherenceFor, proofOf } = await import('../coherence-run');
    const run = await runCoherenceFor(sql, [compte.id]);
    expect(run.status).toBe('COMPLETE');
    const ouverte = async (id: number) => (await sql<{ open: boolean }[]>`SELECT resolved_at IS NULL AS open FROM to_process_actions WHERE id = ${id}`)[0].open;
    // Agenda « à savoir » et fournisseur sans proposition : retirées par leur producteur (décision tracée).
    expect(await ouverte(cAgenda)).toBe(false);
    expect(await ouverte(cFour)).toBe(false);
    expect((await proofOf(sql, compte.id, 'COH-TODO-RELEVANCE-CARDS', cAgenda))?.last_result).toBe('REPAIRED');
    expect((await proofOf(sql, compte.id, 'COH-TODO-RELEVANCE-CARDS', cFour))?.last_result).toBe('REPAIRED');
    // Carte documentaire : jugée par le contrôle « donnée » (une seule chaîne), jamais par deux contrôles.
    expect(await proofOf(sql, compte.id, 'COH-TODO-RELEVANCE-CARDS', cDoc)).toBeNull();
    expect(['REPAIRED', 'CONSISTENT']).toContain((await proofOf(sql, compte.id, 'COH-TODO-DOCUMENT-FIELDS', cDoc))?.last_result);
    // Décision sans carte de l'ancien moteur : reprise (phase « décisions »), différée par le moteur courant.
    expect((await proofOf(sql, compte.id, 'COH-TODO-STALE-DECISIONS', sansCarte))?.last_result).toBe('REPAIRED');
    expect((await diag(sansCarte)).at(-1)).toMatchObject({ outcome: 'DEFER', engine_version: 'l76-2', trigger_code: 'BACKFILL' });
    // Aucune suppression physique ; rejouée : aucune réparation ni doublon.
    expect(await cartes(info, 'date', 'AGENDA_ITEM')).toHaveLength(1);
    const avant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coherence_repairs WHERE account_id = ${compte.id}`)[0].n;
    const run2 = await runCoherenceFor(sql, [compte.id]);
    expect(run2.status).toBe('COMPLETE');
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coherence_repairs WHERE account_id = ${compte.id}`)[0].n).toBe(avant);
  });

  it('ATP-FIX-16 — décision sans création de carte : diagnostic BO explicite (règle, cible, issue, nature, motif, faits, réévaluation)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'documentDate', value: NEUF_ANS.iso }] });
    await balayage(compte);
    const [{ id: item }] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, is_automatic, origin_type, home_category) VALUES (${compte.id}, 'À savoir', true, 'qualified_document', 'information') RETURNING id`;
    await (await import('@/services/to-process/producers.service')).produceAgendaActions(compte.id);
    const { getT3OpenActionsDiagnostic } = await import('@/services/ai/queue/t3-open-actions-diagnostic');
    const docs = await getT3OpenActionsDiagnostic({ documentId: f, ruleCode: 'DATA-CONTRACT-END' });
    expect(docs.documentRules![0]).toMatchObject({ outcome: 'DEFER', decisionKind: 'DEFERRED', reevaluateAt: expect.any(String), configRef: expect.stringMatching(/^det:/) });
    expect(await cartes(f)).toHaveLength(0);
    const fam = await getT3OpenActionsDiagnostic({ accountId: compte.id, ruleCode: 'DATA-AGENDA-DATE' });
    expect(fam.familyDecisions!.find((d) => d.targetId === item)).toMatchObject({
      outcome: 'NO_ACTION', decisionKind: 'MISSING_INFO_NOT_REQUIRED', reasonCode: 'INFORMATIONAL_EVENT', decisiveCheck: 'neededForUse',
      effect: 'NONE', evidence: expect.objectContaining({ homeCategory: 'information' }), trigger: 'SWEEP',
    });
    // Isolation : un autre compte ne voit rien de ce compte.
    const autre = await make.account();
    expect((await getT3OpenActionsDiagnostic({ accountId: autre.id, ruleCode: 'DATA-AGENDA-DATE' })).familyDecisions).toEqual([]);
  });

  it('ATP-FIX-17 — échéance réglée dans « À traiter » (même à venir) : état persisté et lu par la collecte T6 ; simple constat jamais lu comme un règlement', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [] });
    const [iv] = await sql<{ id: number; public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, proposals_json, trigger_context)
      VALUES (${compte.id}, 'DOCUMENT', ${f}, 'intervention:contractEndDate', 'ARBITRATE', 'DOC-INTERVENTION', 'Résilier le contrat',
              '[{"value":"DONE","label":"C’est fait","confidence":0},{"value":"NOT_NEEDED","label":"Pas nécessaire","confidence":0}]'::jsonb,
              '{"intervention":{"kind":"TERMINATE","actBy":null}}'::jsonb) RETURNING id, public_id`;
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, iv.public_id, 'DONE', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    // Échéance À VENIR, clé d'origine sous un ALIAS du registre.
    const [futur] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, origin_field_key)
      VALUES (${compte.id}, 'Fin de contrat', ${PROCHE.iso}, true, 'qualified_document', 'asset_file', ${f}, 'finContrat') RETURNING id`;
    // Échéance passée dont la seule trace est un constat (donnée connue) : PAS réglée.
    const g = await doc(compte, { title: 'Contrat', facts: [] });
    await sql`INSERT INTO document_rule_evaluations (account_id, file_id, rule_code, field_key, trigger_code, engine_version, decision, reason_code, signature, outcome)
              VALUES (${compte.id}, ${g}, 'DATA-CONTRACT-END', 'contractEndDate', 'ANALYSIS', 'l72-1', 'NONE', 'ALREADY_SATISFIED', 's', 'NO_ACTION')`;
    const [passe] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, origin_field_key)
      VALUES (${compte.id}, 'Fin de contrat', ${PASSE.iso}, true, 'qualified_document', 'asset_file', ${g}, 'contractEndDate') RETURNING id`;
    const { settledObligations } = await import('@/services/to-process/settled-obligations');
    const reglees = await settledObligations(compte.id, jour(0).iso);
    expect(reglees.find((o) => o.agendaItemId === futur.id)).toMatchObject({ reason: 'USER_DONE', future: true, dataKey: 'contractEndDate', fileId: f });
    expect(reglees.find((o) => o.agendaItemId === passe.id)).toBeUndefined();
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const raw = await collectMascotData(compte.id);
    expect(raw.toProcessSettledAgendaIds).toContain(futur.id);
    expect(raw.toProcessSettledAgendaIds).not.toContain(passe.id);
    // Aucune réouverture de l'intervention réglée par le moteur « À traiter ».
    for (let i = 0; i < 2; i += 1) await balayage(compte);
    expect(await ouvertes(f, 'intervention:contractEndDate')).toHaveLength(0);
  });

  it('ATP-FIX-19 — réexécution sans modification : aucun appel IA, aucune réouverture, traces dédupliquées', async () => {
    const compte = await make.account();
    const a = await doc(compte, { title: 'Contrat de location', facts: [{ raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Le contrat a pris fin.' }] });
    const b = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: jour(-60).iso }] });
    const c = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'documentDate', value: NEUF_ANS.iso }] });
    const replay = await rejouer([]);
    t4Mode = 'none';
    await balayage(compte);
    t4Mode = 'needed';
    const appels = appelsT4(replay).length;
    const etat = async () => ({
      cartes: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id}`)[0].n,
      ouvertes: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL`)[0].n,
      lignes: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_rule_evaluations WHERE account_id = ${compte.id}`)[0].n,
    });
    const avant = await etat();
    for (let i = 0; i < 3; i += 1) await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(appels);
    expect(await etat()).toEqual(avant);
    expect(await aReevaluer(compte)).not.toContain(a);
    expect(await aReevaluer(compte)).not.toContain(c);
    void b;
  });
});
