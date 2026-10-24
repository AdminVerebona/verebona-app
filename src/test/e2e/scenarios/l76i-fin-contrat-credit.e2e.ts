/**
 * Lot 76I — ticket « [P2] À traiter — Calcul automatique des dates de fin de
 * contrat et suppression des sollicitations inutiles », sur PostgreSQL 16
 * réel. Cas constaté : offre de crédit immobilier (bien « Maison ») recevant
 * « Quelle est la date de fin de ce contrat ? ».
 *
 * Vérifie les données RÉELLEMENT persistées : valeur de fin (nature
 * CALCULATED / EXPLICIT, provenance `derivation` : méthode, sources,
 * hypothèses), cartes actives et fermées (jamais supprimées), décisions
 * (`document_rule_evaluations`), appels T4, campagne de réévaluation.
 * T4 (CLASSIFY_EVENT, `t4_output_v3`) est SIMULÉ de façon générique : il
 * demande TOUJOURS la date d'un contrat sans date (pire cas pour le ticket :
 * l'IA « impose » la question) ; seul le moteur « À traiter » peut l'éviter.
 * Aucune règle propre à un établissement : libellés génériques d'échéancier.
 * Dates relatives au jour d'exécution ; assertions limitées aux comptes créés ici.
 *
 *  FCC-01  date de fin explicite                         → enregistrée, aucune carte
 *  FCC-02  date calculable depuis un échéancier          → calculée, aucune carte
 *  FCC-03  1re échéance + nombre de mensualités fiables  → calculée correctement (cas constaté)
 *  FCC-04  signature + durée seules                      → aucun calcul arbitraire, aucune carte
 *  FCC-05  informations insuffisantes (crédit)           → aucune date, aucune carte, T4 non appelé
 *  FCC-06  données contradictoires                       → aucune date, aucune carte
 *  FCC-07  date indispensable (préavis, reconduction)    → sollicitation possible (règle de pertinence)
 *  FCC-08  carte existante devenue inutile               → clôturée / écartée, historique conservé
 *  FCC-09  nouvelle analyse du même document             → aucune recréation, aucun appel IA
 *  FCC-10  modification de l'échéancier                  → réévaluée, valeur protégée intacte
 *  FCC-11  stock : décision du moteur antérieur          → reprise par la campagne existante
 *  FCC-12  tableau d'amortissement du même contrat       → exploité
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';
import { useKnowledgeQueryDelivered } from '../knowledge-query';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

/** Date décalée (jours) du jour d'exécution. */
const jour = (decalage: number) => {
  const iso = new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);
  const [y, m, j] = iso.split('-');
  return { iso, slash: `${j}/${m}/${y}` };
};
/** Même quantième, `mois` mois plus tard (borné à la fin du mois). */
const plusMois = (iso: string, mois: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = (m - 1) + mois;
  const ty = y + Math.floor(t / 12);
  const tm = t % 12;
  const dernier = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, dernier))).toISOString().slice(0, 10);
};
const enSlash = (iso: string) => iso.split('-').reverse().join('/');
/** Première échéance : le 5 du mois, il y a ~5 ans (prêt en cours). */
const PREMIERE = (() => { const b = jour(-1800).iso; return `${b.slice(0, 8)}05`; })();

let appelsT4 = 0;
/**
 * T4 simulé GÉNÉRIQUE et défavorable : date inconnue → « indiquer la date »
 * (donnée nécessaire), preuve citée si une clause de préavis est transmise ;
 * date connue → aucune démarche.
 */
function t4Simule(input: { prompt: string }): unknown {
  appelsT4 += 1;
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any> } : {};
  const demande = ctx.event_context?.toProcessAssessment as { situation: string; knownDate?: string; clauses?: string[] } | undefined;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (!demande) return { ...base, intervention: null };
  const aucune = { needed: 'no', kind: null, action: null, justification: 'aucune démarche (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
  if (demande.knownDate) return { ...base, intervention: aucune };
  const preavis = (demande.clauses ?? []).find((c) => /pr[ée]avis/i.test(c));
  return { ...base, homeCategory: 'action', intervention: { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat',
    justification: preavis ? 'préavis à respecter (simulé)' : 'date de fin utile (simulé)', consequence: null, evidence: preavis ?? null, timing: 'NOW', actBy: null, dataNeeded: true } };
}

