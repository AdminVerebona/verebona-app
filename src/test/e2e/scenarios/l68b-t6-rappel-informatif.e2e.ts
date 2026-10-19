/**
 * Lot 68 — ticket « [P2] Accueil / T6 — Alléger la bulle et distinguer rappel
 * informatif et action » — de bout en bout sur PostgreSQL 16 réel : vrai
 * collecteur, vraie décision, vraie passerelle IA (modèle SIMULÉ, aucun
 * réseau), vraie mascotte (`getMascotPresentation`), vraie route des rappels,
 * vrai reporting, migration 0474.
 *
 *  T6-RAP-E2E-01  parcours complet du rappel informatif (cas de la capture) : EVALUATE → validation →
 *                 conservation (INFORM, révision 2) → décision → bulle (un bloc, une occurrence, aucune
 *                 introduction ni « Action à prévoir ») → FORMULATE (faits sans action) → rapports
 *  T6-RAP-E2E-02  rappel + action : l'action garde sa priorité ; action manquante jamais convertie
 *  T6-RAP-E2E-03  menu « Rappels » : reporté / refusé ne réapparaît pas ; préférences Duo indépendantes
 *  T6-RAP-E2E-04  renouvellement ciblé : évaluation antérieure réévaluée sans quitter l'accueil
 *  T6-RAP-E2E-05  migration 0474 rejouable ; contrainte élargie à INFORM, révision par défaut 1
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

interface Candidat { subjectId: string; title: string; evidence: Array<{ ref: string }> }

/** IA simulée : le scénario dit ce qu'elle décide ; FORMULATE recopie les textes de secours. */
const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Record<string, unknown> | null => null,
  evaluate: [] as string[],
  formulate: [] as string[],
}));

