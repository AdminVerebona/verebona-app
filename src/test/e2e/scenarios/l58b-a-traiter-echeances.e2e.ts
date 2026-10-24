/**
 * Lot 58B — ticket P1 « À traiter : questions inutiles sur des échéances
 * passées et données déjà connues » (ECH-01 à ECH-16), sur PostgreSQL réel.
 *
 * Cas constaté (préproduction) : « Quelle est la date de fin de ce contrat ? »
 * sur « Votre contrat de gardiennage de pneus arrive à échéance le
 * 20:06:2026.pdf », alors que l'échéance est passée. Il est REPRODUIT sur une
 * connaissance T1 PERSISTÉE (extraction, faits, unités source, nom de
 * fichier), avec des dates RELATIVES au jour d'exécution (passé / futur).
 *
 * Le modèle T4 (CLASSIFY_EVENT, branche existante, prompt inchangé) est
 * SIMULÉ de façon générique : il classe l'échéance « action » si la preuve
 * transmise évoque une démarche (reconduction, résiliation, renouvellement),
 * « information » sinon — comme le prompt maître (C1, C2) le lui demande.
 * Aucune règle propre au gardiennage dans le code testé.
 *
 * Lot 61 (tickets « À traiter » : écarts 58B, pertinence) : le texte de
 * référence T4 sort en `t4_output_v3` — le simulateur rend aussi le bloc
 * `intervention` quand le serveur le demande (`toProcessAssessment`), de
 * façon GÉNÉRIQUE (démarche évoquée dans le contexte transmis → intervention
 * citant ce passage ; date inconnue d'un contrat récent → date utile ;
 * sinon aucune intervention). Comportements révisés par le lot 61, intention
 * des cas conservée : date du SEUL titre → décision différée (jamais
 * « aucune intervention » sur ce seul indice) ; action attendue → carte
 * d'INTERVENTION (jamais une question de date) ; échéance future lointaine
 * → interpellation différée (les cas d'arbitrage utilisent une date proche).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';
import { useKnowledgeQueryDelivered } from '../knowledge-query';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

/**
 * Date relative au jour (ISO) et ses écritures documentaires. Lot 85F (stabilisation, aucune assertion
 * changée) : la date n'est JAMAIS d'ordre jour / mois ambigu (jour et mois ≤ 12 et différents) — une telle
 * date n'est volontairement jamais « certaine » (lot 72, C1) et rendait ECH-03/04, 09, 12 et 16 dépendants
 * du jour d'exécution (ex. le 24/10/2026 : J+250 = 01/07/2027). On s'éloigne d'aujourd'hui (≤ 12 jours).
 */
const jour = (decalage: number) => {
  for (let n = decalage; ; n += decalage < 0 ? -1 : 1) {
    const iso = new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const [y, m, j] = iso.split('-');
    if (Number(j) <= 12 && Number(m) <= 12 && j !== m) continue;
    return { iso, deuxPoints: `${j}:${m}:${y}`, slash: `${j}/${m}/${y}`, point: `${j}.${m}.${y}` };
  }
};
const PASSE = jour(-117);
const FUTUR = jour(250);
const FUTUR2 = jour(400);
/** Lot 61 : échéances proches (≤ 120 jours) — la date compte maintenant. */
const PROCHE = jour(60);
const PROCHE2 = jour(90);

