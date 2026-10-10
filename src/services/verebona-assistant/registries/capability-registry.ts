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
 * Gemini (§8.3). Priorité : page > compte > action utile > aide fréquente.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE, RÉPONDABLE AVANT AFFICHAGE (lot 32 point 8, lot 34)
 *
 * Lot 32 : chaque exemple NOMME le bien qu'il désigne (jamais « ce bien »).
 *
 * Lot 34 (ticket « ne proposer que des questions pertinentes et réellement
 * répondables par T2 ») : la mascotte avait son propre catalogue
 * (`T2_QUESTIONS` : « Que dois-je faire aujourd'hui ? » dès qu'un « À
 * traiter » existait, « Que sais-tu sur Cupra ? »), avec des
 * pseudo-intentions (`account_next_actions`, `asset_summary`…) qu'aucun
 * contrat T2 ne garantissait, et passait AVANT ce catalogue. Désormais :
 *   · UNE seule liste (`SUGGESTIONS`, `ACCOUNT_STATE_SUGGESTIONS`) et UNE
 *     seule éligibilité (`suggestionsForRoute`) — champ desktop, espace
 *     mobile, route `/api/verebona/suggestions` ET mascotte d'accueil
 *     (`mascot.service` → `buildSecondaries`) ;
 *   · chaque entrée déclare son INTENTION T2 CANONIQUE (`canonicalIntent`,
 *     une vraie `VerebonaIntent`), son DOMAINE de réponse (`domain`) et ses
 *     PRÉCONDITIONS explicites (`requires`, sur des compteurs lus côté
 *     serveur) — aucune IA ne décide d'une suggestion ;
 *   · « Que sais-tu sur X ? » n'existe plus (trop ouvert) ;
 *   · « Que dois-je faire aujourd'hui ? » n'est proposé que si le résolveur
 *     des demandes d'actions (lot 34, `actionable-request`) reconnaît la
 *     question ET trouve des éléments datés (retards actifs, dus aujourd'hui) ;
 *     sinon « Que dois-je traiter en priorité ? » (`toProcessPending > 0`) ;
 *   · 0 à 3 suggestions : jamais de remplissage (les génériques ne servent
 *     que de liste de page aux pages sans liste propre).
 * Le contrat « affichée → cliquée → intention attendue → source du bon
 * domaine → réponse non fallback » est vérifié pour CHAQUE entrée par
 * `src/test/e2e/scenarios/l34-suggestions-repondables.e2e.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Bien nommable dans un exemple (lu côté serveur, borné au compte). */
export interface SuggestionAsset {
  /** Identifiant (contexte transmis au clic, revalidé côté serveur). Absent : inconnu. */
  id?: number;
  name: string;
  /** Documents rattachés (asset_id ou linked_asset_id), non supprimés. */
  documents: number;
  /** Échéances actives à venir (règle canonique `countUpcomingAgenda`). Absent : inconnu. */
  deadlines?: number;
}

/**
 * État du compte utile aux suggestions (§8.2 « compte » et « prochaine
 * action utile ») : des COMPTEURS seulement, lus côté serveur et bornés au
 * compte — jamais un contenu. Un compteur absent est INCONNU : une
 * précondition qui le lit n'est pas satisfaite.
 */
export interface AccountSuggestionState {
  /** Éléments « À traiter » non résolus. */
  toProcessPending: number;
  /** Échéances actives dans les 30 prochains jours (règle canonique `listUpcomingAgenda`). */
  deadlinesSoon: number;
  /** Documents en cours d'analyse. */
  documentsInAnalysis: number;
  /** Documents dont l'analyse a échoué. */
  documentsFailed: number;
  /** Exports ou dossiers prêts. */
  exportsReady: number;
  /** Documents rattachés à aucun bien (lot 32). */
  documentsUnlinked?: number;
  /** Lot 34 : échéances actives à venir, sans fenêtre (`countUpcomingAgenda`). */
  deadlinesUpcoming?: number;
  /**
   * Lot 34 : éléments en retard ou dus aujourd'hui que le RÉSOLVEUR des
   * demandes d'actions rend pour « Que dois-je faire aujourd'hui ? » (0 si
   * le résolveur ne reconnaît pas la question).
   */
  actionsDueToday?: number;
  /** Lot 34 : biens disponibles du compte. */
  assetsTotal?: number;
  /** Lot 34 : documents non supprimés du compte. */
  documentsTotal?: number;
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

/** Compteur lu par une précondition ; `asset.*` : le bien désigné par l'entrée (`asset`). */
export type SuggestionFact = keyof AccountSuggestionState | 'asset.documents' | 'asset.deadlines';

/**
 * Précondition explicite : `positive` (connu et > 0), `zero` (connu et nul),
 * `notPositive` (nul ou inconnu).
 */
export interface SuggestionRequirement { fact: SuggestionFact; is: 'positive' | 'zero' | 'notPositive' }

/** Domaine de la réponse attendue (sources admissibles, vérifiées par le test contractuel). */
export type SuggestionDomain = 'ACTIONS' | 'TO_PROCESS' | 'AGENDA' | 'DOCUMENTS' | 'DOCUMENT_STATUS' | 'EXPORTS' | 'HELP' | 'PLAN';

/** Types de sources T2 admissibles pour chaque domaine (aide : article ou règle produit). */
export const SUGGESTION_DOMAIN_SOURCES: Readonly<Record<SuggestionDomain, readonly string[]>> = {
  ACTIONS: ['to_process_item', 'agenda_item'],
  TO_PROCESS: ['to_process_item'],
  AGENDA: ['agenda_item'],
  DOCUMENTS: ['document'],
  DOCUMENT_STATUS: ['document'],
  EXPORTS: ['export_item'],
  HELP: ['help_entry', 'product_rule'],
  PLAN: ['product_rule', 'help_entry'],
};

export interface SuggestionEntry {
  id: string;
  /**
   * Libellé ; `{de_bien}` est remplacé par « de <nom> » (« d’<nom> » devant
   * une voyelle) du bien désigné par `asset`.
   */
  label: string;
  /** Intention T2 canonique que le libellé déclenche (routage déterministe vérifié). */
  canonicalIntent: VerebonaIntent;
  /** Domaine de la réponse. */
  domain: SuggestionDomain;
  /**
   * Sujet : deux entrées du même sujet ne sont jamais proposées ensemble
   * (« Quelle est ma prochaine échéance ? » et « Quelles échéances arrivent
   * bientôt ? »). Défaut : l'identifiant.
   */
  topic?: string;
  routePrefix?: string; // contexte de page (§8.2)
  /** Routes exactes (l'accueil : « / » préfixe TOUTES les routes). */
  routeExact?: string[];
  /** Route en expression régulière (fiche d'un bien : `/assets/:id`). */
  routePattern?: RegExp;
  priority: number;     // plus bas = plus prioritaire
  /** Bien nommé dans le libellé : celui de la fiche, ou un bien du compte. */
  asset?: 'page' | 'account';
  /** Préconditions sur les données : toutes doivent être vraies. */
  requires?: readonly SuggestionRequirement[];
}

/** Suggestion rendue (libellé final, sans gabarit). */
export interface RenderedSuggestion {
  id: string;
  label: string;
  priority: number;
  canonicalIntent: VerebonaIntent;
  domain: SuggestionDomain;
  topic: string;
  /** Bien désigné (contexte transmis au clic, revalidé côté serveur). */
  assetId?: number;
}

const HOME = ['/', '/accueil'];
const FICHE = /^\/assets\/\d+(\/|$)/;

const R = (fact: SuggestionFact, is: SuggestionRequirement['is'] = 'positive'): SuggestionRequirement => ({ fact, is });

export const SUGGESTIONS: SuggestionEntry[] = [
  // Accueil — ce qui attend une action, puis ce qui arrive, puis les documents.
  { id: 'home_today', label: 'Que dois-je faire aujourd’hui ?', canonicalIntent: 'ACCOUNT_TO_PROCESS', domain: 'ACTIONS', topic: 'actions', routeExact: HOME, priority: 1, requires: [R('actionsDueToday')] },
  { id: 'home_todo_priority', label: 'Que dois-je traiter en priorité ?', canonicalIntent: 'ACCOUNT_TO_PROCESS', domain: 'TO_PROCESS', topic: 'actions', routeExact: HOME, priority: 1, requires: [R('toProcessPending'), R('actionsDueToday', 'notPositive')] },
  { id: 'home_next_deadline', label: 'Quelle est ma prochaine échéance ?', canonicalIntent: 'ACCOUNT_SEARCH_AGENDA', domain: 'AGENDA', topic: 'deadlines', routeExact: HOME, priority: 2, requires: [R('deadlinesUpcoming')] },
  { id: 'home_analysis', label: 'Où en est l’analyse de mes documents ?', canonicalIntent: 'ACCOUNT_FACT_DOCUMENT', domain: 'DOCUMENT_STATUS', topic: 'analysis', routeExact: HOME, priority: 3, requires: [R('documentsInAnalysis')] },
  { id: 'home_asset_docs', label: 'Quels sont les documents {de_bien} ?', canonicalIntent: 'ACCOUNT_SEARCH_DOCUMENT', domain: 'DOCUMENTS', topic: 'asset-docs', routeExact: HOME, priority: 4, asset: 'account', requires: [R('asset.documents')] },
  // Accueil, premiers pas (compte vide, aucun document) : l'aide d'ajout.
  { id: 'home_add_asset', label: 'Comment ajouter un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routeExact: HOME, priority: 5, requires: [R('assetsTotal', 'zero')] },
  { id: 'home_add_doc', label: 'Comment ajouter un document ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routeExact: HOME, priority: 6, requires: [R('documentsTotal', 'zero')] },
  { id: 'home_analysis_help', label: 'L’analyse automatique, c’est quoi ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', domain: 'HELP', routeExact: HOME, priority: 7, requires: [R('documentsTotal', 'zero')] },
  // À traiter
  { id: 'todo_priority', label: 'Que dois-je traiter en priorité ?', canonicalIntent: 'ACCOUNT_TO_PROCESS', domain: 'TO_PROCESS', topic: 'actions', routePrefix: '/accueil/a-traiter', priority: 1, requires: [R('toProcessPending')] },
  { id: 'todo_explain', label: 'Comment fonctionne la page « À traiter » ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routePrefix: '/accueil/a-traiter', priority: 2 },
  { id: 'todo_arbitrate', label: 'Comment arbitrer entre deux valeurs ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routePrefix: '/accueil/a-traiter', priority: 3 },
  // Fiche d'un bien : le bien est NOMMÉ (jamais « ce bien »)
  { id: 'asset_docs', label: 'Quels sont les documents {de_bien} ?', canonicalIntent: 'ACCOUNT_SEARCH_DOCUMENT', domain: 'DOCUMENTS', topic: 'asset-docs', routePattern: FICHE, priority: 1, asset: 'page', requires: [R('asset.documents')] },
  { id: 'asset_deadlines', label: 'Quelles sont les prochaines échéances {de_bien} ?', canonicalIntent: 'ACCOUNT_SEARCH_AGENDA', domain: 'AGENDA', topic: 'deadlines', routePattern: FICHE, priority: 2, asset: 'page', requires: [R('asset.deadlines')] },
  { id: 'asset_complete', label: 'Comment compléter la fiche d’un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routePattern: FICHE, priority: 3 },
  { id: 'asset_add_doc', label: 'Comment ajouter un document ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routePattern: FICHE, priority: 4 },
  // Liste des biens
  { id: 'assets_add', label: 'Comment ajouter un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routeExact: ['/assets'], priority: 1 },
  { id: 'assets_deadlines', label: 'Quelles sont les prochaines échéances {de_bien} ?', canonicalIntent: 'ACCOUNT_SEARCH_AGENDA', domain: 'AGENDA', topic: 'deadlines', routeExact: ['/assets'], priority: 2, asset: 'account', requires: [R('asset.deadlines')] },
  { id: 'assets_transfer', label: 'Comment transmettre un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routeExact: ['/assets'], priority: 3 },
  // Documents
  { id: 'docs_unlinked', label: 'Quels documents ne sont rattachés à aucun bien ?', canonicalIntent: 'ACCOUNT_SEARCH_DOCUMENT', domain: 'DOCUMENTS', routePrefix: '/documents', priority: 1, requires: [R('documentsUnlinked')] },
  { id: 'docs_asset', label: 'Quels sont les documents {de_bien} ?', canonicalIntent: 'ACCOUNT_SEARCH_DOCUMENT', domain: 'DOCUMENTS', topic: 'asset-docs', routePrefix: '/documents', priority: 2, asset: 'account', requires: [R('asset.documents')] },
  { id: 'docs_in_analysis', label: 'Pourquoi un document est-il encore en analyse ?', canonicalIntent: 'PRODUCT_HELP_STATUS', domain: 'HELP', topic: 'analysis', routePrefix: '/documents', priority: 3, requires: [R('documentsInAnalysis')] },
  { id: 'docs_add', label: 'Comment ajouter un document ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routePrefix: '/documents', priority: 4 },
  // Agenda
  { id: 'agenda_next', label: 'Quelles échéances arrivent bientôt ?', canonicalIntent: 'ACCOUNT_SEARCH_AGENDA', domain: 'AGENDA', topic: 'deadlines', routePrefix: '/agenda', priority: 1, requires: [R('deadlinesSoon')] },
  { id: 'agenda_sync', label: 'Comment synchroniser mon agenda ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routePrefix: '/agenda', priority: 2 },
  // Mon compte
  { id: 'account_plan', label: 'Que comprend mon offre ?', canonicalIntent: 'PRODUCT_PLAN_LIMIT', domain: 'PLAN', routePrefix: '/mon-compte', priority: 1 },
  { id: 'account_notif', label: 'Comment gérer mes notifications ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', routePrefix: '/mon-compte', priority: 2 },
  // Génériques : la liste des pages qui n'en ont pas — jamais un complément.
  { id: 'generic_ask', label: 'Comment poser une question à Verebona ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', priority: 9 },
  { id: 'generic_add_doc', label: 'Comment ajouter un document ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', domain: 'HELP', priority: 10 },
];

/**
 * Suggestions dérivées de l'état du compte (§8.2), dans l'ordre d'utilité :
 * ce qui attend une action, puis ce qui arrive, puis l'état des documents.
 * Libellés du catalogue validé (§8.3) — aucune donnée du compte n'y figure.
 * Elles suivent la liste de la page, dans la limite de 3 et sans répéter un
 * sujet déjà proposé.
 */
export const ACCOUNT_STATE_SUGGESTIONS: Array<SuggestionEntry & { requires: readonly SuggestionRequirement[] }> = [
  { id: 'state_todo', label: 'Que dois-je traiter en priorité ?', canonicalIntent: 'ACCOUNT_TO_PROCESS', domain: 'TO_PROCESS', topic: 'actions', priority: 1, requires: [R('toProcessPending')] },
  { id: 'state_deadlines', label: 'Quelles échéances arrivent bientôt ?', canonicalIntent: 'ACCOUNT_SEARCH_AGENDA', domain: 'AGENDA', topic: 'deadlines', priority: 2, requires: [R('deadlinesSoon')] },
  { id: 'state_failed', label: 'Pourquoi un document est-il en erreur ?', canonicalIntent: 'PRODUCT_HELP_STATUS', domain: 'HELP', topic: 'failed', priority: 3, requires: [R('documentsFailed')] },
  { id: 'state_analysis', label: 'Pourquoi un document est-il encore en analyse ?', canonicalIntent: 'PRODUCT_HELP_STATUS', domain: 'HELP', topic: 'analysis', priority: 4, requires: [R('documentsInAnalysis')] },
  { id: 'state_exports', label: 'Quels exports sont disponibles ?', canonicalIntent: 'ACCOUNT_SEARCH_DOCUMENT', domain: 'EXPORTS', topic: 'exports', priority: 5, requires: [R('exportsReady')] },
];

/** Toutes les entrées publiables (catalogue unique, couvert par le test contractuel). */
export const ALL_SUGGESTIONS: readonly SuggestionEntry[] = [...SUGGESTIONS, ...ACCOUNT_STATE_SUGGESTIONS];

/** Nombre maximal de suggestions affichées (un maximum, jamais un objectif). */
export const MAX_SUGGESTIONS = 3;

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

const isGeneric = (s: SuggestionEntry) => !s.routeExact && !s.routePrefix && !s.routePattern;

/** Valeur d'un compteur dans un contexte (`undefined` : inconnue). */
function factValue(fact: SuggestionFact, ctx: SuggestionContext, asset: SuggestionAsset | null | undefined): number | undefined {
  if (fact === 'asset.documents') return asset?.documents;
  if (fact === 'asset.deadlines') return asset?.deadlines;
  const v = ctx.state?.[fact];
  return typeof v === 'number' ? v : undefined;
}

/** Préconditions satisfaites ? (pure, testée) */
export function requirementsMet(s: SuggestionEntry, ctx: SuggestionContext | null): boolean {
  if (!s.requires?.length) return true;
  if (!ctx) return false;
  const bien = s.asset === 'page' ? ctx.pageAsset : s.asset === 'account' ? ctx.accountAsset : null;
  return s.requires.every((r) => {
    const v = factValue(r.fact, ctx, bien);
    if (r.is === 'positive') return v != null && v > 0;
    if (r.is === 'zero') return v === 0;
    return v == null || v <= 0;
  });
}

/**
 * Rend une entrée dans un contexte : `null` si elle dépend d'une donnée
 * inconnue ou absente (sans contexte serveur, aucun exemple dépendant des
 * données n'est proposé).
 */
function render(s: SuggestionEntry, ctx: SuggestionContext | null): RenderedSuggestion | null {
  if ((s.requires?.length || s.asset) && !ctx) return null;
  if (!requirementsMet(s, ctx)) return null;
  let label = s.label;
  let assetId: number | undefined;
  if (s.asset) {
    const bien = s.asset === 'page' ? ctx!.pageAsset : ctx!.accountAsset;
    if (!bien?.name) return null;
    label = label.replace('{de_bien}', deBien(bien.name));
    assetId = bien.id;
  }
  return {
    id: s.id, label, priority: s.priority, canonicalIntent: s.canonicalIntent, domain: s.domain, topic: s.topic ?? s.id,
    ...(assetId ? { assetId } : {}),
  };
}

/**
 * Suggestions d'une route (§8.1 / §8.2) : la liste de la page (les
 * génériques pour une page sans liste propre), puis l'état du compte quand
 * il est connu — au plus 3, sans sujet répété, JAMAIS complétées pour
 * atteindre 3 (0, 1 ou 2 est une réponse valide). Sans contexte serveur,
 * seuls les exemples indépendants des données.
 */
export function suggestionsForRoute(route: string | undefined, ctx?: SuggestionContext | null): RenderedSuggestion[] {
  const c = ctx ?? null;
  const r = (route ?? '/').split(/[?#]/)[0].replace(/(.)\/$/, '$1');
  const rendre = (l: SuggestionEntry[]) => [...l].sort((a, b) => a.priority - b.priority)
    .map((s) => render(s, c)).filter((s): s is RenderedSuggestion => s !== null);
  const dePage = SUGGESTIONS.filter((s) => !isGeneric(s) && matchesPage(s, r));
  const page = rendre(dePage.length ? dePage : SUGGESTIONS.filter(isGeneric));
  const out: RenderedSuggestion[] = [];
  const labels = new Set<string>();
  const sujets = new Set<string>();
  for (const s of [...page, ...rendre(ACCOUNT_STATE_SUGGESTIONS)]) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (labels.has(s.label) || sujets.has(s.topic)) continue;
    labels.add(s.label);
    sujets.add(s.topic);
    out.push(s);
  }
  return out;
}

/** État d'un compte vide (aucun bien, aucun document, rien en attente). */
export const EMPTY_ACCOUNT_STATE: AccountSuggestionState = {
  toProcessPending: 0, deadlinesSoon: 0, documentsInAnalysis: 0, documentsFailed: 0, exportsReady: 0, documentsUnlinked: 0,
  deadlinesUpcoming: 0, actionsDueToday: 0, assetsTotal: 0, documentsTotal: 0,
};

/** Questions de l'accueil d'un compte vide (§12ter) : le même catalogue, mêmes règles. */
export function emptyAccountSuggestions(): RenderedSuggestion[] {
  return suggestionsForRoute('/accueil', { state: EMPTY_ACCOUNT_STATE });
}
