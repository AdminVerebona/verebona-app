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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE, TOUJOURS RÉPONDABLE (lot 32, point 8)
 *
 * « Quels documents sont liés à ce bien ? » s'affichait hors de toute fiche
 * (« ce bien » n'y désigne rien) et, même sur une fiche, T2 ne le résolvait
 * pas (« ce bien » n'est pas un nom : recherche vide). Chaque exemple de ce
 * catalogue est désormais :
 *   · CONTEXTUEL — sur une fiche, il NOMME le bien (« Quels sont les
 *     documents de Cupra ? ») ; hors fiche, il est général ou nomme un vrai
 *     bien du compte ;
 *   · RÉPONDABLE — formulé comme T2 le traite (vérifié de bout en bout par
 *     `src/test/e2e/scenarios/l32e-exemples-verebona.e2e.ts`, orchestrateur
 *     réel et modèle simulé) ; un exemple qui dépend des données (documents
 *     d'un bien, éléments « À traiter », documents non rattachés, exports)
 *     n'est proposé que si la donnée existe (`when`).
 * Le champ desktop, l'espace mobile et la mascotte lisent tous cette liste
 * (`suggestionsForRoute`, route `/api/verebona/suggestions`).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Bien nommable dans un exemple (lu côté serveur, borné au compte). */
export interface SuggestionAsset {
  name: string;
  /** Documents rattachés (asset_id ou linked_asset_id), non supprimés. */
  documents: number;
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
  /** Documents rattachés à aucun bien (lot 32). Absent : inconnu. */
  documentsUnlinked?: number;
}

/**
 * Contexte serveur des suggestions. Absent (rendu client avant la réponse
 * du serveur) : seuls les exemples qui ne dépendent d'aucune donnée sont
 * proposés.
 */
export interface SuggestionContext {
  state?: AccountSuggestionState | null;
  /** Bien de la fiche ouverte (`/assets/:id`), s'il est disponible et nommable sans ambiguïté. */
  pageAsset?: SuggestionAsset | null;
  /** Bien du compte à nommer hors fiche (nommable sans ambiguïté). */
  accountAsset?: SuggestionAsset | null;
}

export interface SuggestionEntry {
  id: string;
  /**
   * Libellé ; `{de_bien}` est remplacé par « de <nom> » (« d’<nom> » devant
   * une voyelle) du bien désigné par `asset`.
   */
  label: string;
  routePrefix?: string; // contexte de page (§8.2)
  /** Routes exactes (l'accueil : « / » préfixe TOUTES les routes). */
  routeExact?: string[];
  /** Route en expression régulière (fiche d'un bien : `/assets/:id`). */
  routePattern?: RegExp;
  priority: number;     // plus bas = plus prioritaire
  /** Bien nommé dans le libellé : celui de la fiche, ou un bien du compte. */
  asset?: 'page' | 'account';
  /** Condition sur les données : l'exemple n'est proposé que si elle est vraie. */
  when?: (ctx: SuggestionContext) => boolean;
}

/** Suggestion rendue (libellé final, sans gabarit). */
export interface RenderedSuggestion { id: string; label: string; priority: number }

const HOME = ['/', '/accueil'];
const FICHE = /^\/assets\/\d+(\/|$)/;

const docsDuBien = (cle: 'pageAsset' | 'accountAsset') => (c: SuggestionContext) => (c[cle]?.documents ?? 0) > 0;

export const SUGGESTIONS: SuggestionEntry[] = [
  // Accueil
  { id: 'home_deadlines', label: 'Quelles échéances arrivent bientôt ?', routeExact: HOME, priority: 2 },
  { id: 'home_asset_docs', label: 'Quels sont les documents {de_bien} ?', routeExact: HOME, priority: 3, asset: 'account', when: docsDuBien('accountAsset') },
  { id: 'home_add_doc', label: 'Comment ajouter un document ?', routeExact: HOME, priority: 4 },
  // À traiter
  { id: 'todo_priority', label: 'Que dois-je traiter en priorité ?', routePrefix: '/accueil/a-traiter', priority: 1, when: (c) => (c.state?.toProcessPending ?? 0) > 0 },
  { id: 'todo_explain', label: 'Comment fonctionne la page « À traiter » ?', routePrefix: '/accueil/a-traiter', priority: 2 },
  { id: 'todo_arbitrate', label: 'Comment arbitrer entre deux valeurs ?', routePrefix: '/accueil/a-traiter', priority: 3 },
  // Fiche d'un bien : le bien est NOMMÉ (jamais « ce bien »)
  { id: 'asset_docs', label: 'Quels sont les documents {de_bien} ?', routePattern: FICHE, priority: 1, asset: 'page', when: docsDuBien('pageAsset') },
  { id: 'asset_deadlines', label: 'Quelles sont les prochaines échéances {de_bien} ?', routePattern: FICHE, priority: 2, asset: 'page' },
  { id: 'asset_complete', label: 'Comment compléter la fiche d’un bien ?', routePattern: FICHE, priority: 3 },
  { id: 'asset_add_doc', label: 'Comment ajouter un document ?', routePattern: FICHE, priority: 4 },
  // Liste des biens
  { id: 'assets_add', label: 'Comment ajouter un bien ?', routeExact: ['/assets'], priority: 1 },
  { id: 'assets_deadlines', label: 'Quelles sont les prochaines échéances {de_bien} ?', routeExact: ['/assets'], priority: 2, asset: 'account' },
  { id: 'assets_transfer', label: 'Comment transmettre un bien ?', routeExact: ['/assets'], priority: 3 },
  // Documents
  { id: 'docs_unlinked', label: 'Quels documents ne sont rattachés à aucun bien ?', routePrefix: '/documents', priority: 1, when: (c) => (c.state?.documentsUnlinked ?? 0) > 0 },
  { id: 'docs_asset', label: 'Quels sont les documents {de_bien} ?', routePrefix: '/documents', priority: 2, asset: 'account', when: docsDuBien('accountAsset') },
  { id: 'docs_in_analysis', label: 'Pourquoi un document est-il encore en analyse ?', routePrefix: '/documents', priority: 3 },
  { id: 'docs_add', label: 'Comment ajouter un document ?', routePrefix: '/documents', priority: 4 },
  // Agenda
  { id: 'agenda_next', label: 'Quelles échéances arrivent bientôt ?', routePrefix: '/agenda', priority: 1 },
  { id: 'agenda_sync', label: 'Comment synchroniser mon agenda ?', routePrefix: '/agenda', priority: 2 },
  // Mon compte
  { id: 'account_plan', label: 'Que comprend mon offre ?', routePrefix: '/mon-compte', priority: 1 },
  { id: 'account_notif', label: 'Comment gérer mes notifications ?', routePrefix: '/mon-compte', priority: 2 },
  // Génériques (complément)
  { id: 'generic_ask', label: 'Comment poser une question à Verebona ?', priority: 9 },
  { id: 'generic_add_doc', label: 'Comment ajouter un document ?', priority: 10 },
  { id: 'generic_deadlines', label: 'Quelles échéances arrivent bientôt ?', priority: 11 },
];

/**
 * Suggestions dérivées de l'état du compte (§8.2), dans l'ordre d'utilité :
 * ce qui attend une action, puis ce qui arrive, puis l'état des documents.
 * Libellés du catalogue validé (§8.3) — aucune donnée du compte n'y figure.
 */
export const ACCOUNT_STATE_SUGGESTIONS: Array<SuggestionEntry & { when: (c: SuggestionContext) => boolean }> = [
  { id: 'state_todo', label: 'Que dois-je traiter en priorité ?', priority: 1, when: (c) => (c.state?.toProcessPending ?? 0) > 0 },
  { id: 'state_deadlines', label: 'Quelles échéances arrivent bientôt ?', priority: 2, when: (c) => (c.state?.deadlinesSoon ?? 0) > 0 },
  { id: 'state_failed', label: 'Pourquoi un document est-il en erreur ?', priority: 3, when: (c) => (c.state?.documentsFailed ?? 0) > 0 },
  { id: 'state_analysis', label: 'Pourquoi un document est-il encore en analyse ?', priority: 4, when: (c) => (c.state?.documentsInAnalysis ?? 0) > 0 },
  { id: 'state_exports', label: 'Quels exports sont disponibles ?', priority: 5, when: (c) => (c.state?.exportsReady ?? 0) > 0 },
];

/** Longueur maximale d'un nom de bien cité dans un exemple. */
export const SUGGESTION_ASSET_NAME_MAX = 40;
const NOM_ACCEPTE = /^[\p{L}\p{N}][\p{L}\p{N} '’.\-]*$/u;

/** Forme de comparaison d'un nom (casse et accents ignorés). */
export function normalizeAssetName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Un nom est-il citable dans un exemple ? Court, sans caractère spécial, et
 * SANS AMBIGUÏTÉ dans le compte : aucun autre bien disponible ne porte le
 * même nom, ni un nom qui le contient ou qu'il contient (« Cupra » et
 * « Cupra Born » : T2 hésiterait, l'exemple ne répondrait pas).
 */
export function isAssetNameSuggestable(name: string | null | undefined, others: Array<string | null | undefined>): boolean {
  const n = (name ?? '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > SUGGESTION_ASSET_NAME_MAX || !NOM_ACCEPTE.test(n)) return false;
  const k = normalizeAssetName(n);
  return others.every((o) => {
    const x = normalizeAssetName(o ?? '');
    return !x || (x !== k && !x.includes(k) && !k.includes(x));
  });
}

/** « de Cupra », « d’Appartement d’Annecy » (élision devant une voyelle). */
export function deBien(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  return /^[aeiouâàäéèêëîïôöûùüœæ]/i.test(n) ? `d’${n}` : `de ${n}`;
}

function matchesPage(s: SuggestionEntry, route: string): boolean {
  if (s.routeExact) return s.routeExact.includes(route);
  if (s.routePattern) return s.routePattern.test(route);
  return s.routePrefix != null && route.startsWith(s.routePrefix);
}

/**
 * Rend une entrée dans un contexte : `null` si elle dépend d'une donnée
 * inconnue ou absente (sans contexte serveur, aucun exemple dépendant des
 * données n'est proposé).
 */
function render(s: SuggestionEntry, ctx: SuggestionContext | null): RenderedSuggestion | null {
  if ((s.when || s.asset) && !ctx) return null;
  if (s.when && !s.when(ctx!)) return null;
  let label = s.label;
  if (s.asset) {
    const bien = s.asset === 'page' ? ctx!.pageAsset : ctx!.accountAsset;
    if (!bien?.name) return null;
    label = label.replace('{de_bien}', deBien(bien.name));
  }
  return { id: s.id, label, priority: s.priority };
}

/**
 * Renvoie 3–4 suggestions selon la route (§8.1 / §8.2) : page d'abord, puis
 * état du compte (quand il est connu), génériques ensuite. Sans contexte
 * serveur, seuls les exemples indépendants des données.
 */
export function suggestionsForRoute(route: string | undefined, ctx?: SuggestionContext | null): RenderedSuggestion[] {
  const c = ctx ?? null;
  const r = (route ?? '/').split(/[?#]/)[0].replace(/(.)\/$/, '$1');
  const rendre = (l: SuggestionEntry[]) => l.map((s) => render(s, c)).filter((s): s is RenderedSuggestion => s !== null);
  const page = rendre(SUGGESTIONS.filter((s) => matchesPage(s, r)).sort((a, b) => a.priority - b.priority));
  const vus = new Set(page.map((s) => s.label));
  // §8.2 : « compte » et « prochaine action utile », entre la page et les
  // génériques. Sur une page qui a déjà ses 3 suggestions, une seule
  // suggestion d'état vient compléter.
  const compte = rendre(ACCOUNT_STATE_SUGGESTIONS)
    .filter((s) => !vus.has(s.label))
    .slice(0, page.length >= 3 ? 1 : 2);
  for (const s of compte) vus.add(s.label);
  const generiques = rendre(SUGGESTIONS.filter((s) => !s.routeExact && !s.routePrefix && !s.routePattern).sort((a, b) => a.priority - b.priority))
    .filter((s) => !vus.has(s.label));
  return [...page, ...compte, ...generiques].slice(0, page.length + compte.length >= 3 ? 4 : 3);
}
