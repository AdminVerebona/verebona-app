/**
 * Lot 75E — ticket « [P1] T6 — Corriger les écarts résiduels de sélection,
 * preuves et rappels » — recette §3 de bout en bout sur PostgreSQL 16 réel :
 * vrai collecteur, vraie décision, vraie file de pré-génération, vraies
 * routes. Modèle SIMULÉ (aucun réseau) : en MODE=EVALUATE, il rend la
 * décision que le scénario lui confie selon ce qu'il REÇOIT (faits, statuts,
 * description) — le jugement reste celui de l'IA simulée, jamais une règle
 * du code.
 *
 *  L75E-T6-A  échéance dépassée de 90 jours écartée (SUPPRESS), clause ajoutée :
 *             redevient évaluable, jamais réaffichée avant la décision IA ;
 *             modification de clause sans changement de titre ni de date ;
 *             réextraction identique : aucun appel IA supplémentaire
 *  L75E-T6-B  plus de 200 échéances, dont une fenêtre saturée par des
 *             échéances anciennes déjà décidées : reprise complète, bornée,
 *             sans doublon ; échéance lointaine documentée finalement examinée
 *  L75E-T6-C  exception au seuil : preuve valide (préavis extrait), absente
 *             (intitulé de document seul) ou incertaine
 *  L75E-T6-D  replanification et nouveau cycle (mensuelle, trimestrielle,
 *             annuelle, pluriannuelle) ; régénération complète d'une série
 *             refusée ; migration 0551 rejouable, choix existants préservés
 *  L75E-T6-E  Premium Duo : préférences distinctes ; lecture incomplète ou
 *             indisponible : aucun sujet réintroduit, tracé
 *  Concurrence : appels simultanés sans doublon (préférences, examens, évaluations)
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

const etat = vi.hoisted(() => ({ session: { userId: 0, currentAccountId: 0 as number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

type Eval = Record<string, unknown> | null;
interface Fait { ref: string; document: string | null; excerpt: string | null; status: string; provenance: string }
interface Candidat {
  subjectId: string; title: string; description: string | null; daysUntilDue: number | null; overdue: boolean;
  documents: string[]; facts?: Fait[]; evidence: Array<{ ref: string; kind: string }>;
}

const modele = vi.hoisted(() => ({ juger: (_c: Candidat): Eval => null, candidats: [] as Candidat[][] }));

function provider() {
  return {
    name: 'simule-l75e',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        modele.candidats.push(ctx.candidates);
        const decisions = ctx.candidates.map((c) => {
          const e = modele.juger(c) ?? AUCUNE;
          const { preuve, ...reste } = e as { preuve?: string };
          const refs = c.evidence.map((x) => x.ref);
          return {
            subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, priorityHint: null, uncertainties: [],
            evidenceRefs: [refs.find((r) => r.endsWith(`.${preuve ?? 'dueDate'}`)) ?? refs[0]],
            ...reste,
          };
        });
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return {
        rawText: JSON.stringify({ schemaVersion: 't6-output-v2', messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })), suggestions: [] }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', priorityHint: 'LOW', preuve: 'title' };
const AGIR = (o: Record<string, unknown> = {}) => ({
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON',
  reason: 'Une démarche est nécessaire à court terme.', expectedAction: 'Prendre rendez-vous avec le prestataire', priorityHint: 'MEDIUM', ...o,
});
const PREAVIS = (actionDeadline: string, preuve: string, o: Record<string, unknown> = {}) => ({
  decision: 'SHOW_NOW', category: 'TO_ANTICIPATE', reasonCode: 'NOTICE_PERIOD_RUNNING',
  reason: 'La clause de préavis extraite impose d’envoyer la résiliation avant la date limite.',
  expectedAction: 'Envoyer la lettre de résiliation', actionDeadline, priorityHint: 'HIGH', preuve, ...o,
});

scenario('L75E-T6', 'Lot 75E — écarts résiduels de sélection, preuves et rappels T6', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.juger = () => null;
    modele.candidats.length = 0;
    (await import('@/services/home/mascot/t6-runner')).resetT6Breaker();
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState?.();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    await sql`DELETE FROM home_mascot_pregen_requests`;
  });
  afterEach(async () => { (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations(); });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');

  async function compte() {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    return { ...a, maison: maison.id };
  }
  async function echeance(c: { id: number; ownerUserId: number; maison: number }, titre: string, date: string, o: { description?: string; serie?: string } = {}) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action', description = ${o.description ?? null}, series_key = ${o.serie ?? null} WHERE id = ${e.id}`;
    return e.id;
  }
  async function contrat(c: { id: number; ownerUserId: number; maison: number }, agendaItemId: number, titre = 'Contrat d’entretien') {
    const f = await make.assetFile(c as never, { assetId: c.maison });
    await sql`UPDATE asset_files SET retained_title = ${titre}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${agendaItemId}, ${f.id})`;
    const [x] = await sql<[{ id: number }]>`INSERT INTO document_extractions (account_id, file_id, title) VALUES (${c.id}, ${f.id}, ${titre}) RETURNING id`;
    return { fileId: f.id, extractionId: Number(x.id) };
  }
  async function fait(c: { id: number }, doc: { fileId: number; extractionId: number }, o: { key: string; label: string; value: string; excerpt: string; confidence?: string }) {
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt)
              VALUES (${c.id}, ${doc.fileId}, ${doc.extractionId}, ${o.key}, ${o.label}, ${o.value}, ${o.value}, ${o.confidence ?? 'certain'}, ${o.excerpt})`;
  }
  const passer = async (accountId: number, userId: number | null = null) => (await svc()).getMascotPresentation(accountId, 'pregen', userId);
  const sujets = (p: import('@/services/home/mascot/types').MascotPresentation) => p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR' && x.reminder != null);
  const ids = (p: import('@/services/home/mascot/types').MascotPresentation) => sujets(p).map((x) => x.reminder!.agendaItemId);
  const evalues = () => modele.candidats.flat();
  const req = (method: string, body?: unknown, query = '') => new NextRequest(`http://localhost/api/home/mascot/reminders${query}`, {
    method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const route = () => import('@/app/api/home/mascot/reminders/route');
  const en = (userId: number, accountId: number) => { etat.session = { userId, currentAccountId: accountId }; };
  const prefs = async (accountId: number) => sql<Array<{ user_id: number; subject_key: string; decision: string; cycle_key: string | null }>>`
    SELECT user_id, subject_key, decision, cycle_key FROM t6_reminder_preferences WHERE account_id = ${accountId} ORDER BY id`;
  const murir = () => sql`UPDATE home_mascot_pregen_requests SET requested_at = requested_at - interval '1 minute' WHERE processed_at IS NULL OR requested_at > processed_at`;
  const preparer = async (accountId: number, userId: number | null, loaders: Record<string, unknown> = {}) => {
    const S = await import('@/services/home/mascot/t6-interpellation.service');
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    return S.prepareT6Interpellation({ accountId, userId, raw: await collectMascotData(accountId) },
      { aiCapable: async () => true, thresholdDays: async () => 60, loaders: loaders as never });
  };
  /** Pré-génération durable jusqu'à épuisement (reprise bornée). */
  async function reprendre(accountId: number, max = 60) {
    const Q = await import('@/services/home/mascot/pregen-queue');
    await Q.requestMascotPregeneration(accountId, 'test');
    let passages = 0;
    for (; passages < max; passages += 1) {
      await murir();
      const r = await Q.runMascotPregeneration();
      if (r.claimed === 0) break;
    }
    return passages;
  }

  // ── A ─────────────────────────────────────────────────────────────────────

  it('L75E-T6-A — dépassée de 90 jours, écartée, clause pertinente ajoutée : évaluable à nouveau, jamais réaffichée avant décision IA', async () => {
    const c = await compte();
    const e = await echeance(c, 'Fin du contrat d’entretien chaudière', await plus(-90));
    const doc = await contrat(c, e);
    // Écartée il y a 3 semaines (décision IA conservée, données de l'époque).
    const { evaluerEcheance } = await import('../t6-assessment');
    await evaluerEcheance(sql, e, { interpellation: 'NONE' });
    await sql`UPDATE t6_interpellation_assessments SET assessed_on = assessed_on - 21 WHERE agenda_item_id = ${e}`;
    // Contexte inchangé : jamais relue ni réévaluée (aucun appel répété).
    await passer(c.id);
    await passer(c.id);
    expect(evalues().filter((x) => x.title.startsWith('Fin du contrat'))).toEqual([]);
    // Nouvelle clause extraite (titre et date inchangés).
    await fait(c, doc, { key: 'unpaidMaintenance', label: 'Obligation de paiement du solde', value: '120 €', excerpt: 'Le solde de 120 € reste dû au prestataire en cas de résiliation.' });
    modele.candidats.length = 0;
    modele.juger = (x) => ((x.facts ?? []).some((f) => /solde/.test(f.excerpt ?? '')) ? AGIR({ reasonCode: 'OVERDUE_ACTION_PENDING', expectedAction: 'Régler le solde au prestataire', preuve: 'fact1' }) : AUCUNE);
    // Affichage AVANT la décision IA : rien d'office ; l'évaluation est demandée en arrière-plan.
    en(c.ownerUserId, c.id);
    const avant = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(ids(avant)).not.toContain(e);
    await vi.waitFor(async () => {
      const [a] = await sql<[{ decision: string }]>`SELECT decision FROM t6_interpellation_assessments WHERE agenda_item_id = ${e}`;
      expect(a.decision).toBe('SHOW_NOW');
    }, { timeout: 10_000 });
    const p = await passer(c.id);
    // Une seule évaluation (aucune demande répétée), puis présentée.
    expect(evalues().map((x) => x.title)).toEqual(['Fin du contrat d’entretien chaudière']);
    expect(ids(p)).toEqual([e]);
    // Réextraction IDENTIQUE (nouvelle version, variation cosmétique : casse, ponctuation, espaces) : aucun appel IA supplémentaire.
    // Lot 76A : l'ordre des mots porte le sens — une clause réordonnée est réévaluée une fois (jamais présumée identique).
    modele.candidats.length = 0;
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${doc.fileId}`;
    await fait(c, doc, { key: 'unpaidMaintenance', label: 'Obligation de paiement du solde', value: '120 €', excerpt: '  LE SOLDE de 120 € reste dû au prestataire, en cas de résiliation !' });
    expect(ids(await passer(c.id))).toEqual([e]);
    expect(evalues()).toEqual([]);
    // Modification de CLAUSE sans changement de titre, de date ni de valeur : réévaluée.
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${doc.fileId}`;
    await fait(c, doc, { key: 'unpaidMaintenance', label: 'Obligation de paiement du solde', value: '120 €', excerpt: 'Le solde de 120 € n’est pas dû en cas de résiliation.' });
    modele.juger = () => ({ ...AUCUNE, reasonCode: 'ALREADY_HANDLED', reason: 'La clause n’impose plus aucun paiement.' });
    const q = await passer(c.id);
    expect(evalues().map((x) => x.title)).toEqual(['Fin du contrat d’entretien chaudière']);
    expect(ids(q)).toEqual([]);
  });

  // ── B ─────────────────────────────────────────────────────────────────────

  it('L75E-T6-B — plus de 200 échéances, fenêtre saturée d’anciennes décisions : reprise complète, bornée, sans doublon', async () => {
    const c = await compte();
    // 200 échéances proches (lecture principale).
    await sql`INSERT INTO agenda_items (account_id, title, start_date, home_category)
              SELECT ${c.id}, 'Relevé compteur ' || g, ${await jour()}::date + 1 + (g * 170 / 200), 'action' FROM generate_series(1, 200) g`;
    // 130 échéances anciennes (61 à 400 jours) déjà jugées « plus tard » : elles occupaient durablement la fenêtre de 120.
    const anciennes = await sql<Array<{ id: number }>>`INSERT INTO agenda_items (account_id, title, start_date, home_category)
              SELECT ${c.id}, 'Ancienne échéance ' || g, ${await jour()}::date - 61 - g * 2, 'action' FROM generate_series(1, 130) g RETURNING id`;
    const { evaluerEcheance } = await import('../t6-assessment');
    for (const { id } of anciennes) await evaluerEcheance(sql, id, { interpellation: 'LATER' });
    // Plusieurs dépassées jamais évaluées, documentées (action identifiable), et une lointaine documentée.
    const depassees: number[] = [];
    for (const n of [70, 80, 95]) {
      const id = await echeance(c, `Mise en conformité ${n}`, await plus(-n));
      await fait(c, await contrat(c, id), { key: 'complianceObligation', label: 'Obligation de mise en conformité', value: 'oui', excerpt: 'Mise en conformité obligatoire.' });
      depassees.push(id);
    }
    const loin = await echeance(c, 'Échéance bail commercial', await plus(400));
    await fait(c, await contrat(c, loin, 'Bail commercial'), { key: 'terminationNotice', label: 'Congé', value: '6 mois', excerpt: 'Le congé doit être délivré six mois avant la fin du bail.' });
    const limite = await plus(30);
    modele.juger = (x) => (x.title === 'Échéance bail commercial' ? PREAVIS(limite, 'fact1') : x.title.startsWith('Mise en conformité') ? AGIR({ reasonCode: 'OVERDUE_ACTION_PENDING' }) : AUCUNE);
    const passages = await reprendre(c.id);
    // Bornée : chaque passage évalue au plus 8 candidats ; la reprise s'arrête d'elle-même.
    expect(passages).toBeLessThan(60);
    expect(Math.max(...modele.candidats.map((x) => x.length))).toBeLessThanOrEqual(8);
    // Exhaustive : la lointaine documentée et les dépassées documentées ont été examinées…
    const titres = evalues().map((x) => x.title);
    for (const t of ['Échéance bail commercial', 'Mise en conformité 70', 'Mise en conformité 80', 'Mise en conformité 95']) expect(titres, t).toContain(t);
    // … sans duplication (une seule demande par échéance, une seule décision conservée).
    expect(new Set(titres).size).toBe(titres.length);
    const [{ n, d }] = await sql<[{ n: number; d: number }]>`SELECT count(*)::int AS n, count(DISTINCT agenda_item_id)::int AS d FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    expect(n).toBe(d);
    // Toutes les anciennes déjà décidées ont été examinées (curseur persistant), sans appel IA.
    const [{ ex }] = await sql<[{ ex: number }]>`SELECT count(*)::int AS ex FROM t6_candidate_examinations x JOIN agenda_items i ON i.id = x.agenda_item_id
                                                  WHERE x.account_id = ${c.id} AND i.title LIKE 'Ancienne échéance %'`;
    expect(ex).toBe(130);
    expect(titres.filter((t) => t.startsWith('Ancienne échéance'))).toEqual([]);
    // La décision lointaine est présentée (exception motivée par la clause extraite).
    const p = await passer(c.id);
    expect(ids(p)).toContain(loin);
    // Plus rien à reprendre : un nouveau passage n'évalue rien.
    modele.candidats.length = 0;
    await passer(c.id);
    expect(evalues()).toEqual([]);
  }, 300_000);

  // ── C ─────────────────────────────────────────────────────────────────────

  it('L75E-T6-C — exception au seuil : préavis extrait (valide) ; intitulé de document seul (absente) ; clause incertaine', async () => {
    const c = await compte();
    const valide = await echeance(c, 'Échéance assurance habitation', await plus(240));
    await fait(c, await contrat(c, valide, 'Conditions particulières'), { key: 'terminationNotice', label: 'Préavis de résiliation', value: '8 mois', excerpt: 'Résiliation notifiée au moins huit mois avant l’échéance.' });
    const titre = await echeance(c, 'Échéance contrat alarme', await plus(245));
    await contrat(c, titre, 'Contrat alarme — préavis 8 mois');
    const incertaine = await echeance(c, 'Échéance contrat box', await plus(250));
    await fait(c, await contrat(c, incertaine, 'Contrat box'), { key: 'terminationNotice', label: 'Préavis', value: '8 mois', excerpt: 'Préavis peut-être de huit mois (sources contradictoires).', confidence: 'conflictual' });
    const limite = await plus(5);
    modele.juger = (x) => (x.title === 'Échéance contrat alarme' ? PREAVIS(limite, 'doc1')
      : x.title === 'Échéance contrat box' ? PREAVIS(limite, 'fact1', { uncertainties: ['Durée du préavis contradictoire'] })
        : PREAVIS(limite, 'fact1'));
    await passer(c.id);
    const p = await passer(c.id);
    expect(evalues().map((x) => x.title).sort()).toEqual(['Échéance assurance habitation', 'Échéance contrat alarme', 'Échéance contrat box']);
    expect(ids(p)).toEqual([valide]);
    const prep = await preparer(c.id, null);
    const code = (id: number) => prep.decisions.find((d) => d.agendaItemId === id)?.code;
    expect(code(valide)).toBe('THRESHOLD_EXCEPTION');
    expect(code(titre)).toBe('BEYOND_THRESHOLD');
    expect(code(incertaine)).toBe('BEYOND_THRESHOLD');
    // Références et versions des preuves conservées (reporting) : fait, extraction, statut.
    const [s] = await sql<[{ snap: { refs: Array<Record<string, unknown>> } }]>`SELECT evidence_snapshot AS snap FROM t6_interpellation_assessments WHERE agenda_item_id = ${valide}`;
    expect(s.snap.refs).toEqual([expect.objectContaining({ ref: expect.stringMatching(/^C\d\.fact1$/), kind: 'DOCUMENT_FACT', status: 'PROVEN', extractionId: expect.any(Number) })]);
    // Décision ANTÉRIEURE au lot 75E (règle du lot 71G : intitulé de document = preuve) : l'exception
    // n'est plus retenue, sans attendre sa réévaluation — jamais affichée.
    await sql`UPDATE t6_interpellation_assessments SET exception_reason = 'Le contrat prévoit un préavis de huit mois.' WHERE agenda_item_id = ${titre}`;
    const apres = await preparer(c.id, null);
    expect(apres.decisions.find((d) => d.agendaItemId === titre)?.code).toBe('THRESHOLD_EXCEPTION_UNPROVEN');
    expect(apres.shown.map((x) => x.agendaItemId)).toEqual([valide]);
  });

  it('L75E-T6-C — clause incertaine seule fondement d’une démarche présentée comme certaine : décision rejetée, jamais affichée', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision ascenseur', await plus(20));
    await fait(c, await contrat(c, e), { key: 'maintenanceObligation', label: 'Obligation d’entretien', value: 'mensuelle', excerpt: 'Entretien peut-être mensuel.', confidence: 'conflictual' });
    modele.juger = () => AGIR({ preuve: 'fact1' });
    await passer(c.id);
    const p = await passer(c.id);
    expect(ids(p)).toEqual([]);
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM t6_interpellation_assessments WHERE agenda_item_id = ${e}`;
    expect(n).toBe(0);
  });

  // ── D ─────────────────────────────────────────────────────────────────────

  it('L75E-T6-D — replanification (quel que soit l’écart) et nouveau cycle, pour des séries mensuelle, trimestrielle, annuelle, pluriannuelle', async () => {
    const c = await compte();
    modele.juger = () => AGIR();
    en(c.ownerUserId, c.id);
    const R = await route();
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    for (const [nom, periode] of [['mensuelle', 30], ['trimestrielle', 91], ['annuelle', 365], ['quinquennale', 1826]] as const) {
      const serie = `serie-${nom}`;
      const o1 = await echeance(c, `Contrôle ${nom}`, await plus(10), { serie });
      const o2 = await echeance(c, `Contrôle ${nom}`, await plus(10 + periode), { serie });
      await passer(c.id);
      expect((await R.POST(req('POST', { agendaItemId: o1, action: 'DISMISS', scope: 'OCCURRENCE' }))).status).toBe(200);
      // Occurrence suivante (nouvelle occurrence T4) : jamais héritée.
      const prep = await preparer(c.id, c.ownerUserId);
      expect(prep.decisions.find((d) => d.agendaItemId === o1)?.code, nom).toBe('USER_DISMISSED_OCCURRENCE');
      expect(prep.decisions.find((d) => d.agendaItemId === o2)?.code ?? '', nom).not.toMatch(/USER_DISMISSED/);
      // Replanification de l'occurrence refusée, même d'un écart supérieur à 183 jours : refus conservé.
      await sql`UPDATE agenda_items SET start_date = start_date + ${Math.min(periode, 400)}::int WHERE id = ${o1}`;
      const re = await preparer(c.id, c.ownerUserId);
      expect(re.decisions.find((d) => d.agendaItemId === o1)?.code, `${nom} replanifiée`).toBe('USER_DISMISSED_OCCURRENCE');
      // Occurrence réalisée puis rouverte (cycle suivant de la même ligne) : refus non transmis, ni présenté.
      await updateManualStatus(o1, 'realise', c.id);
      await updateManualStatus(o1, null, c.id);
      const nv = await preparer(c.id, c.ownerUserId);
      expect(nv.decisions.find((d) => d.agendaItemId === o1)?.code ?? '', `${nom} nouveau cycle`).not.toMatch(/USER_DISMISSED/);
      const etatO1 = await (await R.GET(req('GET', undefined, `?agendaItemId=${o1}`))).json();
      expect(etatO1).toMatchObject({ occurrence: null });
    }
    // Nettoyage : le refus du cycle précédent (sans objet) est retiré ; aucun autre.
    const { cleanupT6Reminders } = await import('@/services/home/mascot/t6-reminders.service');
    await cleanupT6Reminders(await jour());
    expect(await prefs(c.id)).toEqual([]);
  });

  it('L75E-T6-D — régénération complète d’une série refusée (aucune occurrence pendant plus d’un an) : refus conservé', async () => {
    const c = await compte();
    const o1 = await echeance(c, 'Entretien pompe à chaleur', await plus(12), { serie: 'serie-pac-75' });
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    expect((await (await route()).POST(req('POST', { agendaItemId: o1, action: 'DISMISS', scope: 'SERIES' }))).status).toBe(200);
    const [p0] = await sql<[{ series_asset_id: number | null }]>`SELECT series_asset_id FROM t6_reminder_preferences WHERE account_id = ${c.id}`;
    expect(p0.series_asset_id).toBe(c.maison);
    await sql`DELETE FROM agenda_items WHERE series_key = 'serie-pac-75'`;
    const { cleanupT6Reminders } = await import('@/services/home/mascot/t6-reminders.service');
    await cleanupT6Reminders(await jour());
    await sql`UPDATE t6_reminder_preferences SET orphaned_since = ${await plus(-500)} WHERE account_id = ${c.id}`;
    await cleanupT6Reminders(await jour());
    expect(await prefs(c.id)).toEqual([expect.objectContaining({ subject_key: 'series:serie-pac-75', decision: 'DISMISSED' })]);
    // T4 régénère la série (nouvelles lignes) : toutes refusées.
    const o2 = await echeance(c, 'Entretien pompe à chaleur', await plus(30), { serie: 'serie-pac-75' });
    const o3 = await echeance(c, 'Entretien pompe à chaleur', await plus(395), { serie: 'serie-pac-75' });
    const prep = await preparer(c.id, c.ownerUserId);
    for (const id of [o2, o3]) expect(prep.decisions.find((d) => d.agendaItemId === id)?.code).toBe('USER_DISMISSED_SERIES');
    expect(await prefs(c.id)).toHaveLength(1);
  });

  it('L75E-T6-D — migration 0551 rejouable ; préférences existantes migrées sans effacer de choix valide', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision chaudière', await plus(20), { serie: 'serie-chaudiere' });
    // Préférences antérieures (sans cycle ni bien), dont une « d'un cycle précédent » selon l'ancien écart de 183 jours.
    await sql`INSERT INTO t6_reminder_preferences (account_id, user_id, subject_key, scope, agenda_item_id, decision, occurrence_date)
              VALUES (${c.id}, ${c.ownerUserId}, ${`agenda:${e}`}, 'OCCURRENCE', ${e}, 'DISMISSED', ${await plus(-200)})`;
    await sql`INSERT INTO t6_reminder_preferences (account_id, user_id, subject_key, scope, series_key, decision)
              VALUES (${c.id}, ${c.ownerUserId}, 'series:serie-chaudiere', 'SERIES', 'serie-chaudiere', 'DISMISSED')`;
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0551_l75e_t6_cycles_selection.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    const p = await sql<Array<{ scope: string; cycle_key: string | null; series_asset_id: number | null }>>`
      SELECT scope, cycle_key, series_asset_id FROM t6_reminder_preferences WHERE account_id = ${c.id} ORDER BY id`;
    expect(p).toEqual([
      { scope: 'OCCURRENCE', cycle_key: `agenda:${e}#0`, series_asset_id: null },
      { scope: 'SERIES', cycle_key: null, series_asset_id: c.maison },
    ]);
    // Le choix existant reste appliqué (même occurrence T4 : replanification).
    const prep = await preparer(c.id, c.ownerUserId);
    expect(prep.decisions.find((d) => d.agendaItemId === e)?.code).toMatch(/USER_DISMISSED/);
    const cols = await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 't6_candidate_examinations'`;
    expect(cols).toHaveLength(1);
  });

  // ── E ─────────────────────────────────────────────────────────────────────

  it('L75E-T6-E — Premium Duo : préférences distinctes ; lecture incomplète ou indisponible : aucun sujet réintroduit, tracé', async () => {
    const c = await compte();
    const b = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${b.id}, 'member', 'active')`;
    const e1 = await echeance(c, 'Révision chaudière', await plus(15));
    const e2 = await echeance(c, 'Ramonage', await plus(18));
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    expect((await (await route()).POST(req('POST', { agendaItemId: e1, action: 'DISMISS' }))).status).toBe(200);
    en(b.id, c.id);
    expect((await (await route()).POST(req('POST', { agendaItemId: e2, action: 'SNOOZE', remindAt: await plus(5) }))).status).toBe(200);
    expect(ids(await passer(c.id, c.ownerUserId)).sort()).toEqual([e2]);
    expect(ids(await passer(c.id, b.id)).sort()).toEqual([e1]);
    // Lecture INCOMPLÈTE (borne atteinte) : aucun des deux sujets n'est présenté, l'état le dit, le rapport le trace.
    const S = await import('@/services/home/mascot/t6-interpellation.service');
    const incomplete = await preparer(c.id, c.ownerUserId, { preferences: (a: number, u: number, s: never) => S.loadUserPreferences(a, u, s, 0) });
    expect(incomplete.shown).toEqual([]);
    expect(incomplete.failedSources).toEqual(['preferences_incomplete']);
    expect(incomplete.evaluation).toBe('UNAVAILABLE');
    await S.writeT6InterpellationReport({ accountId: c.id, userId: c.ownerUserId, mode: 'display', prep: incomplete });
    const [r] = await sql<[{ steps: Array<{ step: string; error: string | null; detail: Record<string, unknown> }> }]>`
      SELECT steps FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND target_id = ${c.ownerUserId} ORDER BY id DESC LIMIT 1`;
    expect(r.steps.find((s) => s.step === 'decision')).toMatchObject({ error: expect.stringMatching(/preferences_incomplete/), detail: expect.objectContaining({ preferencesUnverified: true }) });
    // Lecture INDISPONIBLE : idem.
    const panne = await preparer(c.id, b.id, { preferences: async () => { throw new Error('base indisponible'); } });
    expect(panne.shown).toEqual([]);
    expect(panne.failedSources).toEqual(['preferences']);
  });

  it('Concurrence — pré-générations, affichages et choix simultanés : aucune préférence, évaluation ni examen dupliqué', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision portail', await plus(400));
    await fait(c, await contrat(c, e), { key: 'warranty', label: 'Garantie', value: '2 ans', excerpt: 'Garantie de deux ans.' });
    for (let k = 0; k < 205; k += 1) await sql`INSERT INTO agenda_items (account_id, title, start_date, home_category) VALUES (${c.id}, ${`Relevé ${k}`}, ${await plus(1 + (k % 150))}, 'action')`;
    modele.juger = () => AUCUNE;
    en(c.ownerUserId, c.id);
    const R = await route();
    await Promise.all([
      passer(c.id), passer(c.id), passer(c.id, c.ownerUserId), passer(c.id),
      R.POST(req('POST', { agendaItemId: e, action: 'DISMISS' })), R.POST(req('POST', { agendaItemId: e, action: 'DISMISS' })),
    ]);
    expect(await prefs(c.id)).toHaveLength(1);
    const [{ n, d }] = await sql<[{ n: number; d: number }]>`SELECT count(*)::int AS n, count(DISTINCT agenda_item_id)::int AS d FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    expect(n).toBe(d);
    const [{ x, y }] = await sql<[{ x: number; y: number }]>`SELECT count(*)::int AS x, count(DISTINCT agenda_item_id)::int AS y FROM t6_candidate_examinations WHERE account_id = ${c.id}`;
    expect(x).toBe(y);
  });
});
