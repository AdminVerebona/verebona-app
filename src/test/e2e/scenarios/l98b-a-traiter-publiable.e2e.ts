/**
 * Lot 98B — ticket P0 « À traiter — ne publier une carte que si son utilité
 * est démontrée » (P0-C, P0-D, P0-E, P1), sur PostgreSQL 16 réel.
 *
 * T3 KNOWLEDGE_QUERY est SIMULÉ derrière la passerelle réelle (fournisseur
 * rejoué ; la réponse dépend des preuves et des constituants RÉELLEMENT
 * transmis) ; la branche du prompt T3 est activée par une version BO de
 * test (aucun fichier de prompt modifié). T4 : configuration INCOMPATIBLE
 * (contrat hérité, comme en préproduction au moment du constat) sauf mention.
 * Aucune règle BNP / crédit / formulation : le texte est un exemple.
 *
 *  L98B-E2E-01  cas BNP simulé (durée + remboursement rendus par T3) : NO_ACTION, aucune carte, même avec T4 incompatible
 *  L98B-E2E-02  T3 ne rend que la durée : incomplet détecté, demande complémentaire ciblée → remboursement → carte fermée
 *  L98B-E2E-03  T3 ne rend toujours que la durée + T4 incompatible : carte RETENUE — jamais CONSISTENT, absente de la
 *               page, du compteur et de la mascotte, signalée en Supervision (cause, nouvelle tentative)
 *  L98B-E2E-04  panne / délai IA (T3) : aucune carte créée ; carte existante retenue, jamais validée
 *  L98B-E2E-05  campagne CORRECTIVE (stock, budget épuisé la veille) : réponse incomplète détectée, carte obsolète fermée, recontrôle CONSISTENT
 *  L98B-E2E-06  réponse déjà disponible dans T1 / calcul fiable : fermeture automatique
 *  L98B-E2E-07  intervention utile démontrée (T4 compatible) : carte conservée ET publiée
 *  L98B-E2E-08  valeurs contradictoires : arbitrage conservé, publié, aucune écriture
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';
import { proofOf, runCoherenceFor } from '../coherence-run';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Preuve = { ref: string; document: string; label: string | null; value: string | null; text: string | null };

const jour = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const enSlash = (iso: string) => iso.split('-').reverse().join('/');
const TEXTE = 'Le montant du prêt est de 490000,00 euros. La durée est égale à 22 ans';

/** Modèle T3 simulé : réponse décidée par le test, à partir des preuves et des constituants RÉELLEMENT transmis. */
const modele = {
  appels: [] as Array<{ evidences: Preuve[]; prompt: string; cible: boolean }>,
  repondre: (_ev: Preuve[], _cible: boolean): unknown => ({ task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'simulé' }),
};
const preuvesDe = (prompt: string): Preuve[] => {
  const ligne = /^Preuves candidates : (.*)$/m.exec(prompt);
  return ligne ? JSON.parse(ligne[1]) as Preuve[] : [];
};
/** Demande COMPLÉMENTAIRE : seuls les constituants manquants sont offerts (la durée ne l'est plus). */
const estCiblee = (prompt: string) => prompt.includes('"repayment"') && !prompt.includes('"duration"');
const constat = (target: string, rawValue: string, refs: string[], excerpt: string, p: Record<string, unknown> = {}) =>
  ({ target, rawValue, evidenceRefs: refs, excerpt, confidence: 'certain', meaning: 'simulé (e2e)', ...p });
const refDe = (ev: Preuve[], texte: string) => ev.find((e) => (e.text ?? '').includes(texte) || (e.value ?? '').includes(texte))?.ref ?? 'U-0';
const DUREE = (ev: Preuve[]) => constat('duration', '22 ans', [refDe(ev, '22 ans')], 'La durée est égale à 22 ans');
const REMBOURSEMENT = (ev: Preuve[]) => constat('repayment', 'La durée est égale à 22 ans', [refDe(ev, '22 ans')], TEXTE, { meaning: 'prêt remboursé sur sa durée' });
/** T3 « réel » d'avant le lot 98A : la durée seule (réponse valide mais incomplète). */
const dureeSeule = (ev: Preuve[], cible: boolean) => (cible
  ? { task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'rien de plus' }
  : { task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'durée', findings: [DUREE(ev)] });
