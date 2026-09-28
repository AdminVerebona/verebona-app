/**
 * Registre des capacités par offre + suggestions — CDC §25.6 / §6 / §8.
 *
 * Évite les switch dispersés sur les offres (§25.6). Les capacités futures sont
 * enregistrées mais DÉSACTIVÉES en V1 (§5.4). L'éligibilité IA réelle est calculée
 * par `entitlements.service.getEntitlements(accountId).premiumFeatures` (source de
 * vérité serveur), ce registre ne fait que déclarer la matrice.
 */
import type { VerebonaIntent } from '../types/intents';
import { FLAG_NAMES, isAssistantFlagOn, type AssistantFlag } from '../config/assistant-flags';

/** Codes de plan tels qu'utilisés par le repo (`PlanType`). */
export type PlanCode = 'STANDARD' | 'PREMIUM' | 'PREMIUM_DUO' | 'PREMIUM_PRO';

export interface AssistantCapability {
  code: string;
  enabled: boolean;
  plans: PlanCode[];
  intents: VerebonaIntent[];
  featureFlag?: string;
}

/** Offres éligibles aux réponses intelligentes (§6). Standard exclu (§6.1). */
export const AI_ELIGIBLE_PLANS: PlanCode[] = ['PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'];

export const CAPABILITIES: AssistantCapability[] = [
  {
    code: 'classic_search',
    enabled: true,
    plans: ['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'],
    intents: ['ACCOUNT_SEARCH_ASSET', 'ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_SUPPLIER'],
  },
  {
    code: 'product_help',
    enabled: true,
    plans: ['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'],
    intents: ['PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'PRODUCT_PLAN_LIMIT', 'NAVIGATION_FIND', 'EXPORT_HELP'],
    featureFlag: 'verebona_assistant_product_help',
  },
  {
    code: 'deterministic_facts',
    enabled: true,
    plans: ['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'],
    intents: ['ACCOUNT_FACT_ASSET', 'ACCOUNT_FACT_DOCUMENT', 'ACCOUNT_FACT_AGENDA', 'ACCOUNT_TO_PROCESS', 'ACCOUNT_MISSING_INFORMATION', 'NAVIGATION_OPEN'],
  },
  {
    code: 'account_ai',
    enabled: true,
    plans: AI_ELIGIBLE_PLANS,
    intents: ['ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE'],
    featureFlag: 'verebona_assistant_account_ai',
  },
  // Capacités futures — enregistrées, DÉSACTIVÉES en V1 (§5.4).
  { code: 'semantic_retrieval', enabled: false, plans: AI_ELIGIBLE_PLANS, intents: [], featureFlag: 'verebona_assistant_semantic_retrieval' },
  { code: 'voice_io', enabled: false, plans: [], intents: [] },
  { code: 'photo_search', enabled: false, plans: [], intents: [] },
  { code: 'proactive_notifications', enabled: false, plans: [], intents: [] },
];

export function isPlanAiEligible(plan: string): boolean {
  return (AI_ELIGIBLE_PLANS as string[]).includes(plan);
}

export function capabilityForIntent(intent: VerebonaIntent): AssistantCapability | undefined {
  return CAPABILITIES.find((c) => c.enabled && c.intents.includes(intent));
}

/** Flag du §39 porté par une capacité (`featureFlag`) : actif ? Lu à chaque appel. */
export function isCapabilityFlagOn(c: AssistantCapability, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!c.featureFlag) return true;
  const flag = (Object.keys(FLAG_NAMES) as AssistantFlag[]).find((f) => FLAG_NAMES[f] === c.featureFlag);
  // Flag inconnu du §39 : la capacité reste gouvernée par `enabled` seul.
  return flag ? isAssistantFlagOn(flag, env) : true;
}

/**
 * La capacité qui porte cette intention l'autorise-t-elle pour cette offre ?
 * — CDC §25.6 : l'éligibilité est lue dans le registre (capacité activée,
 * offre listée, flag du §39 actif), pas dans des `switch` dispersés.
 * Intention sans capacité déclarée (politesse, inconnu…) : aucune restriction
 * propre, les autres garde-fous s'appliquent.
 */
export function capabilityAllows(intent: VerebonaIntent, plan: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const capacite = capabilityForIntent(intent);
  // Aucune capacité ACTIVE : refus si l'intention appartient à une capacité
  // désactivée (§5.4), sinon aucune restriction propre.
  if (!capacite) return !CAPABILITIES.some((c) => !c.enabled && c.intents.includes(intent));
  return (capacite.plans as string[]).includes(plan) && isCapabilityFlagOn(capacite, env);
}