scenario('L76I-FCC', 'À traiter : fin de contrat de crédit calculée, sollicitations inutiles supprimées (FCC-01 à FCC-12)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  // Lot 85F : donnée inconnue de TOUTE la connaissance T1 — capacité T3 KNOWLEDGE_QUERY livrée, interprétation sans résultat.
  useKnowledgeQueryDelivered();
  beforeAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule); });
  afterAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null); });
  afterEach(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/to-process/document-field-evidence')).__setT4AssessmentConfigForTests(null);
  });

  type Fait = { key?: string | null; raw?: string; label?: string; value: string; norm?: string | null; confidence?: string; excerpt?: string };
  const doc = async (compte: Compte, p: {
    title: string; type?: string; facts?: Fait[]; assetId?: number;
    units?: Array<{ kind: string; label?: string | null; value?: string | null; text?: string | null; coverage?: string }>;
    endDate?: { value: string; user?: boolean; kind?: string };
  }) => {
    const bien = p.assetId ?? (await make.asset(compte)).id;
    const f = await make.assetFile(compte, { assetId: bien });
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${f.id}, ${p.title}, ${p.type ?? 'FINANCING_CONTRACT'}, NULL, 0) RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${p.type ?? 'FINANCING_CONTRACT'}, analysis_state = 'ANALYZED', original_filename = 'Offre.pdf'
               WHERE id = ${f.id}`;
    await faits(compte, f.id, p.facts ?? []);
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
  const faits = async (compte: Compte, fileId: number, xs: Fait[]) => {
    for (const x of xs) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                SELECT ${compte.id}, ${fileId}, id, ${x.raw ?? x.key ?? 'fait'}, ${x.label ?? null}, ${x.value}, ${x.norm === undefined ? x.value : x.norm},
                       ${x.confidence ?? 'certain'}, ${x.excerpt ?? `${x.label ?? x.key ?? 'fait'} : ${x.value}`}, ${x.key ?? null}
                  FROM document_extractions WHERE file_id = ${fileId} ORDER BY id DESC LIMIT 1`;
    }
  };
  const carte = async (compte: Compte, fileId: number) => (await sql<{ id: number }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
    VALUES (${compte.id}, 'DOCUMENT', ${fileId}, 'contractEndDate', 'COMPLETE', 'DATA-CONTRACT-END', 'Quelle est la date de fin de ce contrat ?') RETURNING id`)[0].id;
  const cartes = async (fileId: number) => sql<Array<{ id: number; kind: string; open: boolean; reason: string | null }>>`
    SELECT id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId}
       AND COALESCE(field_key, relation_key) IN ('contractEndDate', 'intervention:contractEndDate') ORDER BY id`;
  const ouvertes = async (fileId: number) => (await cartes(fileId)).filter((c) => c.open);
  const evenements = async (actionId: number) => sql<Array<{ type: string; details: any }>>`
    SELECT event AS type, details FROM to_process_action_events WHERE action_id = ${actionId} ORDER BY id`;
  const valeur = async (fileId: number) => (await sql<Array<{ v: string | null; u: boolean; kind: string | null; derivation: any }>>`
    SELECT value_text AS v, user_validated AS u, value_kind AS kind, derivation FROM document_field_values WHERE file_id = ${fileId} AND field_key = 'contractEndDate'`)[0] ?? null;
  const diag = async (fileId: number) => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = 'DATA-CONTRACT-END' ORDER BY id`;
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  const reanalyse = async (compte: Compte, fileId: number) => (await import('@/services/to-process/document-rule-bridge')).syncDocumentRulesFromAnalysis({
    accountId: compte.id, fileId, observations: { facts: [], assetCandidates: [], documentAssetId: null } as never, runRef: 'e2e:reanalyse',
  });

  /** Offre de crédit (cas constaté) : libellés génériques d'un échéancier. */
  const offre = (p: { premiere?: string | null; nombre?: string | null; periodicite?: string | null; duree?: string | null; derniere?: string | null; reference?: string } = {}): Fait[] => [
    { raw: 'dateEmissionOffre', label: 'Date d’émission de l’offre', value: enSlash(plusMois(PREMIERE, -3)), norm: plusMois(PREMIERE, -3) },
    ...(p.premiere === null ? [] : [{ raw: 'datePremiereEcheance', label: 'Date de première échéance', value: enSlash(p.premiere ?? PREMIERE), norm: p.premiere ?? PREMIERE }]),
    ...(p.nombre === null ? [] : [{ raw: 'nombreEcheances', label: 'Nombre d’échéances', value: p.nombre ?? '240', norm: null }]),
    ...(p.periodicite === null ? [] : [{ raw: 'periodicite', label: 'Périodicité des échéances', value: p.periodicite ?? 'Mensuelle', norm: null }]),
    ...(p.duree === null ? [] : [{ raw: 'dureePret', label: 'Durée du prêt', value: p.duree ?? '240 mois', norm: null }]),
    ...(p.derniere ? [{ raw: 'dateDerniereEcheance', label: 'Date de dernière échéance', value: enSlash(p.derniere), norm: p.derniere }] : []),
    ...(p.reference ? [{ key: 'contractNumber', raw: 'numeroContrat', label: 'N° de contrat', value: p.reference }] : []),
    { raw: 'objetPret', label: 'Objet du financement', value: 'Acquisition d’une maison' },
  ];
  /** Dernière échéance attendue de 240 mensualités. */
  const FIN_240 = plusMois(PREMIERE, 239);

  // ══════════════════════════════════════════════════════════════════════

  it('FCC-01 — date de fin explicite dans les données structurées : enregistrée (nature EXPLICIT), aucune carte, T4 non sollicité', async () => {
    const compte = await make.account();
    appelsT4 = 0;
    const f = await doc(compte, { title: 'Offre de crédit immobilier',
      facts: [...offre({ premiere: null, nombre: null, periodicite: null }), { key: 'contractEndDate', label: 'Date de fin du contrat', value: enSlash(FIN_240), norm: FIN_240 }] });
    await balayage(compte);
    expect(await valeur(f)).toMatchObject({ v: FIN_240, kind: 'EXPLICIT', u: false });
    expect(await ouvertes(f)).toEqual([]);
    expect(appelsT4).toBe(0);
  });

  it('FCC-02 — date calculable depuis un échéancier (dernière échéance lue) : persistée CALCULATED avec provenance, aucune carte', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre({ premiere: null, nombre: null, periodicite: null, derniere: FIN_240 }) });
    await balayage(compte);
    expect(await valeur(f)).toMatchObject({ v: FIN_240, kind: 'CALCULATED',
      derivation: { status: 'CALCULATED_RELIABLE', method: 'SCHEDULE_LAST_INSTALMENT', schedule: { sources: { lastInstalment: { value: FIN_240 } } } } });
    expect(await ouvertes(f)).toEqual([]);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'AUTO_RESOLVED', reason_code: 'CALCULATED_FROM_SCHEDULE', write_verified: true });
  });

  it('FCC-03 — cas constaté : 1re échéance + 240 mensualités → dernière échéance exacte, carte « À compléter » existante clôturée (AUTO_RESOLVED), historique conservé', async () => {
    const compte = await make.account();
    appelsT4 = 0;
    const maison = (await make.asset(compte)).id;
    const f = await doc(compte, { title: 'Offre de crédit immobilier', assetId: maison, facts: offre() });
    const ancienne = await carte(compte, f);
    await balayage(compte);
    const v = await valeur(f);
    expect(v).toMatchObject({ v: FIN_240, kind: 'CALCULATED', u: false });
    expect(v!.derivation).toMatchObject({ status: 'CALCULATED_RELIABLE', method: 'FIRST_INSTALMENT_PLUS_COUNT',
      schedule: { sources: { firstInstalment: { value: PREMIERE }, count: { count: 240 }, periodicity: { months: 1, origin: 'READ' } } } });
    // Jamais la date d'émission de l'offre comme point de départ.
    expect(JSON.stringify(v!.derivation)).not.toContain(plusMois(PREMIERE, -3));
    expect(await ouvertes(f)).toEqual([]);
    const c = (await cartes(f)).find((x) => x.id === ancienne)!;
    expect(c).toMatchObject({ open: false });
    expect((await evenements(ancienne)).at(-1)!.details).toMatchObject({ reason: 'AUTO_RESOLVED', valueKind: 'CALCULATED' });
    expect(appelsT4).toBe(0);
  });

  it('FCC-04 — date de signature + durée seules : aucun calcul arbitraire, aucune carte pour ce seul manque', async () => {
    const compte = await make.account();
    appelsT4 = 0;
    const f = await doc(compte, { title: 'Offre de crédit immobilier', facts: [
      { raw: 'dateSignature', label: 'Date de signature', value: jour(-1700).slash, norm: jour(-1700).iso },
      { raw: 'dureePret', label: 'Durée du prêt', value: '240 mois', norm: null },
    ] });
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    expect(await ouvertes(f)).toEqual([]);
    const d = (await diag(f)).at(-1)!;
    expect(d).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'UNDATED_NOT_NEEDED' });
    expect(d.reason_code).toBe('NO_ACTION_NEEDED');
    expect(d.derivation).toMatchObject({ status: 'NOT_DERIVABLE' });
    expect(d.pertinence_reason).toBe('repayment_schedule_without_end_action');
    expect(appelsT4).toBe(0);
  });

  it('FCC-05 — informations insuffisantes (nombre de mensualités sans point de départ) : aucune date inventée, aucune carte, motif tracé', async () => {
    const compte = await make.account();
    appelsT4 = 0;
    const f = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre({ premiere: null }) });
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    expect(await ouvertes(f)).toEqual([]);
    const d = (await diag(f)).at(-1)!;
    expect(d).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'UNDATED_NOT_NEEDED' });
    expect(d.derivation).toMatchObject({ schedule: { evidenced: true, status: 'NOT_DERIVABLE', reason: 'no_first_instalment' } });
    expect(appelsT4).toBe(0);
  });

  it('FCC-06 — données contradictoires (dernière échéance ≠ calcul, nombre ≠ durée) : aucune date calculée, aucune carte', async () => {
    const compte = await make.account();
    const a = await doc(compte, { title: 'Offre de crédit', facts: offre({ derniere: plusMois(PREMIERE, 251) }) });
    const b = await doc(compte, { title: 'Offre de crédit', facts: offre({ duree: '300 mois' }) });
    await balayage(compte);
    for (const [f, motif] of [[a, 'last_instalment_contradicts_schedule'], [b, 'schedule_inconsistent_with_duration']] as const) {
      expect(await valeur(f)).toBeNull();
      expect(await ouvertes(f)).toEqual([]);
      expect((await diag(f)).at(-1)!.derivation).toMatchObject({ status: 'AMBIGUOUS', reason: `schedule:${motif}` });
    }
  });

  it('FCC-07 — date indispensable (reconduction, préavis) et inconnue : la règle de pertinence existante peut solliciter l’utilisateur', async () => {
    const compte = await make.account();
    appelsT4 = 0;
    const f = await doc(compte, { title: 'Contrat d’abonnement', type: 'SUBSCRIPTION_CONTRACT', facts: [
      { raw: 'reconduction', label: 'Reconduction', value: 'Le contrat est reconduit tacitement sauf dénonciation avec un préavis de 2 mois avant l’échéance.' },
      { raw: 'nombreMensualites', label: 'Nombre de mensualités', value: '12' },
    ] });
    await balayage(compte);
    expect(appelsT4).toBeGreaterThan(0);
    expect((await ouvertes(f)).map((c) => c.kind)).toEqual(['COMPLETE']);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'CREATE_ACTION' });
  });

  it('FCC-08 — carte existante devenue inutile (crédit, fin indéterminable) : écartée (NO_ACTION_NEEDED), jamais supprimée ; « Non applicable » de l’utilisateur conservé', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre({ premiere: null }) });
    const ancienne = await carte(compte, f);
    const g = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre({ premiere: null }) });
    const na = await carte(compte, g);
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'NOT_APPLICABLE' WHERE id = ${na}`;
    await balayage(compte);
    expect(await ouvertes(f)).toEqual([]);
    expect((await cartes(f)).find((c) => c.id === ancienne)).toMatchObject({ open: false, reason: 'OBSOLETE' });
    expect((await evenements(ancienne)).at(-1)!.details).toMatchObject({ reason: 'NO_ACTION_NEEDED' });
    expect((await cartes(g)).find((c) => c.id === na)).toMatchObject({ open: false, reason: 'NOT_APPLICABLE' });
    expect(await ouvertes(g)).toEqual([]);
  });

  it('FCC-09 — nouvelle analyse du même document : aucune recréation, aucun appel IA, décision dédupliquée', async () => {
    const compte = await make.account();
    const calc = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre() });
    const sans = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre({ premiere: null }) });
    await balayage(compte);
    appelsT4 = 0;
    for (let k = 0; k < 2; k += 1) {
      await reanalyse(compte, calc);
      await reanalyse(compte, sans);
      await balayage(compte);
    }
    expect(appelsT4).toBe(0);
    expect(await cartes(calc)).toEqual([]);
    expect(await cartes(sans)).toEqual([]);
    expect(await valeur(calc)).toMatchObject({ v: FIN_240, kind: 'CALCULATED' });
    expect((await diag(calc)).at(-1)).toMatchObject({ outcome: 'AUTO_RESOLVED' });
  });

  it('FCC-10 — modification de l’échéancier : valeur calculée réévaluée ; avenant connu → retirée ; valeur de l’utilisateur jamais écrasée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre() });
    const u = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre(), endDate: { value: '2050-01-01', user: true } });
    await balayage(compte);
    expect(await valeur(f)).toMatchObject({ v: FIN_240 });
    // Échéancier modifié (300 mensualités, durée cohérente).
    await sql`UPDATE document_facts SET value_text = '300' WHERE file_id = ${f} AND fact_key = 'nombreEcheances'`;
    await sql`UPDATE document_facts SET value_text = '300 mois' WHERE file_id = ${f} AND fact_key = 'dureePret'`;
    await balayage(compte);
    expect(await valeur(f)).toMatchObject({ v: plusMois(PREMIERE, 299), kind: 'CALCULATED' });
    // Modification contractuelle connue (avenant) : plus aucune certitude → valeur théorique retirée, aucune carte.
    await faits(compte, f, [{ raw: 'avenant', label: 'Avenant', value: 'Avenant n°1 : réaménagement du prêt signé le ' + jour(-200).slash }]);
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    expect((await diag(f)).at(-1)!.derivation).toMatchObject({ schedule: { reason: 'known_schedule_change' } });
    expect(await ouvertes(f)).toEqual([]);
    expect(await valeur(u)).toMatchObject({ v: '2050-01-01', u: true });
  });

  it('FCC-11 — stock : décision sans carte du moteur antérieur reprise par le contrôle de cohérence (valeur calculée, aucune carte)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre() });
    const { currentKnowledgeRev, DOCUMENT_RULE_ENGINE_VERSION } = await import('@/services/to-process/document-field-evidence');
    expect(DOCUMENT_RULE_ENGINE_VERSION).toBe('l76-2');
    await sql`INSERT INTO document_rule_evaluations (account_id, file_id, rule_code, field_key, trigger_code, engine_version, decision, reason_code, signature, outcome, pertinence, knowledge_rev, config_ref)
              VALUES (${compte.id}, ${f}, 'DATA-CONTRACT-END', 'contractEndDate', 'SWEEP', 'l76-1', 'NONE', 'DEFERRED', ${`ancien-${f}`},
                      'DEFER', 'T4_INCOMPATIBLE', ${await currentKnowledgeRev(compte.id, f)}, 'det:structured')`;
    // Lot 83E (C-Q9) : la campagne est RETIRÉE — reprise par le contrôle de cohérence COH-TODO-STALE-DECISIONS (même décision).
    const { runCoherenceFor, proofOf } = await import('../coherence-run');
    expect((await runCoherenceFor(sql, [compte.id])).status).toBe('COMPLETE');
    expect(await valeur(f)).toMatchObject({ v: FIN_240, kind: 'CALCULATED' });
    expect(await ouvertes(f)).toEqual([]);
    expect((await proofOf(sql, compte.id, 'COH-TODO-STALE-DECISIONS', f))?.last_result).toBe('REPAIRED');
  });

  it('FCC-12 — tableau d’amortissement du MÊME contrat (référence exacte) : dernière échéance exploitée pour l’offre', async () => {
    const compte = await make.account();
    const offreId = await doc(compte, { title: 'Offre de crédit immobilier', facts: offre({ premiere: null, nombre: null, periodicite: null, reference: 'PRET-0042-778' }) });
    await doc(compte, { title: 'Tableau d’amortissement', type: 'FINANCING_SCHEDULE', facts: [
      { key: 'contractNumber', raw: 'numeroContrat', label: 'N° de contrat', value: 'PRET 0042 778' },
      { raw: 'dateDerniereEcheance', label: 'Date de dernière échéance', value: enSlash(FIN_240), norm: FIN_240 },
    ] });
    await balayage(compte);
    expect(await valeur(offreId)).toMatchObject({ v: FIN_240, kind: 'CALCULATED',
      derivation: { method: 'SCHEDULE_LAST_INSTALMENT', schedule: { sources: { lastInstalment: { source: expect.stringContaining('RELATED_DOCUMENT') } } } } });
    expect(await ouvertes(offreId)).toEqual([]);
  });
});
