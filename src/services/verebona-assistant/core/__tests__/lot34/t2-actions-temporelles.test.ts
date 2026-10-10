/**
 * Lot 34 — ticket T2 « Que dois-je faire aujourd'hui ? » : routage des
 * demandes d'actions temporelles vers les données actionnables, contrat de
 * sources, résolution temporelle, filtres par formulation, ordre,
 * déduplication, zéro résultat = SUCCESS, suppression du repli documentaire
 * générique. Tests TEMP-01 à TEMP-12 du ticket (+ compléments).
 *
 * SANS BASE : orchestrateur RÉEL (`runAssistant`), cascade RÉELLE
 * (`answerFromData`), port de données en mémoire qui applique les MÊMES
 * règles que les lectures SQL (`canonical/actionables`, couvertes en e2e) ;
 * COMPTEUR d'appels modèle (UNDERSTAND + ANSWER) et espions sur la
 * recherche documentaire (qui ne doit JAMAIS être appelée).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: { $client: { unsafe: vi.fn(async () => []) } }, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));

const { runAssistant } = await import('../../assistant-orchestrator.service');
const { answerFromData, fallbackUnderContract, actionableReadWindow } = await import('../../data-answer.service');
const { routeDeterministic } = await import('../../intent-router.service');
const {
  analyserDemandeActionnable, selectionnerActionnables, memeBesoin, FAMILY_ALLOWED_SOURCES,
} = await import('../../actionable-request');
const { analyserPorteeTemporelle } = await import('../../query-period');

import type { AccountDataPort, AssetRow, DocumentHit } from '../../data-answer.service';
import type { OrchestratorPorts } from '../../assistant-orchestrator.service';
import type { AssistantRequestInput, AssistantRunResult } from '../../../types/contracts';
import type { DeadlineRow, TodoRow } from '../../actionable-request';
import type { RetrievedSource } from '../../../types/sources';

const TODAY = '2026-10-09'; // vendredi — semaine du 5 au 11 octobre
const HIER = '2026-10-08';
const DEMAIN = '2026-10-10';
const ACCOUNT = 1;

// ── Compte en mémoire ─────────────────────────────────────────────────────

interface FxDeadline extends DeadlineRow { closed?: boolean; accountId?: number }
interface FxTodo extends TodoRow { resolved?: boolean; accountId?: number }
interface Fx { assets: AssetRow[]; todos: FxTodo[]; deadlines: FxDeadline[]; docs: DocumentHit[] }

const fx = (p: Partial<Fx> = {}): Fx => ({ assets: [], todos: [], deadlines: [], docs: [], ...p });

let seq = 100;
const echeance = (title: string, date: string, o: Partial<FxDeadline> = {}): FxDeadline => ({
  id: ++seq, title, date, endDate: null, forecast: false, isAction: true, originFieldKey: null, assets: [], documents: [], ...o,
});
const aTraiter = (title: string, o: Partial<FxTodo> = {}): FxTodo => ({
  id: ++seq, title, priority: 'DO_NEXT', actionKind: 'COMPLETE', ruleCode: 'DATA-X', targetType: 'ASSET', targetId: 1, fieldKey: null,
  dueDate: null, activeSince: '2026-09-01T10:00:00.000Z', assetId: null, assetName: null, document: null, ...o,
});
const docsDe = (titres: string[]): DocumentHit[] => titres.map((t, i) => ({ fileId: 9000 + i, title: t, date: '2026-03-15', assetName: null, matchedTerms: 2 }));
const DOCS_CAPTURE = docsDe(['32501387723_2026-03-15.pdf', 'Justificatif d’entretien 7', 'Notice de montage du lit enfant Chamonix']);

/**
 * Port de données : mêmes règles que `canonical/actionables` (compte, ouvert
 * / non résolu, fenêtre de dates, biens visés) ; la recherche documentaire
 * est espionnée et rend des documents « proches » — elle ne doit pas servir.
 */
