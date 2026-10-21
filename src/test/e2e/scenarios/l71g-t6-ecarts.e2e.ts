/**
 * Lot 71 (71G) — ticket « [P1] T6 — Corriger les écarts de décision
 * d'interpellation et fiabiliser les rappels » — recette §5 de bout en bout
 * sur PostgreSQL 16 réel : vrai collecteur, vraie décision, vraie mascotte,
 * vraie file de pré-génération, vraies routes. Modèle SIMULÉ (aucun réseau) :
 * en MODE=EVALUATE, il rend la décision que le scénario lui confie, en
 * fonction de ce qu'il REÇOIT (faits documentaires, description…) — le
 * jugement reste celui de l'IA simulée, jamais une règle du code.
 *
 *  T6-01  contrat modifié (nouvelle clause de préavis) : réévaluation malgré
 *         titre et date inchangés ; description modifiée sans incidence
 *         métier / réextraction identique : aucun appel IA ;
 *  T6-02  échéance dépassée de 90 jours : éligible si une action reste
 *         établie, absente sinon ;
 *  T6-03  échéance à 240 jours : proposée seulement si un préavis documenté
 *         exige d'agir maintenant ; plus de 200 échéances : aucun candidat
 *         pertinent définitivement ignoré (sélection priorisée, reprise) ;
 *  T6-04  clause réellement extraite transmise à EVALUATE (provenance,
 *         statut) — jamais une obligation tirée du seul intitulé ;
 *  T6-05  report arrivé à sa date : réévalué SANS visite (planification
 *         durable), affiché seulement si toujours pertinent ;
 *  T6-07  série refusée : nouvelle occurrence toujours refusée, même après
 *         une régénération complète ; refus d'une occurrence : pas hérité
 *         par le nouveau cycle ; replanification : préférence conservée ;
 *         Duo : préférences indépendantes ;
 *  T6-08  date civile invalide refusée par l'API (aucune écriture) ;
 *  Lot 68 rappel informatif : affiché sans action inventée ;
 *  Concurrence : aucune préférence, évaluation ou demande dupliquée.
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
  subjectId: string; title: string; description: string | null; daysUntilDue: number | null; overdue: boolean; recurring: boolean;
  documents: string[]; facts?: Fait[]; evidence: Array<{ ref: string; kind: string }>;
}

const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Eval => null,
  candidats: [] as Candidat[][],
}));

function provider() {
  return {
    name: 'simule-l71g',
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
const AGIR = (o: { priority?: string; action?: string; reasonCode?: string } = {}) => ({
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: o.reasonCode ?? 'ACTION_REQUIRED_SOON',
  reason: 'Une démarche est nécessaire à court terme.', expectedAction: o.action ?? 'Prendre rendez-vous avec le prestataire', priorityHint: o.priority ?? 'MEDIUM',
});
/** Préavis : action fondée sur la clause extraite (référence `factN`). */
const PREAVIS = (actionDeadline: string, fait: string) => ({
  decision: 'SHOW_NOW', category: 'TO_ANTICIPATE', reasonCode: 'NOTICE_PERIOD_RUNNING',
  reason: 'La clause de préavis extraite du contrat impose d’envoyer la résiliation avant la date limite.',
  expectedAction: 'Envoyer la lettre de résiliation', actionDeadline, priorityHint: 'HIGH', preuve: fait,
});

