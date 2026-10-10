/**
 * Lot 34 — ticket « ne proposer que des questions pertinentes et réellement
 * répondables par T2 » : catalogue UNIQUE, contrat de chaque suggestion
 * (id, libellé, intention T2 canonique, domaine, préconditions explicites),
 * cas 1 à 6 du ticket, 0 à 3 suggestions sans remplissage, mascotte branchée
 * sur le même catalogue.
 *
 * Le parcours réel « affichée → cliquée → intention → source du bon domaine
 * → réponse non fallback » de CHAQUE suggestion est vérifié de bout en bout
 * (PostgreSQL réel) par `src/test/e2e/scenarios/l34-suggestions-repondables.e2e.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const {
  ALL_SUGGESTIONS, EMPTY_ACCOUNT_STATE, SUGGESTION_DOMAIN_SOURCES, suggestionsForRoute, requirementsMet, MAX_SUGGESTIONS,
} = await import('../capability-registry');
const { INTENT_DEFINITIONS } = await import('../intent-registry');
const { routeDeterministic } = await import('../../core/intent-router.service');
const { analyserDemandeActionnable } = await import('../../core/actionable-request');
const { buildCandidates } = await import('@/services/home/mascot/signals');
const { buildSecondaries, selectSubjects } = await import('@/services/home/mascot/selector');

import type { AccountSuggestionState, SuggestionContext } from '../capability-registry';

const ROOT = join(__dirname, '../../../../..');
const etat = (s: Partial<AccountSuggestionState> = {}): AccountSuggestionState => ({ ...EMPTY_ACCOUNT_STATE, assetsTotal: 2, documentsTotal: 5, ...s });
const ROUTES = ['/', '/accueil', '/accueil/a-traiter', '/assets', '/assets/42', '/documents', '/agenda', '/mon-compte', '/aide', '/fournisseurs'];
const labels = (route: string, ctx: SuggestionContext | null) => suggestionsForRoute(route, ctx).map((s) => s.label);

/** Contexte où TOUTES les préconditions positives sont satisfaites. */
const RICHE: SuggestionContext = {
  state: etat({
    toProcessPending: 3, actionsDueToday: 0, deadlinesSoon: 2, deadlinesUpcoming: 4, documentsInAnalysis: 1, documentsFailed: 1,
    exportsReady: 1, documentsUnlinked: 2,
  }),
  pageAsset: { id: 42, name: 'Cupra', documents: 3, deadlines: 1 },
  accountAsset: { id: 7, name: 'Cupra', documents: 3, deadlines: 1 },
};