function port(f: Fx) {
  const searchDocuments = vi.fn(async () => f.docs);
  const searchFacts = vi.fn(async () => []);
  const listActionables = vi.fn(async (accountId: number, o: { assetIds?: number[]; from: string | null; to: string | null; todos: boolean; deadlines: boolean }) => {
    const duCompte = <T extends { accountId?: number }>(x: T) => (x.accountId ?? ACCOUNT) === accountId;
    const vise = (ids: number[]) => !o.assetIds?.length || ids.some((i) => o.assetIds!.includes(i));
    const todos = o.todos ? f.todos.filter((t) => duCompte(t) && !t.resolved && vise(t.assetId ? [t.assetId] : [])) : [];
    const deadlines = o.deadlines ? f.deadlines.filter((d) => duCompte(d) && !d.closed
      && (o.from == null || (d.endDate ?? d.date) >= o.from) && (o.to == null || d.date <= o.to)
      && vise(d.assets.map((a) => a.id))) : [];
    const queried: Array<'TODO' | 'DEADLINE'> = [];
    if (o.todos) queried.push('TODO');
    if (o.deadlines) queried.push('DEADLINE');
    return { todos, deadlines, queried };
  });
  const p: AccountDataPort = {
    today: () => TODAY,
    findAssets: async (_a, words) => {
      const w = words.map((x) => x.toLowerCase());
      return f.assets.filter((a) => w.some((x) => a.name.toLowerCase().includes(x))).map((a) => ({ ...a, matched: 2 }));
    },
    listAssets: async () => f.assets,
    countDocuments: async () => f.docs.length,
    countAgenda: async () => f.deadlines.length,
    upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
    searchFacts,
    searchDocuments,
    listActionables,
  };
  return { port: p, searchDocuments, searchFacts, listActionables };
}

/** Orchestrateur réel, modèle simulé et compté, recherche classique espionnée. */
function harness(f: Fx, o: { planType?: string } = {}) {
  const data = port(f);
  const classify = vi.fn(async () => null);
  const generate = vi.fn(async () => null);
  const docSources: RetrievedSource[] = f.docs.map((d) => ({ id: `doc_${d.fileId}`, type: 'document', title: d.title, content: '', relevanceScore: 0.3 }));
  const retrieve = vi.fn(async () => docSources);
  const retrieveNear = vi.fn(async () => docSources);
  const ports: OrchestratorPorts = {
    retrieve, retrieveNear,
    resolveSources: async (sources) => sources.map((s) => ({ id: s.id, type: s.type, typeLabel: s.type, title: s.title, excerpt: '', isAvailable: true })),
    classifyWithAI: classify,
    generateWithAI: generate,
    resolveActions: async () => [],
    persist: async () => null,
    hasPendingClarification: async () => false,
    saveClarification: vi.fn(async () => true),
    answerFromData: (route, input, thresholds) => answerFromData({
      port: data.port, accountId: input.accountId, message: input.message, thresholds, intent: route.intent,
      pageAssetId: Number(input.pageContext?.assetId) || null,
      resolvedAssetId: input.resume?.assetId ?? (input.reference?.type === 'asset' ? input.reference.id : null),
    }),
  };
  const ask = (message: string): Promise<AssistantRunResult> => runAssistant({
    accountId: ACCOUNT, userId: 7, planType: o.planType ?? 'PREMIUM', message, clientRequestId: `t-${Math.random()}`, locale: 'fr-FR', conversationId: 99,
  } as AssistantRequestInput, ports);
  return { ...data, classify, generate, retrieve, retrieveNear, ask, llmCalls: () => classify.mock.calls.length + generate.mock.calls.length };
}

const QUE_FAIRE = 'Que dois-je faire aujourd’hui ?';
const ids = (r: AssistantRunResult) => r.sources.map((s) => s.id);
const types = (r: AssistantRunResult) => [...new Set(r.sources.map((s) => s.type))];

/** Invariants de toute demande d'actions comprise : SQL, 0 appel modèle, aucun document. */
function sansDocumentNiModele(h: ReturnType<typeof harness>, r: AssistantRunResult) {
  expect(h.llmCalls()).toBe(0);
  expect(r.cascade?.aiCalls).toBe(0);
  expect(h.searchDocuments).not.toHaveBeenCalled();
  expect(h.searchFacts).not.toHaveBeenCalled();
  expect(h.retrieve).not.toHaveBeenCalled();
  expect(h.retrieveNear).not.toHaveBeenCalled();
  expect(r.sources.every((s) => s.type === 'to_process_item' || s.type === 'agenda_item')).toBe(true);
  expect(r.answer).not.toMatch(/semblent li/);
  expect(r.cascade?.actionable?.queryStrategy).toBe('SQL_CANONICAL');
  expect(r.cascade?.actionable?.fallbackUsed).toBe(false);
  expect(r.cascade?.fallbackUsed).toBe(false);
}

