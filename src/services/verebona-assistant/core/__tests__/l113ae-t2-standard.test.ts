/**
 * Lot 113AE — Trello #728 : Standard actif = T2 complet, SANS ouvrir les
 * droits Premium métier. Trois droits distincts côté serveur :
 *   · T2 cognitif (registre) ; · autorisation effective d'appel modèle
 *   (prédicat unique `ai-access.ts`) ; · droit Premium métier (`premiumFeatures`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));
const ent = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/services/entitlements.service', () => ({
  getEntitlements: vi.fn(async () => ent.value),
  restrictedRefusal: vi.fn(async () => ({ code: 'TRIAL_EXPIRED', message: 'Votre essai est terminé.' })),
}));

const { capabilitiesForPlan, capabilityAllows, isAiEligibleFor, isT2CognitivePlan } = await import('../../registries/capability-registry');
const { resolveActions, offrePermet } = await import('../action-resolver.service');
const { tryDeterministic } = await import('../deterministic-answer.service');
const ai = await import('../ai-access');
const { defaultCanWrite } = await import('../../commands/plan.service');
const { GUIDE_STOCK } = await import('@/services/suggestions/shared/stock');
const { guideCandidatesOf } = await import('@/services/suggestions/shared/service');
const { parseHelpCorpus } = await import('../help-corpus.service');
const { asHelpSearchCorpus, parseResourcesCorpus } = await import('../resources-corpus.service');
const { resetAssistantConfigForTests } = await import('../../config/assistant-config');

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

afterEach(() => {
  delete process.env.VEREBONA_ASSISTANT_AI_ENABLED;
  delete process.env.VEREBONA_ASSISTANT_ACCOUNT_AI;
  resetAssistantConfigForTests();
});

const E = (o: Record<string, unknown> = {}) => ({ plan: 'standard', status: 'active', premiumFeatures: false, canWrite: true, canRead: true, isRestricted: false, ...o }) as never;

describe('A1 — registre : T2 cognitif identique pour toutes les offres actives', () => {
  it('account_ai (synthèse, comparaison, chronologie) ouvert à Standard comme à Premium', () => {
    for (const intent of ['ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE'] as const) {
      for (const plan of ['STANDARD', 'PREMIUM', 'PREMIUM_DUO']) {
        expect(capabilityAllows(intent, plan)).toBe(true);
        expect(isAiEligibleFor(intent, plan, true)).toBe(true);
      }
    }
    expect(isT2CognitivePlan('STANDARD')).toBe(true);
    expect(capabilitiesForPlan('STANDARD').open.map((c) => c.code).sort()).toEqual(capabilitiesForPlan('PREMIUM').open.map((c) => c.code).sort());
  });
  it('capacités futures toujours FERMÉES (voix, photo, sémantique expérimentale)', () => {
    for (const plan of ['STANDARD', 'PREMIUM']) {
      const fermees = capabilitiesForPlan(plan).closed.map((c) => c.code);
      expect(fermees).toEqual(expect.arrayContaining(['semantic_retrieval', 'voice_io', 'photo_search', 'proactive_notifications']));
    }
  });
  it('flag account_ai coupé : capacité fermée pour TOUTES les offres', () => {
    process.env.VEREBONA_ASSISTANT_ACCOUNT_AI = 'off';
    expect(capabilityAllows('ACCOUNT_SUMMARY', 'STANDARD')).toBe(false);
    expect(capabilityAllows('ACCOUNT_SUMMARY', 'PREMIUM')).toBe(false);
  });
});

describe('A2 — prédicat unique d’autorisation effective', () => {
  it('Standard actif OUI, essai actif OUI ; readonly / past_due / canceled / none NON ; canRead=false NON', () => {
    expect(ai.assistantAiAccessFromEntitlements(E()).modelCalls).toBe(true);
    expect(ai.assistantAiAccessFromEntitlements(E({ plan: 'trial', status: 'trialing', premiumFeatures: true })).modelCalls).toBe(true);
    for (const status of ['readonly', 'past_due', 'canceled', 'none']) {
      expect(ai.assistantAiAccessFromEntitlements(E({ plan: 'none', status, canWrite: false, isRestricted: true })).modelCalls).toBe(false);
    }
    expect(ai.assistantAiAccessFromEntitlements(E({ plan: 'none', status: 'none', canRead: false, canWrite: false, isRestricted: true })).denial).toBe('NO_ACCESS');
  });
  it('flags du §39 : IA coupée → aucun appel, quel que soit le compte', () => {
    const standard = { planType: 'STANDARD', aiAccess: ai.assistantAiAccessFromEntitlements(E()) };
    expect(ai.isAssistantModelCallAllowed(standard)).toBe(true);
    process.env.VEREBONA_ASSISTANT_AI_ENABLED = 'false';
    resetAssistantConfigForTests();
    expect(ai.isAssistantModelCallAllowed(standard)).toBe(false);
  });
  it('trace : offre commerciale RÉELLE (jamais PREMIUM pour Standard)', () => {
    const t = ai.accessTraceOf({ planType: 'STANDARD', aiAccess: ai.assistantAiAccessFromEntitlements(E()) });
    expect(t).toEqual({ commercialPlan: 'standard', status: 'active', modelCalls: true, denial: null, premiumFeatures: false, source: 'entitlements' });
  });
  it('limite de compte expliquée indépendamment de l’offre cognitive', () => {
    expect(ai.accountLimitOf({ planType: 'STANDARD', aiAccess: ai.assistantAiAccessFromEntitlements(E()) })).toBeNull();
    expect(ai.accountLimitOf({ planType: 'STANDARD', aiAccess: ai.assistantAiAccessFromEntitlements(E({ plan: 'none', status: 'readonly', canWrite: false, isRestricted: true })) })).toBe('TRIAL_EXPIRED');
  });
  it('TOUS les points d’appel modèle passent par le prédicat (orchestrateur, ports, routes)', () => {
    const orch = lire('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');
    const ports = lire('src/services/verebona-assistant/core/ports.ts');
    // Plus aucune éligibilité d'offre utilisée comme autorisation d'appel.
    expect(orch).not.toMatch(/isPlanAiEligible\(/);
    expect(ports).not.toMatch(/isPlanAiEligible\(/);
    expect(lire('src/services/verebona-assistant/core/action-resolver.service.ts')).not.toMatch(/isPlanAiEligible/);
    // Ports modèle gardés ; revalidation sur le même prédicat.
    expect(ports).toMatch(/classifyWithAI: gardeModele\(/);
    expect(ports).toMatch(/generateWithAI: gardeModele\(/);
    expect(ports).toMatch(/arbitrateWithAI: gardeModele\(/);
    expect(ports).toMatch(/allowModel: isAssistantModelCallAllowed\(input\)/);
    // Pas de `if (plan === 'STANDARD')` répliqué dans le pipeline.
    for (const src of [orch, ports]) expect(src).not.toMatch(/planType\s*===?\s*'STANDARD'/);
    // Routes : accès IA transmis au pipeline ET à la reprise de clarification.
    const messages = lire('src/app/api/verebona/messages/route.ts');
    const clarif = lire('src/app/api/verebona/clarifications/[clarificationId]/answer/route.ts');
    expect(messages).toMatch(/aiAccess,\s*\n\s*};/);
    expect(messages).toMatch(/aiAccess, planLimit: input\.planLimit/);
    expect(clarif).toMatch(/aiAccess: assistantAiAccessFromEntitlements\(entitlements\)/);
    // Jamais de droits Premium simulés.
    for (const src of [messages, clarif]) expect(src).not.toMatch(/premiumFeatures:\s*true|planType:\s*'PREMIUM'/);
  });
});

const ACCESS = {
  assetInAccount: async (_a: number, id: number) => id === 3,
  documentInAccount: async () => true,
  agendaItemInAccount: async () => true,
  helpEntryPublished: async () => true,
};

describe('A3 / C — droit Premium MÉTIER distinct (actions, TCO, offre)', () => {
  const dossier = [{ type: 'OPEN_EXPORT_AREA' as const, targetId: 'asset_3', params: { exportType: 'DOSSIER_VENTE' } }];
  it('OPEN_EXPORT_AREA dossier Premium : selon le droit RÉEL aux exports, jamais l’IA', async () => {
    // Standard actif : T2 complet, mais AUCUN dossier Premium.
    const std = await resolveActions({ accountId: 7, intent: 'EXPORT_HELP', actionIntents: dossier, access: ACCESS, planType: 'STANDARD', premiumExports: false });
    expect(std).toHaveLength(0);
    const prem = await resolveActions({ accountId: 7, intent: 'EXPORT_HELP', actionIntents: dossier, access: ACCESS, planType: 'PREMIUM', premiumExports: true });
    expect(prem.map((a) => a.type)).toEqual(['OPEN_EXPORT_AREA']);
    // Essai : droit Premium réel (code cognitif PREMIUM, droit réel vrai).
    expect(offrePermet('OPEN_EXPORT_AREA', { exportType: 'DOSSIER_VENTE' }, 'PREMIUM', null, true)).toBe(true);
    // Droit réel absent même si un code d'offre « PREMIUM » était fourni : refus.
    expect(offrePermet('OPEN_EXPORT_AREA', { exportType: 'DOSSIER_VENTE' }, 'PREMIUM', null, false)).toBe(false);
    // Export brut : ouvert à tous.
    expect(offrePermet('OPEN_EXPORT_AREA', { exportType: 'EXPORT_BRUT' }, 'STANDARD', null, false)).toBe(true);
    // Lecture seule : ni dossier, ni création.
    expect(offrePermet('OPEN_EXPORT_AREA', { exportType: 'DOSSIER_VENTE' }, 'PREMIUM', 'TRIAL_EXPIRED', true)).toBe(false);
    expect(offrePermet('START_ADD_DOCUMENT', undefined, 'STANDARD', 'TRIAL_EXPIRED', false)).toBe(false);
    expect(offrePermet('START_ADD_DOCUMENT', undefined, 'STANDARD', null, false)).toBe(true);
  });
  it('droit Premium métier de la demande : celui des droits, jamais déduit de l’IA', () => {
    expect(ai.premiumBusinessRightOf({ aiAccess: ai.assistantAiAccessFromEntitlements(E()) })).toBe(false);
    expect(ai.premiumBusinessRightOf({ aiAccess: ai.assistantAiAccessFromEntitlements(E({ plan: 'premium', premiumFeatures: true })) })).toBe(true);
    expect(ai.premiumBusinessRightOf({})).toBeUndefined();
  });
  it('garde TCO inchangé : lecture du coût de possession refusée sans `premiumFeatures`', () => {
    const repo = lire('src/services/verebona-assistant/canonical/repository.ts');
    expect(repo).toMatch(/if \(!\(await ownershipCostAllowed\(accountId\)\)\) throw new OwnershipCostNotAllowedError\(\)/);
    expect(repo).toMatch(/e\.premiumFeatures === true/);
  });
  it('PRODUCT_PLAN_LIMIT : questions incluses en Standard ; TCO / agenda / dossiers restent Premium', () => {
    const std = tryDeterministic('PRODUCT_PLAN_LIMIT', { planType: 'STANDARD', planLimit: null, premiumFeatures: false }).answer!;
    expect(std).toMatch(/^Votre offre Standard comprend .*les réponses à vos questions/);
    expect(std).not.toMatch(/réponses rédigées[^.]*font partie de Premium/);
    expect(std).toMatch(/Le coût de possession, la synchronisation de l’agenda et les dossiers prêts à l’usage font partie de Premium et Premium Duo\./);
    const prem = tryDeterministic('PRODUCT_PLAN_LIMIT', { planType: 'PREMIUM', planLimit: null, premiumFeatures: true }).answer!;
    expect(prem).toMatch(/fonctions Premium : coût de possession, synchronisation de l’agenda et dossiers prêts à l’usage/);
    const ro = tryDeterministic('PRODUCT_PLAN_LIMIT', { planType: 'STANDARD', planLimit: 'TRIAL_EXPIRED', premiumFeatures: false }).answer!;
    expect(ro).not.toMatch(/^Votre offre Standard/);
    expect(ro).toMatch(/Votre essai est terminé/);
  });
});

describe('C — commandes : ouvertes à Standard actif, revalidées à l’exécution, refusées en lecture seule', () => {
  it('droit d’écriture évalué À L’EXÉCUTION sur les droits réels', async () => {
    ent.value = { plan: 'standard', status: 'active', canWrite: true };
    expect(await defaultCanWrite(7)).toEqual({ allowed: true });
    ent.value = { plan: 'none', status: 'readonly', canWrite: false };
    expect(await defaultCanWrite(7)).toMatchObject({ allowed: false });
  });
  it('aucune condition d’offre dans les commandes (Standard = mêmes commandes que Premium)', () => {
    const plan = lire('src/services/verebona-assistant/commands/plan.service.ts');
    expect(plan).not.toMatch(/premiumFeatures|isPlanAiEligible|planType/);
    // L'interrupteur VEREBONA_ASSISTANT_WRITE_COMMANDS reste la seule porte (ports).
    expect(lire('src/services/verebona-assistant/core/ports.ts')).toMatch(/prepareCommand: async \(input\) => \{\s*\n\s*if \(!areWriteCommandsEnabled\(\)\) return null;/);
  });
});

describe('C — suggestions : rien qui exige une fonction Premium sans le droit réel', () => {
  const FIX = join(ROOT, 'src/test/e2e/fixtures');
  const help = parseHelpCorpus(JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8')))!;
  const res = parseResourcesCorpus(JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8')))!;
  const corpora = { help, resources: asHelpSearchCorpus(res) };
  const usage = (premiumFeatures?: boolean) => ({
    assetsTotal: 1, documentsTotal: 3, documentsAnalyzed: 3, userDocuments: 3, userQuestions: 5, deadlinesUpcoming: 1, exportsTotal: 0,
    ...(premiumFeatures === undefined ? {} : { premiumFeatures }),
  });
  it('synchronisation d’agenda et dossiers : marquées Premium dans le stock', () => {
    expect(GUIDE_STOCK.filter((e) => e.requiresPremium).map((e) => e.id).sort()).toEqual(['guide_agenda_sync', 'guide_prepare_dossier']);
  });
  it('Standard (ou droit inconnu) : jamais proposées ; Premium / essai : proposables', () => {
    const ids = (p?: boolean) => guideCandidatesOf('PROGRESS', usage(p), corpora).candidates.map((c) => c.entry.id);
    expect(ids(false)).not.toEqual(expect.arrayContaining(['guide_agenda_sync']));
    expect(ids(false)).not.toContain('guide_prepare_dossier');
    expect(ids(undefined)).not.toContain('guide_agenda_sync');
    expect(ids(true)).toEqual(expect.arrayContaining(['guide_agenda_sync', 'guide_prepare_dossier']));
  });
  it('coût de possession : précondition `ownershipCostAvailable` (droit Premium) conservée', () => {
    const reg = lire('src/services/verebona-assistant/registries/capability-registry.ts');
    expect(reg).toMatch(/id: 'home_asset_ownership_cost'[^\n]*requires: \[R\('ownershipCostAvailable'\)/);
  });
});

describe('D — champ commun : la frappe reste lexicale, sans modèle', () => {
  it('frappe → /api/search?instant=1 (SQL) ; aucune route de recherche intelligente recréée', () => {
    expect(lire('src/lib/verebona/live-search.ts')).toMatch(/\/api\/search\?instant=1/);
    const route = lire('src/app/api/search/route.ts');
    const imports = route.split('\n').filter((l) => /^import /.test(l)).join('\n');
    expect(imports).not.toMatch(/gateway|gemini|verebona-assistant|ai\//i);
    expect(route).not.toMatch(/runAssistant\(|classifyWithAI|generateWithAI/);
    expect(existsSync(join(ROOT, 'src/app/api/search/intelligent'))).toBe(false);
  });
});