/**
 * Éligibilité à un appel modèle d'une intention (§6, §15.1, §25.6) : il faut
 * que l'intention le permette (`geminiEligible`), que l'offre soit éligible
 * aux réponses intelligentes ET que la capacité de l'intention l'autorise.
 */
export function isAiEligibleFor(intent: VerebonaIntent, plan: string, geminiEligible: boolean): boolean {
  return geminiEligible && isPlanAiEligible(plan) && capabilityAllows(intent, plan);
}

/** Libellés des capacités, pour la couche « droits et offre » du prompt (§17.3). */
export const CAPABILITY_LABELS: Record<string, string> = {
  classic_search: 'recherche dans les biens, documents, échéances et fournisseurs du compte',
  product_help: 'aide à l’utilisation de Verebona',
  deterministic_facts: 'lecture des informations enregistrées dans le compte',
  account_ai: 'synthèse, comparaison et chronologie rédigées à partir des documents',
  semantic_retrieval: 'recherche sémantique',
  voice_io: 'saisie vocale',
  photo_search: 'recherche par photo',
  proactive_notifications: 'notifications proactives',
};

/** Capacités ouvertes et fermées pour une offre, à cet instant (flags compris). */
export function capabilitiesForPlan(plan: string): { open: AssistantCapability[]; closed: AssistantCapability[] } {
  const open: AssistantCapability[] = [];
  const closed: AssistantCapability[] = [];
  for (const c of CAPABILITIES) {
    const ok = c.enabled && (c.plans as string[]).includes(plan) && isCapabilityFlagOn(c);
    (ok ? open : closed).push(c);
  }
  return { open, closed };
}

/**
 * Suggestions initiales contextuelles — CDC §8. Catalogue VALIDÉ, jamais généré par
 * Gemini (§8.3). Priorité : page > compte > action utile > aide fréquente > générique.
 */