describe('Lot 34 — T2 demandes d’actions temporelles (TEMP-01 à TEMP-12)', () => {
  it('TEMP-01 — aucune action, plusieurs documents : 0 résultat, SUCCESS, aucun document en substitut, pas de repli', async () => {
    const h = harness(fx({ docs: DOCS_CAPTURE }));
    const r = await h.ask(QUE_FAIRE);
    sansDocumentNiModele(h, r);
    expect(r.route.intent).toBe('ACCOUNT_TO_PROCESS');
    expect(r.cascade?.strategy).toBe('structured.actionable');
    expect(r.cascade?.answeredBy).toBe('structured');
    expect(r.cascade?.actionable).toMatchObject({
      intentResolution: 'ACTIONS_TEMPORAL', resolution: 'SUCCESS', requestedTimeScope: 'TODAY', appliedTimeScope: 'TODAY',
      resolvedStartDate: TODAY, resolvedEndDate: TODAY, allowedSourceTypes: ['TODO', 'DEADLINE'], queriedSources: ['TODO', 'DEADLINE'],
      resultCount: 0, todoCount: 0, deadlineCount: 0, overdueCount: 0, todayCount: 0, fallbackReason: null, answeredBy: 'structured',
    });
    expect(r.sources).toEqual([]);
    expect(r.answer).toMatch(/^Rien à faire pour aujourd’hui/);
    for (const d of DOCS_CAPTURE) expect(r.answer).not.toContain(d.title);
    expect(r.cascade?.diagnostic).toBeUndefined();
    const { truthSourceOf } = await import('@/services/ai/telemetry/t2-observability');
    expect(truthSourceOf(r.cascade?.strategy)).toBe('agenda');
  });

  it('TEMP-02 — une échéance aujourd’hui : retournée, DUE_TODAY', async () => {
    const e = echeance('Entretien voiture', TODAY, { assets: [{ id: 3, name: 'Polo' }] });
    const h = harness(fx({ deadlines: [e], docs: DOCS_CAPTURE }));
    const r = await h.ask(QUE_FAIRE);
    sansDocumentNiModele(h, r);
    expect(ids(r)).toEqual([`agenda_${e.id}`]);
    expect(r.cascade?.actionable?.results[0]).toMatchObject({
      sourceType: 'DEADLINE', sourceId: `agenda_${e.id}`, reasonForInclusion: 'DUE_TODAY', status: 'ACTIVE', dueDate: TODAY, relatedAssetId: 3,
    });
    expect(r.cascade?.actionable).toMatchObject({ resultCount: 1, deadlineCount: 1, todayCount: 1, actionCount: 1 });
    expect(r.answer).toContain('« Entretien voiture » (Polo)');
  });

  it('TEMP-03 — échéance d’hier encore active : retournée, OVERDUE', async () => {
    const e = echeance('Contrôle technique', HIER);
    const h = harness(fx({ deadlines: [e] }));
    const r = await h.ask(QUE_FAIRE);
    sansDocumentNiModele(h, r);
    expect(r.cascade?.actionable?.results).toEqual([expect.objectContaining({ sourceId: `agenda_${e.id}`, reasonForInclusion: 'OVERDUE', dueDate: HIER })]);
    expect(r.cascade?.actionable?.overdueCount).toBe(1);
    expect(r.answer).toMatch(/En retard \(prévu le 8 octobre 2026\) : « Contrôle technique »/);
  });

  it('TEMP-04 — échéance d’hier close (réalisée) : non retournée', async () => {
    const close = echeance('Vidange', HIER, { closed: true });
    const h = harness(fx({ deadlines: [close] }));
    const r = await h.ask(QUE_FAIRE);
    sansDocumentNiModele(h, r);
    expect(r.cascade?.actionable?.resultCount).toBe(0);
    expect(r.answer).not.toContain('Vidange');
  });

  it('TEMP-05 — « Qu’est-ce que je dois traiter ? » : l’À traiter ouvert est retourné (OPEN_TODO), sources TODO seules', async () => {
    const t = aTraiter('Quel est le numéro d’immatriculation de ce bien ?', { assetId: 3, assetName: 'Polo' });
    const resolu = aTraiter('Ancienne question', { resolved: true });
    const e = echeance('Assurance', TODAY);
    const h = harness(fx({ todos: [t, resolu], deadlines: [e] }));
    const r = await h.ask('Qu’est-ce que je dois traiter ?');
    sansDocumentNiModele(h, r);
    expect(r.route.intent).toBe('ACCOUNT_TO_PROCESS');
    expect(ids(r)).toEqual([`todo_${t.id}`]);
    expect(r.cascade?.actionable).toMatchObject({
      intentResolution: 'TO_PROCESS_OPEN', allowedSourceTypes: ['TODO'], queriedSources: ['TODO'], todoCount: 1, deadlineCount: 0,
    });
    expect(r.cascade?.actionable?.results[0]).toMatchObject({ sourceType: 'TODO', reasonForInclusion: 'OPEN_TODO', status: 'OPEN', relatedAssetId: 3 });
  });

  it('TEMP-06 — compte avec seulement factures, notices, contrats : aucun document présenté comme une action', async () => {
    const docs = docsDe(['Facture EDF mars', 'Notice lave-linge', 'Contrat assurance habitation', 'Facture garage']);
    const h = harness(fx({ docs }));
    for (const q of [QUE_FAIRE, 'Qu’est-ce qui est urgent ?', 'Est-ce que j’ai quelque chose en retard ?', 'Qu’est-ce que j’ai cette semaine ?']) {
      const r = await h.ask(q);
      sansDocumentNiModele(h, r);
      expect(r.sources).toEqual([]);
      expect(r.resultGroups ?? []).toEqual([]);
      for (const d of docs) expect(r.answer).not.toContain(d.title);
      expect(r.cascade?.actionable?.resolution).toBe('SUCCESS');
    }
  });

  it('TEMP-07 — échéance du jour + document associé : l’échéance est le résultat, le document un contexte', async () => {
    const e = echeance('Entretien annuel chaudière', TODAY, { assets: [{ id: 2, name: 'Maison' }], documents: [{ id: 77, title: 'Contrat entretien chaudière.pdf' }] });
    const h = harness(fx({ deadlines: [e], docs: docsDe(['Contrat entretien chaudière.pdf']) }));
    const r = await h.ask(QUE_FAIRE);
    sansDocumentNiModele(h, r);
    expect(ids(r)).toEqual([`agenda_${e.id}`]);
    expect(types(r)).toEqual(['agenda_item']);
    expect(r.cascade?.actionable?.results[0]).toMatchObject({ sourceType: 'DEADLINE', reasonForInclusion: 'DUE_TODAY', contextDocumentIds: [77], relatedAssetId: 2 });
    expect(r.answer).toContain('« Entretien annuel chaudière » (Maison) — document associé : « Contrat entretien chaudière.pdf »');
  });

  it('TEMP-08 — formulations équivalentes : même domaine de résolution, mêmes résultats', async () => {
    const e = echeance('Entretien voiture', TODAY);
    const t = aTraiter('Date de fin de garantie à compléter');
    const h = harness(fx({ deadlines: [e], todos: [t], docs: DOCS_CAPTURE }));
    const attendus = [`agenda_${e.id}`, `todo_${t.id}`];
    for (const q of [
      'Que dois-je faire aujourd’hui ?', 'Qu’est-ce que j’ai à faire aujourd’hui ?', 'J’ai quoi à faire aujourd’hui ?',
      'J’ai quoi aujourd’hui ?', 'Qu’est-ce que je dois faire aujourd’hui ?', 'Que dois-je faire ?', 'Qu’ai-je à faire aujourd’hui ?',
    ]) {
      const r = await h.ask(q);
      sansDocumentNiModele(h, r);
      expect(r.route.intent, q).toBe('ACCOUNT_TO_PROCESS');
      expect(r.cascade?.actionable?.intentResolution, q).toBe('ACTIONS_TEMPORAL');
      expect(r.cascade?.actionable?.appliedTimeScope, q).toBe('TODAY');
      expect(ids(r), q).toEqual(attendus);
    }
  });

  it('TEMP-09 — « Quelles sont mes échéances aujourd’hui ? » : 1 échéance, les À traiter sans lien ne sont pas injectés', async () => {
    const e = echeance('Contrôle chaudière', TODAY);
    const todos = [aTraiter('A'), aTraiter('B'), aTraiter('C')];
    const h = harness(fx({ deadlines: [e, echeance('Plus tard', '2026-10-20'), echeance('Retard', HIER)], todos }));
    const r = await h.ask('Quelles sont mes échéances aujourd’hui ?');
    sansDocumentNiModele(h, r);
    expect(r.route.intent).toBe('ACCOUNT_SEARCH_AGENDA');
    expect(ids(r)).toEqual([`agenda_${e.id}`]);
    expect(r.cascade?.actionable).toMatchObject({
      intentResolution: 'DEADLINES_PERIOD', allowedSourceTypes: ['DEADLINE'], queriedSources: ['DEADLINE'], todoCount: 0, deadlineCount: 1, resultCount: 1,
    });
    expect(h.listActionables.mock.calls[0][1]).toMatchObject({ todos: false, deadlines: true, from: TODAY, to: TODAY });
  });

  it('TEMP-10 — « Est-ce que j’ai quelque chose en retard ? » : uniquement les éléments échus ET encore actifs', async () => {
    const retard = echeance('Contrôle technique', '2026-09-30');
    const close = echeance('Vidange', '2026-09-28', { closed: true });
    const todoRetard = aTraiter('Renouveler l’assurance', { dueDate: HIER });
    const todoSansDate = aTraiter('Type de document à préciser');
    const todoResolu = aTraiter('Déjà fait', { dueDate: '2026-09-01', resolved: true });
    const h = harness(fx({
      deadlines: [retard, close, echeance('Aujourd’hui', TODAY), echeance('Futur', '2026-11-02')],
      todos: [todoRetard, todoSansDate, todoResolu],
    }));
    for (const q of ['Est-ce que j’ai quelque chose en retard ?', 'Qu’est-ce que j’ai en retard ?', 'Quels éléments sont en retard ?']) {
      const r = await h.ask(q);
      sansDocumentNiModele(h, r);
      expect(r.cascade?.actionable?.intentResolution, q).toBe('ACTIONS_OVERDUE');
      expect(ids(r), q).toEqual([`agenda_${retard.id}`, `todo_${todoRetard.id}`]);
      expect(r.cascade?.actionable?.results.every((x) => x.reasonForInclusion === 'OVERDUE'), q).toBe(true);
      expect(r.cascade?.actionable?.overdueCount, q).toBe(2);
    }
  });

  it('TEMP-11 — période future : « cette semaine », « demain », « ce mois-ci », « la semaine prochaine » filtrés sur la période calculée', async () => {
    const lun = echeance('Lundi (passé, ouvert)', '2026-10-05');
    const sam = echeance('Samedi', DEMAIN);
    const dim = echeance('Dimanche', '2026-10-11');
    const lunProchain = echeance('Lundi prochain', '2026-10-12');
    const fin = echeance('Fin du mois', '2026-10-31');
    const nov = echeance('Novembre', '2026-11-03');
    const ancien = echeance('Ancien retard', '2026-08-01');
    const todoSansDate = aTraiter('Sans date');
    const todoSemaine = aTraiter('Dû dimanche', { dueDate: '2026-10-11' });
    const h = harness(fx({ deadlines: [lun, sam, dim, lunProchain, fin, nov, ancien], todos: [todoSansDate, todoSemaine] }));

    const semaine = await h.ask('Qu’est-ce que j’ai cette semaine ?');
    sansDocumentNiModele(h, semaine);
    expect(semaine.cascade?.actionable).toMatchObject({ requestedTimeScope: 'THIS_WEEK', resolvedStartDate: '2026-10-05', resolvedEndDate: '2026-10-11' });
    // Retards actifs (la période contient aujourd'hui), puis la période ; ni le
    // lundi suivant, ni l'À traiter sans date.
    expect(ids(semaine)).toEqual([`agenda_${ancien.id}`, `agenda_${lun.id}`, `agenda_${sam.id}`, `agenda_${dim.id}`, `todo_${todoSemaine.id}`]);

    const demain = await h.ask('Que dois-je faire demain ?');
    expect(demain.cascade?.actionable).toMatchObject({ requestedTimeScope: 'TOMORROW', resolvedStartDate: DEMAIN, resolvedEndDate: DEMAIN });
    expect(ids(demain)).toEqual([`agenda_${sam.id}`]);

    const mois = await h.ask('Qu’est-ce que j’ai à faire ce mois-ci ?');
    expect(mois.cascade?.actionable).toMatchObject({ requestedTimeScope: 'THIS_MONTH', resolvedStartDate: '2026-10-01', resolvedEndDate: '2026-10-31' });
    expect(ids(mois)).not.toContain(`agenda_${nov.id}`);
    expect(ids(mois)).toContain(`agenda_${fin.id}`);

    const prochaine = await h.ask('Qu’est-ce que j’ai la semaine prochaine ?');
    expect(prochaine.cascade?.actionable).toMatchObject({ requestedTimeScope: 'NEXT_WEEK', resolvedStartDate: '2026-10-12', resolvedEndDate: '2026-10-18' });
    expect(ids(prochaine)).toEqual([`agenda_${lunProchain.id}`]);

    const echeancesSemaine = await h.ask('Quelles sont mes échéances cette semaine ?');
    expect(echeancesSemaine.cascade?.actionable?.intentResolution).toBe('DEADLINES_PERIOD');
    expect(ids(echeancesSemaine)).toEqual([`agenda_${lun.id}`, `agenda_${sam.id}`, `agenda_${dim.id}`]);
    expect(h.llmCalls()).toBe(0);
  });

  it('TEMP-12 — beaucoup de documents sans action : résultat identique, recherche documentaire jamais appelée', async () => {
    const base = { deadlines: [echeance('Entretien', TODAY), echeance('Retard', HIER)], todos: [aTraiter('À compléter')] };
    const sans = await harness(fx(base)).ask(QUE_FAIRE);
    const nombreux = docsDe(Array.from({ length: 300 }, (_, i) => `Document ${i} faire aujourd’hui`));
    const h = harness(fx({ ...base, docs: nombreux }));
    const avec = await h.ask(QUE_FAIRE);
    sansDocumentNiModele(h, avec);
    expect(avec.answer).toBe(sans.answer);
    expect(avec.cascade?.actionable?.results).toEqual(sans.cascade?.actionable?.results);
    expect(ids(avec)).toEqual(ids(sans));
  });
});