describe('L34-SUGG — contrat de chaque suggestion du catalogue unique', () => {
  it('chaque entrée déclare id, libellé, intention T2 CANONIQUE réelle, domaine et (si elle dépend des données) des préconditions', () => {
    const ids = new Set<string>();
    for (const s of ALL_SUGGESTIONS) {
      expect(ids.has(s.id), s.id).toBe(false);
      ids.add(s.id);
      expect(s.label.length, s.id).toBeGreaterThan(5);
      expect(INTENT_DEFINITIONS[s.canonicalIntent], `${s.id} → ${s.canonicalIntent}`).toBeDefined();
      expect(SUGGESTION_DOMAIN_SOURCES[s.domain], s.id).toBeDefined();
      // Domaine compatible avec le contrat de sources de l'intention.
      const attendus = INTENT_DEFINITIONS[s.canonicalIntent].expectedSourceTypes;
      if (s.domain !== 'EXPORTS') {
        expect(SUGGESTION_DOMAIN_SOURCES[s.domain].some((t) => attendus.includes(t as never)), `${s.id} : ${s.domain} / ${attendus}`).toBe(true);
      }
      // Une question qui lit le compte a des préconditions explicites ;
      // seule l'aide produit (et l'offre) peut être proposée sans condition.
      if (s.domain !== 'HELP' && s.domain !== 'PLAN') expect(s.requires?.length ?? 0, s.id).toBeGreaterThan(0);
      if (s.asset) expect(s.requires?.some((r) => r.fact.startsWith('asset.')), s.id).toBe(true);
    }
  });

  it('aucune pseudo-intention (asset_summary, account_next_actions, next_deadline…) dans le code des suggestions', () => {
    for (const f of ['src/services/home/mascot/selector.ts', 'src/services/verebona-assistant/registries/capability-registry.ts', 'src/services/home/mascot/bubble.ts']) {
      const t = readFileSync(join(ROOT, f), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      for (const p of ['asset_summary', 'account_next_actions', "'next_deadline'", 'document_analysis_status', 'help_add_asset', 'help_scope', 'help_analysis']) {
        expect(t.includes(p), `${f} : ${p}`).toBe(false);
      }
      expect(t, f).not.toMatch(/T2_QUESTIONS|Que sais-tu sur/);
    }
  });

  it('chaque libellé rendu est routé, SANS modèle, vers son intention canonique (cliquée → intention attendue)', () => {
    for (const route of ROUTES) {
      for (const s of suggestionsForRoute(route, RICHE)) {
        const o = routeDeterministic({ message: s.label, planType: 'PREMIUM', hasPendingClarification: false, pageContext: { route } } as never);
        expect(o.kind, `${route} « ${s.label} »`).toBe('route');
        if (o.kind === 'route') expect(o.route.intent, `${route} « ${s.label} »`).toBe(s.canonicalIntent);
      }
    }
    // Les questions d'actions sont reconnues par le résolveur du ticket 1.
    expect(analyserDemandeActionnable('Que dois-je faire aujourd’hui ?', '2026-10-09')?.intentResolution).toBe('ACTIONS_TEMPORAL');
    expect(analyserDemandeActionnable('Que dois-je traiter en priorité ?', '2026-10-09')?.intentResolution).toBe('TO_PROCESS_OPEN');
  });

  it('chaque entrée est publiable : préconditions minimales satisfaites → affichée sur sa page (sinon elle serait morte)', () => {
    for (const e of ALL_SUGGESTIONS) {
      const state = etat();
      const bien: { id: number; name: string; documents: number; deadlines: number } = { id: 42, name: 'Cupra', documents: 0, deadlines: 0 };
      for (const r of e.requires ?? []) {
        const v = r.is === 'positive' ? 1 : 0;
        if (r.fact === 'asset.documents') bien.documents = v;
        else if (r.fact === 'asset.deadlines') bien.deadlines = v;
        else (state as unknown as Record<string, number>)[r.fact] = v;
      }
      const route = e.routeExact?.[0] ?? e.routePrefix ?? (e.routePattern ? '/assets/42' : '/fournisseurs');
      const rendues = suggestionsForRoute(route, { state, pageAsset: bien, accountAsset: bien });
      expect(rendues.map((x) => x.id), `${e.id} sur ${route}`).toContain(e.id);
    }
  });
});

describe('L34-SUGG — cas 1 à 6 du ticket', () => {
  it('Cas 1 — bien avec documents : « Quels sont les documents de Cupra ? », jamais « Que sais-tu sur Cupra ? »', () => {
    const fiche = labels('/assets/42', { state: etat(), pageAsset: { id: 42, name: 'Cupra', documents: 2, deadlines: 0 } });
    expect(fiche).toContain('Quels sont les documents de Cupra ?');
    const accueil = labels('/accueil', { state: etat(), accountAsset: { id: 42, name: 'Cupra', documents: 2 } });
    expect(accueil).toContain('Quels sont les documents de Cupra ?');
    for (const r of ROUTES) for (const l of labels(r, RICHE)) expect(l).not.toMatch(/Que sais-tu/);
  });

  it('Cas 2 — bien sans document : aucune question sur ses documents', () => {
    for (const r of ['/assets/42', '/accueil', '/documents']) {
      const l = labels(r, { state: etat(), pageAsset: { id: 42, name: 'Cupra', documents: 0, deadlines: 1 }, accountAsset: { id: 42, name: 'Cupra', documents: 0 } });
      expect(l.some((x) => /documents de Cupra/.test(x)), r).toBe(false);
    }
  });

  it('Cas 3 — À traiter présent (toProcessPending > 0) : « Que dois-je traiter en priorité ? », jamais « Que dois-je faire aujourd’hui ? » sur ce seul critère', () => {
    const l = labels('/accueil', { state: etat({ toProcessPending: 4 }) });
    expect(l).toContain('Que dois-je traiter en priorité ?');
    expect(l).not.toContain('Que dois-je faire aujourd’hui ?');
    const s = suggestionsForRoute('/accueil', { state: etat({ toProcessPending: 4 }) }).find((x) => x.label === 'Que dois-je traiter en priorité ?');
    expect(s?.canonicalIntent).toBe('ACCOUNT_TO_PROCESS');
    // « Que dois-je faire aujourd'hui ? » : seulement si le résolveur trouve
    // des éléments en retard ou dus aujourd'hui — et alors pas les deux.
    const auj = labels('/accueil', { state: etat({ toProcessPending: 4, actionsDueToday: 1 }) });
    expect(auj).toContain('Que dois-je faire aujourd’hui ?');
    expect(auj).not.toContain('Que dois-je traiter en priorité ?');
    // Compteur inconnu (résolveur non évalué) : jamais « aujourd'hui ».
    expect(labels('/accueil', { state: { ...etat({ toProcessPending: 1 }), actionsDueToday: undefined } })).not.toContain('Que dois-je faire aujourd’hui ?');
  });

  it('Cas 4 — aucune échéance : ni « Quelle est ma prochaine échéance ? » ni « Quelles échéances arrivent bientôt ? » ni « prochaines échéances de X »', () => {
    const sans: SuggestionContext = { state: etat({ deadlinesSoon: 0, deadlinesUpcoming: 0 }), pageAsset: { id: 1, name: 'Cupra', documents: 1, deadlines: 0 }, accountAsset: { id: 1, name: 'Cupra', documents: 1, deadlines: 0 } };
    for (const r of ROUTES) {
      for (const l of labels(r, sans)) expect(l, r).not.toMatch(/prochaine échéance|échéances arrivent|prochaines échéances/);
    }
    expect(labels('/accueil', { state: etat({ deadlinesUpcoming: 1 }) })).toContain('Quelle est ma prochaine échéance ?');
  });

  it('Cas 5 — « Où en est l’analyse de mes documents ? » uniquement si documentsInAnalysis > 0', () => {
    expect(labels('/accueil', { state: etat({ documentsInAnalysis: 0 }) })).not.toContain('Où en est l’analyse de mes documents ?');
    expect(labels('/accueil', { state: etat({ documentsInAnalysis: 2 }) })).toContain('Où en est l’analyse de mes documents ?');
    expect(labels('/documents', { state: etat({ documentsInAnalysis: 0 }) })).not.toContain('Pourquoi un document est-il encore en analyse ?');
  });

  it('Cas 6 — aucune donnée exploitable : moins de 3 suggestions, aucune fabriquée', () => {
    const rien: SuggestionContext = { state: etat() };
    expect(suggestionsForRoute('/accueil', rien)).toEqual([]);
    expect(suggestionsForRoute('/agenda', rien).map((s) => s.id)).toEqual(['agenda_sync']);
    for (const r of ROUTES) {
      const l = suggestionsForRoute(r, rien);
      expect(l.length, r).toBeLessThanOrEqual(MAX_SUGGESTIONS);
      for (const s of l) expect(['HELP', 'PLAN'], `${r} ${s.id}`).toContain(s.domain);
    }
  });

  it('préconditions : `positive`, `zero`, `notPositive` ; inconnu ≠ zéro', () => {
    const e = { id: 'x', label: 'x', canonicalIntent: 'ACCOUNT_TO_PROCESS' as const, domain: 'TO_PROCESS' as const, priority: 1 };
    expect(requirementsMet({ ...e, requires: [{ fact: 'toProcessPending', is: 'positive' }] }, null)).toBe(false);
    expect(requirementsMet({ ...e, requires: [{ fact: 'assetsTotal', is: 'zero' }] }, { state: { ...etat(), assetsTotal: undefined } })).toBe(false);
    expect(requirementsMet({ ...e, requires: [{ fact: 'actionsDueToday', is: 'notPositive' }] }, { state: { ...etat(), actionsDueToday: undefined } })).toBe(true);
    expect(requirementsMet(e, null)).toBe(true);
  });
});

describe('L34-SUGG — mascotte : même catalogue, mêmes règles', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    accountId: 7, today: '2026-10-09', processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 1, name: 'Cupra' }], activeAssetCount: 1, documentCount: 3 },
    toProcess: [], agenda: [], acknowledgments: [], ...over,
  });
  it('les questions de la mascotte sont exactement celles du catalogue (libellé, intention canonique, bien)', () => {
    const ctx: SuggestionContext = { state: etat({ toProcessPending: 1, documentsInAnalysis: 1 }), accountAsset: { id: 1, name: 'Cupra', documents: 3 } };
    const catalogue = suggestionsForRoute('/accueil', ctx);
    const c = buildCandidates(raw() as never);
    const sec = buildSecondaries(c, selectSubjects(c.candidates), catalogue).filter((s) => s.kind === 'question');
    expect(sec.map((s) => s.action.label)).toEqual(catalogue.map((s) => s.label));
    expect(sec.map((s) => (s.action.target as { context: { intent: string } }).context.intent)).toEqual(catalogue.map((s) => s.canonicalIntent));
    for (const s of sec) expect(INTENT_DEFINITIONS[(s.action.target as { context: { intent: string } }).context.intent as never]).toBeDefined();
  });
  it('sans catalogue (indisponible) : aucune question, jamais une question non garantie', () => {
    const c = buildCandidates(raw({ toProcess: null }) as never);
    expect(buildSecondaries(c, selectSubjects(c.candidates)).filter((s) => s.kind === 'question')).toEqual([]);
  });
  it('le service de la mascotte lit le catalogue unique de l’accueil', () => {
    const t = readFileSync(join(ROOT, 'src/services/home/mascot/mascot.service.ts'), 'utf8');
    expect(t).toMatch(/suggestionsForRoute\('\/accueil', ctx\)/);
    expect(t).toMatch(/buildSecondaries\(candidates, subjects, await homeCatalogQuestions\(accountId\)\)/);
  });
});