scenario('L71G-T6', 'Lot 71G — écarts de décision d’interpellation T6 et rappels', ({ sql, make }) => {
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
  /** Document lié à l'échéance, avec son extraction T1 (faits). */
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
  /** Sujets ÉCHÉANCE de la bulle (décidés par T6) — l'onboarding d'un compte sans document n'en est pas un. */
  const sujets = (p: import('@/services/home/mascot/types').MascotPresentation) => p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR' && x.reminder != null);
  const ids = (p: import('@/services/home/mascot/types').MascotPresentation) => sujets(p).map((x) => x.reminder!.agendaItemId);
  const evalues = () => modele.candidats.flat();
  const req = (method: string, body?: unknown, query = '') => new NextRequest(`http://localhost/api/home/mascot/reminders${query}`, {
    method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const route = () => import('@/app/api/home/mascot/reminders/route');
  const en = (userId: number, accountId: number) => { etat.session = { userId, currentAccountId: accountId }; };
  const prefs = async (accountId: number) => sql<Array<{ user_id: number; subject_key: string; decision: string }>>`
    SELECT user_id, subject_key, decision FROM t6_reminder_preferences WHERE account_id = ${accountId} ORDER BY id`;
  /** Accueil vu par l'utilisateur (route réelle, affichage). */
  const accueil = async (userId: number, accountId: number) => {
    en(userId, accountId);
    const { GET } = await import('@/app/api/home/mascot/route');
    return (await (await GET(new NextRequest('http://localhost/api/home/mascot'))).json()) as import('@/services/home/mascot/types').MascotPresentation;
  };
  /** Rend les demandes de pré-génération immédiatement traitables (attente anti-rafale écoulée). */
  const murir = () => sql`UPDATE home_mascot_pregen_requests SET requested_at = requested_at - interval '1 minute' WHERE processed_at IS NULL OR requested_at > processed_at`;

  it('T6-01 — contrat modifié, nouvelle clause de préavis : réévaluation malgré titre et date inchangés', async () => {
    const c = await compte();
    const e = await echeance(c, 'Fin du contrat d’entretien', await plus(40));
    const doc = await contrat(c, e);
    const limite = await plus(10);
    modele.juger = (x) => ((x.facts ?? []).some((f) => /préavis/i.test(f.excerpt ?? '')) ? PREAVIS(limite, 'fact1') : AUCUNE);
    await passer(c.id);
    expect(ids(await passer(c.id))).toEqual([]);
    expect(evalues().map((x) => x.title)).toEqual(['Fin du contrat d’entretien']);
    // Réanalyse T1 : une clause de préavis est extraite ; titre et date inchangés.
    modele.candidats.length = 0;
    await fait(c, doc, { key: 'terminationNotice', label: 'Préavis de résiliation', value: '1 mois', excerpt: 'Résiliation par lettre recommandée avec un préavis d’un mois avant la date d’échéance.' });
    const p = await passer(c.id);
    expect(evalues()).toHaveLength(1);
    // T6-04 : la clause, sa provenance et son statut sont transmis (pas seulement le titre du document).
    expect(evalues()[0].facts).toEqual([expect.objectContaining({ ref: 'C1.fact1', document: 'C1.doc1', provenance: 'T1_EXTRACTION', status: 'PROVEN', excerpt: expect.stringMatching(/préavis d’un mois/) })]);
    expect(evalues()[0].evidence).toEqual(expect.arrayContaining([{ ref: 'C1.fact1', kind: 'DOCUMENT_FACT' }]));
    expect(ids(p)).toEqual([e]);
    // Préférences intactes, évaluation unique, référence et version des preuves conservées.
    const [a] = await sql<[{ n: number; snap: unknown }]>`SELECT count(*) OVER ()::int AS n, evidence_snapshot AS snap FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    expect(a.n).toBe(1);
    expect(a.snap).toMatchObject({ refs: expect.arrayContaining([expect.objectContaining({ ref: 'C1.fact1', fileId: doc.fileId })]) });
  });

  it('T6-01 — description modifiée sans incidence métier, réextraction identique : aucun appel IA inutile', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision chaudière', await plus(25), { description: 'Entretien annuel obligatoire.' });
    const doc = await contrat(c, e);
    await fait(c, doc, { key: 'maintenanceFrequency', label: 'Périodicité', value: 'annuelle', excerpt: 'Entretien annuel.' });
    modele.juger = () => AGIR();
    await passer(c.id);
    expect(evalues()).toHaveLength(1);
    modele.candidats.length = 0;
    // Casse, accents, ponctuation, espaces : cosmétique.
    await sql`UPDATE agenda_items SET description = '  entretien ANNUEL obligatoire ', updated_at = now() WHERE id = ${e}`;
    // Réextraction T1 qui produit les mêmes faits (nouvelle extraction, mêmes valeurs ; extrait reformulé).
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${doc.fileId}`;
    await fait(c, doc, { key: 'maintenanceFrequency', label: 'Périodicité', value: 'annuelle', excerpt: 'L’entretien est annuel.' });
    expect(ids(await passer(c.id))).toEqual([e]);
    expect(evalues()).toEqual([]);
  });

  it('T6-02 — échéance dépassée de 90 jours : éligible si une action reste établie, absente sinon', async () => {
    const c = await compte();
    const ouverte = await echeance(c, 'Mise en conformité électrique', await plus(-90));
    const close = await echeance(c, 'Ramonage cheminée', await plus(-92));
    const sansSignal = await echeance(c, 'Contrôle portail', await plus(-95));
    // Évaluations antérieures (quand l'échéance avait 50 jours de retard) : une démarche restait attendue.
    const { evaluerEcheance } = await import('../t6-assessment');
    for (const id of [ouverte, close]) {
      await evaluerEcheance(sql, id, { interpellation: 'ACT_NOW' });
      await sql`UPDATE t6_interpellation_assessments SET assessed_on = assessed_on - 40, reason_code = 'OVERDUE_ACTION_PENDING' WHERE agenda_item_id = ${id}`;
    }
    modele.juger = (x) => (x.title.startsWith('Mise en conformité')
      ? AGIR({ reasonCode: 'OVERDUE_ACTION_PENDING', action: 'Faire intervenir un électricien' })
      : { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'ALREADY_HANDLED', reason: 'Le ramonage a été réalisé selon la facture jointe.', priorityHint: 'LOW', preuve: 'title' });
    const p = await passer(c.id);
    // Réévaluées (jamais une date dépassée prise pour une action non faite), sélection bornée.
    expect(evalues().map((x) => x.title).sort()).toEqual(['Mise en conformité électrique', 'Ramonage cheminée']);
    expect(ids(p)).toEqual([ouverte]);
    expect(ids(p)).not.toContain(close);
    expect(ids(p)).not.toContain(sansSignal);
    // Échéance historique sans action restante : plus jamais proposée.
    modele.candidats.length = 0;
    expect(ids(await passer(c.id))).toEqual([ouverte]);
    expect(evalues()).toEqual([]);
  });

  it('T6-03 / T6-04 — échéance à 240 jours : proposée si un préavis documenté exige d’agir maintenant ; sinon rien', async () => {
    const c = await compte();
    const preavis = await echeance(c, 'Échéance contrat d’assurance', await plus(240));
    const doc = await contrat(c, preavis, 'Conditions particulières assurance');
    await fait(c, doc, { key: 'terminationNotice', label: 'Préavis de résiliation', value: '8 mois', excerpt: 'Toute résiliation doit être notifiée au moins huit mois avant l’échéance annuelle.' });
    const loinSansEnjeu = await echeance(c, 'Échéance abonnement box', await plus(240));
    const loinDoc = await echeance(c, 'Échéance contrat alarme', await plus(245));
    await contrat(c, loinDoc, 'Contrat alarme');
    const limite = await plus(5);
    modele.juger = (x) => ((x.facts ?? []).some((f) => /huit mois/.test(f.excerpt ?? '')) ? PREAVIS(limite, 'fact1')
      // Titre de document seul : l'IA simulée conclut « trop tôt ».
      : { decision: 'DEFER', category: 'TO_ANTICIPATE', reasonCode: 'TOO_EARLY', reason: 'Rien n’impose d’agir maintenant pour cette échéance lointaine.', priorityHint: 'LOW', preuve: 'dueDate' });
    await passer(c.id);
    const p = await passer(c.id);
    // Lointaine avec preuve documentaire : évaluée ; sans aucune preuve : jamais transmise.
    expect(evalues().map((x) => x.title).sort()).toEqual(['Échéance contrat alarme', 'Échéance contrat d’assurance']);
    expect(ids(p)).toEqual([preavis]);
    expect(ids(p)).not.toContain(loinSansEnjeu);
    expect(ids(p)).not.toContain(loinDoc);
    const { prepareT6Interpellation } = await import('@/services/home/mascot/t6-interpellation.service');
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const prep = await prepareT6Interpellation({ accountId: c.id, userId: null, raw: await collectMascotData(c.id) }, { aiCapable: async () => true, thresholdDays: async () => 60 });
    expect(prep.decisions.find((d) => d.agendaItemId === preavis)).toMatchObject({ decision: 'SHOW_NOW', code: 'THRESHOLD_EXCEPTION', actionDate: limite, dueDate: await plus(240) });
  });

  it('T6-03 — plus de 200 échéances candidates : aucun candidat pertinent définitivement ignoré (priorité, reprise)', async () => {
    const c = await compte();
    // 210 échéances dans l'horizon d'évaluation (au-delà de la lecture principale de 200 lignes).
    await sql`INSERT INTO agenda_items (account_id, title, start_date, home_category)
              SELECT ${c.id}, 'Relevé compteur ' || g, ${await jour()}::date + 1 + (g * 170 / 210), 'action' FROM generate_series(1, 210) g`;
    const loin = await echeance(c, 'Échéance bail commercial', await plus(400));
    const doc = await contrat(c, loin, 'Bail commercial');
    await fait(c, doc, { key: 'terminationNotice', label: 'Congé', value: '6 mois', excerpt: 'Le congé doit être délivré six mois avant la fin du bail.' });
    const limite = await plus(30);
    modele.juger = (x) => (x.title === 'Échéance bail commercial' ? PREAVIS(limite, 'fact1') : AUCUNE);
    const Q = await import('@/services/home/mascot/pregen-queue');
    await Q.requestMascotPregeneration(c.id, 'test');
    for (let k = 0; k < 40; k += 1) {
      await murir();
      const r = await Q.runMascotPregeneration();
      if (r.claimed === 0) break;
    }
    // Chaque passage évalue au plus 8 candidats ; la reprise durable va jusqu'au bout.
    expect(Math.max(...modele.candidats.map((x) => x.length))).toBeLessThanOrEqual(8);
    expect(evalues().some((x) => x.title === 'Échéance bail commercial')).toBe(true);
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(DISTINCT agenda_item_id)::int AS n FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    expect(n).toBeGreaterThan(200);
    expect(ids(await passer(c.id))).toContain(loin);
  }, 240_000);

  it('T6-05 — report arrivé à sa date : réévalué sans visite, affiché seulement si toujours pertinent', async () => {
    const c = await compte();
    const pertinent = await echeance(c, 'Révision chaudière', await plus(20));
    const resolu = await echeance(c, 'Taille de la haie', await plus(22));
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    for (const id of [pertinent, resolu]) {
      expect((await (await route()).POST(req('POST', { agendaItemId: id, action: 'SNOOZE', remindAt: await plus(5) }))).status).toBe(200);
    }
    expect(ids(await accueil(c.ownerUserId, c.id))).toEqual([]);
    // Le 12 novembre est arrivé (date de rappel = aujourd'hui) ; évaluation antérieure.
    await sql`UPDATE t6_reminder_preferences SET remind_at = ${await jour()} WHERE account_id = ${c.id}`;
    await sql`UPDATE t6_interpellation_assessments SET assessed_on = assessed_on - 1 WHERE account_id = ${c.id}`;
    await sql`DELETE FROM home_mascot_pregen_requests`;
    modele.candidats.length = 0;
    modele.juger = (x) => (x.title === 'Taille de la haie' ? { ...AUCUNE, reasonCode: 'ALREADY_HANDLED', reason: 'La haie a déjà été taillée, rien à faire.' } : AGIR());
    // Planification durable (tâche planifiée), SANS visite de l'accueil.
    const Q = await import('@/services/home/mascot/pregen-queue');
    const plan = await Q.enqueueT6DueReevaluations(await jour());
    expect(plan.snoozeDue).toBe(1);
    // Idempotent : une ligne par compte, aucun doublon.
    await Q.enqueueT6DueReevaluations(await jour());
    expect((await sql`SELECT 1 FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`).length).toBe(1);
    await murir();
    await Q.runMascotPregeneration();
    expect(evalues().map((x) => x.title).sort()).toEqual(['Révision chaudière', 'Taille de la haie']);
    // Déjà réévalué : la planification suivante ne redemande rien.
    expect((await Q.enqueueT6DueReevaluations(await jour())).snoozeDue).toBe(0);
    // Première visite APRÈS la date : l'évaluation est déjà là, aucune attente.
    modele.candidats.length = 0;
    const p = await accueil(c.ownerUserId, c.id);
    expect(ids(p)).toEqual([pertinent]);
    expect(evalues()).toEqual([]);
    expect(await prefs(c.id)).toHaveLength(2); // préférences conservées
  });

  it('T6-07 — série refusée : nouvelle occurrence (même après régénération complète) toujours refusée', async () => {
    const c = await compte();
    const o1 = await echeance(c, 'Entretien pompe à chaleur', await plus(12), { serie: 'serie-pac-71' });
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    expect((await (await route()).POST(req('POST', { agendaItemId: o1, action: 'DISMISS', scope: 'SERIES' }))).status).toBe(200);
    // T4 régénère la série : plus aucune occurrence pendant un temps, nettoyage quotidien entre-temps.
    await sql`DELETE FROM agenda_items WHERE id = ${o1}`;
    const { cleanupT6Reminders } = await import('@/services/home/mascot/t6-reminders.service');
    await cleanupT6Reminders(await jour());
    expect(await prefs(c.id)).toEqual([expect.objectContaining({ subject_key: 'series:serie-pac-71', decision: 'DISMISSED' })]);
    const o2 = await echeance(c, 'Entretien pompe à chaleur', await plus(30), { serie: 'serie-pac-71' });
    await passer(c.id);
    expect(ids(await passer(c.id, c.ownerUserId))).not.toContain(o2);
    // Lot 75E (D) : plus de retrait après une longue absence d'occurrence (365 jours, lot 71G) —
    // seulement quand l'invalidité est établie (le bien d'où le refus a été posé n'existe plus).
    await sql`DELETE FROM agenda_items WHERE id = ${o2}`;
    await sql`UPDATE t6_reminder_preferences SET orphaned_since = ${await plus(-500)} WHERE account_id = ${c.id}`;
    await cleanupT6Reminders(await jour());
    expect(await prefs(c.id)).toEqual([expect.objectContaining({ subject_key: 'series:serie-pac-71', decision: 'DISMISSED' })]);
    await sql`DELETE FROM assets WHERE id = ${c.maison}`;
    await cleanupT6Reminders(await jour());
    expect(await prefs(c.id)).toEqual([]);
  });

  it('T6-07 — refus d’une seule occurrence : pas hérité par le nouveau cycle ; replanification : conservé ; Duo indépendant', async () => {
    const c = await compte();
    const b = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${b.id}, 'member', 'active')`;
    const e = await echeance(c, 'Échéance contrat de maintenance', await plus(20));
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    expect((await (await route()).POST(req('POST', { agendaItemId: e, action: 'DISMISS', scope: 'OCCURRENCE' }))).status).toBe(200);
    expect(ids(await passer(c.id, c.ownerUserId))).toEqual([]);
    expect(ids(await passer(c.id, b.id))).toEqual([e]); // Duo : l'autre membre garde ses rappels
    // Replanification du même événement (dix jours plus tard) : le refus tient.
    await sql`UPDATE agenda_items SET start_date = start_date + 10, updated_at = now() WHERE id = ${e}`;
    await passer(c.id);
    expect(ids(await passer(c.id, c.ownerUserId))).toEqual([]);
    // Lot 75E (D) : nouveau cycle de la MÊME ligne = occurrence réalisée puis rouverte pour l'échéance
    // suivante (identité persistante, cohérente avec T4) — plus un simple écart de dates (183 jours).
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    await updateManualStatus(e, 'realise', c.id);
    await updateManualStatus(e, null, c.id);
    await sql`UPDATE agenda_items SET start_date = start_date + 365, updated_at = now(),
                description = 'Renouvellement : relancer le prestataire un mois avant.' WHERE id = ${e}`;
    // L'IA juge le nouveau cycle (réévaluation après changement de date et de contenu).
    modele.juger = () => AGIR();
    await passer(c.id);
    const etatA = await (await (await route()).GET(req('GET', undefined, `?agendaItemId=${e}`))).json();
    // Le refus du cycle précédent n'est plus appliqué ni présenté comme actif.
    expect(etatA).toMatchObject({ occurrence: null });
    const prep = await (await import('@/services/home/mascot/t6-interpellation.service')).prepareT6Interpellation(
      { accountId: c.id, userId: c.ownerUserId, raw: await (await import('@/services/home/mascot/collector')).collectMascotData(c.id) },
      { aiCapable: async () => true, thresholdDays: async () => 60 });
    expect(prep.decisions.find((d) => d.agendaItemId === e)?.code).not.toMatch(/USER_DISMISSED/);
  });

  it('T6-08 — date civile invalide ou hors bornes : refusée par l’API, aucune écriture, aucune confirmation', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision portail', await plus(14));
    en(c.ownerUserId, c.id);
    const an = Number((await jour()).slice(0, 4)) + 1;
    for (const remindAt of [`${an}-02-30`, `${an}-13-01`, await jour(), await plus(731)]) {
      const r = await (await route()).POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt }));
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'INVALID_DATE' });
    }
    expect(await prefs(c.id)).toEqual([]);
    expect((await (await route()).POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt: await plus(730) }))).status).toBe(200);
  });

  it('Lot 68 — rappel informatif sans action : affiché comme information, aucune action inventée, non compté comme action', async () => {
    const c = await compte();
    const e = await echeance(c, 'Visite expert bois', await plus(6));
    await make.assetFile(c as never, { assetId: c.maison }); // compte documenté : aucun sujet d'accueil (onboarding)
    modele.juger = () => ({ decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER', reason: 'La visite approche : la rappeler est utile.', priorityHint: 'LOW', expectedAction: null, actionDeadline: null });
    await passer(c.id);
    const p = await passer(c.id, c.ownerUserId);
    expect(ids(p)).toEqual([e]);
    // Information, aucune action inventée : état « information », texte sans démarche.
    expect(p.state).toMatchObject({ kind: 'INFORMATION', actions: 0, information: 1 });
    expect(sujets(p)[0].text).not.toMatch(/Prendre|À prévoir|prévoir|préparer/i);
    expect(sujets(p)[0].tile?.attention ?? false).toBe(false);
    const repo = await import('@/services/ai/execution-report/repository');
    await vi.waitFor(async () => {
      const [r] = await sql<[{ counters: Record<string, number> }?]>`SELECT counters FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND target_id = ${c.ownerUserId} ORDER BY id DESC LIMIT 1`;
      expect(r?.counters).toMatchObject({ shownInformativeReminders: 1, shownActions: 0 });
    }, { timeout: 10_000 });
    void repo;
  });

  it('Concurrence — appels, pré-générations et planifications simultanés : aucune préférence, évaluation ni demande dupliquée', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision ascenseur', await plus(18));
    await contrat(c, e);
    modele.juger = () => AGIR();
    en(c.ownerUserId, c.id);
    const R = await route();
    const Q = await import('@/services/home/mascot/pregen-queue');
    await Promise.all([
      passer(c.id), passer(c.id), passer(c.id, c.ownerUserId),
      R.POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt: await plus(3) })),
      R.POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt: await plus(4) })),
      R.POST(req('POST', { agendaItemId: e, action: 'DISMISS' })),
      Q.enqueueT6DueReevaluations(await jour()), Q.enqueueT6DueReevaluations(await jour()),
    ]);
    expect(await prefs(c.id)).toHaveLength(1);
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    expect(n).toBe(1);
    expect((await sql`SELECT 1 FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`).length).toBeLessThanOrEqual(1);
  });

  it('Migration 0507 rejouable, colonnes présentes', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0507_l71g_t6_ecarts.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    const cols = await sql<Array<{ c: string }>>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns
      WHERE (table_name, column_name) IN (('t6_reminder_preferences', 'occurrence_date'), ('t6_reminder_preferences', 'orphaned_since'),
                                          ('t6_interpellation_assessments', 'evidence_snapshot'), ('t6_interpellation_assessments', 'reevaluation_reason'))`;
    expect(cols).toHaveLength(4);
  });
});
