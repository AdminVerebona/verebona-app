/**
 * Lot 85F — ticket P1 « T3 doit exploiter toute la connaissance T1
 * persistée avant de conclure qu'une information manque », sur PostgreSQL 16
 * réel. Données RÉELLEMENT persistées : cartes « À traiter » (ouvertes,
 * fermées, jamais supprimées), valeurs documentaires, décisions
 * (`document_rule_evaluations`), interprétations T3 (`t3_knowledge_queries`),
 * preuves de cohérence.
 *
 * T3 KNOWLEDGE_QUERY est SIMULÉ derrière la passerelle réelle (fournisseur
 * rejoué) ; la branche du prompt T3 est présente seulement quand un test
 * l'active (version BO de test : texte du dépôt + section de test) — sinon
 * la capacité est indisponible, comme en préproduction tant que l'équipe IA
 * n'a pas livré le texte. T4 est simulé DÉFAVORABLE (demande toujours la
 * date) : seule la décision du moteur peut éviter une question.
 *
 *  L85F-E2E-01  cas BNP : durée comprise dans un TEXT_BLOCK, carte DATA-CONTRACT-END inutile fermée, aucune date inventée
 *  L85F-E2E-02  capacité IA indisponible : aucun FIELD_NOT_IN_T1 abusif, carte conservée, aucune nouvelle carte
 *  L85F-E2E-03  valeur déjà structurée : aucune IA
 *  L85F-E2E-04  LABEL_VALUE au libellé non reconnu : valeur retrouvée → proposition (jamais écrite seule)
 *  L85F-E2E-05  connaissance d'un document lié (même Opération) : exploitable
 *  L85F-E2E-06  texte ambigu : abstention, aucune écriture, carte conservée (pas FIELD_NOT_IN_T1)
 *  L85F-E2E-07  texte contradictoire : arbitrage, aucune écriture
 *  L85F-E2E-08  aucune information : véritable FIELD_NOT_IN_T1
 *  L85F-E2E-09  constituants répartis sur deux unités : calcul déterministe (probable, jamais écrit)
 *  L85F-E2E-10  information insuffisante : aucune date inventée
 *  L85F-E2E-11  donnée inutile : aucune carte créée (balayage)
 *  L85F-E2E-12  décision de l'utilisateur protégée : aucune IA, aucune écriture
 *  L85F-E2E-13  preuve hors contexte : refusée par la validation serveur
 *  L85F-E2E-14  second passage idempotent : aucun rappel IA, cartes inchangées
 *  L85F-E2E-15  passage T3 récurrent : motif INTERPRETATION_PENDING journalisé
 *  L85F-E2E-COH-01  cohérence, capacité indisponible : constat INTERPRETATION_PENDING (aucune écriture)
 *  L85F-E2E-COH-02  cohérence, capacité livrée : réexamen, carte obsolète fermée, constat T1 résiduel ; candidat sans preuve T1 signalé
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';
import { runCoherenceFor, proofOf } from '../coherence-run';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Preuve = { ref: string; document: string; label: string | null; value: string | null; text: string | null };

/** Date décalée (jours) du jour d'exécution. */
const jour = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const enSlash = (iso: string) => iso.split('-').reverse().join('/');
const BNP = 'Le montant du prêt est de 490000,00 euros. La durée est égale à 22 ans';

/** Modèle T3 simulé : la réponse est décidée par le test, à partir des preuves RÉELLEMENT transmises. */
const modele = {
  appels: [] as Array<{ evidences: Preuve[]; prompt: string }>,
  repondre: (_ev: Preuve[]): unknown => ({ task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'simulé' }),
};
const preuvesDe = (prompt: string): Preuve[] => {
  const ligne = /^Preuves candidates : (.*)$/m.exec(prompt);
  return ligne ? JSON.parse(ligne[1]) as Preuve[] : [];
};
const constat = (target: string, rawValue: string, refs: string[], excerpt: string, p: Record<string, unknown> = {}) =>
  ({ target, rawValue, evidenceRefs: refs, excerpt, confidence: 'certain', meaning: 'simulé (e2e)', ...p });
const refDe = (ev: Preuve[], texte: string) => ev.find((e) => (e.text ?? '').includes(texte) || (e.value ?? '').includes(texte))?.ref ?? 'U-0';