export interface SuggestionEntry {
  id: string;
  label: string;
  routePrefix?: string; // contexte de page (§8.2)
  /** Routes exactes (l'accueil : « / » préfixe TOUTES les routes). */
  routeExact?: string[];
  priority: number;     // plus bas = plus prioritaire
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * SUGGESTIONS PAR PAGE — §8.1, §8.2 (audit P2)
 *
 * Les suggestions d'accueil portaient `routePrefix: '/'`, qui préfixe toutes
 * les routes : sur `/assets/42`, « Que dois-je traiter en priorité ? » se
 * mêlait à « Quels documents sont liés à ce bien ? ». L'accueil est désormais
 * une route EXACTE ; chaque page a ses suggestions, et les génériques ne
 * complètent que s'il en manque (priorité page > générique).
 * ══════════════════════════════════════════════════════════════════════════
 */
const HOME = ['/', '/accueil'];

export const SUGGESTIONS: SuggestionEntry[] = [
  { id: 'home_priority', label: 'Que dois-je traiter en priorité ?', routeExact: HOME, priority: 1 },
  { id: 'home_deadlines', label: 'Quelles échéances arrivent bientôt ?', routeExact: HOME, priority: 2 },
  { id: 'home_add_doc', label: 'Comment ajouter un document ?', routeExact: HOME, priority: 4 },
  { id: 'todo_explain', label: 'À quoi sert « À traiter » ?', routePrefix: '/accueil/a-traiter', priority: 1 },
  { id: 'todo_priority', label: 'Que dois-je traiter en priorité ?', routePrefix: '/accueil/a-traiter', priority: 2 },
  { id: 'asset_docs', label: 'Quels documents sont liés à ce bien ?', routePrefix: '/assets/', priority: 1 },
  { id: 'asset_deadlines', label: 'Quelles échéances concernent ce bien ?', routePrefix: '/assets/', priority: 2 },
  { id: 'asset_complete', label: 'Comment compléter sa fiche ?', routePrefix: '/assets/', priority: 3 },
  { id: 'assets_add', label: 'Comment ajouter un bien ?', routeExact: ['/assets'], priority: 1 },
  { id: 'docs_find_invoice', label: 'Retrouve une facture.', routePrefix: '/documents', priority: 1 },
  { id: 'docs_unlinked', label: "Quels documents ne sont rattachés à aucun bien ?", routePrefix: '/documents', priority: 2 },
  { id: 'docs_in_analysis', label: 'Pourquoi un document est-il encore en analyse ?', routePrefix: '/documents', priority: 3 },
  { id: 'agenda_next', label: 'Quelles échéances arrivent bientôt ?', routePrefix: '/agenda', priority: 1 },
  { id: 'agenda_sync', label: 'Comment synchroniser mon agenda ?', routePrefix: '/agenda', priority: 2 },
  { id: 'account_plan', label: 'Que comprend mon offre ?', routePrefix: '/mon-compte', priority: 1 },
  { id: 'account_notif', label: 'Comment gérer mes notifications ?', routePrefix: '/mon-compte', priority: 2 },
  // Génériques (complément)
  { id: 'generic_help', label: 'Comment utiliser Verebona ?', priority: 9 },
  { id: 'generic_add_doc', label: 'Comment ajouter un document ?', priority: 10 },
  { id: 'generic_deadlines', label: 'Quelles échéances arrivent bientôt ?', priority: 11 },
];

function matchesPage(s: SuggestionEntry, route: string): boolean {
  if (s.routeExact) return s.routeExact.includes(route);
  return s.routePrefix != null && route.startsWith(s.routePrefix);
}

/**
 * État du compte utile aux suggestions (§8.2 « compte » et « prochaine
 * action utile ») : des COMPTEURS seulement, lus côté serveur et bornés au
 * compte — jamais un contenu.
 */
export interface AccountSuggestionState {
  /** Éléments « À traiter » non résolus. */
  toProcessPending: number;
  /** Échéances dans les 30 prochains jours. */
  deadlinesSoon: number;
  /** Documents en cours d'analyse. */
  documentsInAnalysis: number;
  /** Documents dont l'analyse a échoué. */
  documentsFailed: number;
  /** Exports ou dossiers prêts. */
  exportsReady: number;
}

/**
 * Suggestions dérivées de l'état du compte (§8.2), dans l'ordre d'utilité :
 * ce qui attend une action, puis ce qui arrive, puis l'état des documents.
 * Libellés du catalogue validé (§8.3) — aucune donnée du compte n'y figure.
 */
export const ACCOUNT_STATE_SUGGESTIONS: Array<SuggestionEntry & { when: (s: AccountSuggestionState) => boolean }> = [
  { id: 'state_todo', label: 'Que dois-je traiter en priorité ?', priority: 1, when: (s) => s.toProcessPending > 0 },
  { id: 'state_deadlines', label: 'Quelles échéances arrivent bientôt ?', priority: 2, when: (s) => s.deadlinesSoon > 0 },
  { id: 'state_failed', label: 'Pourquoi un document est-il en erreur ?', priority: 3, when: (s) => s.documentsFailed > 0 },
  { id: 'state_analysis', label: 'Pourquoi un document est-il encore en analyse ?', priority: 4, when: (s) => s.documentsInAnalysis > 0 },
  { id: 'state_exports', label: 'Quels exports sont disponibles ?', priority: 5, when: (s) => s.exportsReady > 0 },
];

/**
 * Renvoie 3–4 suggestions selon la route (§8.1 / §8.2) : page d'abord, puis
 * état du compte (quand il est connu), génériques ensuite.
 */
export function suggestionsForRoute(route: string | undefined, state?: AccountSuggestionState | null): SuggestionEntry[] {
  const r = (route ?? '/').split(/[?#]/)[0].replace(/(.)\/$/, '$1');
  const page = SUGGESTIONS.filter((s) => matchesPage(s, r)).sort((a, b) => a.priority - b.priority);
  const vus = new Set(page.map((s) => s.label));
  // §8.2 : « compte » et « prochaine action utile », entre la page et les
  // génériques. Sur une page qui a déjà ses 3 suggestions, une seule
  // suggestion d'état vient compléter.
  const compte = state
    ? ACCOUNT_STATE_SUGGESTIONS.filter((s) => s.when(state) && !vus.has(s.label))
      .map(({ when: _when, ...s }) => s)
      .slice(0, page.length >= 3 ? 1 : 2)
    : [];
  for (const s of compte) vus.add(s.label);
  const generiques = SUGGESTIONS
    .filter((s) => !s.routeExact && !s.routePrefix && !vus.has(s.label))
    .sort((a, b) => a.priority - b.priority);
  return [...page, ...compte, ...generiques].slice(0, page.length + compte.length >= 3 ? 4 : 3);
}