/** T3 qui, interrogé SPÉCIFIQUEMENT sur le remboursement, le reconnaît. */
const dureePuisRemboursement = (ev: Preuve[], cible: boolean) => (cible
  ? { task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'remboursement', findings: [REMBOURSEMENT(ev)] }
  : dureeSeule(ev, false));

let appelsT4 = 0;
/** T4 compatible : demande la date (intervention utile : information nécessaire). */
function t4Demande(input: { prompt: string }): unknown {
  appelsT4 += 1;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'action', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (!input.prompt.includes('toProcessAssessment')) return { ...base, intervention: null };
  return { ...base, intervention: { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin', justification: 'simulé', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true } };
}

scenario('L98B-PUBLIABLE', '« À traiter » : ne publier une carte que si son utilité est démontrée (lot 98B)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  const fichierT3 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  const capacite = async () => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: 98901, treatment: 'T3', versionNumber: 981,
      content: `${fichierT3}\n\nBRANCHE TASK = KNOWLEDGE_QUERY\n\n(Section de test e2e : réponse simulée par le fournisseur rejoué.)\n` }]);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  };
  const t4 = async (compatible: boolean) => (await import('@/services/to-process/document-field-evidence'))
    .__setT4AssessmentConfigForTests(compatible ? { ref: 'repo:t4_output_v3', interventionCapable: true } : { ref: 'bo:v7:LEGACY_TEMPLATE', interventionCapable: false });
  beforeAll(() => {
    setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Demande);
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', (input) => {
      const evidences = preuvesDe(input.prompt);
      const cible = estCiblee(input.prompt);
      modele.appels.push({ evidences, prompt: input.prompt, cible });
      return modele.repondre(evidences, cible);
    });
  });
  beforeEach(async () => {
    modele.appels.length = 0;
    modele.repondre = () => ({ task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'simulé' });
    appelsT4 = 0;
    await t4(false);
    await capacite();
  });
  afterEach(async () => {
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
    delete process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX;
  });
  afterAll(async () => {
    setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null);
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', null);
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  });

  type Unite = { text: string; coverage?: string };
  type Fait = { key: string | null; raw?: string; label?: string; value: string; norm?: string | null };
  const doc = async (compte: Compte, p: { type?: string; title?: string; units?: Unite[]; facts?: Fait[] }) => {
    const bien = (await make.asset(compte)).id;
    const f = await make.assetFile(compte, { assetId: bien });
    const type = p.type ?? 'FINANCING_CONTRACT';
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${f.id}, ${p.title ?? 'Offre de prêt'}, ${type}, NULL, 0) RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${type}, analysis_state = 'ANALYZED', original_filename = 'Offre.pdf' WHERE id = ${f.id}`;
    for (const x of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${f.id}, ${id}, ${x.raw ?? x.key ?? 'fait'}, ${x.label ?? null}, ${x.value}, ${x.norm === undefined ? x.value : x.norm},
                        'certain', ${`${x.label ?? x.key ?? 'fait'} : ${x.value}`}, ${x.key})`;
    }
    let n = 0;
    for (const u of p.units ?? []) {
      n += 1;
      // Unité NON couverte par défaut : aucun constat T1 résiduel (PARTIALLY_STRUCTURED_UNIT) ne brouille le recontrôle.
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, coverage_status)
                VALUES (${compte.id}, ${f.id}, ${id}, ${`u${n}`}, 'TEXT_BLOCK', ${n}, ${u.text}, ${u.coverage ?? 'UNRESOLVED'})`;
    }
    return f.id;
  };
  const carte = async (compte: Compte, fileId: number) => (await sql<{ id: number }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
    VALUES (${compte.id}, 'DOCUMENT', ${fileId}, 'contractEndDate', 'COMPLETE', 'DATA-CONTRACT-END', 'Quelle est la date de fin de ce contrat ?') RETURNING id`)[0].id;
  const cartes = async (fileId: number) => sql<Array<{ id: number; kind: string; open: boolean; reason: string | null; proposals: any }>>`
    SELECT id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason, proposals_json AS proposals
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} ORDER BY id`;
  const ouvertes = async (fileId: number) => (await cartes(fileId)).filter((c) => c.open);
  const valeur = async (fileId: number) => (await sql<Array<{ v: string | null }>>`
    SELECT value_text AS v FROM document_field_values WHERE file_id = ${fileId} AND field_key = 'contractEndDate'`)[0]?.v ?? null;
  const diag = async (fileId: number) => (await sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = 'DATA-CONTRACT-END' ORDER BY id`).at(-1)!;
  const resoudre = async (compte: Compte, fileId: number, trigger?: 'T3' | 'BACKFILL') =>
    (await import('@/services/to-process/document-rule-bridge')).resolveDocumentRuleFromKnowledge(compte.id, fileId, 'DATA-CONTRACT-END', { runRef: 'e2e:98b', ...(trigger ? { trigger } : {}) });
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  /** Ce que voit l'utilisateur : page, compteur de la page, pastille, mascotte (même définition). */
  const vu = async (compte: Compte) => {
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const { countActiveActions } = await import('@/services/to-process/to-process-action.service');
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const page = await getToProcessPage(compte.id);
    const mascotte = await collectMascotData(compte.id);
    return { page: page.actions.length, total: page.total, pastille: await countActiveActions(compte.id), mascotte: mascotte.toProcessTotal, mascotteCartes: mascotte.toProcess?.length ?? null };
  };

  // ══════════════════════════════════════════════════════════════════════

  it('L98B-E2E-01 — cas BNP simulé (durée + remboursement rendus par T3) : NO_ACTION / UNDATED_NOT_NEEDED, aucune carte, aucune date inventée — même avec T4 incompatible', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: TEXTE }] });
    modele.repondre = (ev) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'durée et remboursement', findings: [DUREE(ev), REMBOURSEMENT(ev)] });
    await balayage(compte);
    expect(await cartes(f)).toEqual([]);
    expect(await diag(f)).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'UNDATED_NOT_NEEDED' });
    expect(await valeur(f)).toBeNull();
    // Réponse complète : aucune demande complémentaire, aucun T4.
    expect(modele.appels).toHaveLength(1);
    expect(appelsT4).toBe(0);
    // Carte héritée (stock) : fermée par la même décision.
    const c = await carte(compte, f);
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'NO_ACTION_NEEDED' });
    expect((await cartes(f)).find((x) => x.id === c)).toMatchObject({ open: false, reason: 'OBSOLETE' });
    expect(await vu(compte)).toMatchObject({ page: 0, total: 0, pastille: 0, mascotte: 0 });
  });

  it('L98B-E2E-02 — T3 ne rend que la durée : réponse INCOMPLÈTE détectée par la décision, demande complémentaire ciblée (remboursement), carte fermée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: TEXTE }] });
    const c = await carte(compte, f);
    modele.repondre = dureePuisRemboursement;
    const r = await resoudre(compte, f);
    expect(r).toMatchObject({ status: 'NO_ACTION_NEEDED', knowledgeQuery: { outcome: 'CONSTITUENTS', calls: 2, followUp: { focus: ['repayment'], status: 'ANSWERED', outcome: 'CONSTITUENTS' } } });
    expect(modele.appels.map((a) => a.cible)).toEqual([false, true]);
    expect((await cartes(f)).find((x) => x.id === c)).toMatchObject({ open: false });
    const d = await diag(f);
    expect(d).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'UNDATED_NOT_NEEDED' });
    expect(d.sources.T3_SEMANTIC_FOLLOW_UP_QUERY).toBeGreaterThan(0);
    expect(d.missing_sources.filter((m: string) => m.startsWith('DECISION_GAP:'))).toEqual([]);
    expect(await valeur(f)).toBeNull();
    // Second passage : mémoire — aucun rappel.
    await resoudre(compte, f);
    expect(modele.appels).toHaveLength(2);
  });

  it('L98B-E2E-03 — T3 ne rend toujours que la durée, T4 incompatible : carte RETENUE — jamais CONSISTENT, absente de la page, du compteur et de la mascotte ; Supervision (cause, nouvelle tentative)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: TEXTE }] });
    const c = await carte(compte, f);
    // Une carte JUSTIFIÉE ailleurs dans le compte : la seule visible.
    const autre = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat de service', units: [] });
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${compte.id}, 'DOCUMENT', ${autre}, 'supplierName', 'COMPLETE', 'DATA-SUPPLIER', 'Quel est le fournisseur ?')`;
    modele.repondre = dureeSeule;
    await resoudre(compte, f);
    expect(modele.appels.map((a) => a.cible)).toEqual([false, true]);
    expect(await diag(f)).toMatchObject({ outcome: 'KEEP', reason_code: 'KEPT_T4_INCOMPATIBLE' });
    expect((await diag(f)).missing_sources).toContain('DECISION_GAP:repayment');
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
    // Ouverte mais NON publiable : ni page, ni compteur, ni pastille, ni mascotte.
    expect(await vu(compte)).toMatchObject({ page: 1, total: 1, pastille: 1, mascotte: 1, mascotteCartes: 1 });
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    expect((await getToProcessPage(compte.id)).actions.map((a) => a.ruleCode)).toEqual(['DATA-SUPPLIER']);
    // Contrôles de cohérence : jamais CONSISTENT.
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    const pt = await proofOf(sql, compte.id, 'COH-TODO-DOCUMENT-FIELDS', c);
    expect(pt).toMatchObject({ last_result: 'FINDING' });
    expect(pt!.finding).toMatchObject({ anomaly: 'DECISION_NOT_DEMONSTRATED', detail: { cause: 'T4_INCOMPATIBLE', standing: 'NOT_DEMONSTRATED' } });
    const pk = await proofOf(sql, compte.id, 'COH-T1-KNOWLEDGE-CONSUMPTION', f);
    expect(pk).toMatchObject({ last_result: 'FINDING' });
    expect(pk!.finding).toMatchObject({ anomaly: 'KNOWLEDGE_ANSWER_STILL_INCOMPLETE', detail: { anomalies: [expect.objectContaining({ detail: expect.objectContaining({ missing: ['repayment'], rendered: ['duration'] }) })] } });
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
    // Supervision : cause et nouvelle tentative.
    const { computeCoherenceAlerts } = await import('@/services/coherence/supervision');
    const alerte = (await computeCoherenceAlerts(new Date())).find((a) => a.fingerprint === 'other:coherence:a-traiter-retenues:t4_incompatible');
    expect(alerte).toBeDefined();
    expect(alerte!.detail).toMatchObject({ cause: 'T4_INCOMPATIBLE' });
    expect(String(alerte!.detail.accountIds)).toContain(String(compte.id));
    expect(String(alerte!.detail.retry)).toContain('Nouvelle tentative');
    // Contrat T4 compatible activé (P0-B) + nouvelle tentative : la décision redevient démontrée (question utile) et la carte publiée.
    await t4(true);
    const { retryHeldCards } = await import('@/services/to-process/publishability');
    const essai = await retryHeldCards({ accountId: compte.id });
    expect(essai.examined).toBe(1);
    expect(appelsT4).toBeGreaterThan(0);
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
    expect(await vu(compte)).toMatchObject({ page: 2, total: 2, pastille: 2, mascotte: 2 });
  });

  it('L98B-E2E-04 — panne / délai IA (T3) : aucune carte créée par le balayage ; carte existante retenue (non publiée), jamais validée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: TEXTE }] });
    modele.repondre = () => { throw new Error('délai dépassé (simulé)'); };
    await balayage(compte);
    expect(await cartes(f)).toEqual([]);
    // T4 compatible ici : seule la panne T3 empêche de statuer.
    await t4(true);
    const g = await doc(compte, { units: [{ text: TEXTE }] });
    const c = await carte(compte, g);
    await resoudre(compte, g);
    expect(await diag(g)).toMatchObject({ outcome: 'KEEP', reason_code: 'KEPT_INTERPRETATION_PENDING' });
    expect((await ouvertes(g)).map((x) => x.id)).toEqual([c]);
    // Panne T4 (délai dépassé) sur une autre carte : maintien technique, jamais une décision.
    const h = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat', units: [] });
    const c2 = await carte(compte, h);
    setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', () => { throw new Error('délai dépassé (simulé)'); });
    try {
      await resoudre(compte, h);
    } finally {
      setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Demande);
    }
    expect(await diag(h)).toMatchObject({ outcome: 'KEEP', reason_code: 'KEPT_ON_TECHNICAL_FAILURE' });
    expect((await ouvertes(h)).map((x) => x.id)).toEqual([c2]);
    expect(await vu(compte)).toMatchObject({ page: 0, total: 0, pastille: 0, mascotte: 0 });
    await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN' });
    for (const id of [c, c2]) {
      const p = await proofOf(sql, compte.id, 'COH-TODO-DOCUMENT-FIELDS', id);
      expect(p?.last_result, String(id)).not.toBe('CONSISTENT');
      expect(p!.finding).toMatchObject({ anomaly: 'DECISION_NOT_DEMONSTRATED' });
    }
  });

  it('L98B-E2E-05 — campagne CORRECTIVE sur le stock (demande complémentaire bloquée par le budget) : réponse incomplète détectée, carte obsolète fermée, puis recontrôlée CONSISTENT', async () => {
    const compte = await make.account();
    const f = await doc(compte, { units: [{ text: TEXTE }] });
    const c = await carte(compte, f);
    modele.repondre = dureePuisRemboursement;
    // Veille : budget du compte épuisé après la première interprétation (la demande ciblée n'a pas pu partir).
    process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX = '1';
    await resoudre(compte, f);
    expect(modele.appels).toHaveLength(1);
    expect((await diag(f)).missing_sources).toEqual(expect.arrayContaining(['T3_SEMANTIC_FOLLOW_UP:BUDGET_EXHAUSTED', 'DECISION_GAP:repayment']));
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
    // Campagne À BLANC : détecté, rien écrit.
    await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN' });
    expect(await proofOf(sql, compte.id, 'COH-T1-KNOWLEDGE-CONSUMPTION', f)).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
    // Budget rétabli, campagne CORRECTIVE : nouvelle demande T3 ciblée, carte fermée, recontrôle CONSISTENT.
    delete process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX;
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    const [rep] = await sql<Array<{ outcome: string; anomaly: string; recheck_verdict: string; service: string }>>`
      SELECT outcome, anomaly, recheck_verdict, service FROM coherence_repairs
       WHERE account_id = ${compte.id} AND check_id = 'COH-T1-KNOWLEDGE-CONSUMPTION' AND object_id = ${f} ORDER BY id`;
    expect(rep).toMatchObject({ outcome: 'REPAIRED', anomaly: 'KNOWLEDGE_ANSWER_INCOMPLETE', recheck_verdict: 'CONSISTENT', service: 'resolveDocumentRuleFromKnowledge' });
    expect(await ouvertes(f)).toEqual([]);
    expect(modele.appels.map((a) => a.cible)).toEqual([false, true]);
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect(await proofOf(sql, compte.id, 'COH-T1-KNOWLEDGE-CONSUMPTION', f)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(modele.appels).toHaveLength(2);
  });

  it('L98B-E2E-06 — réponse déjà disponible dans T1, ou calcul fiable possible : fermeture automatique (campagne corrective)', async () => {
    const compte = await make.account();
    const fin = jour(400);
    const lue = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat', facts: [{ key: 'contractEndDate', label: 'Date de fin du contrat', value: enSlash(fin), norm: fin }] });
    const c1 = await carte(compte, lue);
    const debut = jour(-700);
    const calcul = await doc(compte, { title: 'Offre de prêt', facts: [{ key: 'contractStartDate', value: debut }, { key: null, raw: 'dureePret', label: 'Durée du prêt', value: '240 mois', norm: null }] });
    const c2 = await carte(compte, calcul);
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect((await cartes(lue)).find((x) => x.id === c1)).toMatchObject({ open: false });
    expect(await valeur(lue)).toBe(fin);
    const { endFromStart } = await import('@/services/to-process/document-derivations');
    expect((await cartes(calcul)).find((x) => x.id === c2)).toMatchObject({ open: false });
    expect(await valeur(calcul)).toBe(endFromStart(debut, 240));
    expect(modele.appels).toHaveLength(0);
    expect(await vu(compte)).toMatchObject({ total: 0, pastille: 0 });
  });

  it('L98B-E2E-07 — intervention utile démontrée (T4 compatible) : la carte est conservée ET publiée ; le contrôle la tient pour justifiée', async () => {
    await t4(true);
    const compte = await make.account();
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat de maintenance', units: [{ text: 'Contrat conclu pour 36 mois.' }] });
    const c = await carte(compte, f);
    modele.repondre = (ev) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'durée', findings: [constat('duration', '36 mois', [refDe(ev, '36 mois')], 'Contrat conclu pour 36 mois.')] });
    await resoudre(compte, f);
    expect(appelsT4).toBeGreaterThan(0);
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
    expect((await diag(f)).outcome).not.toBe('ERROR');
    expect((await diag(f)).reason_code).not.toMatch(/^KEPT_(T4|INTERPRETATION|ON_TECHNICAL)/);
    expect(await vu(compte)).toMatchObject({ page: 1, total: 1, pastille: 1, mascotte: 1 });
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect(await proofOf(sql, compte.id, 'COH-TODO-DOCUMENT-FIELDS', c)).toMatchObject({ last_result: 'CONSISTENT' });
    expect((await ouvertes(f)).map((x) => x.id)).toEqual([c]);
  });

  it('L98B-E2E-08 — valeurs contradictoires : arbitrage conservé et publié, aucune correction arbitraire', async () => {
    const compte = await make.account();
    const a = jour(20);
    const b = jour(50);
    const f = await doc(compte, { type: 'SERVICE_CONTRACT', title: 'Contrat', units: [{ text: `Fin du contrat : ${enSlash(a)}` }, { text: `Le contrat expirera le ${enSlash(b)}` }] });
    await carte(compte, f);
    modele.repondre = (ev) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'CONTRADICTION', reason: 'deux dates', findings: [
      constat('FIELD', enSlash(a), [refDe(ev, enSlash(a))], `Fin du contrat : ${enSlash(a)}`), constat('FIELD', enSlash(b), [refDe(ev, enSlash(b))], `expirera le ${enSlash(b)}`)] });
    await resoudre(compte, f);
    const [c] = await ouvertes(f);
    expect(c.kind).toBe('ARBITRATE');
    expect(await valeur(f)).toBeNull();
    expect(await vu(compte)).toMatchObject({ page: 1, total: 1, pastille: 1 });
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect((await ouvertes(f)).map((x) => [x.id, x.kind])).toEqual([[c.id, 'ARBITRATE']]);
    expect(await valeur(f)).toBeNull();
    const p = await proofOf(sql, compte.id, 'COH-TODO-DOCUMENT-FIELDS', c.id);
    expect(['CONSISTENT', 'AMBIGUOUS']).toContain(p?.last_result);
  });
});
