/**
 * Registre des capacités par offre + suggestions — CDC §25.6 / §6 / §8.
 *
 * Évite les switch dispersés sur les offres (§25.6). Les capacités futures sont
 * enregistrées mais DÉSACTIVÉES en V1 (§5.4). L'éligibilité IA réelle est calculée
 * par `entitlements.service.getEntitlements(accountId).premiumFeatures` (source de
 * vérité serveur), ce registre ne fait que déclarer la matrice.
 */
import type { VerebonaIntent } from '../types/intents';

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

/** Renvoie 3–4 suggestions selon la route (§8.1 / §8.2) : page d'abord, génériques ensuite. */
export function suggestionsForRoute(route: string | undefined): SuggestionEntry[] {
  const r = (route ?? '/').split(/[?#]/)[0].replace(/(.)\/$/, '$1');
  const page = SUGGESTIONS.filter((s) => matchesPage(s, r)).sort((a, b) => a.priority - b.priority);
  const vus = new Set(page.map((s) => s.label));
  const generiques = SUGGESTIONS
    .filter((s) => !s.routeExact && !s.routePrefix && !vus.has(s.label))
    .sort((a, b) => a.priority - b.priority);
  return [...page, ...generiques].slice(0, page.length >= 3 ? 4 : 3);
}
