/**
 * Lot 114S — carte #773 « Assistant Verebona — Retirer les 7 suggestions
 * rejetées (catalogue actif et historique) ».
 *
 * Décision PO du 13/11/2026 : sur 40 formulations, 33 sont conservées et 7
 * sont retirées de TOUTES les sources de suggestions (catalogue par page,
 * suggestions d'état du compte, stock partagé, sélection, réserve, repli) :
 *
 *   n° 04  « Combien ai-je dépensé en {annee} ? »          home_year_spend
 *   n° 27  « Que dois-je faire aujourd’hui ? »              home_today
 *   n° 29  « Où en est l’analyse de mes documents ? »       home_analysis
 *   n° 30  « Quels sont les documents {de_bien} ? »         home_asset_docs, asset_docs, docs_asset
 *   n° 33  « Comment arbitrer entre deux valeurs ? »        todo_arbitrate
 *   n° 37  « Que comprend mon offre ? »                     account_plan
 *   n° 39  « Pourquoi un document est-il en erreur ? »      state_failed
 *
 *   U01  absence : aucun identifiant ni libellé retiré dans les catalogues et le stock ;
 *   U02  aucun contexte (compte riche, pauvre, vide, sans contexte) ne les rend,
 *        sur aucune page ; ni la sélection, ni la réserve, ni le repli ;
 *   U03  les 33 conservées : 25 actives (6 du stock + 19 du guide) et 8
 *        historiques, à l'identique (conditions comprises), sans promotion ;
 *   U04  paires à ne pas confondre (27/28, 29/35, 30/34, 39/35) ;
 *   U05  version du stock changée (anciennes sélections invalidées) ;
 *   U06  une question retirée, posée LIBREMENT, reste routée par T2 (aucune
 *        interdiction lexicale) ; un ancien clic n'a plus aucun privilège ;
 *   U07  aucune référence morte (compteurs, gabarit, domaines) ni libellé
 *        retiré dans le code des suggestions et de l'interface.
 *
 * Aucun test ne dépend de la date du jour.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, ensureMigrations: vi.fn(async () => {}) }));

import {
  ACCOUNT_STATE_SUGGESTIONS, ALL_SUGGESTIONS, EMPTY_ACCOUNT_STATE, SUGGESTIONS, SUGGESTION_DOMAIN_SOURCES,
  renderSuggestionEntry, suggestionsForRoute,
  type AccountSuggestionState, type SuggestionAsset, type SuggestionContext,
} from '@/services/verebona-assistant/registries/capability-registry';
import { routeDeterministic } from '@/services/verebona-assistant/core/intent-router.service';
import { analyserDemandeActionnable } from '@/services/verebona-assistant/core/actionable-request';
import { ACTIONS_DUE_TODAY_PROBE } from '@/services/verebona-assistant/core/account-state';
import { fallbackSuggestions } from '@/lib/suggestions/shared-suggestions';
import { ACCOUNT_STOCK, GUIDE_STOCK, SAFE_FALLBACK_GUIDE_IDS, accountSuggestionId } from '../stock';
import { selectSharedSuggestions } from '../select';
import { STOCK_VERSION, resolveSuggestionForMessage, reviewAccountCandidates } from '../service';
import { withExploitFacts } from '../exploit-facts';

const ROOT = process.cwd();

/** Les 7 décisions PO : identifiants retirés, libellé (gabarit) et forme rendue. */
const RETIREES: ReadonlyArray<{ po: string; ids: readonly string[]; gabarit: string; rendu: RegExp; libre: string; intention: string }> = [
  { po: '04', ids: ['home_year_spend'], gabarit: 'Combien ai-je dépensé en {annee} ?', rendu: /^Combien ai-je dépensé en \d{4} \?$/, libre: 'Combien ai-je dépensé en 2026 ?', intention: 'ACCOUNT_FACT_ASSET' },
  { po: '27', ids: ['home_today'], gabarit: 'Que dois-je faire aujourd’hui ?', rendu: /^Que dois-je faire aujourd[’']hui \?$/, libre: 'Que dois-je faire aujourd’hui ?', intention: 'ACCOUNT_TO_PROCESS' },
  { po: '29', ids: ['home_analysis'], gabarit: 'Où en est l’analyse de mes documents ?', rendu: /^Où en est l[’']analyse de mes documents \?$/, libre: 'Où en est l’analyse de mes documents ?', intention: 'ACCOUNT_FACT_DOCUMENT' },
  { po: '30', ids: ['home_asset_docs', 'asset_docs', 'docs_asset'], gabarit: 'Quels sont les documents {de_bien} ?', rendu: /^Quels sont les documents (de |d[’'])/, libre: 'Quels sont les documents de Cupra ?', intention: 'ACCOUNT_SEARCH_DOCUMENT' },
  { po: '33', ids: ['todo_arbitrate'], gabarit: 'Comment arbitrer entre deux valeurs ?', rendu: /^Comment arbitrer entre deux valeurs \?$/, libre: 'Comment arbitrer entre deux valeurs ?', intention: 'PRODUCT_HELP_HOW_TO' },
  { po: '37', ids: ['account_plan'], gabarit: 'Que comprend mon offre ?', rendu: /^Que comprend mon offre \?$/, libre: 'Que comprend mon offre ?', intention: 'PRODUCT_PLAN_LIMIT' },
  { po: '39', ids: ['state_failed'], gabarit: 'Pourquoi un document est-il en erreur ?', rendu: /^Pourquoi un document est-il en erreur \?$/, libre: 'Pourquoi un document est-il en erreur ?', intention: 'PRODUCT_HELP_STATUS' },
];
const IDS_RETIRES = RETIREES.flatMap((r) => r.ids);
const estRetire = (label: string) => RETIREES.some((r) => r.rendu.test(label));

const ROUTES = ['/', '/accueil', '/accueil/a-traiter', '/assets', '/assets/42', '/assets/42/documents', '/documents', '/agenda', '/mon-compte', '/aide', '/fournisseurs', '/page-inconnue'];
const etat = (o: Partial<AccountSuggestionState> = {}): AccountSuggestionState => ({ ...EMPTY_ACCOUNT_STATE, assetsTotal: 2, documentsTotal: 12, ...o });
const bien = (id: number, name: string, f: Partial<SuggestionAsset> = {}): SuggestionAsset => ({ id, name, documents: 6, deadlines: 1, ...f });

/** Compte RICHE : tout ce qui rendait autrefois les 7 formulations est présent. */
const prouve = bien(7, 'Cupra', { spend: 42000, maintenanceSpend: 42000, warrantyUpcoming: 1, lastService: 1 });
const RICHE: SuggestionContext = {
  state: etat({ toProcessPending: 3, actionsDueToday: 2, deadlinesSoon: 2, deadlinesUpcoming: 4, documentsInAnalysis: 2, exportsReady: 1, documentsUnlinked: 2, ownershipCostAvailable: 1 }),
  pageAsset: bien(42, 'Cupra'), accountAsset: bien(7, 'Cupra'), provenAssets: [prouve],
};
/**
 * Même compte, avec les ANCIENS compteurs que le code ne lit plus (total
 * annuel positif, documents en erreur, année) : un client ou un cache ancien
 * qui les fournirait encore ne fait rien ressortir.
 */
const RICHE_ANCIEN = {
  ...RICHE, year: 2026,
  state: { ...RICHE.state!, yearSpend: 42000, documentsFailed: 3 },
} as SuggestionContext;
const RICHE_SANS_RETARD: SuggestionContext = { ...RICHE, state: { ...RICHE.state!, actionsDueToday: 0 } };
const PAUVRE: SuggestionContext = { state: etat({ assetsTotal: 1, documentsTotal: 1 }), accountAsset: bien(7, 'Cupra', { documents: 1, deadlines: 0 }), pageAsset: bien(42, 'Cupra', { documents: 1, deadlines: 0 }) };
const VIDE: SuggestionContext = { state: EMPTY_ACCOUNT_STATE };
const CONTEXTES: Array<[string, SuggestionContext | null | undefined]> = [
  ['riche', RICHE], ['riche (anciens compteurs)', RICHE_ANCIEN], ['riche sans retard', RICHE_SANS_RETARD], ['pauvre', PAUVRE], ['vide', VIDE], ['état illisible', { state: null }], ['sans contexte', null], ['non fourni', undefined],
];

describe('L114S-U01 — les 7 formulations retirées sont absentes de tous les catalogues et du stock', () => {
  it.each(RETIREES.map((r) => [r.po, r] as const))('décision PO n° %s : ni identifiant ni libellé', (_po, r) => {
    for (const [nom, liste] of [['SUGGESTIONS', SUGGESTIONS], ['ACCOUNT_STATE_SUGGESTIONS', ACCOUNT_STATE_SUGGESTIONS], ['ALL_SUGGESTIONS', ALL_SUGGESTIONS]] as const) {
      for (const e of liste) {
        expect(r.ids, `${nom} ${e.id}`).not.toContain(e.id);
        expect(e.label, `${nom} ${e.id}`).not.toBe(r.gabarit);
      }
    }
    for (const id of r.ids) {
      expect(ACCOUNT_STOCK.some((e) => e.catalogId === id), id).toBe(false);
      expect(GUIDE_STOCK.some((e) => e.id === id || e.id === accountSuggestionId(id)), id).toBe(false);
    }
    expect(GUIDE_STOCK.some((e) => e.label === r.gabarit || r.rendu.test(e.label))).toBe(false);
  });

  it('plus aucun gabarit `{annee}` ; plus aucun sujet propre aux entrées retirées', () => {
    for (const e of ALL_SUGGESTIONS) {
      expect(e.label, e.id).not.toContain('{annee}');
      expect(['year-spend', 'asset-docs', 'failed'], e.id).not.toContain(e.topic ?? e.id);
    }
  });

  it('toute entrée du stock désigne une entrée EXISTANTE du catalogue (aucune référence orpheline)', () => {
    for (const e of ACCOUNT_STOCK) expect(ALL_SUGGESTIONS.some((s) => s.id === e.catalogId), e.catalogId).toBe(true);
    for (const id of SAFE_FALLBACK_GUIDE_IDS) expect(GUIDE_STOCK.some((e) => e.id === id), id).toBe(true);
  });
});

describe('L114S-U02 — aucun contexte, aucune page, aucune sélection ne les fait ressortir', () => {
  it.each(CONTEXTES)('catalogue par page (`suggestionsForRoute`, anciens appelants) — compte %s', (_nom, ctx) => {
    for (const route of ROUTES) {
      const l = suggestionsForRoute(route, ctx);
      expect(l.length, route).toBeLessThanOrEqual(3);
      for (const s of l) {
        expect(IDS_RETIRES, `${route} ${s.id}`).not.toContain(s.id);
        expect(estRetire(s.label), `${route} « ${s.label} »`).toBe(false);
        expect(s.label, route).not.toMatch(/[{}]/);
      }
    }
  });

  it.each(CONTEXTES)('rendu direct d’un identifiant retiré : toujours `null` — compte %s', (_nom, ctx) => {
    for (const id of IDS_RETIRES) expect(renderSuggestionEntry(id, ctx ?? null), id).toBeNull();
  });

  it.each(CONTEXTES.filter(([, c]) => c?.state))('stock partagé : ni promue, ni « répondable non promue » (diagnostic BO) — compte %s', (_nom, ctx) => {
    const r = reviewAccountCandidates(ctx ?? null);
    for (const x of r.accepted) {
      expect(IDS_RETIRES, x.catalogId).not.toContain(x.catalogId);
      expect(estRetire(x.label), x.label).toBe(false);
    }
    for (const x of r.rejected) expect(IDS_RETIRES.map(accountSuggestionId), x.id).not.toContain(x.id);
  });

  it('CA02 — total annuel positif et qualifié : aucune question annuelle, aucune suggestion de remplacement', () => {
    const avec = reviewAccountCandidates(RICHE_ANCIEN).accepted.map((x) => x.catalogId).sort();
    const sans = reviewAccountCandidates(RICHE).accepted.map((x) => x.catalogId).sort();
    expect(avec).toEqual(sans);
    // Exactement les questions personnelles qui existaient déjà, moins la question annuelle : rien de nouveau.
    expect(avec).toEqual(['assets_deadlines', 'home_asset_last_service', 'home_asset_maintenance_spend', 'home_asset_ownership_cost', 'home_asset_warranty_end', 'home_next_deadline']);
  });

  it('sélection servie ET réserve (items, rotation) : aucune formulation retirée, 3 au plus', () => {
    const account = reviewAccountCandidates(RICHE_ANCIEN).accepted;
    for (const bucket of [1, 2, 3, 4, 5, 6]) {
      for (const consulted of [new Set<string>(), new Set(account.map((a) => accountSuggestionId(a.catalogId)))]) {
        const sel = selectSharedSuggestions({ stage: 'ESTABLISHED', account, guide: [], consulted, seed: 7, bucket, max: 3, fingerprint: 'l114s', now: new Date('2026-11-13T10:00:00Z') });
        expect(sel.items.length).toBeLessThanOrEqual(3);
        for (const x of [...sel.items, ...sel.reserve]) {
          expect(IDS_RETIRES.map(accountSuggestionId), x.id).not.toContain(x.id);
          expect(estRetire(x.label), x.label).toBe(false);
        }
      }
    }
  });

  it('repli sûr du navigateur : questions du guide seulement, aucune formulation retirée', () => {
    const repli = fallbackSuggestions();
    expect(repli.map((x) => x.id)).toEqual([...SAFE_FALLBACK_GUIDE_IDS]);
    for (const x of repli) expect(estRetire(x.label), x.label).toBe(false);
  });
});

describe('L114S-U03 — les 33 formulations conservées le sont à l’identique', () => {
  it('25 actives : 6 questions personnelles du stock (mêmes objectif, priorité, besoin) + 19 questions du guide', () => {
    expect(ACCOUNT_STOCK.filter((e) => e.need !== 'INVENTORY').map((e) => [e.catalogId, e.objective, e.priority, e.need])).toEqual([
      ['assets_deadlines', 'ANTICIPATE', 1, 'ANTICIPATION'],
      ['home_next_deadline', 'ANTICIPATE', 2, 'FACT'],
      ['home_asset_ownership_cost', 'EXPLOIT', 1, 'FACT'],
      ['home_asset_warranty_end', 'EXPLOIT', 2, 'FACT'],
      ['home_asset_maintenance_spend', 'EXPLOIT', 3, 'FACT'],
      ['home_asset_last_service', 'EXPLOIT', 5, 'FACT'],
    ]);
    expect(GUIDE_STOCK).toHaveLength(19);
    expect(new Set(GUIDE_STOCK.map((e) => e.id)).size).toBe(19);
    expect(GUIDE_STOCK.map((e) => e.id)).toEqual([
      'guide_add_asset', 'guide_add_document', 'guide_document_analysis', 'guide_home_page', 'guide_ask_verebona',
      'guide_agenda_sync', 'guide_detected_deadlines', 'guide_complete_asset', 'guide_prepare_dossier', 'guide_transfer_asset',
      'res_works_invoices', 'res_boiler_service', 'res_house_documents', 'res_technical_inspection', 'res_car_service', 'res_ebike_service',
      'res_invoice_retention', 'res_appliance_warranty', 'res_home_inventory',
    ]);
  });

  it('les 6 questions personnelles actives gardent libellé, intention et préconditions', () => {
    const fiche = (id: string) => {
      const e = ALL_SUGGESTIONS.find((x) => x.id === id)!;
      return [e.label, e.canonicalIntent, e.asset ?? null, (e.requires ?? []).map((r) => `${r.fact}:${r.is}`)];
    };
    expect(fiche('assets_deadlines')).toEqual(['Quelles sont les prochaines échéances {de_bien} ?', 'ACCOUNT_SEARCH_AGENDA', 'account', ['asset.deadlines:positive']]);
    expect(fiche('home_next_deadline')).toEqual(['Quelle est ma prochaine échéance ?', 'ACCOUNT_SEARCH_AGENDA', null, ['deadlinesUpcoming:positive']]);
    expect(fiche('home_asset_ownership_cost')).toEqual(['Quel est le coût de possession {de_bien} ?', 'ACCOUNT_FACT_ASSET', 'proven', ['ownershipCostAvailable:positive', 'asset.spend:positive']]);
    expect(fiche('home_asset_warranty_end')).toEqual(['Quelle est la date de fin de garantie {de_bien} ?', 'ACCOUNT_FACT_DOCUMENT', 'proven', ['asset.warrantyUpcoming:positive']]);
    expect(fiche('home_asset_maintenance_spend')).toEqual(['Combien ai-je dépensé en entretien pour {bien} ?', 'ACCOUNT_FACT_ASSET', 'proven', ['asset.maintenanceSpend:positive']]);
    expect(fiche('home_asset_last_service')).toEqual(['Quelle est la date du dernier entretien {de_bien} ?', 'ACCOUNT_FACT_ASSET', 'proven', ['asset.lastService:positive']]);
  });

  /** Les 8 historiques conservés (décisions PO 28, 31, 32, 34, 35, 36, 38, 40) : entrées et conditions d'avant la carte. */
  const HISTORIQUES: ReadonlyArray<[string, string, ReadonlyArray<[string, string[]]>]> = [
    ['28', 'Que dois-je traiter en priorité ?', [['home_todo_priority', ['toProcessPending:positive', 'actionsDueToday:notPositive']], ['todo_priority', ['toProcessPending:positive']], ['state_todo', ['toProcessPending:positive']]]],
    ['31', 'L’analyse automatique, c’est quoi ?', [['home_analysis_help', ['documentsTotal:zero']]]],
    ['32', 'Comment fonctionne la page « À traiter » ?', [['todo_explain', []]]],
    ['34', 'Quels documents ne sont rattachés à aucun bien ?', [['docs_unlinked', ['documentsUnlinked:positive']]]],
    ['35', 'Pourquoi un document est-il encore en analyse ?', [['docs_in_analysis', ['documentsInAnalysis:positive']], ['state_analysis', ['documentsInAnalysis:positive']]]],
    ['36', 'Quelles échéances arrivent bientôt ?', [['agenda_next', ['deadlinesSoon:positive']], ['state_deadlines', ['deadlinesSoon:positive']]]],
    ['38', 'Comment gérer mes notifications ?', [['account_notif', []]]],
    ['40', 'Quels exports sont disponibles ?', [['state_exports', ['exportsReady:positive']]]],
  ];
  it.each(HISTORIQUES)('historique conservé n° %s « %s » : mêmes entrées, mêmes préconditions', (_po, label, entrees) => {
    const trouvees = ALL_SUGGESTIONS.filter((e) => e.label === label).map((e) => [e.id, (e.requires ?? []).map((r) => `${r.fact}:${r.is}`)]);
    expect(trouvees).toEqual(entrees.map(([id, req]) => [id, req]));
  });

  it('aucune promotion nouvelle : seules `docs_unlinked` et `state_exports` restent dans le stock sans être promues (lot 111L) ; les autres historiques n’y entrent pas', () => {
    expect(ACCOUNT_STOCK.filter((e) => e.need === 'INVENTORY').map((e) => e.catalogId)).toEqual(['docs_unlinked', 'state_exports']);
    expect(ACCOUNT_STOCK).toHaveLength(8);
    const r = reviewAccountCandidates(RICHE);
    expect(r.rejected).toEqual([{ id: 'acc_docs_unlinked', decision: 'INVENTORY_DECLARED' }, { id: 'acc_state_exports', decision: 'INVENTORY_DECLARED' }]);
    const historiques = HISTORIQUES.flatMap(([, , e]) => e.map(([id]) => id));
    for (const x of r.accepted) expect(historiques, x.catalogId).not.toContain(x.catalogId);
  });

  it('le catalogue compte exactement 9 entrées de moins (33 → 25 par page, 5 → 4 d’état, 38 → 29 au total)', () => {
    expect(SUGGESTIONS).toHaveLength(25);
    expect(ACCOUNT_STATE_SUGGESTIONS).toHaveLength(4);
    expect(ALL_SUGGESTIONS).toHaveLength(29);
    expect(new Set(ALL_SUGGESTIONS.map((e) => e.id)).size).toBe(29);
  });
});

describe('L114S-U04 — paires à ne pas confondre (CA04)', () => {
  const labels = (route: string, ctx: SuggestionContext) => suggestionsForRoute(route, ctx).map((s) => s.label);
  it('n° 27 / 28 : « aujourd’hui » retirée ; « traiter en priorité » garde sa condition (À traiter présent, rien en retard ni dû aujourd’hui)', () => {
    expect(labels('/accueil', { state: etat({ toProcessPending: 2, actionsDueToday: 0 }) })).toContain('Que dois-je traiter en priorité ?');
    // Éléments dus aujourd'hui : l'entrée d'accueil reste absente (condition inchangée) ; la question n° 28 est
    // alors rendue par l'entrée d'état `state_todo` (même libellé), que le sujet de `home_today` masquait.
    expect(suggestionsForRoute('/accueil', { state: etat({ toProcessPending: 2, actionsDueToday: 1 }) }).map((s) => s.id)).toEqual(['state_todo']);
    expect(labels('/accueil/a-traiter', { state: etat({ toProcessPending: 2, actionsDueToday: 1 }) })[0]).toBe('Que dois-je traiter en priorité ?');
    // Le compteur reste calculé avec la même demande type, reconnue par le résolveur des demandes d'actions.
    expect(analyserDemandeActionnable(ACTIONS_DUE_TODAY_PROBE, '2026-10-09')?.intentResolution).toBe('ACTIONS_TEMPORAL');
  });
  it('n° 29 / 35 : « Où en est l’analyse… » retirée ; « Pourquoi un document est-il encore en analyse ? » conservée sous sa précondition', () => {
    expect(labels('/documents', { state: etat({ documentsInAnalysis: 1 }) })).toContain('Pourquoi un document est-il encore en analyse ?');
    expect(labels('/documents', { state: etat({ documentsInAnalysis: 0 }) })).not.toContain('Pourquoi un document est-il encore en analyse ?');
    expect(labels('/agenda', { state: etat({ documentsInAnalysis: 1 }) })).toContain('Pourquoi un document est-il encore en analyse ?');
  });
  it('n° 30 / 34 : « Quels sont les documents de <bien> ? » retirée ; « Quels documents ne sont rattachés à aucun bien ? » conservée sous sa précondition', () => {
    expect(labels('/documents', { state: etat({ documentsUnlinked: 2 }), accountAsset: bien(7, 'Cupra') })[0]).toBe('Quels documents ne sont rattachés à aucun bien ?');
    expect(labels('/documents', { state: etat({ documentsUnlinked: 0 }), accountAsset: bien(7, 'Cupra') })).not.toContain('Quels documents ne sont rattachés à aucun bien ?');
  });
  it('n° 39 / 35 : « …en erreur ? » retirée ; « …encore en analyse ? » inchangée, même si des documents sont en erreur', () => {
    const ancien = { state: { ...etat({ documentsInAnalysis: 1 }), documentsFailed: 4 } } as SuggestionContext;
    const l = labels('/agenda', ancien);
    expect(l).not.toContain('Pourquoi un document est-il en erreur ?');
    expect(l).toContain('Pourquoi un document est-il encore en analyse ?');
  });
});

describe('L114S-U05 — version du catalogue : les sélections d’avant la carte sont invalidées', () => {
  it('`STOCK_VERSION` diffère de la version livrée avant la carte #773 (lot114-02)', () => {
    // Empreinte relevée sur l'état livré `lot114-02`, avant le retrait.
    expect(STOCK_VERSION).not.toBe('7523f7a3be3a');
    expect(STOCK_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('L114S-U06 — question retirée posée librement : toujours comprise par T2 ; ancien clic : aucun privilège', () => {
  it.each(RETIREES.map((r) => [r.libre, r] as const))('« %s » saisie librement : routée sans modèle, aucune interdiction lexicale', (_l, r) => {
    const o = routeDeterministic({ message: r.libre, planType: 'PREMIUM', hasPendingClarification: false, pageContext: { route: '/accueil' } } as never);
    expect(o.kind, r.libre).toBe('route');
    if (o.kind === 'route') expect(o.route.intent, r.libre).toBe(r.intention);
  });

  it.each(IDS_RETIRES.flatMap((id) => [id, accountSuggestionId(id)]))('ancien identifiant « %s » envoyé par un onglet resté ouvert : question LIBRE (ni revalidée, ni enregistrée)', async (id) => {
    for (const r of RETIREES) expect(await resolveSuggestionForMessage(1, 1, id, r.libre, '7523f7a3be3a')).toBeNull();
  });
});

describe('L114S-U07 — aucune référence morte, aucun libellé retiré dans le code', () => {
  const sansCommentaires = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

  it('catalogue, stock, service et faits : ni identifiant retiré, ni compteur ou gabarit orphelin', () => {
    for (const f of [
      'src/services/verebona-assistant/registries/capability-registry.ts', 'src/services/suggestions/shared/stock.ts',
      'src/services/suggestions/shared/service.ts', 'src/services/suggestions/shared/exploit-facts.ts',
      'src/services/suggestions/shared/select.ts', 'src/services/suggestions/shared/utility.ts',
      'src/services/verebona-assistant/core/account-state.ts', 'src/lib/suggestions/shared-suggestions.ts',
      'src/app/api/suggestions/route.ts', 'src/app/api/verebona/suggestions/route.ts',
    ]) {
      const t = sansCommentaires(f);
      for (const id of IDS_RETIRES) expect(t, `${f} : ${id}`).not.toMatch(new RegExp(`['"\`]${id}['"\`]`));
      expect(t, f).not.toMatch(/yearSpend|screenYear|\{annee\}|documentsFailed|ANALYSIS_FAILED/);
    }
  });

  it('domaines de réponse : plus de domaine orphelin (ACTIONS, DOCUMENT_STATUS, PLAN) ; chaque domaine déclaré est utilisé', () => {
    const utilises = new Set(ALL_SUGGESTIONS.map((e) => e.domain));
    expect(Object.keys(SUGGESTION_DOMAIN_SOURCES).sort()).toEqual([...utilises].sort());
    for (const d of ['ACTIONS', 'DOCUMENT_STATUS', 'PLAN']) expect(Object.keys(SUGGESTION_DOMAIN_SOURCES)).not.toContain(d);
  });

  it('le contexte des suggestions ne porte plus ni total annuel ni année', () => {
    const c = withExploitFacts({ state: etat() }, { provenAssets: [prouve], premium: true });
    expect(c.state).not.toHaveProperty('yearSpend');
    expect(c).not.toHaveProperty('year');
    expect(EMPTY_ACCOUNT_STATE).not.toHaveProperty('documentsFailed');
  });

  it('aucun libellé retiré dans le code des catalogues ni de l’interface (composants, pages, magasin navigateur)', () => {
    const fichiers: string[] = [
      'src/services/verebona-assistant/registries/capability-registry.ts', 'src/services/suggestions/shared/stock.ts',
      'src/services/suggestions/shared/resource-questions.ts', 'src/lib/suggestions/shared-suggestions.ts',
    ];
    const parcourir = (d: string) => {
      for (const f of readdirSync(join(ROOT, d))) {
        const p = `${d}/${f}`;
        if (f === '__tests__' || f === 'node_modules') continue;
        if (statSync(join(ROOT, p)).isDirectory()) parcourir(p);
        else if (/\.tsx?$/.test(f)) fichiers.push(p);
      }
    };
    parcourir('src/components');
    parcourir('src/app/(dashboard)');
    parcourir('src/app/api/suggestions');
    parcourir('src/app/api/verebona/suggestions');
    expect(fichiers.length).toBeGreaterThan(50);
    const litteraux = ['Combien ai-je dépensé en {annee}', 'Que dois-je faire aujourd', 'Où en est l’analyse de mes documents', 'Quels sont les documents {de_bien}', 'Comment arbitrer entre deux valeurs', 'Que comprend mon offre', 'Pourquoi un document est-il en erreur'];
    for (const f of fichiers) {
      const t = sansCommentaires(f);
      for (const l of litteraux) expect(t.includes(l), `${f} : « ${l} »`).toBe(false);
    }
  });
});
