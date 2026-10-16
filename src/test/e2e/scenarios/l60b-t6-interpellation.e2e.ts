/**
 * Lot 60 — ticket « [P2] T6 — Améliorer la décision d'interpellation et
 * implémenter la gestion intelligente des rappels » — de bout en bout sur
 * PostgreSQL 16 réel : vrai collecteur, vraie décision, vraie mascotte
 * (`getMascotPresentation`), vraie passerelle IA, vraies routes. Modèle
 * SIMULÉ (aucun réseau) : en MODE=FORMULATE, T6 recopie les textes de
 * secours ; en MODE=EVALUATE (lot 61, contrat `t6-evaluation-v1`), il rend
 * pour chaque candidat la décision que le scénario lui confie — le JUGEMENT
 * reste celui de l'IA simulée, jamais une règle du code.
 *
 *  T6-INT-01/03/14  assurances à 78 jours et échéance à 20 jours sans démarche :
 *                   aucune interpellation, ni dans le texte ni dans les cartes ;
 *  T6-INT-02/05     au-delà du seuil avec démarche motivée ; échéance dépassée
 *                   qui demande une démarche (et une autre qui n'en demande plus) ;
 *  T6-INT-07/08/10  report : masqué jusqu'à la date, réévalué à la date (devenu
 *                   sans objet → pas de rappel), survit aux nouvelles exécutions T6,
 *                   aux sessions et aux mises à jour de l'échéance ;
 *  T6-INT-09/11     refus durable ; portée occurrence / série (occurrences futures) ;
 *  T6-INT-12        Duo : préférences individuelles ;
 *  T6-INT-13        isolation des comptes (lecture, écriture, décision) ;
 *  T6-INT-17        reporting T6 : affichés ET écartés, motif, seuil, rappel ;
 *                   pas de rapport recopié à chaque affichage ;
 *  T6-INT-18        aucun doublon (traitements simultanés ou répétés) ;
 *  T6-INT-19        version BO antérieure du prompt (lot 61 : sans EVALUATE) : décision prudente ;
 *  T6-INT-21        agenda, documents et traitements T1/T3 intacts ; nettoyage ;
 *                   migration 0432 rejouable.
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
interface Candidat { subjectId: string; title: string; description: string | null; daysUntilDue: number | null; overdue: boolean; recurring: boolean; evidence: Array<{ ref: string }> }

/** IA simulée : le scénario dit ce qu'elle juge, candidat par candidat. */
const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Eval => null,
  candidats: [] as Candidat[][],
}));

