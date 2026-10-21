/**
 * Lot 76C — ticket « [P1] À traiter — Corriger les défauts résiduels du lot
 * 72C et sécuriser la réévaluation » (RES-01 à RES-23), sur PostgreSQL 16
 * réel (migrations 0581 et 0582 appliquées par le bootstrap).
 *
 * Vérifie les données RÉELLEMENT persistées : valeurs calculées (nature,
 * provenance, motifs de refus), cartes actives et fermées, décisions
 * (`document_rule_evaluations`, `to_process_decisions`), traces non écrites et
 * leur reprise (`to_process_trace_retries`), campagnes (éléments, reprises,
 * bilan), collecte T6. Dates RELATIVES au jour d'exécution. T4
 * (CLASSIFY_EVENT, `t4_output_v3`) est SIMULÉ de façon générique : une
 * obligation n'est reconnue que si une CLAUSE transmise la prouve ; aucune
 * règle propre à un fournisseur ni à un contrat. Assertions limitées aux
 * comptes créés ici.
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
const NEUF_ANS = jour(-3300);
const RESTITUTION = 'Le locataire doit restituer le matériel loué dans un délai de 30 jours.';

let t4Mode: 'normal' | 'failure' | 'invalid' = 'normal';
/**
 * T4 simulé GÉNÉRIQUE : une obligation n'existe que si une clause transmise la
 * prouve (restituer, remettre, préavis) — preuve citée telle quelle. Titre
 * « PANNE-E2E » : panne persistante (reprise de campagne).
 */
function t4Simule(input: { prompt: string }): unknown {
  if (t4Mode === 'failure' || input.prompt.includes('PANNE-E2E')) throw Object.assign(new Error('T4 indisponible (e2e)'), { code: 'PROVIDER_UNAVAILABLE' });
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any> } : {};
  const demande = ctx.event_context?.toProcessAssessment as { situation: string; knownDate?: string; clauses?: string[] } | undefined;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (!demande) return { ...base, intervention: null };
  if (t4Mode === 'invalid') return { ...base, intervention: null };
  const aucune = { needed: 'no', kind: null, action: null, justification: 'aucune démarche (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
  const clauses = demande.clauses ?? [];
  const restitution = clauses.find((c) => /restitu|remettre/i.test(c));
  if (demande.knownDate) {
    return restitution
      ? { ...base, homeCategory: 'action', intervention: { needed: 'yes', kind: 'RETURN_OR_RESTITUTE', action: 'Restituer ce qui est prévu au contrat', justification: 'clause (simulé)',
        consequence: null, evidence: restitution, timing: 'NOW', actBy: null, dataNeeded: false } }
      : { ...base, intervention: aucune };
  }
  if (demande.situation === 'UNDATED') {
    const preavis = clauses.find((c) => /pr[ée]avis/i.test(c));
    return { ...base, homeCategory: 'action', intervention: { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat',
      justification: preavis ? 'préavis à respecter (simulé)' : 'contrat en cours (simulé)', consequence: null, evidence: preavis ?? null, timing: 'NOW', actBy: null, dataNeeded: true } };
  }
  return { ...base, intervention: aucune };
}

