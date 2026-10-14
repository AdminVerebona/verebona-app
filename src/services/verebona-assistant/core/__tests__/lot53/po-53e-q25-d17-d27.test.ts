/**
 * Lot 53 — retour PO Q25 (harmonisation de T2 avec la mascotte : plus
 * d'« urgent », formulation de priorité, jamais « aucun sujet » si l'état des
 * données ne le permet pas), D17 côté assistant (une date passée ne prouve
 * pas la réalisation) et D27 (échéance ≠ rendez-vous programmé).
 *
 * Même banc que le lot 34 : orchestrateur et cascade RÉELS, port de données
 * en mémoire, aucun appel modèle. Base : 53h (T2 demandes courtes) intact.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: { $client: { unsafe: vi.fn(async () => []) } }, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));

const { runAssistant } = await import('../../assistant-orchestrator.service');
const { agendaTargetAnswer } = await import('../../target-answer');
const { answerFromData } = await import('../../data-answer.service');
const { analyserDemandeActionnable, formatActionnables, NO_PRIORITY_SUBJECT } = await import('../../actionable-request');
const { agendaStatus4 } = await import('../../../canonical/agenda');

import type { AccountDataPort, AssetRow, DocumentHit } from '../../data-answer.service';
import type { OrchestratorPorts } from '../../assistant-orchestrator.service';
import type { AssistantRequestInput, AssistantRunResult } from '../../../types/contracts';
import type { DeadlineRow, TodoRow } from '../../actionable-request';
import type { CanonicalAgendaItem } from '../../../canonical/agenda';
import type { RetrievedSource } from '../../../types/sources';

const TODAY = '2026-10-09'; // vendredi — semaine du 5 au 11 octobre
const HIER = '2026-10-08';
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


const URGENT = 'Qu’est-ce qui est urgent ?';

describe('PO-Q25 — T2 : vocabulaire de priorité, cohérent avec la mascotte', () => {
  it('PO-Q25-01 — rien de prioritaire ni d’autre élément : « Aucun sujet à traiter en priorité aujourd’hui », jamais « urgent »', async () => {
    const h = harness(fx({ deadlines: [echeance('Futur', '2026-11-20')] }));
    const r = await h.ask(URGENT);
    expect(r.answer).toBe(`${NO_PRIORITY_SUBJECT} : aucune échéance dépassée, aucune échéance aujourd’hui et aucun élément « À faire d’abord ».`);
    expect(r.answer).not.toMatch(/urgen|Rien d/i);
    expect(h.llmCalls()).toBe(0);
  });

  it('PO-Q25-02 — éléments « À traiter » non prioritaires (ex. rapprochement en attente) : signalés, jamais masqués par « aucun sujet »', async () => {
    const h = harness(fx({ todos: [aTraiter('Rapprocher la facture'), aTraiter('Compléter le contrat', { priority: 'CAN_WAIT' })] }));
    const r = await h.ask(URGENT);
    expect(r.answer).toContain(NO_PRIORITY_SUBJECT);
    expect(r.answer).toContain('2 autres éléments restent à voir dans « À traiter », sans priorité immédiate.');
    const un = await harness(fx({ todos: [aTraiter('Rapprocher la facture')] })).ask(URGENT);
    expect(un.answer).toContain('Un autre élément reste à voir dans « À traiter »');
  });

  it('PO-Q25-03 — échéance échue ou « À faire d’abord » : listés comme sujets à traiter en priorité (jamais « aucun sujet »)', async () => {
    const h = harness(fx({ deadlines: [echeance('Contrôle technique', HIER)], todos: [aTraiter('Vérifier l’IBAN', { priority: 'DO_FIRST' })] }));
    const r = await h.ask(URGENT);
    expect(r.answer).toMatch(/^Vous avez 2 sujets à traiter en priorité aujourd’hui :/);
    expect(r.answer).toContain('En retard (échéance du 8 octobre 2026) : « Contrôle technique »');
    expect(r.answer).not.toMatch(/urgen|Aucun sujet|prévu le/i);
  });

  it('PO-Q25-04 — lecture bornée atteinte : jamais une assurance catégorique', () => {
    const req = analyserDemandeActionnable(URGENT, TODAY)!;
    const t = formatActionnables(req, [], (d) => d, { truncated: true });
    expect(t).toContain('Lecture partielle');
  });

  it('PO-Q25-05 — aucun texte de réponse T2 des demandes d’actions n’emploie « urgent »', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const code = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/core/actionable-request.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      // Vocabulaire de RECONNAISSANCE de la question (jamais rendu).
      .replace(/const URGENT = .*$/m, '').replace(/^const VOCABULAIRE[\s\S]*?\]\);/m, '');
    const gabarits = code.match(/`(?:\\.|[^`])*`/g) ?? [];
    for (const g of gabarits) expect(g, g).not.toMatch(/urgen/i);
  });
});

const item = (o: Partial<CanonicalAgendaItem>): CanonicalAgendaItem => ({
  id: 5, title: 'Achat Clio', date: '2024-05-01', nature: 'HISTORICAL', businessType: 'purchase', status: 'not_proven',
  manualStatus: null, forecast: false, category: null, isAutomatic: true, userModified: false, overdue: false, assets: [], sources: [], ...o,
});

describe('PO-D17 — assistant : une date passée ne prouve pas la réalisation', () => {
  it('PO-D17-05 — statut à 4 états : fait historique passé sans statut = non prouvé ; réalisé seulement si établi', () => {
    expect(agendaStatus4(null, false, '2024-05-01', TODAY, true)).toBe('not_proven');
    expect(agendaStatus4('realise', false, '2024-05-01', TODAY, true)).toBe('completed');
  });

  it('PO-D17-06 — réponses : « a eu lieu » seulement si la réalisation est établie', () => {
    const nonProuve = agendaTargetAnswer(item({}), 'date', TODAY).text;
    expect(nonProuve).toBe('« Achat Clio » est daté du 1 mai 2024 dans votre historique ; sa réalisation n’est pas confirmée.');
    expect(agendaTargetAnswer(item({ status: 'completed', manualStatus: 'realise' }), 'date', TODAY).text).toBe('« Achat Clio » a eu lieu le 1 mai 2024.');
    const statut = agendaTargetAnswer(item({}), 'status', TODAY).text;
    expect(statut).toContain('sa réalisation n’est pas confirmée');
    expect(statut).not.toMatch(/a eu lieu|réalisé\b(?! depuis)/);
  });
});

describe('PO-D27 — assistant : échéance à respecter ≠ rendez-vous programmé', () => {
  it('PO-D27-05 — échéance : « à prévoir pour le » ; événement saisi par l’utilisateur : « prévu le » ; jamais « confirmé »', () => {
    const ct = item({ title: 'Contrôle technique', date: '2026-11-20', nature: 'DEADLINE', businessType: 'inspection', status: 'unknown', dateRole: 'DEADLINE' });
    expect(agendaTargetAnswer(ct, 'date', TODAY).text).toBe('« Contrôle technique » est à prévoir pour le 20 novembre 2026.');
    const rdv = item({ title: 'Garage', date: '2026-11-20', nature: null, businessType: null, status: 'unknown', isAutomatic: false, dateRole: 'SCHEDULED_EVENT' });
    expect(agendaTargetAnswer(rdv, 'date', TODAY).text).toBe('« Garage » est prévu le 20 novembre 2026.');
    // Rôle inconnu (appelant ancien) : prudence — échéance.
    expect(agendaTargetAnswer({ ...ct, dateRole: undefined }, 'date', TODAY).text).toContain('à prévoir');
    for (const x of [ct, rdv]) expect(agendaTargetAnswer(x, 'date', TODAY).text).not.toMatch(/confirm/);
  });
});