describe('Lot 34 — formulations, période, ordre, déduplication', () => {
  it('formulations différentes → filtres différents (pas un SELECT unique)', () => {
    const fam = (q: string) => analyserDemandeActionnable(q, TODAY)?.intentResolution ?? null;
    expect(fam('Que dois-je faire aujourd’hui ?')).toBe('ACTIONS_TEMPORAL');
    expect(fam('Quelles sont mes échéances aujourd’hui ?')).toBe('DEADLINES_PERIOD');
    expect(fam('Est-ce que j’ai quelque chose en retard ?')).toBe('ACTIONS_OVERDUE');
    expect(fam('Qu’est-ce que je dois traiter ?')).toBe('TO_PROCESS_OPEN');
    expect(fam('Qu’est-ce qui est urgent ?')).toBe('ACTIONS_URGENT');
    expect(fam('Qu’est-ce que j’ai cette semaine ?')).toBe('ACTIONS_TEMPORAL');
    expect(FAMILY_ALLOWED_SOURCES.DEADLINES).toEqual(['DEADLINE']);
    expect(FAMILY_ALLOWED_SOURCES.TO_PROCESS).toEqual(['TODO']);
    // Pas des demandes d'actions : la suite habituelle s'applique.
    for (const q of [
      'Quel est le montant de la facture d’aujourd’hui ?', 'Comment ajouter un document ?', 'Quelles sont mes prochaines échéances ?',
      'Quelles échéances arrivent bientôt ?', 'Qu’est-ce que j’ai acheté cette semaine ?', 'Retrouve le contrôle technique dans mon agenda',
      'Qu’est-ce que j’ai ?', 'Montre-moi les factures en retard',
    ]) expect(fam(q), q).toBeNull();
  });

  it('routeur : les demandes d’actions vont aux intentions EXISTANTES (aucune intention nouvelle)', () => {
    const intent = (q: string) => {
      const o = routeDeterministic({ message: q, planType: 'PREMIUM', hasPendingClarification: false });
      return o.kind === 'route' ? o.route.intent : 'needs_classification';
    };
    expect(intent('Que dois-je faire aujourd’hui ?')).toBe('ACCOUNT_TO_PROCESS');
    expect(intent('J’ai quoi aujourd’hui ?')).toBe('ACCOUNT_TO_PROCESS');
    expect(intent('Qu’est-ce qui est urgent ?')).toBe('ACCOUNT_TO_PROCESS');
    expect(intent('Est-ce que j’ai quelque chose en retard ?')).toBe('ACCOUNT_TO_PROCESS');
    expect(intent('Qu’est-ce que j’ai cette semaine ?')).toBe('ACCOUNT_TO_PROCESS');
    expect(intent('Quelles sont mes échéances aujourd’hui ?')).toBe('ACCOUNT_SEARCH_AGENDA');
    // Inchangés.
    expect(intent('Comment ajouter un document ?')).toBe('PRODUCT_HELP_HOW_TO');
    expect(intent('Quels éléments dois-je traiter ?')).toBe('ACCOUNT_TO_PROCESS');
    expect(intent('Qu’est-ce qui manque sur mes fiches ?')).toBe('ACCOUNT_MISSING_INFORMATION');
  });

  it('résolution temporelle commune : aujourd’hui, demain, cette semaine, ce mois-ci, en retard, à venir', () => {
    const p = (q: string) => analyserPorteeTemporelle(q, TODAY);
    expect(p('aujourd’hui')).toMatchObject({ scope: 'TODAY', from: TODAY, to: TODAY });
    expect(p('demain')).toMatchObject({ scope: 'TOMORROW', from: DEMAIN, to: DEMAIN });
    expect(p('après-demain')).toMatchObject({ scope: 'PERIOD', from: '2026-10-11', to: '2026-10-11' });
    expect(p('cette semaine')).toMatchObject({ scope: 'THIS_WEEK', from: '2026-10-05', to: '2026-10-11' });
    expect(p('la semaine prochaine')).toMatchObject({ scope: 'NEXT_WEEK', from: '2026-10-12', to: '2026-10-18' });
    expect(p('ce mois-ci')).toMatchObject({ scope: 'THIS_MONTH', from: '2026-10-01', to: '2026-10-31' });
    expect(p('le mois prochain')).toMatchObject({ scope: 'NEXT_MONTH', from: '2026-11-01', to: '2026-11-30' });
    expect(p('en retard')).toMatchObject({ scope: 'OVERDUE', from: null, to: HIER });
    expect(p('à venir')).toMatchObject({ scope: 'UPCOMING', from: TODAY, to: '2026-11-08' });
    expect(p('en mars 2026')).toMatchObject({ scope: 'PERIOD', from: '2026-03-01', to: '2026-03-31' });
    expect(p('rien')).toMatchObject({ scope: 'NONE', from: null, to: null });
    // Dimanche : la semaine en cours finit le jour même.
    expect(analyserPorteeTemporelle('cette semaine', '2026-10-11')).toMatchObject({ from: '2026-10-05', to: '2026-10-11' });
    // Changement d'année.
    expect(analyserPorteeTemporelle('demain', '2026-12-31')).toMatchObject({ from: '2027-01-01' });
  });

  it('bornes de lecture : retards sans borne basse ; période future sans retard ; liste À traiter sans borne', () => {
    const w = (q: string) => actionableReadWindow(analyserDemandeActionnable(q, TODAY)!, TODAY);
    expect(w(QUE_FAIRE)).toEqual({ from: null, to: TODAY });
    expect(w('Que dois-je faire demain ?')).toEqual({ from: DEMAIN, to: DEMAIN });
    expect(w('Qu’est-ce que je dois traiter ?')).toEqual({ from: null, to: null });
    expect(w('Quelles sont mes échéances aujourd’hui ?')).toEqual({ from: TODAY, to: TODAY });
  });

  it('ordre : retards (date), du jour, puis À traiter sans date (priorité, ancienneté)', () => {
    const req = analyserDemandeActionnable(QUE_FAIRE, TODAY)!;
    const r = selectionnerActionnables(req, {
      todos: [
        aTraiter('Peut attendre', { id: 1, priority: 'CAN_WAIT' }),
        aTraiter('D’abord récent', { id: 2, priority: 'DO_FIRST', activeSince: '2026-10-01T00:00:00Z' }),
        aTraiter('D’abord ancien', { id: 3, priority: 'DO_FIRST', activeSince: '2026-09-01T00:00:00Z' }),
        aTraiter('Dû aujourd’hui', { id: 4, dueDate: TODAY }),
        aTraiter('Dû dans un mois', { id: 5, dueDate: '2026-11-09' }),
      ],
      deadlines: [echeance('Jour', TODAY, { id: 10 }), echeance('Retard récent', HIER, { id: 11 }), echeance('Retard ancien', '2026-09-01', { id: 12 })],
    }, TODAY);
    expect(r.map((x) => x.sourceId)).toEqual(['agenda_12', 'agenda_11', 'agenda_10', 'todo_4', 'todo_3', 'todo_2', 'todo_1']);
  });

  it('déduplication : un À traiter qui vise l’échéance (ou la même donnée du même bien) est fusionné, l’échéance reste principale', () => {
    const req = analyserDemandeActionnable(QUE_FAIRE, TODAY)!;
    const e = echeance('Fin de garantie', TODAY, { id: 20, originFieldKey: 'warrantyEndDate', assets: [{ id: 3, name: 'Polo' }], documents: [{ id: 5, title: 'Facture achat' }] });
    const carte = aTraiter('L’échéance a-t-elle été réalisée ?', { id: 30, targetType: 'AGENDA_ITEM', targetId: 20 });
    const champ = aTraiter('Confirmer la fin de garantie', { id: 31, targetType: 'ASSET', targetId: 3, fieldKey: 'warrantyEndDate' });
    const doc = aTraiter('Date de fin de garantie du document', { id: 32, targetType: 'DOCUMENT', targetId: 5, fieldKey: 'warrantyEndDate', document: { id: 5, title: 'Facture achat' } });
    const autre = aTraiter('Autre sujet', { id: 33, targetType: 'ASSET', targetId: 3, fieldKey: 'registrationNumber' });
    expect(memeBesoin(carte, e) && memeBesoin(champ, e) && memeBesoin(doc, e)).toBe(true);
    expect(memeBesoin(autre, e)).toBe(false);
    const r = selectionnerActionnables(req, { todos: [carte, champ, doc, autre], deadlines: [e] }, TODAY);
    expect(r.map((x) => x.sourceId)).toEqual(['agenda_20', 'todo_33']);
    expect(r[0].mergedSourceIds).toEqual(['todo_30', 'todo_31', 'todo_32']);
    expect(r[0].contextDocuments.map((d) => d.id)).toEqual([5]);
  });

  it('« urgent » : retards, jour et « À faire d’abord » seulement', () => {
    const req = analyserDemandeActionnable('Qu’est-ce qui est urgent ?', TODAY)!;
    const r = selectionnerActionnables(req, {
      todos: [aTraiter('Ensuite', { id: 1 }), aTraiter('D’abord', { id: 2, priority: 'DO_FIRST' })],
      deadlines: [echeance('Futur', '2026-10-20', { id: 3 }), echeance('Jour', TODAY, { id: 4 })],
    }, TODAY);
    expect(r.map((x) => [x.sourceId, x.reasonForInclusion])).toEqual([['agenda_4', 'DUE_TODAY'], ['todo_2', 'PRIORITY_TODO']]);
  });

  it('biens : un bien nommé filtre la lecture ; deux biens homonymes → clarification ; mot inconnu → jamais à l’échelle du compte', async () => {
    const assets: AssetRow[] = [{ id: 3, name: 'Polo', category: 'VEHICULE', subtype: null, purchaseDate: null, isRented: false }];
    const h = harness(fx({ assets, deadlines: [echeance('Polo CT', TODAY, { assets: [{ id: 3, name: 'Polo' }] }), echeance('Maison', TODAY, { assets: [{ id: 4, name: 'Maison' }] })] }));
    const r = await h.ask('Que dois-je faire pour la Polo aujourd’hui ?');
    sansDocumentNiModele(h, r);
    expect(r.cascade?.actionable?.assetScope).toEqual([3]);
    expect(r.cascade?.actionable?.resultCount).toBe(1);

    const deux = harness(fx({ assets: [...assets, { ...assets[0], id: 5 }] }));
    const amb = await deux.ask('Que dois-je faire pour la Polo aujourd’hui ?');
    expect(amb.clarification?.candidates.length).toBe(2);
    expect(deux.llmCalls()).toBe(0);

    const inconnu = harness(fx({ assets, docs: DOCS_CAPTURE }), { planType: 'STANDARD' });
    const x = await inconnu.ask('Que dois-je faire pour la Clio aujourd’hui ?');
    expect(x.sources.some((s) => s.type === 'document')).toBe(false);
    expect(x.answer).not.toMatch(/semblent li/);
  });
});