function provider() {
  return {
    name: 'simule-l60b',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        // Lot 61 : décision par candidat (contrat t6-evaluation-v1), même ordre.
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        modele.candidats.push(ctx.candidates);
        const decisions = ctx.candidates.map((c) => {
          const e = modele.juger(c);
          if (!e) return null;
          const { preuve, ...reste } = e as { preuve?: string };
          const refs = c.evidence.map((x) => x.ref);
          return {
            subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, priorityHint: null, uncertainties: [],
            evidenceRefs: [refs.find((r) => r.endsWith(`.${preuve ?? 'dueDate'}`)) ?? refs[0]],
            ...reste,
          };
        });
        // Un candidat sans jugement : sortie incomplète (rejetée en entier par le serveur).
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions: decisions.filter(Boolean) }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return {
        rawText: JSON.stringify({
          schemaVersion: 't6-output-v2',
          messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
          suggestions: [],
        }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

/** Lot 61 : décisions du contrat `t6-evaluation-v1`. */
const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', priorityHint: 'LOW', preuve: 'title' };
const AGIR = (o: { priority?: string; action?: string; exceptionReason?: string; actionDate?: string } = {}) => ({
  decision: 'SHOW_NOW', category: 'ACTION_NOW',
  reasonCode: o.exceptionReason ? 'NOTICE_PERIOD_RUNNING' : 'ACTION_REQUIRED_SOON',
  reason: o.exceptionReason ?? 'Une démarche est nécessaire à court terme.',
  expectedAction: o.action ?? 'Prendre rendez-vous', priorityHint: o.priority ?? 'MEDIUM',
  actionDeadline: o.actionDate ?? null, preuve: o.exceptionReason ? 'description' : 'dueDate',
});

scenario('L60B-T6', 'Lot 60 — décision d’interpellation T6 et rappels de l’accueil', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.juger = () => null;
    modele.candidats.length = 0;
    (await import('@/services/home/mascot/t6-runner')).resetT6Breaker();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
  });
  afterEach(async () => { (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations(); });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');

  async function compte() {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    const f = await make.assetFile(a, { assetId: maison.id });
    await sql`UPDATE asset_files SET retained_title = 'Contrat habitation', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return { ...a, maison: maison.id };
  }
  async function echeance(c: { id: number; ownerUserId: number; maison: number }, titre: string, date: string, o: { description?: string; serie?: string } = {}) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action', description = ${o.description ?? null}, series_key = ${o.serie ?? null} WHERE id = ${e.id}`;
    return e.id;
  }
  /** Passage complet (pré-génération : la génération T6 et ses évaluations sont attendues). */
  const passer = async (accountId: number, userId: number | null = null) => (await svc()).getMascotPresentation(accountId, 'pregen', userId);
  const sujets = (p: import('@/services/home/mascot/types').MascotPresentation) => p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR');
  const ids = (p: import('@/services/home/mascot/types').MascotPresentation) => sujets(p).map((x) => x.reminder?.agendaItemId ?? null);
  const texte = async (p: import('@/services/home/mascot/types').MascotPresentation) => (await import('@/services/home/mascot/bubble')).composeSpeech({ presentation: p, empty: false }).text;
  const req = (method: string, body?: unknown, query = '') => new NextRequest(`http://localhost/api/home/mascot/reminders${query}`, {
    method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const route = () => import('@/app/api/home/mascot/reminders/route');
  const en = (userId: number, accountId: number) => { etat.session = { userId, currentAccountId: accountId }; };
  const prefs = async (accountId: number) => sql<Array<{ user_id: number; subject_key: string; decision: string; scope: string; remind_at: string | null }>>`
    SELECT user_id, subject_key, decision, scope, to_char(remind_at, 'YYYY-MM-DD') AS remind_at FROM t6_reminder_preferences WHERE account_id = ${accountId} ORDER BY id`;

  it('T6-INT-01 / T6-INT-03 / T6-INT-14 — assurances à 78 jours et échéance à 20 jours sans démarche : rien dans le texte ni dans les cartes', async () => {
    const c = await compte();
    const a1 = await echeance(c, 'Échéance assurance habitation', await plus(78));
    const a2 = await echeance(c, 'Échéance assurance auto', await plus(78));
    const v = await echeance(c, 'Vérification extincteur', await plus(20));
    modele.juger = () => AUCUNE;
    // 1er passage : aucune évaluation encore → rien n'est affiché d'office ; T6 évalue.
    const p1 = await passer(c.id);
    expect(sujets(p1)).toEqual([]);
    expect(modele.candidats.flat().map((x) => x.title).sort()).toEqual(['Vérification extincteur', 'Échéance assurance auto', 'Échéance assurance habitation'].sort());
    const evals = await sql<Array<{ agenda_item_id: number; interpellation: string; decision: string; contract_version: string }>>`
      SELECT agenda_item_id, interpellation, decision, contract_version FROM t6_interpellation_assessments WHERE account_id = ${c.id} ORDER BY agenda_item_id`;
    expect(evals.map((e) => [e.agenda_item_id, e.interpellation, e.decision, e.contract_version])).toEqual([
      [a1, 'NONE', 'SUPPRESS', 't6-evaluation-v1'], [a2, 'NONE', 'SUPPRESS', 't6-evaluation-v1'], [v, 'NONE', 'SUPPRESS', 't6-evaluation-v1']]);
    // 2e passage : décisions SUPPRESS — ni carte ni mention ; aucun nouvel appel d'évaluation.
    modele.candidats.length = 0;
    const p2 = await passer(c.id);
    expect(sujets(p2)).toEqual([]);
    const t = await texte(p2);
    expect(t).not.toMatch(/assurance|extincteur|mérite votre attention|à vérifier/i);
    expect(modele.candidats.flat()).toEqual([]);
    // L'agenda garde les trois échéances, intactes.
    expect((await sql`SELECT id FROM agenda_items WHERE account_id = ${c.id} AND manual_status IS NULL`).length).toBe(3);
  });

  it('T6-INT-02 / T6-INT-05 — démarche motivée au-delà du seuil, échéance dépassée qui demande (ou non) une action ; texte et cartes cohérents', async () => {
    const c = await compte();
    const preavis = await echeance(c, 'Fin du contrat de gaz', await plus(90), { description: 'Résiliation possible avec un préavis de deux mois avant la fin du contrat.' });
    const ramonage = await echeance(c, 'Ramonage cheminée', await plus(-5));
    const fete = await echeance(c, 'Visite de la chaudière', await plus(-8));
    const actionDate = await plus(20);
    modele.juger = (x) => (x.title === 'Fin du contrat de gaz'
      ? AGIR({ priority: 'HIGH', action: 'Envoyer la demande de résiliation', exceptionReason: 'Préavis de deux mois indiqué dans la description.', actionDate })
      : x.title === 'Ramonage cheminée' ? AGIR({ action: 'Faire réaliser le ramonage' }) : AUCUNE);
    await passer(c.id);
    const p = await passer(c.id);
    expect(ids(p)).toEqual([preavis, ramonage]); // HIGH d'abord
    expect(sujets(p).map((x) => x.sourceCode)).toEqual(['DATE-NEXT', 'MASC-EXT-ACTION']);
    expect(sujets(p)[0].text).toContain('À prévoir : envoyer la demande de résiliation.');
    expect(sujets(p)[0].tile).toMatchObject({ attention: true, tone: 'amber' });
    const t = await texte(p);
    expect(t).toMatch(/^Deux sujets méritent votre attention aujourd’hui/);
    // L'échéance dépassée sans action restante n'est ni dite ni comptée (« dépassées à
    // vérifier ») : seule celle qui est présentée (ramonage) reste comptée.
    expect(p.overdueDeadlines).toBe(1);
    expect(ids(p)).not.toContain(fete);
  });

  it('T6-INT-07 / T6-INT-08 / T6-INT-10 — report : masqué jusqu’à la date ; survit aux exécutions, sessions et mises à jour ; réévalué à la date', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision chaudière', await plus(15));
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    const { GET: mascotte } = await import('@/app/api/home/mascot/route');
    const lire = async () => (await (await mascotte(new NextRequest('http://localhost/api/home/mascot'))).json()) as import('@/services/home/mascot/types').MascotPresentation;
    const avant = await lire();
    expect(ids(avant)).toEqual([e]);
    const proposee = sujets(avant)[0].reminder!.suggestedDate;
    expect(proposee).toBe(await plus(8)); // une semaine avant l'échéance
    // « Me le rappeler plus tard » à une AUTRE date que celle proposée.
    const date = await plus(10);
    const r = await (await route()).POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt: date }));
    expect(r.status).toBe(200);
    expect(await prefs(c.id)).toEqual([expect.objectContaining({ user_id: c.ownerUserId, subject_key: `agenda:${e}`, decision: 'SNOOZED', remind_at: date })]);
    expect(ids(await lire())).toEqual([]);
    // Nouvelle exécution T6, autre « session », réanalyse qui MET À JOUR l'échéance (même id) : toujours masqué.
    await sql`DELETE FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    await sql`UPDATE agenda_items SET description = 'Contrat d’entretien renouvelé (nouvelle extraction)', updated_at = now() WHERE id = ${e}`;
    await passer(c.id);
    en(c.ownerUserId, c.id);
    expect(ids(await lire())).toEqual([]);
    expect(await prefs(c.id)).toHaveLength(1);
    // La date est atteinte : réévaluation AVANT tout réaffichage — devenu sans objet, rien.
    await sql`UPDATE t6_reminder_preferences SET remind_at = ${await jour()} WHERE account_id = ${c.id}`;
    await sql`UPDATE t6_interpellation_assessments SET assessed_on = assessed_on - 1 WHERE account_id = ${c.id}`;
    const { prepareT6Interpellation } = await import('@/services/home/mascot/t6-interpellation.service');
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const prep = await prepareT6Interpellation({ accountId: c.id, userId: c.ownerUserId, raw: await collectMascotData(c.id) }, { aiCapable: async () => true, thresholdDays: async () => 60 });
    expect(prep.decisions.find((d) => d.agendaItemId === e)).toMatchObject({ decision: 'DEFER', code: 'AWAITING_REEVALUATION_AFTER_SNOOZE' });
    modele.juger = () => AUCUNE; // entre-temps, plus rien à faire
    await passer(c.id, c.ownerUserId);
    const apres = await passer(c.id, c.ownerUserId);
    expect(ids(apres)).toEqual([]);
    // L'échéance réalisée n'est jamais rappelée non plus.
    modele.juger = () => AGIR();
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${e}`;
    expect(ids(await passer(c.id, c.ownerUserId))).toEqual([]);
  });

  it('T6-INT-09 / T6-INT-11 — « Ne plus me rappeler » durable ; occurrence ou série (occurrences futures comprises)', async () => {
    const c = await compte();
    const o1 = await echeance(c, 'Entretien pompe à chaleur', await plus(12), { serie: 'serie-pac' });
    const o2 = await echeance(c, 'Entretien pompe à chaleur', await plus(30), { serie: 'serie-pac' });
    const seule = await echeance(c, 'Contrôle alarme', await plus(25));
    modele.juger = () => AGIR();
    await passer(c.id);
    expect(ids(await passer(c.id, c.ownerUserId))).toEqual([o1, seule]); // priorité égale : par date ; 2 sujets au plus
    en(c.ownerUserId, c.id);
    // Occurrence seulement : l'autre occurrence reste rappelée.
    expect((await (await route()).POST(req('POST', { agendaItemId: o1, action: 'DISMISS', scope: 'OCCURRENCE' }))).status).toBe(200);
    expect(ids(await passer(c.id, c.ownerUserId))).toEqual([seule, o2]);
    // Série : toutes les occurrences, y compris une NOUVELLE occurrence future (T4).
    expect((await (await route()).POST(req('POST', { agendaItemId: o2, action: 'DISMISS', scope: 'SERIES' }))).status).toBe(200);
    const o3 = await echeance(c, 'Entretien pompe à chaleur', await plus(40), { serie: 'serie-pac' });
    // Une évaluation prioritaire ultérieure n'annule jamais le refus.
    modele.juger = () => AGIR({ priority: 'HIGH' });
    await sql`DELETE FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    await passer(c.id);
    const p = await passer(c.id, c.ownerUserId);
    expect(ids(p)).toEqual([seule]);
    expect(ids(p)).not.toContain(o3);
    // Une série sans clé n'accepte pas la portée « série ».
    expect((await (await route()).POST(req('POST', { agendaItemId: seule, action: 'DISMISS', scope: 'SERIES' }))).status).toBe(400);
    // Le choix reste modifiable : « Réactiver » (DELETE) rétablit la série.
    expect((await (await route()).DELETE(req('DELETE', { agendaItemId: o2, scope: 'SERIES' }))).status).toBe(200);
    expect(ids(await passer(c.id, c.ownerUserId))).toContain(o2);
  });

  it('T6-INT-12 — Duo : les préférences de rappel de chaque membre sont distinctes', async () => {
    const c = await compte();
    const b = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${b.id}, 'member', 'active')`;
    const e = await echeance(c, 'Révision vélo', await plus(9));
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    expect((await (await route()).POST(req('POST', { agendaItemId: e, action: 'DISMISS' }))).status).toBe(200);
    expect(ids(await passer(c.id, c.ownerUserId))).toEqual([]);
    expect(ids(await passer(c.id, b.id))).toEqual([e]);
    en(b.id, c.id);
    const etatB = await (await (await route()).GET(req('GET', undefined, `?agendaItemId=${e}`))).json();
    expect(etatB).toMatchObject({ occurrence: null, series: null });
  });

  it('T6-INT-13 — aucun rappel d’un autre compte n’est lisible ni modifiable ; aucune préférence étrangère appliquée', async () => {
    const x = await compte();
    const y = await compte();
    const ey = await echeance(y, 'Échéance du compte Y', await plus(10));
    en(y.ownerUserId, y.id);
    await (await route()).POST(req('POST', { agendaItemId: ey, action: 'DISMISS' }));
    const avant = await prefs(y.id);
    en(x.ownerUserId, x.id);
    const R = await route();
    expect((await R.GET(req('GET', undefined, `?agendaItemId=${ey}`))).status).toBe(404);
    expect((await R.POST(req('POST', { agendaItemId: ey, action: 'SNOOZE', remindAt: await plus(3) }))).status).toBe(404);
    expect((await R.DELETE(req('DELETE', { agendaItemId: ey }))).status).toBe(404);
    expect(await prefs(y.id)).toEqual(avant);
    expect(await prefs(x.id)).toEqual([]);
    // Une ligne forgée (compte X, échéance de Y) n'est jamais appliquée ni lue.
    await sql`INSERT INTO t6_reminder_preferences (account_id, user_id, subject_key, scope, agenda_item_id, decision)
              VALUES (${x.id}, ${x.ownerUserId}, ${`agenda:${ey}`}, 'OCCURRENCE', ${ey}, 'DISMISSED')`;
    const { loadUserPreferences } = await import('@/services/home/mascot/t6-interpellation.service');
    expect(await loadUserPreferences(x.id, x.ownerUserId)).toEqual([]);
    const { cleanupT6Reminders } = await import('@/services/home/mascot/t6-reminders.service');
    await cleanupT6Reminders(await jour());
    expect(await prefs(x.id)).toEqual([]);
    expect(await prefs(y.id)).toEqual(avant);
  });

  it('T6-INT-18 — traitements simultanés ou répétés : aucun rappel ni évaluation dupliqués', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision portail', await plus(14));
    en(c.ownerUserId, c.id);
    const R = await route();
    const reponses = await Promise.all([
      ...Array.from({ length: 4 }, () => R.POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt: '2099-01-01' }))),
      ...Array.from({ length: 4 }, async () => R.POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt: await plus(7) }))),
    ]);
    // 2099 : hors des deux ans autorisés → refus ; les autres convergent sur UNE ligne.
    expect(reponses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 400, 400, 400, 400]);
    expect(await prefs(c.id)).toHaveLength(1);
    modele.juger = () => AGIR();
    await Promise.all([passer(c.id), passer(c.id), passer(c.id)]);
    await passer(c.id);
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM t6_interpellation_assessments WHERE account_id = ${c.id}`;
    expect(n).toBe(1);
  });

  it('T6-INT-17 — reporting T6 : chaque échéance (affichée, différée, écartée), motif, seuil, rappel ; justification relue en direct ; pas de rapport à chaque affichage', async () => {
    const c = await compte();
    const loin = await echeance(c, 'Échéance assurance habitation', await plus(78));
    const proche = await echeance(c, 'Révision chaudière', await plus(15));
    const reportee = await echeance(c, 'Taille de la haie', await plus(18));
    modele.juger = (x) => (x.title.startsWith('Échéance assurance') ? AUCUNE : AGIR());
    await passer(c.id);
    en(c.ownerUserId, c.id);
    await (await route()).POST(req('POST', { agendaItemId: reportee, action: 'SNOOZE', remindAt: await plus(5) }));
    await passer(c.id, c.ownerUserId);
    const repo = await import('@/services/ai/execution-report/repository');
    let rapport: Awaited<ReturnType<typeof repo.getExecutionReport>> = null;
    await vi.waitFor(async () => {
      const [r] = await sql<[{ id: number }?]>`SELECT id FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND target_id = ${c.ownerUserId} ORDER BY id DESC LIMIT 1`;
      expect(r).toBeDefined();
      rapport = await repo.getExecutionReport(Number(r!.id));
    }, { timeout: 10_000 });
    expect(rapport!).toMatchObject({ treatment: 'T6', scope: 'HOME', targetType: 'USER', counters: { candidates: 3, shown: 1, deferred: 1, suppressed: 1, thresholdDays: 60 } });
    const { entries } = await repo.readReportEntries(rapport!, { section: 'INTERPELLATION' });
    const parId = new Map(entries.map((e) => [e.entityId, e]));
    expect(parId.get(loin)).toMatchObject({ recordStatus: 'SUPPRESS', reasonCode: 'AI_NO_INTERPELLATION' });
    expect(parId.get(proche)).toMatchObject({ recordStatus: 'SHOW_NOW', reasonCode: 'AI_ACT_NOW' });
    expect(parId.get(reportee)).toMatchObject({ recordStatus: 'DEFER', reasonCode: 'USER_SNOOZED' });
    expect(parId.get(reportee)!.value).toMatchObject({ userPreference: { decision: 'SNOOZED', scope: 'OCCURRENCE' }, threshold: { days: 60 } });
    expect(parId.get(loin)!.value).toMatchObject({ threshold: { days: 60, applied: true } });
    // Aucune donnée personnelle recopiée dans les lignes ; justification IA relue en direct.
    expect(JSON.stringify(entries)).not.toMatch(/assurance|chaudière|haie|Lilas/i);
    const ai = (await repo.readReportEntries(rapport!, { section: 'INTERPELLATION_AI' })).entries[0];
    expect(await repo.resolveRef(c.id, ai)).toMatchObject({ state: 'TRACED' });
    // Liste BO filtrée sur T6.
    expect((await repo.listExecutionReports({ treatment: 'T6', accountId: c.id })).rows.length).toBeGreaterThanOrEqual(1);
    // Même situation, nouvel affichage : aucun nouveau rapport.
    const [{ n: avant }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6'`;
    await passer(c.id, c.ownerUserId);
    await new Promise((r) => setTimeout(r, 300));
    const [{ n: apres }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6'`;
    expect(apres).toBe(avant);
  });

  it('T6-INT-19 (revu lot 61) — version BO active antérieure (sans EVALUATE) : aucune échéance non évaluée présentée, état dit explicitement', async () => {
    const cfg = await import('@/services/ai/config/config-resolver');
    const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
    const master = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf8')
      .replace(/BRANCHE MODE = EVALUATE[\s\S]*?(?=BRANCHE MODE = FORMULATE)/, '');
    const [v] = await sql<[{ id: number }]>`INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'l60b ancien T6') RETURNING id`;
    const entries = [
      ...(['T1', 'T2'] as const).map((t) => ({ ...emptyTreatmentConfig(t), promptArchitecture: 'master' as const })),
      { ...emptyTreatmentConfig('T6'), promptArchitecture: 'master' as const, masterPrompt: master },
    ];
    cfg.__setConfigForTests({ versionId: Number(v.id), entries }, [{ versionId: Number(v.id), entries }]);
    try {
      expect(await (await import('@/services/home/mascot/t6-runner')).t6InterpellationAvailable()).toBe(false);
      const c = await compte();
      const loin = await echeance(c, 'Échéance assurance habitation', await plus(78));
      const proche = await echeance(c, 'Révision chaudière', await plus(15));
      const p = await passer(c.id);
      // Lot 61 : sans évaluation possible, ni l'échéance lointaine ni la proche ne sont présentées d'office.
      expect(ids(p)).toEqual([]);
      expect(ids(p)).not.toContain(loin);
      expect(ids(p)).not.toContain(proche);
      expect(p.state).toMatchObject({ evaluation: 'UNAVAILABLE' });
      expect(await texte(p)).toBe('Je ne peux pas examiner vos échéances pour le moment : elles restent consultables dans l’agenda.');
      expect(modele.candidats).toEqual([]);
    } finally {
      const repo = await import('@/services/ai/config/config-resolver');
      const [w] = await sql<[{ id: number }]>`INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'l60b retour') RETURNING id`;
      const base = (['T1', 'T2'] as const).map((t) => ({ ...emptyTreatmentConfig(t), promptArchitecture: 'master' as const }));
      repo.__setConfigForTests({ versionId: Number(w.id), entries: base }, [{ versionId: Number(w.id), entries: base }]);
    }
  });

  it('T6-INT-21 — agenda, documents, T1/T3 intacts ; suppression d’une échéance et nettoyage ; migration 0432 rejouable', async () => {
    const c = await compte();
    const e = await echeance(c, 'Révision toiture', await plus(11));
    const ligne = async () => (await sql`SELECT * FROM agenda_items WHERE id = ${e}`)[0];
    const liens = async () => sql`SELECT * FROM agenda_asset_links WHERE agenda_item_id = ${e}`;
    const avant = { item: await ligne(), liens: await liens(), files: await sql`SELECT id, analysis_state, retained_title FROM asset_files WHERE account_id = ${c.id} ORDER BY id` };
    const jobs = async () => (await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE account_id = ${c.id}`)[0].n;
    const jobsAvant = await jobs();
    modele.juger = () => AGIR();
    await passer(c.id);
    en(c.ownerUserId, c.id);
    const R = await route();
    await R.POST(req('POST', { agendaItemId: e, action: 'SNOOZE', remindAt: await plus(4) }));
    await R.POST(req('POST', { agendaItemId: e, action: 'DISMISS' }));
    await R.DELETE(req('DELETE', { agendaItemId: e }));
    expect(await ligne()).toEqual(avant.item);
    expect(await liens()).toEqual(avant.liens);
    expect(await sql`SELECT id, analysis_state, retained_title FROM asset_files WHERE account_id = ${c.id} ORDER BY id`).toEqual(avant.files);
    expect(await jobs()).toBe(jobsAvant); // aucun travail T1/T3/T4 déclenché
    // Échéance supprimée : préférences et évaluations disparaissent avec elle.
    await R.POST(req('POST', { agendaItemId: e, action: 'DISMISS' }));
    await sql`DELETE FROM agenda_items WHERE id = ${e}`;
    expect(await prefs(c.id)).toEqual([]);
    expect((await sql`SELECT 1 FROM t6_interpellation_assessments WHERE agenda_item_id = ${e}`).length).toBe(0);
    // Migration rejouable sans effet (contrainte T6 conservée).
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0432_t6_interpellation.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    const [def] = await sql<[{ d: string }]>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ai_execution_reports_treatment_check'`;
    expect(def.d).toMatch(/'T1'.*'T3'.*'T6'/);
  });
});