function provider() {
  return {
    name: 'simule-l68b',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        modele.evaluate.push(input.prompt);
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        const decisions = ctx.candidates.map((c) => ({
          subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, priorityHint: null, uncertainties: [],
          evidenceRefs: [c.evidence.find((x) => x.ref.endsWith('.dueDate'))!.ref], ...(modele.juger(c) ?? AUCUNE),
        }));
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      modele.formulate.push(input.prompt);
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return {
        rawText: JSON.stringify({ schemaVersion: 't6-output-v2', messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })), suggestions: [] }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.' };
const RAPPEL = { decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER', reason: 'La visite est prévue dans quelques jours : le rappel est utile, aucune démarche n’est attendue.', priorityHint: 'LOW' };
const AGIR = (o: Record<string, unknown> = {}) => ({
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.',
  expectedAction: 'Prendre rendez-vous avec le ramoneur', priorityHint: 'MEDIUM', ...o,
});
const MECANIQUE = /mérite votre attention|méritent votre attention|À prévoir :|Action à prévoir|préparer/i;

scenario('L68B-T6RAP', 'Lot 68 — rappel informatif T6 et bulle d’accueil allégée', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.juger = () => null;
    modele.evaluate.length = 0;
    modele.formulate.length = 0;
    const r = await import('@/services/home/mascot/t6-runner');
    r.resetT6Breaker();
    r.resetT6EvaluationState();
    (await import('@/services/home/mascot/t6-interpellation.service')).resetContractRevisionProbe();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
  });
  afterEach(async () => { (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations(); });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');
  const B = () => import('@/services/home/mascot/bubble');
  type P = import('@/services/home/mascot/types').MascotPresentation;

  async function compte() {
    const a = await make.account({ plan: 'premium_duo' });
    const maison = await make.asset(a, { category: 'IMMOBILIER', name: 'Maison' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Maison' WHERE id = ${maison.id}`;
    const f = await make.assetFile(a, { assetId: maison.id });
    await sql`UPDATE asset_files SET retained_title = 'Diagnostic termites', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return { ...a, maison: maison.id };
  }
  async function echeance(c: { id: number; maison: number }, titre: string, date: string, o: { serie?: string } = {}) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action', series_key = ${o.serie ?? null} WHERE id = ${e.id}`;
    return e.id;
  }
  const pregen = async (accountId: number, userId: number | null = null) => (await svc()).getMascotPresentation(accountId, 'pregen', userId);
  const sujets = (p: P) => p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR');
  const ids = (p: P) => sujets(p).map((x) => x.reminder?.agendaItemId ?? null);
  /** Tout ce que la bulle affiche (en-tête, blocs, cartes). */
  const affiche = async (p: P) => {
    const b = await B();
    return [
      b.bubbleLead({ presentation: p, empty: false }).text,
      ...b.subjectBlocks(p).flatMap((x) => [x.badge ?? '', x.text, ...x.actions.map((a) => a.label), x.reminder ? 'Rappels' : '']),
      ...b.homeItems(p, false).flatMap((i) => [i.title, i.sub ?? '', i.cta]),
    ].filter(Boolean).join(' | ');
  };
  const n = (t: string, re: RegExp) => (t.match(new RegExp(re.source, 'gi')) ?? []).length;
  const rapport = async (accountId: number, trigger: string) => {
    const repo = await import('@/services/ai/execution-report/repository');
    const [r] = await sql<[{ id: number }?]>`SELECT id FROM ai_execution_reports WHERE account_id = ${accountId} AND treatment = 'T6' AND trigger_code = ${trigger} ORDER BY id DESC LIMIT 1`;
    expect(r).toBeDefined();
    return { repo, rapport: (await repo.getExecutionReport(Number(r!.id)))! };
  };

  it('T6-RAP-E2E-01 — parcours complet du rappel informatif (« Visite expert bois — Maison »)', async () => {
    const c = await compte();
    const date = await plus(4);
    const visite = await echeance(c, 'Visite expert bois', date);
    modele.juger = () => RAPPEL;
    const p = await pregen(c.id);
    // EVALUATE appelé, décision validée et conservée comme rappel (révision 2 : le prompt du dépôt connaît la règle).
    expect(modele.evaluate).toHaveLength(1);
    expect(await sql`SELECT interpellation, action_needed, action, decision, category, reason_code, contract_revision
                     FROM t6_interpellation_assessments WHERE account_id = ${c.id}`).toEqual([{
      interpellation: 'INFORM', action_needed: false, action: null, decision: 'SHOW_NOW', category: 'INFORMATION',
      reason_code: 'INFORMATIVE_REMINDER', contract_revision: 2,
    }]);
    // Bulle : un bloc, sujet / bien / date une seule fois, « Voir » et « Rappels ».
    expect(ids(p)).toEqual([visite]);
    const { formatDateFr } = await import('@/services/home/mascot/signals');
    const t = await affiche(p);
    expect(n(t, new RegExp(formatDateFr(date)))).toBe(1);
    expect(n(t, /expert bois/)).toBe(1);
    expect(n(t, /maison/)).toBe(1);
    expect(t).not.toMatch(MECANIQUE);
    const [bloc] = (await B()).subjectBlocks(p);
    expect(bloc).toMatchObject({ informative: true, badge: null, reminder: { agendaItemId: visite } });
    expect(bloc.actions.map((a) => a.label)).toEqual(['Voir']);
    expect(bloc.actions[0].action.target).toMatchObject({ kind: 'drawer', drawer: 'echeance', id: visite });
    expect(p.state).toMatchObject({ kind: 'INFORMATION', actions: 0, information: 1 });
    expect((await B()).homePose(p, false)).toBe('neutral');
    // FORMULATE : faits sans action attendue, nature « rappel informatif ».
    const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(modele.formulate.at(-1)!)![1]) as { subjects: Array<{ intent: string; facts: Record<string, unknown>; fallbackText: string }> };
    expect(entree.subjects).toHaveLength(1);
    expect(entree.subjects[0]).toMatchObject({ intent: 'inform', facts: { interpellation: 'rappel informatif' } });
    expect(entree.subjects[0].facts).not.toHaveProperty('expectedAction');
    expect(entree.subjects[0].fallbackText).not.toMatch(MECANIQUE);
    // Rapports : rappel informatif compté à part, jamais comme action.
    await vi.waitFor(async () => {
      const { rapport: ev } = await rapport(c.id, 'evaluate:pregen');
      expect(ev.counters).toMatchObject({ showNow: 1, showNowInformation: 1 });
      const { repo, rapport: aff } = await rapport(c.id, 'pregen');
      expect(aff.counters).toMatchObject({ shown: 1, shownInformativeReminders: 1, shownActions: 0 });
      const { entries } = await repo.readReportEntries(aff, { section: 'INTERPELLATION' });
      expect(entries.find((e) => e.entityId === visite)?.value).toMatchObject({ outcome: 'INFORMATIVE_REMINDER', mode: 'INFORM', code: 'AI_INFORM' });
    }, { timeout: 10_000 });
    // Affichage suivant (utilisateur) : décision réutilisée, aucune nouvelle évaluation.
    const d = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(ids(d)).toEqual([visite]);
    expect(modele.evaluate).toHaveLength(1);
  });

  it('T6-RAP-E2E-02 — rappel et action : l’action garde sa priorité ; une action manquante n’est jamais convertie en rappel', async () => {
    const c = await compte();
    const visite = await echeance(c, 'Visite expert bois', await plus(4));
    const ramonage = await echeance(c, 'Ramonage cheminée', await plus(17));
    modele.juger = (x) => (x.title === 'Visite expert bois' ? RAPPEL : AGIR());
    const p = await pregen(c.id);
    expect(ids(p)).toEqual([ramonage, visite]);
    const blocs = (await B()).subjectBlocks(p);
    expect(blocs.map((b) => [b.informative, b.badge])).toEqual([[false, 'Action à prévoir'], [true, null]]);
    expect(blocs[0].text).toContain('Prendre rendez-vous avec le ramoneur.');
    expect(await affiche(p)).not.toMatch(/mérite votre attention|À prévoir :/);
    expect(p.state).toMatchObject({ kind: 'ACTIONS', actions: 1, information: 1 });
    expect((await B()).homePose(p, false)).toBe('reminder-bell');
    // SHOW_NOW + ACTION_NOW sans action : rejeté, rien conservé, rien affiché d'office.
    const c2 = await compte();
    await echeance(c2, 'Ramonage cheminée', await plus(17));
    modele.juger = () => AGIR({ expectedAction: null });
    const q = await pregen(c2.id);
    expect(ids(q)).toEqual([]);
    expect((await sql`SELECT 1 FROM t6_interpellation_assessments WHERE account_id = ${c2.id}`).length).toBe(0);
    await vi.waitFor(async () => {
      const { repo, rapport: ev } = await rapport(c2.id, 'evaluate:pregen');
      const { entries } = await repo.readReportEntries(ev, { section: 'EVALUATE' });
      expect(entries[0]).toMatchObject({ recordStatus: 'REJECTED', reasonCode: 'VALIDATION:show_now_without_action' });
    }, { timeout: 10_000 });
  });

  it('T6-RAP-E2E-03 — « Rappels » : reporté ou refusé, le rappel ne réapparaît pas ; préférences Duo indépendantes', async () => {
    const c = await compte();
    const visite = await echeance(c, 'Visite expert bois', await plus(4));
    const b = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${b.id}, 'member', 'active')`;
    modele.juger = () => RAPPEL;
    await pregen(c.id);
    const route = await import('@/app/api/home/mascot/reminders/route');
    const req = (body: unknown) => new NextRequest('http://localhost/api/home/mascot/reminders', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    // Titulaire : « Me le rappeler plus tard » (date choisie).
    etat.session = { userId: c.ownerUserId, currentAccountId: c.id };
    expect((await route.POST(req({ agendaItemId: visite, action: 'SNOOZE', remindAt: await plus(3) }))).status).toBe(200);
    expect(ids(await pregen(c.id, c.ownerUserId))).toEqual([]);
    // L'autre membre du Duo garde son rappel.
    expect(ids(await pregen(c.id, b.id))).toEqual([visite]);
    // « Ne plus me rappeler » (membre Duo) : durable, sans toucher au report du titulaire.
    etat.session = { userId: b.id, currentAccountId: c.id };
    expect((await route.POST(req({ agendaItemId: visite, action: 'DISMISS', scope: 'OCCURRENCE' }))).status).toBe(200);
    expect(ids(await pregen(c.id, b.id))).toEqual([]);
    expect(await sql`SELECT user_id, decision FROM t6_reminder_preferences WHERE account_id = ${c.id} ORDER BY user_id`)
      .toEqual([{ user_id: Math.min(c.ownerUserId, b.id), decision: c.ownerUserId < b.id ? 'SNOOZED' : 'DISMISSED' }, { user_id: Math.max(c.ownerUserId, b.id), decision: c.ownerUserId < b.id ? 'DISMISSED' : 'SNOOZED' }]);
    // Devenu sans objet (réalisée) : plus jamais rappelée, pour personne.
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${visite}`;
    await sql`DELETE FROM t6_reminder_preferences WHERE account_id = ${c.id}`;
    expect(ids(await pregen(c.id, c.ownerUserId))).toEqual([]);
    expect(ids(await pregen(c.id, b.id))).toEqual([]);
  });

  it('T6-RAP-E2E-04 — renouvellement ciblé : une évaluation antérieure (révision 1) est réévaluée sans quitter l’accueil', async () => {
    const c = await compte();
    const date = await plus(4);
    const visite = await echeance(c, 'Visite expert bois', date);
    const { agendaFingerprint } = await import('@/services/home/mascot/t6-interpellation.service');
    const fp = agendaFingerprint({ title: 'Visite expert bois', date, forecast: false, requiresQualification: false });
    // Décision du lot 67 : action artificielle « préparer la visite… », révision 1.
    await sql`INSERT INTO t6_interpellation_assessments (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation,
                action_needed, priority, reason, action, contract_version, decision, category, reason_code, evidence_refs)
              VALUES (${c.id}, ${visite}, ${`agenda:${visite}`}, ${fp}, CURRENT_DATE, 'ANTICIPATE', TRUE, 'MEDIUM', 'Préparer la visite.',
                'Préparer la visite expert bois pour la maison', 't6-evaluation-v1', 'SHOW_NOW', 'TO_ANTICIPATE', 'PREPARATION_NEEDED_NOW', '["C1.dueDate"]'::jsonb)`;
    expect((await sql`SELECT contract_revision FROM t6_interpellation_assessments WHERE account_id = ${c.id}`)[0]).toEqual({ contract_revision: 1 });
    modele.juger = () => RAPPEL;
    // Affichage : le sujet reste présenté (sans la préparation artificielle) pendant la réévaluation en arrière-plan.
    const d = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(ids(d)).toEqual([visite]);
    expect(await affiche(d)).not.toMatch(/préparer|À prévoir :/i);
    await vi.waitFor(async () => {
      expect(await sql`SELECT interpellation, contract_revision FROM t6_interpellation_assessments WHERE account_id = ${c.id}`)
        .toEqual([{ interpellation: 'INFORM', contract_revision: 2 }]);
    }, { timeout: 10_000 });
    expect(modele.evaluate).toHaveLength(1);
    const apres = await pregen(c.id, c.ownerUserId);
    expect((await B()).subjectBlocks(apres)[0]).toMatchObject({ informative: true, badge: null });
    // Plus de renouvellement une fois la révision 2 atteinte.
    await pregen(c.id, c.ownerUserId);
    expect(modele.evaluate).toHaveLength(1);
  });

  it('T6-RAP-E2E-05 — migration 0474 rejouable ; INFORM accepté, valeur inconnue refusée ; révision 1 par défaut', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0474_t6_rappel_informatif.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    const c = await compte();
    const e = await echeance(c, 'Visite expert bois', await plus(4));
    const insert = (interpellation: string, revision = 'DEFAULT') => sql.unsafe(`INSERT INTO t6_interpellation_assessments
        (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority, reason, contract_revision)
      VALUES (${c.id}, ${e}, 'agenda:${e}:${interpellation}:${revision}', 'fp', CURRENT_DATE, '${interpellation}', FALSE, 'LOW', 'r', ${revision})`);
    await expect(insert('PEUT-ETRE')).rejects.toThrow(/interpellation_check/);
    await expect(insert('INFORM', '0')).rejects.toThrow(/revision_check/);
    await insert('INFORM');
    expect(await sql`SELECT interpellation, contract_revision FROM t6_interpellation_assessments WHERE account_id = ${c.id}`).toEqual([{ interpellation: 'INFORM', contract_revision: 1 }]);
  });
});