describe('Lot 34 — repli générique sous contrat (toutes intentions à type connu)', () => {
  const doc = (i: number): RetrievedSource => ({ id: `doc_${i}`, type: 'document', title: `Notice ${i}`, content: '', relevanceScore: 0.2 });
  const ag = (i: number): RetrievedSource => ({ id: `agenda_${i}`, type: 'agenda_item', title: `Échéance ${i}`, content: '', relevanceScore: 0.2 });

  it('type de réponse connu : aucune source hors contrat, jamais « semblent liés »', () => {
    const r = fallbackUnderContract('ACCOUNT_SEARCH_AGENDA', [doc(1), doc(2)], 'mes rendez-vous du garagiste');
    expect(r).toMatchObject({ sources: [], fallbackUsed: false, fallbackReason: 'OUT_OF_CONTRACT_SOURCES_DROPPED', dropped: 2 });
    expect(r.answer).not.toMatch(/semblent li|Notice/);
    const m = fallbackUnderContract('ACCOUNT_SEARCH_AGENDA', [doc(1), ag(2)], 'mes rendez-vous du garagiste');
    expect(m.sources.map((s) => s.id)).toEqual(['agenda_2']);
    expect(m).toMatchObject({ fallbackUsed: true, fallbackReason: 'NEAR_RESULTS_SAME_DOMAIN', dropped: 1 });
    expect(m.answer).toMatch(/Résultats proches : « Échéance 2 »/);
    expect(m.answer).not.toMatch(/semblent li|Notice/);
    for (const intent of ['ACCOUNT_TO_PROCESS', 'ACCOUNT_SEARCH_SUPPLIER', 'ACCOUNT_SEARCH_ASSET', 'ACCOUNT_FACT_AGENDA']) {
      expect(fallbackUnderContract(intent, [doc(1)], 'x').answer, intent).not.toMatch(/semblent li/);
    }
  });

  it('intention sans type de réponse connu (UNKNOWN) : repli générique conservé et tracé comme tel', () => {
    const r = fallbackUnderContract('UNKNOWN', [doc(1)], 'x');
    expect(r).toMatchObject({ fallbackUsed: true, fallbackReason: 'GENERIC_UNKNOWN_INTENT' });
  });

  it('orchestrateur : recherche de fournisseur sans IA, documents trouvés → aucun document présenté', async () => {
    const h = harness(fx({ docs: DOCS_CAPTURE }), { planType: 'STANDARD' });
    const r = await h.ask('Quel fournisseur pour la plomberie ?');
    expect(r.route.intent).toBe('ACCOUNT_SEARCH_SUPPLIER');
    expect(r.sources.some((s) => s.type === 'document')).toBe(false);
    expect(r.answer).not.toMatch(/semblent li/);
    for (const d of DOCS_CAPTURE) expect(r.answer).not.toContain(d.title);
  });
});