let t4Mode: 'model' | 'failure' = 'model';
/** Modèle T4 simulé, GÉNÉRIQUE (voir l'en-tête). */
function t4Simule(input: { prompt: string }): unknown {
  if (t4Mode === 'failure') throw Object.assign(new Error('T4 indisponible (e2e)'), { code: 'PROVIDER_UNAVAILABLE' });
  // Seul le contexte d'exécution (événement, preuve) est lu — jamais le texte du prompt maître.
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const contexte = i >= 0 ? input.prompt.slice(i) : '';
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any>; evidence?: string | null } : {};
  const action = /reconduction|résiliation|renouvel/i.test(contexte);
  const demande = ctx.event_context?.toProcessAssessment as { situation: string; documentTitle: string | null } | undefined;
  const base = {
    task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable',
    homeCategory: action ? 'action' : 'information', businessType: null, confidence: 'certain',
    reason: action ? 'démarche attendue (simulé)' : 'échéance historique sans démarche (simulé)', recurrenceReason: null,
  };
  if (!demande) return { ...base, intervention: null };
  const preuve = [ctx.evidence ?? '', demande.documentTitle ?? ''].find((t) => /reconduction|résiliation|renouvel/i.test(t)) ?? null;
  const intervention = demande.situation === 'UNDATED'
    ? { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat', justification: 'contrat en cours (simulé)', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true }
    : demande.situation === 'PAST_DEADLINE' && preuve
      ? { needed: 'yes', kind: 'RENEW_OR_DECIDE', action: 'Décider de la reconduction ou de la résiliation du contrat', justification: 'démarche évoquée (simulé)', consequence: null, evidence: preuve.slice(0, 120), timing: 'NOW', actBy: null, dataNeeded: false }
      : { needed: 'no', kind: null, action: null, justification: 'aucune démarche restante (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
  return { ...base, intervention };
}

scenario('L58B-ECH', 'À traiter : échéances passées et données déjà connues (ECH-01 à ECH-16)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  // Lot 85F : donnée inconnue de TOUTE la connaissance T1 — capacité T3 KNOWLEDGE_QUERY livrée, interprétation sans résultat.
  useKnowledgeQueryDelivered();
  beforeAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule); });
  afterAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null); });

  /** Connaissance T1 PERSISTÉE d'un document (jamais le fichier). */
  const connaissance = async (compte: Compte, fileId: number, p: {
    title: string; type?: string; fullText?: string | null; filename?: string;
    facts?: Array<{ key?: string | null; raw?: string; label?: string; value: string; norm?: string | null; confidence?: string; excerpt?: string }>;
    units?: Array<{ kind: string; text?: string | null; label?: string | null; value?: string | null; coverage?: string }>;
  }) => {
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${fileId}, ${p.title}, ${p.type ?? 'SERVICE_CONTRACT'}, ${p.fullText ?? null}, ${p.fullText?.length ?? 0})
      RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${p.type ?? 'SERVICE_CONTRACT'}, analysis_state = 'ANALYZED',
                     original_filename = ${p.filename ?? 'Contrat.pdf'} WHERE id = ${fileId}`;
    for (const f of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${fileId}, ${id}, ${f.raw ?? f.key ?? 'fait'}, ${f.label ?? null}, ${f.value},
                        ${f.norm === undefined ? f.value : f.norm}, ${f.confidence ?? 'certain'},
                        ${f.excerpt ?? `${f.label ?? f.key ?? 'fait'} : ${f.value}`}, ${f.key ?? null})`;
    }
    let i = 0;
    for (const u of p.units ?? []) {
      i += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, label, value_text, coverage_status)
                VALUES (${compte.id}, ${fileId}, ${id}, ${`u${i}`}, ${u.kind}, ${i}, ${u.text ?? null}, ${u.label ?? null}, ${u.value ?? null}, ${u.coverage ?? 'COVERED'})`;
    }
    return id;
  };
  /** Document de contrat (ou autre Type) analysé. */
  const doc = async (compte: Compte, p: Parameters<typeof connaissance>[2]) => {
    const f = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, f.id, p);
    return f.id;
  };
  const carte = async (compte: Compte, fileId: number, rule = 'DATA-CONTRACT-END', field = 'contractEndDate') =>
    (await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
      VALUES (${compte.id}, 'DOCUMENT', ${fileId}, ${field}, 'COMPLETE', ${rule}, 'Quelle est la date de fin de ce contrat ?')
      RETURNING id`)[0].id;
  const cartes = async (fileId: number, field = 'contractEndDate') => sql<Array<{ id: number; kind: string; open: boolean; reason: string | null; p: unknown }>>`
    SELECT id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason, proposals_json AS p
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND field_key = ${field} ORDER BY id`;
  const ouvertes = async (fileId: number, field = 'contractEndDate') => (await cartes(fileId, field)).filter((c) => c.open);
  const valeur = async (fileId: number, key = 'contractEndDate') => (await sql<{ v: string | null; u: boolean }[]>`
    SELECT value_text AS v, user_validated AS u FROM document_field_values WHERE file_id = ${fileId} AND field_key = ${key}`)[0] ?? null;
  const balayage = async (compte: Compte) => {
    const { produceDocumentActions } = await import('@/services/to-process/producers.service');
    return produceDocumentActions(compte.id);
  };
  const diag = async (fileId: number, rule = 'DATA-CONTRACT-END') => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = ${rule} ORDER BY id`;
  const appelsT4 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't4_classify_event');
  const props = (p: unknown) => ((typeof p === 'string' ? JSON.parse(p) : p) ?? []) as Array<{ value: unknown }>;

  it('ECH-01 — cas constaté : échéance passée suggérée par le nom « …le JJ:MM:AAAA.pdf », sans action : AUCUNE carte, IA consultée une fois, diagnostic complet (lot 61 : titre = indice, décision différée)', async () => {
    const compte = await make.account();
    const nom = `Votre contrat de gardiennage de pneus arrive à échéance le ${PASSE.deuxPoints}.pdf`;
    const f = await doc(compte, { title: nom.replace('.pdf', ''), filename: nom });
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    expect(await valeur(f)).toBeNull(); // le titre seul ne prouve pas la date
    expect(appelsT4(replay)).toHaveLength(1);
    const [d] = await diag(f);
    expect(d).toMatchObject({
      account_id: compte.id, trigger_code: 'SWEEP', engine_version: 'l76-2' /* lot 72 : version du moteur « À traiter » */, target_present: false, decision: 'NONE',
      reason_code: 'DEFERRED', pertinence: 'TITLE_HINT_ONLY', ai_operation: 't4_classify_event', ai_status: 'OK', outcome: 'DEFER', situation: 'TITLE_ONLY',
    });
    expect(d.title_hint).toMatchObject({ dates: [PASSE.iso], confirmed: [] });
    expect(d.sources).toMatchObject({ TITLE_HINT: 1 });
  });

  it('ECH-01 — date passée CONNUE dans T1 (fait certain) : enregistrée (information conservée), aucune carte, aucun appel IA', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de gardiennage', facts: [{ key: 'contractEndDate', value: PASSE.iso }] });
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await valeur(f)).toMatchObject({ v: PASSE.iso, u: false });
    expect(await cartes(f)).toHaveLength(0);
    expect(appelsT4(replay)).toHaveLength(0);
    expect((await diag(f))[0]).toMatchObject({ decision: 'WRITE', write_verified: true });
  });

  it('ECH-02 — date future connue : aucune demande de date redondante (champ déjà renseigné ou repris de T1)', async () => {
    const compte = await make.account();
    const a = await doc(compte, { title: 'Contrat entretien' });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
              VALUES (${compte.id}, ${a}, 'contractEndDate', ${FUTUR.iso}, 'DOCUMENT_EXTRACTION', false)`;
    const b = await doc(compte, { title: 'Contrat entretien', facts: [{ key: 'contractEndDate', value: FUTUR.iso }] });
    await balayage(compte);
    expect(await cartes(a)).toHaveLength(0);
    expect(await cartes(b)).toHaveLength(0);
    expect((await valeur(b))?.v).toBe(FUTUR.iso);
  });

  it('ECH-03 / ECH-04 — date brute « JJ:MM:AAAA » d’un fait générique (alias, non canonique) : rapprochée, normalisée et écrite automatiquement', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: null, raw: 'dateFinContrat', value: FUTUR.deuxPoints, norm: null }] });
    await balayage(compte);
    expect(await valeur(f)).toMatchObject({ v: FUTUR.iso, u: false });
    expect(await cartes(f)).toHaveLength(0);
    const [d] = await diag(f);
    expect(d.observations).toEqual([expect.objectContaining({ source: 'FACTS', key: 'dateFinContrat', raw: FUTUR.deuxPoints, normalized: FUTUR.iso, status: 'NORMALIZED' })]);
  });

  it('ECH-04 — « JJ.MM.AAAA » lue dans une unité « libellé : valeur » : proposition normalisée (À arbitrer, jamais écrite seule) ; forme ambiguë rejetée et tracée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', units: [{ kind: 'LABEL_VALUE', label: 'Date de fin de contrat', value: PROCHE.point }] });
    const g = await doc(compte, { title: 'Contrat', units: [{ kind: 'LABEL_VALUE', label: 'Date de fin de contrat', value: '20/06/26' }] });
    await balayage(compte);
    const [c] = await ouvertes(f);
    expect(c.kind).toBe('ARBITRATE');
    expect(props(c.p).map((x) => x.value)).toEqual([PROCHE.iso]);
    expect(await valeur(f)).toBeNull();
    const [dg] = await diag(g);
    expect(dg.observations).toEqual([expect.objectContaining({ raw: '20/06/26', normalized: null, status: 'REFUSED_AMBIGUOUS' })]);
    expect((await ouvertes(g))[0].kind).toBe('COMPLETE');
  });

  it('ECH-05 — date suggérée par le titre ET retrouvée dans le contenu : proposée (preuve vérifiée), jamais écrite sans validation', async () => {
    const compte = await make.account();
    const f = await doc(compte, {
      title: `Contrat de maintenance — reconduction tacite, échéance ${PROCHE.slash}`,
      fullText: `Le présent contrat prend fin le ${PROCHE.slash}.`,
    });
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    const [c] = await ouvertes(f);
    expect(c.kind).toBe('ARBITRATE');
    expect(props(c.p).map((x) => x.value)).toEqual([PROCHE.iso]);
    expect((await diag(f))[0].title_hint).toMatchObject({ dates: [PROCHE.iso], confirmed: [PROCHE.iso] });
  });

  it('ECH-06 — dates contradictoires : arbitrage justifié sans écriture ; validation utilisateur jamais écrasée ; retrait utilisateur respecté', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: PROCHE.iso }, { key: null, raw: 'finContrat', value: PROCHE2.slash, norm: null }] });
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    const [c] = await ouvertes(f);
    expect(c.kind).toBe('ARBITRATE');
    expect(props(c.p).map((x) => x.value).sort()).toEqual([PROCHE.iso, PROCHE2.iso].sort());

    const u = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: FUTUR2.iso }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
              VALUES (${compte.id}, ${u}, 'contractEndDate', ${FUTUR.iso}, 'USER', true)`;
    const { resolveDocumentRuleFromKnowledge } = await import('@/services/to-process/document-rule-bridge');
    await balayage(compte);
    expect(await valeur(u)).toMatchObject({ v: FUTUR.iso, u: true });
    expect(await ouvertes(u)).toHaveLength(0);

    const r = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: FUTUR2.iso }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
              VALUES (${compte.id}, ${r}, 'contractEndDate', NULL, 'USER', true)`;
    const c2 = await carte(compte, r);
    expect(await resolveDocumentRuleFromKnowledge(compte.id, r, 'DATA-CONTRACT-END')).toMatchObject({ status: 'USER_PROTECTED' });
    expect((await valeur(r))?.v).toBeNull();
    expect((await cartes(r)).find((x) => x.id === c2)?.open).toBe(true);
  });

  it('ECH-07 — contrat reconductible, échéance passée (date probable), T4 : action attendue → lot 61 : carte décrivant l’ACTION réelle, jamais une question de date', async () => {
    const compte = await make.account();
    const f = await doc(compte, {
      title: 'Contrat d’abonnement — reconduction tacite sauf résiliation',
      units: [{ kind: 'LABEL_VALUE', label: 'Fin de contrat', value: PASSE.slash }],
    });
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    const [c] = await ouvertes(f, 'intervention:contractEndDate');
    expect(c.kind).toBe('ARBITRATE');
    expect(props(c.p).map((x) => x.value)).toEqual(['DONE', 'NOT_NEEDED']);
    expect(appelsT4(replay)).toHaveLength(1);
    expect((await diag(f))[0]).toMatchObject({ decision: 'NONE', reason_code: 'REPLACED_BY_INTERVENTION', pertinence: 'ACTION_REQUIRED', outcome: 'CREATE_ACTION' });
  });

  it('ECH-07 — T4 indisponible : variante prudente (lot 61 : aucune carte arbitraire, pertinence UNDECIDED, erreur IA tracée, reprise planifiée), retentée ensuite', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: `Contrat — échéance ${PASSE.slash}`, filename: `Contrat ${PASSE.deuxPoints}.pdf` });
    t4Mode = 'failure';
    try {
      await balayage(compte);
    } finally { t4Mode = 'model'; }
    expect(await ouvertes(f)).toHaveLength(0);
    expect((await diag(f))[0]).toMatchObject({ pertinence: 'UNDECIDED', ai_status: 'ERROR', decision: 'NONE', outcome: 'DEFER', reason_code: 'DEFERRED_TECHNICAL_FAILURE' });
    expect(new Date((await diag(f))[0].reevaluate_at).getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
    // Reprise : la date de reprise est atteinte, T4 rétabli → décision réelle (titre seul : différée), aucune carte.
    await sql`UPDATE document_rule_evaluations SET reevaluate_at = now() - interval '1 minute' WHERE file_id = ${f}`;
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    expect((await diag(f)).at(-1)).toMatchObject({ ai_status: 'OK', outcome: 'DEFER', pertinence: 'TITLE_HINT_ONLY' });
  });

  it('ECH-08 — échéance historique sans date fiable et sans besoin métier : pas de complétion systématique (création initiale par l’analyse T1)', async () => {
    const compte = await make.account();
    const nom = `Échéance contrat ${PASSE.deuxPoints}.pdf`;
    const f = await doc(compte, { title: 'Contrat de gardiennage', filename: nom });
    const { syncDocumentRulesFromAnalysis } = await import('@/services/to-process/document-rule-bridge');
    const r = await syncDocumentRulesFromAnalysis({ accountId: compte.id, fileId: f, observations: { facts: [], assetCandidates: [], documentAssetId: null, deferAssetLinkToT3: true }, runRef: 'analysis_run:e2e' });
    // Lot 61 (écart 7) : une date du seul nom de fichier n'éteint rien — décision différée, aucune carte.
    expect(r.reasons['DATA-CONTRACT-END']).toBe('DEFERRED');
    expect(await cartes(f)).toHaveLength(0);
    expect((await diag(f))[0]).toMatchObject({ trigger_code: 'ANALYSIS', run_ref: 'analysis_run:e2e', decision: 'NONE' });
  });

  it('ECH-16 — analyse T1 : date « JJ:MM:AAAA » d’un fait sans clé canonique (alias) écrite DÈS la création, sans question', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat' });
    const { syncDocumentRulesFromAnalysis } = await import('@/services/to-process/document-rule-bridge');
    await syncDocumentRulesFromAnalysis({
      accountId: compte.id, fileId: f,
      observations: { facts: [{ canonicalKey: null, rawKey: 'dateFinContrat', value: FUTUR.deuxPoints, confidence: 'certain' }], assetCandidates: [], documentAssetId: null, deferAssetLinkToT3: true },
    });
    expect(await valeur(f)).toMatchObject({ v: FUTUR.iso });
    expect(await cartes(f)).toHaveLength(0);
  });

  it('ECH-09 — carte existante devenue inutile : fermée automatiquement (balayage), motif tracé ; et par le passage T3', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de gardiennage', filename: `Votre contrat arrive à échéance le ${PASSE.deuxPoints}.pdf` });
    const c = await carte(compte, f);
    await balayage(compte);
    expect(await cartes(f)).toEqual([expect.objectContaining({ id: c, open: false, reason: 'OBSOLETE' })]);
    const [ev] = await sql<Array<{ details: any }>>`SELECT details FROM to_process_action_events WHERE action_id = ${c}`;
    // Lot 61 (écart 7) : la date du seul nom de fichier ne prouve rien — carte retirée car DIFFÉRÉE (motif tracé).
    expect(ev.details).toMatchObject({ ruleCode: 'DATA-CONTRACT-END', reason: 'DEFERRED', pertinence: 'TITLE_HINT_ONLY', trigger: 'SWEEP' });
    expect((await diag(f)).at(-1)).toMatchObject({ decision: 'CLOSE', reason_code: 'DEFERRED', action_id: null, outcome: 'DEFER' });

    // Passage T3 global (57B) : même décision, journal par carte enrichi.
    const g = await doc(compte, { title: 'Contrat', filename: `Contrat échu ${PASSE.deuxPoints}.pdf` });
    const c2 = await carte(compte, g);
    const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    const r = await reconcileOpenToProcessActions(compte.id, { triggerCode: 'schedule_hourly' });
    expect((r.entries as unknown as Array<Record<string, unknown>>).find((e) => e.actionId === c2)).toMatchObject({
      resolver: 'T3_DOCUMENT_FIELD', actionEffect: 'CLOSED', reasonCode: 'NO_ACTION_NEEDED', aiCalled: true, aiOperation: 't4_classify_event',
    });
    expect((await ouvertes(g))).toHaveLength(0);
    expect((await diag(g)).at(-1)).toMatchObject({ trigger_code: 'T3', decision: 'CLOSE' });

    // Carte existante dont la date est RETROUVÉE : écrite, carte fermée.
    const h = await doc(compte, { title: 'Contrat', facts: [{ key: null, raw: 'date_fin_contrat', value: FUTUR.deuxPoints, norm: null }] });
    const c3 = await carte(compte, h);
    await balayage(compte);
    expect((await cartes(h)).find((x) => x.id === c3)?.open).toBe(false);
    expect((await valeur(h))?.v).toBe(FUTUR.iso);
  });

  it('ECH-10 — balayages successifs : aucune réapparition, IA non rappelée, diagnostic sans doublon ; élément nouveau : réévalué', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de gardiennage', filename: `Échéance ${PASSE.deuxPoints}.pdf` });
    const replay = await rejouer([]);
    for (let i = 0; i < 3; i += 1) await balayage(compte);
    expect(await cartes(f)).toHaveLength(0);
    expect(appelsT4(replay)).toHaveLength(1);
    const lignes = await diag(f);
    expect(lignes).toHaveLength(1);
    // Le document n'est plus repris par le balayage (mémoire 0418) : seen_count reste à 1.
    expect(Number(lignes[0].seen_count)).toBe(1);
    const { documentsToReevaluate } = await import('@/services/to-process/document-rule-bridge');
    expect(await documentsToReevaluate(compte.id)).not.toContain(f);
    // Élément nouveau (date proche lue) : réévalué — lot 61 (écart 4) : SANS changement de asset_files.updated_at.
    await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, label, value_text, coverage_status)
              SELECT ${compte.id}, ${f}, id, 'u-new', 'LABEL_VALUE', 99, 'Date de fin de contrat', ${PROCHE.slash}, 'COVERED' FROM document_extractions WHERE file_id = ${f}`;
    expect(await documentsToReevaluate(compte.id)).toContain(f);
    await balayage(compte);
    expect((await ouvertes(f))[0]?.kind).toBe('ARBITRATE');
  });

  it('ECH-11 — contrats actifs : sans aucune date, DATA-CONTRACT-END demande la date quand elle est utile (non désactivée) ; lot 61 : utilité évaluée une fois ; « Non applicable » respecté', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de télésurveillance' });
    const replay = await rejouer([]);
    await balayage(compte);
    const [c] = await ouvertes(f);
    expect(c.kind).toBe('COMPLETE');
    expect(appelsT4(replay)).toHaveLength(1);
    expect((await diag(f))[0]).toMatchObject({ decision: 'CREATE', pertinence: 'UNDATED_NEEDED', outcome: 'CREATE_ACTION' });
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'NOT_APPLICABLE' WHERE id = ${c.id}`;
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
  });

  it('ECH-12 — garanties : même traitement générique (échue sans action : rien ; date connue : écrite)', async () => {
    const compte = await make.account();
    const a = await doc(compte, { title: 'Certificat de garantie', type: 'WARRANTY_CERTIFICATE', filename: `Garantie expirée le ${PASSE.deuxPoints}.pdf` });
    const b = await doc(compte, { title: 'Certificat de garantie', type: 'WARRANTY_CERTIFICATE', facts: [{ key: null, raw: 'finGarantie', value: FUTUR.slash, norm: null }] });
    await balayage(compte);
    expect(await cartes(a, 'warrantyEndDate')).toHaveLength(0);
    expect((await valeur(b, 'warrantyEndDate'))?.v).toBe(FUTUR.iso);
    expect(await cartes(b, 'warrantyEndDate')).toHaveLength(0);
  });

  it('ECH-13 — autres documents (facture datée dans son nom) : aucune règle d’échéance, aucun appel IA', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Facture', type: 'INVOICE', filename: `Facture ${PASSE.deuxPoints}.pdf` });
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await cartes(f)).toHaveLength(0);
    expect(appelsT4(replay)).toHaveLength(0);
    expect(await diag(f)).toHaveLength(0);
  });

  it('ECH-14 — séparation des comptes : connaissance, mémoire et diagnostic d’un compte n’atteignent jamais l’autre', async () => {
    const a = await make.account();
    const b = await make.account();
    const fa = await doc(a, { title: 'Contrat' });
    const fb = await doc(b, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: FUTUR.iso }], filename: `Contrat ${PASSE.deuxPoints}.pdf` });
    await balayage(b);
    await balayage(a);
    expect((await valeur(fb))?.v).toBe(FUTUR.iso);
    expect(await valeur(fa)).toBeNull();
    expect((await ouvertes(fa))[0].kind).toBe('COMPLETE');
    const { getT3OpenActionsDiagnostic } = await import('@/services/ai/queue/t3-open-actions-diagnostic');
    const d = await getT3OpenActionsDiagnostic({ accountId: a.id });
    expect(d.migrations.documentRules0418).toBe(true);
    expect(d.documentRules!.length).toBeGreaterThan(0);
    expect(d.documentRules!.every((r) => r.accountId === a.id)).toBe(true);
    const parDoc = await getT3OpenActionsDiagnostic({ documentId: fb, ruleCode: 'DATA-CONTRACT-END' });
    expect(parDoc.documentRules).toEqual([expect.objectContaining({ accountId: b.id, fileId: fb, decision: 'WRITE', writeVerified: true })]);
    // Un document d'un autre compte n'est jamais lu pour celui-ci.
    const { resolveDocumentRuleFromKnowledge } = await import('@/services/to-process/document-rule-bridge');
    expect(await resolveDocumentRuleFromKnowledge(a.id, fb, 'DATA-CONTRACT-END')).toMatchObject({ status: 'TARGET_GONE' });
    expect((await valeur(fb))?.v).toBe(FUTUR.iso);
  });

  it('ECH-15 — erreur de réconciliation : tracée en base (diagnostic exploitable), pas seulement en console', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat' });
    const { syncDocumentRulesFromState } = await import('@/services/to-process/document-rule-bridge');
    await sql`ALTER TABLE document_extractions RENAME TO document_extractions_e2e`;
    let r: Awaited<ReturnType<typeof syncDocumentRulesFromState>>;
    try {
      r = await syncDocumentRulesFromState(compte.id, f, { create: true });
    } finally {
      await sql`ALTER TABLE document_extractions_e2e RENAME TO document_extractions`;
    }
    expect(r.errors['DATA-CONTRACT-END']).toMatch(/document_extractions/);
    expect((await diag(f)).at(-1)).toMatchObject({ decision: 'ERROR', reason_code: 'RULE_EVALUATION_FAILED', failed_step: 'KNOWLEDGE' });
  });
});