scenario('L76C-ATP', 'À traiter : défauts résiduels du lot 72C, réévaluation sécurisée (RES-01 à RES-23)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  beforeAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule); });
  afterAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null); });
  afterEach(async () => {
    t4Mode = 'normal';
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
  });

  const doc = async (compte: Compte, p: {
    title: string; type?: string; supplier?: string | null; assetId?: number;
    facts?: Array<{ key?: string | null; raw?: string; label?: string; value: string; norm?: string | null; confidence?: string; excerpt?: string }>;
    units?: Array<{ kind: string; label?: string | null; value?: string | null; text?: string | null; coverage?: string }>;
    endDate?: { value: string; user?: boolean; kind?: string };
  }) => {
    const bien = p.assetId ?? (await make.asset(compte)).id;
    const f = await make.assetFile(compte, { assetId: bien });
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
                VALUES (${compte.id}, ${f.id}, ${id}, ${`u${n}`}, ${u.kind}, ${n}, ${u.text ?? null}, ${u.label ?? null}, ${u.value ?? null}, ${u.coverage ?? 'COVERED'})`;
    }
    if (p.endDate) {
      await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated, value_kind)
                VALUES (${compte.id}, ${f.id}, 'contractEndDate', ${p.endDate.value}, ${p.endDate.user ? 'USER' : p.endDate.kind === 'CALCULATED' ? 'SYSTEM_RULE' : 'RECONCILIATION'},
                        ${p.endDate.user === true}, ${p.endDate.kind ?? 'EXPLICIT'})`;
    }
    return f.id;
  };
  const uniteEn = async (compte: Compte, fileId: number, texte: string, ordinal = 50) => sql`
    INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, coverage_status)
    SELECT ${compte.id}, ${fileId}, id, ${`u-${ordinal}`}, 'TEXT_BLOCK', ${ordinal}, ${texte}, 'COVERED' FROM document_extractions WHERE file_id = ${fileId}`;
  const carte = async (compte: Compte, targetId: number, p: { kind?: string; field?: string; rule?: string; type?: string } = {}) => (await sql<{ id: number }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
    VALUES (${compte.id}, ${p.type ?? 'DOCUMENT'}, ${targetId}, ${p.field ?? 'contractEndDate'}, ${p.kind ?? 'COMPLETE'}, ${p.rule ?? 'DATA-CONTRACT-END'}, 'Question (e2e)') RETURNING id`)[0].id;
  const cartes = async (targetId: number, key = 'contractEndDate', type = 'DOCUMENT') => sql<Array<{ id: number; public_id: string; kind: string; open: boolean; reason: string | null; ctx: any }>>`
    SELECT id, public_id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason, trigger_context AS ctx
      FROM to_process_actions WHERE target_type = ${type} AND target_id = ${targetId} AND COALESCE(field_key, relation_key) = ${key} ORDER BY id`;
  const ouvertes = async (targetId: number, key = 'contractEndDate', type = 'DOCUMENT') => (await cartes(targetId, key, type)).filter((c) => c.open);
  const valeur = async (fileId: number) => (await sql<Array<{ v: string | null; u: boolean; kind: string | null; derivation: any }>>`
    SELECT value_text AS v, user_validated AS u, value_kind AS kind, derivation FROM document_field_values WHERE file_id = ${fileId} AND field_key = 'contractEndDate'`)[0] ?? null;
  const diag = async (fileId: number, rule = 'DATA-CONTRACT-END') => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = ${rule} ORDER BY id`;
  const decisions = async (accountId: number, type: string, id: number) => sql<Array<Record<string, any>>>`
    SELECT * FROM to_process_decisions WHERE account_id = ${accountId} AND target_type = ${type} AND target_id = ${id} ORDER BY id`;
  const appelsT4 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't4_classify_event');
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  const aReevaluer = async (compte: Compte) => (await import('@/services/to-process/document-rule-bridge')).documentsToReevaluate(compte.id);
  const fin = async (debut: string, mois: number) => (await import('@/services/to-process/document-derivations')).endFromStart(debut, mois);
  /** Décision « ancien moteur » posée sur la connaissance actuelle (seule la version du moteur la remet en cause). */
  const ancienneDecision = async (compte: Compte, fileId: number, p: { outcome: string; pertinence?: string | null; reason?: string }) => {
    const { currentKnowledgeRev } = await import('@/services/to-process/document-field-evidence');
    await sql`INSERT INTO document_rule_evaluations (account_id, file_id, rule_code, field_key, trigger_code, engine_version, decision, reason_code, signature, outcome, pertinence, knowledge_rev, config_ref)
              VALUES (${compte.id}, ${fileId}, 'DATA-CONTRACT-END', 'contractEndDate', 'SWEEP', 'l75-1', 'NONE', ${p.reason ?? 'NO_ACTION_NEEDED'}, ${`ancien-${fileId}`},
                      ${p.outcome}, ${p.pertinence ?? null}, ${await currentKnowledgeRev(compte.id, fileId)}, 'det:structured')`;
  };
  const KEY_IV = 'intervention:contractEndDate';
  const svcCampagne = () => import('@/services/to-process/relevance-campaign.service');
  /** Campagne dédiée, poursuivie jusqu'à la fin du parcours (ou l'attente de reprises). */
  const campagne = async (code: string) => {
    const svc = await svcCampagne();
    await svc.startRelevanceCampaign({ code, trigger: 'manual' });
    let r = await svc.runRelevanceCampaign({ deadline: Date.now() + 180_000 });
    while (r.more) r = await svc.runRelevanceCampaign({ deadline: Date.now() + 180_000 });
    return { r, vue: (await svc.listRelevanceCampaigns(20)).find((c) => c.code === code)! };
  };
  const elements = async (code: string, accountId: number) => sql<Array<Record<string, any>>>`
    SELECT i.* FROM to_process_relevance_campaign_items i JOIN to_process_relevance_campaigns c ON c.id = i.campaign_id
     WHERE c.code = ${code} AND i.account_id = ${accountId} ORDER BY i.id`;

  // ══════════════════════════════════════════════════════════════════════
  // C1 — calculs faussement fiables
  // ══════════════════════════════════════════════════════════════════════

  it('RES-01 — « 1,5 ans » : 18 mois exacts recalculés (jamais 60 mois fiables) ; « 1,3 ans » : valeur calculée retirée, motif tracé ; valeur utilisateur intacte', async () => {
    const compte = await make.account();
    const debut = jour(-200);
    const faux = await fin(debut.iso, 60);
    const exact = await doc(compte, { title: 'Contrat de location',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso }, { raw: 'dureeContrat', label: 'Durée du contrat', value: '1,5 ans', norm: null }],
      endDate: { value: faux!, kind: 'CALCULATED' } });
    const inexact = await doc(compte, { title: 'Contrat de location',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso }, { raw: 'dureeContrat', label: 'Durée du contrat', value: '1,3 ans', norm: null }],
      endDate: { value: faux!, kind: 'CALCULATED' } });
    const utilisateur = await doc(compte, { title: 'Contrat de location',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso }, { raw: 'dureeContrat', label: 'Durée du contrat', value: '1.5 ans', norm: null }],
      endDate: { value: faux!, user: true } });
    for (const f of [exact, inexact]) await ancienneDecision(compte, f, { outcome: 'AUTO_RESOLVED', reason: 'CALCULATED_UNCHANGED' });
    expect(await aReevaluer(compte)).toEqual(expect.arrayContaining([exact, inexact]));
    await balayage(compte);
    expect(await valeur(exact)).toMatchObject({ v: await fin(debut.iso, 18), kind: 'CALCULATED', derivation: { status: 'CALCULATED_RELIABLE', duration: { months: 18 } } });
    expect(await valeur(inexact)).toBeNull();
    // Valeur retirée (jamais conservée comme une certitude) ; motif de refus et provenance tracés.
    expect((await diag(inexact)).at(-1)).toMatchObject({ engine_version: 'l76-2',
      derivation: { status: 'NOT_DERIVABLE', reason: 'duration_refused:inexact_decimal_duration', refusals: [expect.objectContaining({ value: '1,3 ans', reason: 'inexact_decimal_duration' })] } });
    expect((await diag(inexact)).at(-1)!.reason_code).not.toBe('CALCULATED_UNCHANGED');
    expect(await valeur(utilisateur)).toMatchObject({ v: faux, u: true });
  });

  it('RES-02 / RES-03 — « 12 mois et quinze jours », faits concurrents « 12 mois » et « 36 ou 48 mois » : aucune valeur fiable persistée, motifs tracés', async () => {
    const compte = await make.account();
    const debut = jour(-30);
    const partielle = await doc(compte, { title: 'Contrat',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso }, { raw: 'dureeContrat', label: 'Durée du contrat', value: '12 mois et quinze jours', norm: null }],
      endDate: { value: (await fin(debut.iso, 12))!, kind: 'CALCULATED' } });
    const concurrents = await doc(compte, { title: 'Contrat',
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso },
        { raw: 'dureeContrat', label: 'Durée du contrat', value: '12 mois', norm: null },
        { raw: 'dureeEngagement', label: 'Durée d’engagement', value: '36 ou 48 mois', norm: null }] });
    await ancienneDecision(compte, partielle, { outcome: 'AUTO_RESOLVED', reason: 'CALCULATED_UNCHANGED' });
    await balayage(compte);
    expect(await valeur(partielle)).toBeNull();
    expect((await diag(partielle)).at(-1)!.derivation).toMatchObject({ reason: 'duration_refused:uninterpreted_component' });
    expect(await valeur(concurrents)).toBeNull();
    expect((await diag(concurrents)).at(-1)!.derivation).toMatchObject({ status: 'AMBIGUOUS', reason: expect.stringContaining('competing_duration_facts') });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C2 — preuve de fin effective
  // ══════════════════════════════════════════════════════════════════════

  it('RES-05 à RES-08 — non renouvelable, fin future, « n’est pas résilié », clause conditionnelle : jamais « contrat terminé » ; ancienne décision CONTRACT_TERMINATED réexaminée', async () => {
    const compte = await make.account();
    const textes = ['Contrat non renouvelable.', `Le contrat prend fin le ${jour(3000).slash}.`, 'Le contrat n’est pas résilié.', 'Le contrat peut être résilié en cas de non-paiement.'];
    const ids: number[] = [];
    for (const t of textes) {
      ids.push(await doc(compte, { title: 'Contrat d’abonnement', facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: NEUF_ANS.iso },
        { raw: 'statutContrat', label: 'Statut', value: t, norm: null, excerpt: t }] }));
    }
    // Décision de l'ANCIENNE détection (« contrat terminé ») posée sur le premier : réexaminée.
    await ancienneDecision(compte, ids[0], { outcome: 'NO_ACTION', pertinence: 'CONTRACT_TERMINATED', reason: 'NO_ACTION_NEEDED' });
    const replay = await rejouer([]);
    await balayage(compte);
    for (const [k, f] of ids.entries()) {
      const d = (await diag(f)).at(-1)!;
      expect(d.pertinence, textes[k]).not.toBe('CONTRACT_TERMINATED');
      expect(d.outcome, textes[k]).toBe('DEFER');
      expect(await ouvertes(f), textes[k]).toEqual([]);
    }
    expect(appelsT4(replay)).toHaveLength(0);
  });

  it('RES-09 — fin effective prouvée ET obligation résiduelle : l’obligation est préservée (carte d’intervention), jamais « terminé »', async () => {
    const compte = await make.account();
    const texte = `Le contrat a pris fin le ${PASSE.slash}. ${RESTITUTION}`;
    const f = await doc(compte, { title: 'Contrat de location de matériel',
      facts: [{ key: 'contractEndDate', label: 'Date de fin', value: PASSE.iso }, { raw: 'statutContrat', label: 'Statut', value: texte, norm: null, excerpt: texte }],
      endDate: { value: PASSE.iso } });
    await balayage(compte);
    expect((await diag(f)).at(-1)).toMatchObject({ situation: 'KNOWN_DEADLINE', outcome: 'CREATE_ACTION' });
    expect(await ouvertes(f, KEY_IV)).toHaveLength(1);
    expect((await diag(f)).at(-1)!.pertinence).not.toBe('CONTRACT_TERMINATED');
  });

  // ══════════════════════════════════════════════════════════════════════
  // C3 — configuration T4 incompatible
  // ══════════════════════════════════════════════════════════════════════

  it('RES-10 — contrat T4 ancien, configuration illisible, sortie invalide : aucune carte arbitraire, aucune fermeture, état T4 et reprise tracés', async () => {
    const compte = await make.account();
    const ev = await import('@/services/to-process/document-field-evidence');
    const passee = await doc(compte, { title: 'Contrat de maintenance', facts: [{ raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Fin du contrat.' }] });
    const sansDate = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', value: jour(-60).iso }] });
    const c1 = await carte(compte, passee);
    const replay = await rejouer([]);
    ev.__setT4AssessmentConfigForTests({ ref: 'bo:v2:t4_output_v2', interventionCapable: false });
    await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(0);
    expect((await cartes(passee)).find((x) => x.id === c1)).toMatchObject({ open: true });
    expect(await cartes(sansDate)).toEqual([]);
    for (const f of [passee, sansDate]) {
      expect((await diag(f)).at(-1)).toMatchObject({ outcome: expect.stringMatching(/DEFER|KEEP/), pertinence: 'T4_INCOMPATIBLE',
        decision_contract: { t4: { state: 'INCOMPATIBLE', configRef: 'bo:v2:t4_output_v2', resume: expect.stringContaining('t4_output_v3') } } });
    }
    // Configuration illisible : indisponibilité technique (distincte), carte conservée, erreur visible.
    ev.__setT4AssessmentConfigForTests({ ref: 'unknown', interventionCapable: false, unavailable: true });
    const r = await balayage(compte);
    expect((await cartes(passee)).find((x) => x.id === c1)).toMatchObject({ open: true });
    expect((await diag(passee)).at(-1)).toMatchObject({ pertinence: 'UNDECIDED', decision_contract: { t4: { state: 'UNAVAILABLE' } } });
    expect(r.ruleErrors.filter((e) => e.fileId === passee)).toEqual([expect.objectContaining({ kind: 'AI_OR_MEMORY_FAILED' })]);
    // Sortie invalide (bloc d'évaluation absent) : distincte, carte conservée, aucune carte créée.
    ev.__setT4AssessmentConfigForTests({ ref: 'bo:v3:t4_output_v3', interventionCapable: true });
    t4Mode = 'invalid';
    await balayage(compte);
    expect((await cartes(passee)).find((x) => x.id === c1)).toMatchObject({ open: true });
    expect(await cartes(sansDate)).toEqual([]);
    expect((await diag(sansDate)).at(-1)).toMatchObject({ decision_contract: { t4: { state: 'INVALID_OUTPUT' } } });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C4 — preuves des documents liés
  // ══════════════════════════════════════════════════════════════════════

  it('RES-11 / RES-12 — clause déterminante ajoutée dans un document du MÊME contrat (aucune valeur retenue modifiée) : décision invalidée et réévaluée avec la clause ; autre contrat du même bien et du même fournisseur : intact', async () => {
    const compte = await make.account();
    const bien = (await make.asset(compte)).id;
    const contrat = (ref: string) => ({ key: 'contractNumber', label: 'N° de contrat', value: ref });
    const a = await doc(compte, { title: 'Contrat de location', assetId: bien, supplier: 'ACME',
      facts: [contrat('CTR-2024-0042'), { key: 'contractEndDate', label: 'Date de fin', value: PASSE.iso }], endDate: { value: PASSE.iso } });
    const lie = await doc(compte, { title: 'Avenant', type: 'LETTER', assetId: bien, supplier: 'ACME', facts: [contrat('CTR-2024-0042')] });
    const autre = await doc(compte, { title: 'Contrat de location', assetId: bien, supplier: 'ACME',
      facts: [contrat('CTR-2024-0099'), { key: 'contractEndDate', label: 'Date de fin', value: PASSE.iso }], endDate: { value: PASSE.iso } });
    const replay = await rejouer([]);
    await balayage(compte);
    expect((await diag(a)).at(-1)).toMatchObject({ situation: 'KNOWN_DEADLINE', pertinence: 'NO_OBLIGATION_EVIDENCE' });
    expect(await aReevaluer(compte)).not.toEqual(expect.arrayContaining([a]));
    const appels = appelsT4(replay).length;
    const valeursAvant = await sql`SELECT file_id, field_key, value_text FROM document_field_values WHERE file_id = ${lie} ORDER BY field_key`;
    // Clause ajoutée dans l'avenant — aucune valeur retenue de l'avenant ne change.
    await uniteEn(compte, lie, RESTITUTION);
    expect(await sql`SELECT file_id, field_key, value_text FROM document_field_values WHERE file_id = ${lie} ORDER BY field_key`).toEqual(valeursAvant);
    const liste = await aReevaluer(compte);
    expect(liste).toContain(a);
    expect(liste).not.toContain(autre);
    await balayage(compte);
    // Réévaluation EFFECTIVE avec la preuve nouvelle : T4 a reçu la clause de l'avenant, carte d'intervention.
    expect(appelsT4(replay).length).toBeGreaterThan(appels);
    expect(await ouvertes(a, KEY_IV)).toHaveLength(1);
    expect((await diag(a)).at(-1)).toMatchObject({ outcome: 'CREATE_ACTION', situation: 'KNOWN_DEADLINE' });
    // Autre contrat (même bien, même fournisseur) : aucune propagation.
    expect(await ouvertes(autre, KEY_IV)).toEqual([]);
    expect((await diag(autre)).at(-1)).toMatchObject({ pertinence: 'NO_OBLIGATION_EVIDENCE' });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C5 — admissibilité sans présomption (agenda)
  // ══════════════════════════════════════════════════════════════════════

  it('RES-13 / RES-14 / RES-15 — agenda : sans catégorie → aucune nécessité présumée ; « à savoir » → aucune complétion ; « action » → carte justifiée ; événement saisi (décision PO 72C) → carte', async () => {
    const compte = await make.account();
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    const ins = async (p: { title: string; home?: string | null; origin?: string; auto?: boolean }) => (await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, home_category)
      VALUES (${compte.id}, ${p.title}, NULL, ${p.auto ?? true}, ${p.origin ?? 'qualified_document'}, ${p.home ?? null}) RETURNING id`)[0].id;
    const sansCategorie = await ins({ title: 'Échéance lue dans un document' });
    const sansCategorieAvecCarte = await ins({ title: 'Échéance lue (carte antérieure)' });
    const information = await ins({ title: 'Changement de tarif', home: 'information' });
    const action = await ins({ title: 'Contrôle technique', home: 'action' });
    const saisi = await ins({ title: 'Appeler le plombier', origin: 'manual', auto: false });
    const ancienne = await carte(compte, sansCategorieAvecCarte, { type: 'AGENDA_ITEM', field: 'date', rule: 'DATA-AGENDA-DATE' });
    await produceAgendaActions(compte.id);
    expect(await cartes(sansCategorie, 'date', 'AGENDA_ITEM')).toEqual([]);
    expect((await decisions(compte.id, 'AGENDA_ITEM', sansCategorie)).at(-1)).toMatchObject({ outcome: 'DEFER', reason_code: expect.stringContaining('UNKNOWN_CRITERIA:neededForUse') });
    // Carte antérieure : jamais fermée sur un « pas encore » (aucune décision fiable).
    expect((await cartes(sansCategorieAvecCarte, 'date', 'AGENDA_ITEM')).find((c) => c.id === ancienne)).toMatchObject({ open: true });
    expect(await cartes(information, 'date', 'AGENDA_ITEM')).toEqual([]);
    expect((await decisions(compte.id, 'AGENDA_ITEM', information)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'INFORMATIONAL_EVENT' });
    expect(await ouvertes(action, 'date', 'AGENDA_ITEM')).toHaveLength(1);
    expect((await decisions(compte.id, 'AGENDA_ITEM', action)).at(-1)).toMatchObject({ outcome: 'CREATE_ACTION', effect: 'CREATED' });
    expect(await ouvertes(saisi, 'date', 'AGENDA_ITEM')).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════
  // C6 — décisions de l'utilisateur
  // ══════════════════════════════════════════════════════════════════════

  it('RES-16 / RES-17 — « Non applicable » : même situation → ni IA ni réouverture ; nouvelle obligation PROUVÉE sans proposition de valeur → réévaluation contrôlée, décision historique conservée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: jour(-60).iso }] });
    const replay = await rejouer([]);
    await balayage(compte);
    const [q] = await ouvertes(f);
    expect(q).toMatchObject({ kind: 'COMPLETE' });
    const { markNotApplicable } = await import('@/services/to-process/resolve-action.service');
    expect(await markNotApplicable(compte.id, q.public_id, { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    const appels = appelsT4(replay).length;
    for (let i = 0; i < 2; i += 1) await balayage(compte);
    expect(await ouvertes(f)).toEqual([]);
    expect(appelsT4(replay)).toHaveLength(appels);
    // Nouvelle obligation prouvée (clause de préavis) — aucune valeur proposée.
    await uniteEn(compte, f, 'Le préavis de résiliation doit être envoyé trois mois avant l’échéance du contrat.');
    await balayage(compte);
    const apres = await cartes(f);
    expect(apres.find((x) => x.id === q.id)).toMatchObject({ open: false, reason: 'NOT_APPLICABLE' });
    const nouvelle = apres.filter((x) => x.open);
    expect(nouvelle).toEqual([expect.objectContaining({ kind: 'COMPLETE' })]);
    expect(nouvelle[0].ctx.justification).toMatchObject({ proof: expect.any(String) });
    // Rejoué sans changement : la même carte, aucun nouvel appel.
    const n = appelsT4(replay).length;
    await balayage(compte);
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([nouvelle[0].id]);
    expect(appelsT4(replay)).toHaveLength(n);
  });

  it('RES-18 — décision « C’est fait » respectée pour la même obligation ; obligation DISTINCTE de même nature, sans date : nouvelle carte', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location',
      facts: [{ key: 'contractEndDate', label: 'Date de fin', value: PASSE.iso }, { raw: 'conditionsRestitution', label: 'Restitution', value: 'Le locataire doit restituer le décodeur.', norm: null, excerpt: 'Le locataire doit restituer le décodeur.' }],
      endDate: { value: PASSE.iso } });
    await balayage(compte);
    const [iv] = await ouvertes(f, KEY_IV);
    expect(iv).toBeDefined();
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, iv.public_id, 'DONE', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    // Même obligation, reformulée dans le document (même preuve citée) : décision respectée.
    await sql`UPDATE document_facts SET label = 'Conditions de restitution' WHERE file_id = ${f} AND fact_key = 'conditionsRestitution'`;
    await balayage(compte);
    expect(await ouvertes(f, KEY_IV)).toEqual([]);
    // Obligation DISTINCTE (autre objet), même nature, sans date : jamais assimilée.
    await sql`UPDATE document_facts SET value_text = 'Le locataire doit remettre les clés du local.', excerpt = 'Le locataire doit remettre les clés du local.'
              WHERE file_id = ${f} AND fact_key = 'conditionsRestitution'`;
    await balayage(compte);
    const toutes = await cartes(f, KEY_IV);
    expect(toutes.find((x) => x.id === iv.id)).toMatchObject({ open: false, reason: 'USER_ARBITRATED' });
    expect(toutes.filter((x) => x.open)).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════
  // C7 — campagne rétroactive et reprise des erreurs
  // ══════════════════════════════════════════════════════════════════════

  it('RES-19 — décision de la version COURANTE devenue périmée (connaissance changée) : prise en compte par la campagne (phase décisions), mêmes règles que la production', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: NEUF_ANS.iso }] });
    await balayage(compte);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'DEFER', engine_version: 'l76-2', pertinence: 'UNDATED_HISTORICAL' });
    // Connaissance changée APRÈS la décision (version courante) : fin effective constatée.
    await uniteEn(compte, f, `Le contrat a été résilié le ${jour(-2000).slash}.`);
    const code = `l76-e2e-res19-${compte.id}`;
    await campagne(code);
    const items = await elements(code, compte.id);
    expect(items.filter((i) => i.target_id === f && i.phase === 'DECISIONS')).toEqual([expect.objectContaining({ rule_code: 'DATA-CONTRACT-END', outcome: 'NO_CARD' })]);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'CONTRACT_TERMINATED', trigger_code: 'BACKFILL' });
  });

  it('RES-20 — erreur pendant un lot, interruption puis reprise : élément repris (issue après reprise), première erreur conservée, bilan exact, aucun doublon ; erreur persistante maintenue BLOQUANTE', async () => {
    const compte = await make.account();
    const repris = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', value: jour(-60).iso }] });
    const persistant = await doc(compte, { title: 'Contrat PANNE-E2E', facts: [{ key: 'contractStartDate', value: jour(-60).iso }] });
    const c1 = await carte(compte, repris);
    const c2 = await carte(compte, persistant);
    const svc = await svcCampagne();
    const code = `l76-e2e-res20-${compte.id}`;
    await svc.startRelevanceCampaign({ code, trigger: 'manual' });
    // Interruption immédiate : rien n'est consigné, rien n'est perdu.
    expect(await svc.runRelevanceCampaign({ deadline: Date.now() - 1 })).toMatchObject({ more: true, done: false });
    t4Mode = 'failure';
    let r = await svc.runRelevanceCampaign({ deadline: Date.now() + 180_000 });
    while (r.more) r = await svc.runRelevanceCampaign({ deadline: Date.now() + 180_000 });
    let items = await elements(code, compte.id);
    expect(items.find((i) => i.action_id === c1)).toMatchObject({ outcome: 'ERROR', attempts: 1, last_error: expect.any(String), first_error: expect.any(String) });
    expect(new Date(items.find((i) => i.action_id === c1)!.retry_after).getTime()).toBeGreaterThan(Date.now());
    // Parcours terminé ≠ campagne terminée : des erreurs restent à reprendre.
    let vue = (await svc.listRelevanceCampaigns(20)).find((c) => c.code === code)!;
    expect(vue.status).toBe('RUNNING');
    expect(vue.traversalFinishedAt).not.toBeNull();
    expect(vue.errors!.pending).toBeGreaterThanOrEqual(2);
    // Reprise (délai de reprise écoulé — simulé) : T4 rétabli.
    t4Mode = 'normal';
    for (let k = 0; k < 4; k += 1) {
      await sql`UPDATE to_process_relevance_campaign_items SET retry_after = now() - interval '1 second'
                 WHERE campaign_id = (SELECT id FROM to_process_relevance_campaigns WHERE code = ${code}) AND last_error IS NOT NULL`;
      r = await svc.runRelevanceCampaign({ deadline: Date.now() + 180_000 });
      if (r.done) break;
    }
    items = await elements(code, compte.id);
    expect(items.find((i) => i.action_id === c1)).toMatchObject({ outcome: 'ERROR', final_outcome: 'KEPT', last_error: null, first_error: expect.any(String) });
    expect(Number(items.find((i) => i.action_id === c1)!.attempts)).toBeGreaterThanOrEqual(2);
    // Erreur persistante : bornée, maintenue BLOQUANTE (jamais « réévaluée » par l'avancement du curseur).
    const bloque = items.find((i) => i.action_id === c2)!;
    expect(bloque).toMatchObject({ final_outcome: 'ERROR', last_error: expect.any(String) });
    expect(Number(bloque.attempts)).toBe(svc.CAMPAIGN_MAX_ATTEMPTS);
    vue = (await svc.listRelevanceCampaigns(20)).find((c) => c.code === code)!;
    expect(vue.status).toBe('DONE_WITH_ERRORS');
    expect(vue.errors!.blocking).toBeGreaterThanOrEqual(1);
    expect(vue.errors!.recovered).toBeGreaterThanOrEqual(1);
    // Bilan exact : recalculé depuis les éléments ; aucun doublon d'élément ni de carte.
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM to_process_relevance_campaign_items WHERE campaign_id = ${vue.id}`;
    expect(vue.outcomes.examined).toBe(n);
    expect(items.filter((i) => i.action_id === c1)).toHaveLength(1);
    expect(await ouvertes(repris)).toHaveLength(1);
    expect(await ouvertes(persistant)).toHaveLength(1);
    // Relance BO des erreurs bloquantes : remises en reprise (bornée).
    expect(await svc.retryCampaignErrors(vue.id)).toBeGreaterThanOrEqual(1);
    expect((await svc.listRelevanceCampaigns(20)).find((c) => c.code === code)!.status).toBe('RUNNING');
    await sql`UPDATE to_process_relevance_campaigns SET status = 'DONE_WITH_ERRORS' WHERE id = ${vue.id}`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // C8 — échecs de traçabilité
  // ══════════════════════════════════════════════════════════════════════

  it('RES-21 — échec de journalisation : décision appliquée signalée NON tracée (n° de reprise, BO), puis trace rejouée ; trace remplacée par une évaluation plus récente : jamais réinsérée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location', facts: [{ key: 'contractEndDate', label: 'Date de fin', value: PASSE.iso },
      { raw: 'conditionsRestitution', label: 'Restitution', value: RESTITUTION, norm: null, excerpt: RESTITUTION }], endDate: { value: PASSE.iso } });
    const [{ id: item }] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, is_automatic, origin_type, home_category)
                                                     VALUES (${compte.id}, 'Révision chaudière', true, 'qualified_document', 'action') RETURNING id`;
    await sql.unsafe(`ALTER TABLE document_rule_evaluations ADD CONSTRAINT l76c_refus CHECK (file_id <> ${f}) NOT VALID`);
    await sql.unsafe(`ALTER TABLE to_process_decisions ADD CONSTRAINT l76c_refus_f CHECK (target_id <> ${item} OR target_type <> 'AGENDA_ITEM') NOT VALID`);
    let rapport: Awaited<ReturnType<typeof balayage>>;
    try {
      rapport = await balayage(compte);
      await (await import('@/services/to-process/producers.service')).produceAgendaActions(compte.id).then((r) => {
        expect(r.errorDetails).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'TRACE_FAILED', targetId: item, retryId: expect.any(Number) })]));
      });
    } finally {
      await sql.unsafe(`ALTER TABLE document_rule_evaluations DROP CONSTRAINT IF EXISTS l76c_refus`);
      await sql.unsafe(`ALTER TABLE to_process_decisions DROP CONSTRAINT IF EXISTS l76c_refus_f`);
    }
    // La décision est appliquée (carte d'intervention) mais signalée non tracée, avec sa reprise.
    expect(await ouvertes(f, KEY_IV)).toHaveLength(1);
    expect(await diag(f)).toEqual([]);
    const echec = rapport.ruleErrors.find((e) => e.fileId === f && e.kind === 'TRACE_FAILED' && e.ruleCode === 'DATA-CONTRACT-END')!;
    expect(echec).toMatchObject({ step: 'TRACE', retryId: expect.any(Number), cause: expect.stringContaining('reprise n°') });
    const tr = await import('@/services/to-process/trace-retries');
    const bo = await tr.traceRetryOverview({ accountId: compte.id });
    expect(bo.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: echec.retryId, status: 'PENDING', targetId: f, decision: expect.objectContaining({ outcome: 'CREATE_ACTION' }) })]));
    const { getT3OpenActionsDiagnostic } = await import('@/services/ai/queue/t3-open-actions-diagnostic');
    expect((await getT3OpenActionsDiagnostic({ accountId: compte.id })).untracedDecisions?.items.length).toBeGreaterThanOrEqual(2);
    // Reprise (délai écoulé — simulé) : traces écrites après coup, diagnostic complet.
    await sql`UPDATE to_process_trace_retries SET next_attempt_at = now() - interval '1 second' WHERE account_id = ${compte.id}`;
    await tr.replayPendingTraces({ limit: 500 });
    const rows = await sql<Array<{ status: string; target_type: string }>>`SELECT status, target_type FROM to_process_trace_retries WHERE account_id = ${compte.id} ORDER BY id`;
    expect(rows.every((x) => x.status === 'REPLAYED')).toBe(true);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'CREATE_ACTION', passages: [expect.objectContaining({ replayed: true })] });
    expect((await decisions(compte.id, 'AGENDA_ITEM', item)).at(-1)).toMatchObject({ outcome: 'CREATE_ACTION' });
    // Trace en échec, puis évaluation plus récente tracée : la reprise ne la réinsère pas (SUPERSEDED).
    const g = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', value: jour(-60).iso }] });
    await sql.unsafe(`ALTER TABLE document_rule_evaluations ADD CONSTRAINT l76c_refus2 CHECK (file_id <> ${g}) NOT VALID`);
    try { await balayage(compte); } finally { await sql.unsafe(`ALTER TABLE document_rule_evaluations DROP CONSTRAINT IF EXISTS l76c_refus2`); }
    await sql`UPDATE document_facts SET excerpt = 'Date d’effet : voir conditions.' WHERE file_id = ${g}`;
    await balayage(compte);
    await sql`UPDATE to_process_trace_retries SET next_attempt_at = now() - interval '1 second' WHERE account_id = ${compte.id} AND status = 'PENDING'`;
    await tr.replayPendingTraces({ limit: 500 });
    const remplaces = (await sql<Array<{ status: string }>>`SELECT status FROM to_process_trace_retries WHERE account_id = ${compte.id} AND target_id = ${g}`).map((x) => x.status);
    expect(remplaces.length).toBeGreaterThanOrEqual(1);
    expect(remplaces.every((x) => x === 'SUPERSEDED')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Cohérence T6, rejeu
  // ══════════════════════════════════════════════════════════════════════

  it('RES-22 — obligation réglée dans « À traiter » puis génération T6 : sujet RÉSOLU (non retenu) ; obligation distincte prouvée : de nouveau active', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location', facts: [{ key: 'contractEndDate', label: 'Date de fin', value: PASSE.iso },
      { raw: 'conditionsRestitution', label: 'Restitution', value: 'Le locataire doit restituer le décodeur.', norm: null, excerpt: 'Le locataire doit restituer le décodeur.' }],
      endDate: { value: PASSE.iso } });
    const [{ id: echeance }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, origin_field_key, home_category)
      VALUES (${compte.id}, 'Fin du contrat de location', ${PASSE.iso}, true, 'qualified_document', 'asset_file', ${f}, 'contractEndDate', 'action') RETURNING id`;
    await balayage(compte);
    const [iv] = await ouvertes(f, KEY_IV);
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    await resolveArbitration(compte.id, iv.public_id, 'DONE', { userId: compte.ownerUserId });
    for (let i = 0; i < 2; i += 1) await balayage(compte);
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { t6Candidates } = await import('@/services/home/mascot/t6-interpellation.service');
    const retenu = async () => t6Candidates(await collectMascotData(compte.id)).find((c) => c.candidate.agendaItemId === echeance)?.candidate.state;
    // Sujet effectivement écarté de l'affichage (RESOLVED), pas seulement présent dans la collecte.
    expect(await retenu()).toBe('RESOLVED');
    expect(await ouvertes(f, KEY_IV)).toEqual([]);
    // Nouvel élément justifié (obligation distincte prouvée) : la relance redevient légitime.
    await sql`UPDATE document_facts SET value_text = 'Le locataire doit remettre les clés du local.', excerpt = 'Le locataire doit remettre les clés du local.'
              WHERE file_id = ${f} AND fact_key = 'conditionsRestitution'`;
    await balayage(compte);
    expect(await ouvertes(f, KEY_IV)).toHaveLength(1);
    expect(await retenu()).toBe('ACTIVE');
  });

  it('RES-23 — réexécution sans changement métier (balayages, campagne) : aucune réouverture, aucun calcul différent, aucun appel IA redondant, traces dédupliquées', async () => {
    const compte = await make.account();
    const debut = jour(-200);
    // Marqueur des documents de ce test : la campagne parcourt toute la base, seuls NOS appels T4 comptent.
    const m = `RES23-${compte.id}`;
    const nosAppels = (replay: { calls: Array<{ operationCode?: string; prompt?: string }> }) => appelsT4(replay).filter((c) => (c as { prompt?: string }).prompt?.includes(m));
    const calc = await doc(compte, { title: `Contrat de location ${m}`,
      facts: [{ key: 'contractStartDate', label: 'Date d’effet', value: debut.iso }, { raw: 'dureeContrat', label: 'Durée du contrat', value: '1,5 ans', norm: null }] });
    const ia = await doc(compte, { title: `Contrat de télésurveillance ${m}`, facts: [{ key: 'contractStartDate', value: jour(-60).iso }] });
    const obligation = await doc(compte, { title: `Contrat de location ${m}`, facts: [{ key: 'contractEndDate', label: 'Date de fin', value: PASSE.iso },
      { raw: 'conditionsRestitution', label: 'Restitution', value: RESTITUTION, norm: null, excerpt: RESTITUTION }], endDate: { value: PASSE.iso } });
    const replay = await rejouer([]);
    // Première exécution puis seconde (carte créée → maintenue) : état stabilisé.
    for (let i = 0; i < 2; i += 1) await balayage(compte);
    const etat = async () => ({
      valeur: await valeur(calc), cartes: (await sql`SELECT id, resolved_at IS NULL AS open FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY id`),
      lignes: (await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM document_rule_evaluations WHERE account_id = ${compte.id}`)[0].n,
    });
    const avant = await etat();
    const appels = nosAppels(replay).length;
    expect(appels).toBeGreaterThanOrEqual(1);
    expect(avant.valeur).toMatchObject({ v: await fin(debut.iso, 18), kind: 'CALCULATED' });
    for (let i = 0; i < 2; i += 1) await balayage(compte);
    await campagne(`l76-e2e-res23-${compte.id}`);
    expect(await etat()).toEqual(avant);
    expect(nosAppels(replay)).toHaveLength(appels);
    expect(await ouvertes(ia)).toHaveLength(1);
    expect(await ouvertes(obligation, KEY_IV)).toHaveLength(1);
  });
});