let appelsT4 = 0;
/** T4 défavorable : demande TOUJOURS la date d'un contrat sans date. */
function t4Demande(input: { prompt: string }): unknown {
  appelsT4 += 1;
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any> } : {};
  const demande = ctx.event_context?.toProcessAssessment as { knownDate?: string } | undefined;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'action', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (!demande) return { ...base, intervention: null };
  if (demande.knownDate) return { ...base, intervention: { needed: 'no', kind: null, action: null, justification: 'simulé', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false } };
  return { ...base, intervention: { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin', justification: 'simulé', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true } };
}

scenario('L85F-T3-T1', 'T3 exploite toute la connaissance T1 persistée avant de conclure qu’une information manque (lot 85F)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  const fichierT3 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  /** Version BO de test du prompt T3 : texte du dépôt + section KNOWLEDGE_QUERY (simulée — aucun fichier de prompt modifié). */
  const capacite = async (on: boolean) => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: on ? 98501 : 98500, treatment: 'T3', versionNumber: on ? 851 : 850,
      content: on ? `${fichierT3}\n\nBRANCHE TASK = KNOWLEDGE_QUERY\n\n(Section de test e2e : réponse simulée par le fournisseur rejoué.)\n` : fichierT3 }]);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  };
  beforeAll(() => {
    setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Demande);
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', (input) => {
      const evidences = preuvesDe(input.prompt);
      modele.appels.push({ evidences, prompt: input.prompt });
      return modele.repondre(evidences);
    });
  });
  beforeEach(async () => {
    modele.appels.length = 0;
    modele.repondre = () => ({ task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'simulé' });
    appelsT4 = 0;
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests({ ref: 'repo:t4_output_v3', interventionCapable: true });
    await capacite(true);
  });
  afterEach(async () => {
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
  });
  afterAll(async () => {
    setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null);
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', null);
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  });

  type Unite = { kind?: string; label?: string | null; value?: string | null; text?: string | null; coverage?: string };
  type Fait = { key?: string | null; raw?: string; label?: string; value: string; norm?: string | null; confidence?: string; excerpt?: string };
  const doc = async (compte: Compte, p: { type?: string; title?: string; units?: Unite[]; facts?: Fait[]; endDate?: { value: string | null; user?: boolean; origin?: string } }) => {
    const bien = (await make.asset(compte)).id;
    const f = await make.assetFile(compte, { assetId: bien });
    const type = p.type ?? 'FINANCING_CONTRACT';
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${f.id}, ${p.title ?? 'Offre de crédit immobilier'}, ${type}, NULL, 0) RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${type}, analysis_state = 'ANALYZED', original_filename = 'Offre.pdf' WHERE id = ${f.id}`;
    for (const x of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${f.id}, ${id}, ${x.raw ?? x.key ?? 'fait'}, ${x.label ?? null}, ${x.value}, ${x.norm === undefined ? x.value : x.norm},
                        ${x.confidence ?? 'certain'}, ${x.excerpt ?? `${x.label ?? x.key ?? 'fait'} : ${x.value}`}, ${x.key ?? null})`;
    }
    let n = 0;
    for (const u of p.units ?? []) {
      n += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, label, value_text, coverage_status)
                VALUES (${compte.id}, ${f.id}, ${id}, ${`u${n}`}, ${u.kind ?? 'TEXT_BLOCK'}, ${n}, ${u.text ?? null}, ${u.label ?? null}, ${u.value ?? null}, ${u.coverage ?? 'COVERED'})`;
    }
    if (p.endDate) {
      await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
                VALUES (${compte.id}, ${f.id}, 'contractEndDate', ${p.endDate.value}, ${p.endDate.origin ?? (p.endDate.user ? 'USER' : 'RECONCILIATION')}, ${p.endDate.user === true})`;
    }
    return f.id;
  };
  const carte = async (compte: Compte, fileId: number) => (await sql<{ id: number }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
    VALUES (${compte.id}, 'DOCUMENT', ${fileId}, 'contractEndDate', 'COMPLETE', 'DATA-CONTRACT-END', 'Quelle est la date de fin de ce contrat ?') RETURNING id`)[0].id;
  const cartes = async (fileId: number) => sql<Array<{ id: number; kind: string; open: boolean; reason: string | null; proposals: any }>>`
    SELECT id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason, proposals_json AS proposals
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND field_key = 'contractEndDate' ORDER BY id`;
  const ouvertes = async (fileId: number) => (await cartes(fileId)).filter((c) => c.open);
  const valeur = async (fileId: number) => (await sql<Array<{ v: string | null; u: boolean }>>`
    SELECT value_text AS v, user_validated AS u FROM document_field_values WHERE file_id = ${fileId} AND field_key = 'contractEndDate'`)[0] ?? null;
  const diag = async (fileId: number) => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = 'DATA-CONTRACT-END' ORDER BY id`;
  const interpretations = async (fileId: number) => sql<Array<Record<string, any>>>`SELECT * FROM t3_knowledge_queries WHERE file_id = ${fileId} ORDER BY id`;
  const resoudre = async (compte: Compte, fileId: number) =>
    (await import('@/services/to-process/document-rule-bridge')).resolveDocumentRuleFromKnowledge(compte.id, fileId, 'DATA-CONTRACT-END', { runRef: 'e2e:t3' });
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  const BNP_CONSTITUANTS = (ev: Preuve[]) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'durée écrite, aucune date de fin', findings: [
    constat('duration', '22 ans', [refDe(ev, '22 ans')], 'La durée est égale à 22 ans', { meaning: 'durée totale du prêt immobilier' }),
    constat('repayment', 'La durée est égale à 22 ans', [refDe(ev, '22 ans')], BNP, { meaning: 'prêt remboursé sur sa durée' }),
  ] });

  // ══════════════════════════════════════════════════════════════════════

  it('L85F-E2E-01 — cas BNP : la durée d’un TEXT_BLOCK est comprise, le code n’invente aucune date, la carte DATA-CONTRACT-END inutile est FERMÉE (historique conservé)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: BNP }] });
    const ancienne = await carte(compte, f);
    modele.repondre = BNP_CONSTITUANTS;
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'NO_ACTION_NEEDED', reasonCode: 'NO_ACTION_NEEDED', verified: true,
      knowledgeQuery: { status: 'ANSWERED', outcome: 'CONSTITUENTS', aiCalled: true, calls: 1 } });
    expect(modele.appels).toHaveLength(1);
    // La connaissance persistée a bien été transmise (référence de l'unité, texte exact).
    expect(modele.appels[0].evidences).toEqual([expect.objectContaining({ document: 'D0', text: BNP })]);
    expect(await valeur(f)).toBeNull();
    expect(await ouvertes(f)).toEqual([]);
    expect((await cartes(f)).find((c) => c.id === ancienne)).toMatchObject({ open: false, reason: 'OBSOLETE' });
    const [q] = await interpretations(f);
    expect(q).toMatchObject({ status: 'ANSWERED', outcome: 'CONSTITUENTS', calls: 1, field_key: 'contractEndDate' });
    expect(q.findings.map((x: any) => [x.target, x.normalized])).toEqual([['duration', '264'], ['repayment', null]]);
    const d = (await diag(f)).at(-1)!;
    expect(d).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'NO_ACTION_NEEDED', pertinence: 'UNDATED_NOT_NEEDED' });
    expect(d.sources).toMatchObject({ T3_SEMANTIC_FINDINGS: 2, T3_SEMANTIC_QUERY: Number(q.id) });
    expect(d.derivation).toMatchObject({ status: 'NOT_DERIVABLE', value: null, schedule: { evidenced: true } });
    expect(appelsT4).toBe(0);
  });

  it('L85F-E2E-02 — capacité IA indisponible : jamais FIELD_NOT_IN_T1 quand de la connaissance non structurée existe ; carte conservée ; aucune nouvelle carte', async () => {
    await capacite(false);
    const compte = await make.account();
    const avecCarte = await doc(compte, { units: [{ text: BNP }] });
    const c = await carte(compte, avecCarte);
    const sansCarte = await doc(compte, { units: [{ text: 'Vous rembourserez ce financement en vingt-deux années.' }] });
    const r = await resoudre(compte, avecCarte);
    expect(r).toMatchObject({ status: 'INTERPRETATION_PENDING', reasonCode: 'INTERPRETATION_PENDING', knowledgeQuery: { status: 'PENDING', pendingReason: 'CAPABILITY_UNAVAILABLE', aiCalled: false } });
    expect(r.reasonCode).not.toBe('FIELD_NOT_IN_T1');
    expect((await ouvertes(avecCarte)).map((x) => x.id)).toEqual([c]);
    expect((await diag(avecCarte)).at(-1)).toMatchObject({ outcome: 'KEEP', reason_code: 'KEPT_INTERPRETATION_PENDING' });
    expect((await diag(avecCarte)).at(-1)!.missing_sources).toContain('T3_SEMANTIC_INTERPRETATION:CAPABILITY_UNAVAILABLE');
    await balayage(compte);
    expect(await cartes(sansCarte)).toEqual([]);
    expect((await diag(sansCarte)).at(-1)).toMatchObject({ outcome: 'DEFER', reason_code: 'INTERPRETATION_PENDING' });
    expect((await diag(sansCarte)).at(-1)!.reevaluate_at).not.toBeNull();
    expect(modele.appels).toHaveLength(0);
    expect(await interpretations(avecCarte)).toEqual([]);
  });

  it('L85F-E2E-03 — valeur déjà structurée : écrite par le niveau déterministe, AUCUN appel IA', async () => {
    const compte = await make.account();
    const fin = jour(400);
    const f = await doc(compte, { units: [{ text: BNP }], facts: [{ key: 'contractEndDate', label: 'Date de fin du contrat', value: enSlash(fin), norm: fin }] });
    await carte(compte, f);
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'WRITTEN', verified: true });
    expect(r.knowledgeQuery ?? null).toBeNull();
    expect(await valeur(f)).toMatchObject({ v: fin, u: false });
    expect(modele.appels).toHaveLength(0);
    expect(await interpretations(f)).toEqual([]);
  });

  it('L85F-E2E-04 — LABEL_VALUE au libellé non reconnu par le registre : valeur retrouvée par T3 → PROPOSITION (carte « À arbitrer »), jamais écrite seule', async () => {
    const compte = await make.account();
    const fin = jour(30);
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Bail', units: [{ kind: 'LABEL_VALUE', label: 'Échéance finale du bail', value: enSlash(fin) }] });
    await carte(compte, f);
    modele.repondre = (ev) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'FOUND', reason: 'écrit', findings: [constat('FIELD', enSlash(fin), [ev[0].ref], `Échéance finale du bail ${enSlash(fin)}`)] });
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'ARBITRATE', knowledgeQuery: { outcome: 'FOUND' } });
    expect(await valeur(f)).toBeNull();
    const [c] = await ouvertes(f);
    expect(c.kind).toBe('ARBITRATE');
    expect(c.proposals).toEqual([expect.objectContaining({ value: fin, evidenceIds: [`t1:${modele.appels[0].evidences[0].ref}`] })]);
  });

  it('L85F-E2E-05 — connaissance portée par un document lié (même Opération) : transmise et exploitable', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: 'Offre de prêt : conditions générales.' }] });
    const lie = await doc(compte, { title: 'Tableau d’amortissement', units: [{ text: BNP }] });
    const [{ id: op }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'REALIZED') RETURNING id`;
    for (const fid of [f, lie]) await sql`INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins) VALUES (${compte.id}, ${op}, ${fid}, ARRAY['SOURCE'])`;
    await carte(compte, f);
    modele.repondre = BNP_CONSTITUANTS;
    const r = await resoudre(compte, f);
    expect(r.status).toBe('NO_ACTION_NEEDED');
    const ev = modele.appels[0].evidences;
    expect(ev.find((e) => e.text === BNP)).toMatchObject({ document: 'D1' });
    expect(modele.appels[0].prompt).toContain('"relation":"SAME_OPERATION"');
    const [q] = await interpretations(f);
    expect(q.findings[0].fileIds).toEqual([lie]);
    expect(await ouvertes(f)).toEqual([]);
  });

  it('L85F-E2E-06 — texte ambigu : abstention, aucune écriture, carte conservée, motif INSUFFICIENT_EVIDENCE (jamais FIELD_NOT_IN_T1)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat de service', units: [{ text: 'Durée : 15 ou 20 ans selon l’option retenue' }] });
    const c = await carte(compte, f);
    modele.repondre = () => ({ task: 'KNOWLEDGE_QUERY', outcome: 'AMBIGUOUS', findings: [], reason: 'deux durées' });
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'NO_EVIDENCE', reasonCode: 'INSUFFICIENT_EVIDENCE', knowledgeQuery: { outcome: 'AMBIGUOUS' } });
    expect(await valeur(f)).toBeNull();
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
  });

  it('L85F-E2E-07 — texte contradictoire : deux valeurs proposées à l’arbitrage, aucune écriture automatique', async () => {
    const compte = await make.account();
    const a = jour(20);
    const b = jour(50);
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat', units: [{ text: `Fin du contrat : ${enSlash(a)}` }, { text: `Le contrat expirera le ${enSlash(b)}` }] });
    await carte(compte, f);
    modele.repondre = (ev) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'CONTRADICTION', reason: 'deux dates', findings: [
      constat('FIELD', enSlash(a), [refDe(ev, enSlash(a))], `Fin du contrat : ${enSlash(a)}`), constat('FIELD', enSlash(b), [refDe(ev, enSlash(b))], `expirera le ${enSlash(b)}`)] });
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'ARBITRATE', knowledgeQuery: { outcome: 'CONTRADICTION' } });
    expect(await valeur(f)).toBeNull();
    const [c] = await ouvertes(f);
    expect(c.kind).toBe('ARBITRATE');
    expect(c.proposals.map((x: any) => x.value).sort()).toEqual([a, b]);
  });

  it('L85F-E2E-08 — aucune information pertinente dans toute la connaissance : véritable FIELD_NOT_IN_T1, carte conservée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat', units: [{ text: 'Montant mensuel : 39,90 €' }, { text: 'Agence de Lyon' }] });
    const c = await carte(compte, f);
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'NO_EVIDENCE', reasonCode: 'FIELD_NOT_IN_T1', knowledgeQuery: { outcome: 'NOT_FOUND', aiCalled: true } });
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
  });

  it('L85F-E2E-09 — début et durée compris dans deux unités : calcul DÉTERMINISTE par le code existant (probable : candidat, jamais écrit)', async () => {
    const compte = await make.account();
    const debut = jour(-30);
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat de maintenance', units: [{ text: `Le contrat prend effet le ${enSlash(debut)}.` }, { text: 'Il est conclu pour une période de 36 mois.' }] });
    await carte(compte, f);
    modele.repondre = (ev) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'début et durée', findings: [
      constat('start', enSlash(debut), [refDe(ev, enSlash(debut))], `Le contrat prend effet le ${enSlash(debut)}.`),
      constat('duration', '36 mois', [refDe(ev, '36 mois')], 'Il est conclu pour une période de 36 mois.')] });
    await resoudre(compte, f);
    const { endFromStart } = await import('@/services/to-process/document-derivations');
    const d = (await diag(f)).at(-1)!;
    expect(d.derivation).toMatchObject({ status: 'CALCULATED_PROBABLE', value: endFromStart(debut, 36), method: 'START_PLUS_DURATION', duration: { months: 36 } });
    expect(d.derivation.duration.source).toMatch(/^T3_SEMANTIC:U-/);
    expect(await valeur(f)).toBeNull();
  });

  it('L85F-E2E-10 — information retrouvée mais insuffisante (durée sans début ni échéancier) : AUCUNE date inventée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { type: 'SUBSCRIPTION_CONTRACT', title: 'Abonnement', units: [{ text: 'Abonnement souscrit pour une durée de 24 mois.' }] });
    const c = await carte(compte, f);
    modele.repondre = (ev) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'durée seule', findings: [constat('duration', '24 mois', [ev[0].ref], 'une durée de 24 mois')] });
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'NO_EVIDENCE', reasonCode: 'INSUFFICIENT_EVIDENCE' });
    expect(await valeur(f)).toBeNull();
    expect((await diag(f)).at(-1)!.derivation).toMatchObject({ value: null });
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
  });

  it('L85F-E2E-11 — donnée inconnue mais inutile (remboursement par échéances sans démarche de fin) : AUCUNE carte créée par le balayage', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: BNP }] });
    modele.repondre = BNP_CONSTITUANTS;
    await balayage(compte);
    expect(await cartes(f)).toEqual([]);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'UNDATED_NOT_NEEDED' });
    expect(modele.appels).toHaveLength(1);
  });

  it('L85F-E2E-12 — décision de l’utilisateur (date effacée) protégée : aucune interprétation, aucune écriture', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: BNP }], endDate: { value: null, user: true } });
    await carte(compte, f);
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'USER_PROTECTED', reasonCode: 'USER_DECISION_PROTECTED' });
    expect(await valeur(f)).toMatchObject({ v: null, u: true });
    expect(modele.appels).toHaveLength(0);
  });

  it('L85F-E2E-13 — preuve citée hors du contexte transmis : refusée par la validation serveur, aucune valeur, refus mémorisé', async () => {
    const compte = await make.account();
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat', units: [{ text: 'Montant financé : 120 000 €' }] });
    await carte(compte, f);
    modele.repondre = () => ({ task: 'KNOWLEDGE_QUERY', outcome: 'FOUND', reason: 'inventé', findings: [constat('FIELD', '30/06/2040', ['U-999999'], 'Fin : 30/06/2040')] });
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'NO_EVIDENCE', reasonCode: 'INSUFFICIENT_EVIDENCE', knowledgeQuery: { outcome: 'REJECTED' } });
    expect(await valeur(f)).toBeNull();
    const [q] = await interpretations(f);
    expect(q.rejected).toEqual([expect.objectContaining({ code: 'UNKNOWN_EVIDENCE_REF', refs: ['U-999999'] })]);
  });

  it('L85F-E2E-14 — second passage identique : IDEMPOTENT (aucun rappel IA, cartes et valeurs inchangées)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat de service', units: [{ text: 'Durée : 15 ou 20 ans selon l’option retenue' }] });
    await carte(compte, f);
    modele.repondre = () => ({ task: 'KNOWLEDGE_QUERY', outcome: 'AMBIGUOUS', findings: [], reason: 'deux durées' });
    await resoudre(compte, f);
    const avant = { cartes: await cartes(f), q: await interpretations(f), evals: (await diag(f)).length };
    const r2 = await resoudre(compte, f);
    expect(r2.knowledgeQuery).toMatchObject({ cached: true, aiCalled: false });
    expect(modele.appels).toHaveLength(1);
    expect(await cartes(f)).toEqual(avant.cartes);
    expect((await interpretations(f)).map((x) => [x.id, x.calls, x.attempts])).toEqual(avant.q.map((x) => [x.id, x.calls, x.attempts]));
    expect((await diag(f)).length).toBe(avant.evals);
  });

  it('L85F-E2E-15 — passage T3 récurrent sur les cartes ouvertes : motif INTERPRETATION_PENDING journalisé, carte conservée', async () => {
    await capacite(false);
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: BNP }] });
    const c = await carte(compte, f);
    const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    const res = await reconcileOpenToProcessActions(compte.id, { triggerCode: 'e2e' });
    expect(res.byReasonCode.INTERPRETATION_PENDING).toBe(1);
    expect(res.byReasonCode.FIELD_NOT_IN_T1 ?? 0).toBe(0);
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
  });

  it('L85F-E2E-COH-01 — cohérence, capacité indisponible : constat INTERPRETATION_PENDING (demande IA 85F), aucune écriture', async () => {
    await capacite(false);
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: BNP }] });
    const c = await carte(compte, f);
    const run = await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect(run.results['COH-T1-KNOWLEDGE-CONSUMPTION']).toMatchObject({ FINDING: 1 });
    const p = await proofOf(sql, compte.id, 'COH-T1-KNOWLEDGE-CONSUMPTION', f);
    expect(p).toMatchObject({ last_result: 'FINDING' });
    expect(JSON.stringify(p!.finding)).toContain('INTERPRETATION_PENDING');
    expect(JSON.stringify(p!.finding)).toContain('85F-t3-comprehension-connaissance-t1');
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
    expect(modele.appels).toHaveLength(0);
  });

  it('L85F-E2E-COH-02 — cohérence, capacité livrée : réexamen (compréhension, pertinence) et carte obsolète FERMÉE ; réparation journalisée, constat T1 résiduel ; candidat Opération sans preuve T1 signalé ; second passage sans rappel IA', async () => {
    await capacite(false);
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: BNP }] });
    const idCarte = await carte(compte, f);
    // Passage T3 sans capacité : la carte reste (motif « interprétation en attente »).
    expect((await resoudre(compte, f)).status).toBe('INTERPRETATION_PENDING');
    const g = await doc(compte, { type: 'INVOICE', title: 'Facture', units: [{ text: 'Total TTC 120 €' }] });
    await sql`INSERT INTO document_operation_candidates (account_id, file_id, extraction_id, candidate_key, established, confidence, summary, payload, t3_pending)
              SELECT ${compte.id}, ${g}, id, 'c1', true, 'certain', 'Intervention', ${JSON.stringify({ evidenceFactIds: [], unresolvedEvidence: 1 })}::jsonb, false
                FROM document_extractions WHERE file_id = ${g} ORDER BY id DESC LIMIT 1`;
    await capacite(true);
    modele.repondre = BNP_CONSTITUANTS;
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    // Réparation journalisée (service métier existant), carte obsolète fermée, un seul appel IA.
    // Lot 98B (P0-C) : le maintien « interprétation en attente » n'est plus une carte justifiée — COH-TODO-DOCUMENT-FIELDS
    // (avant dans le registre) le réexamine dès que la capacité est livrée ; même service, même issue.
    const [rep] = await sql<Array<{ outcome: string; recheck_verdict: string; service: string; anomaly: string; ai_calls: number }>>`
      SELECT outcome, recheck_verdict, service, anomaly, ai_calls FROM coherence_repairs
       WHERE account_id = ${compte.id} AND ((check_id = 'COH-T1-KNOWLEDGE-CONSUMPTION' AND object_id = ${f}) OR (check_id = 'COH-TODO-DOCUMENT-FIELDS' AND object_id = ${idCarte}))
       ORDER BY id`;
    expect(rep).toMatchObject({ outcome: 'REPAIRED', service: 'resolveDocumentRuleFromKnowledge' });
    expect(['FIELD_NOT_IN_T1_WITH_KNOWLEDGE', 'DECISION_NOT_DEMONSTRATED']).toContain(rep.anomaly);
    expect(await ouvertes(f)).toEqual([]);
    expect(modele.appels).toHaveLength(1);
    // Reste un constat T1 (maillon distinct) : l'unité couverte n'avait structuré qu'une partie de ses informations.
    const pf = await proofOf(sql, compte.id, 'COH-T1-KNOWLEDGE-CONSUMPTION', f);
    expect(pf).toMatchObject({ last_result: 'FINDING' });
    expect(JSON.stringify(pf!.finding)).toContain('PARTIALLY_STRUCTURED_UNIT');
    const pg = await proofOf(sql, compte.id, 'COH-T1-KNOWLEDGE-CONSUMPTION', g);
    expect(pg).toMatchObject({ last_result: 'FINDING' });
    expect(JSON.stringify(pg!.finding)).toContain('OPERATION_CANDIDATE_WITHOUT_T1_EVIDENCE');
    // Second passage : interprétation mémorisée, carte absente — aucun rappel IA, aucune nouvelle réparation.
    // Intégration lot 87 : le titre automatique, normalisé au premier passage par COH-DOC-TITLES (87D), fait
    // partie de la connaissance transmise : au plus UNE réinterprétation, puis plus aucun appel.
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    const appelsApresConvergence = modele.appels.length;
    expect(appelsApresConvergence).toBeLessThanOrEqual(2);
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect(modele.appels).toHaveLength(appelsApresConvergence);
    expect((await sql`SELECT 1 FROM coherence_repairs WHERE account_id = ${compte.id} AND ((check_id = 'COH-T1-KNOWLEDGE-CONSUMPTION' AND object_id = ${f})
                         OR (check_id = 'COH-TODO-DOCUMENT-FIELDS' AND object_id = ${idCarte}))`).length).toBeLessThanOrEqual(2);
    expect(await ouvertes(f)).toEqual([]);
  });
});
